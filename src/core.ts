import { Notice, requestUrl, TFile, TFolder } from 'obsidian';
import type { App, Command } from 'obsidian';
import { KnowledgeSystemSettings } from './settings';
import { createIncrementalSseParser } from './utils/sse';
import {
  chatEndpointCandidates,
  hasAnthropicPath,
  modelsEndpointCandidates,
} from './utils/endpoints';
import {
  buildFrontmatter,
  countRecent,
  extractLastChars,
  resolveTimestamp,
  stripFrontmatter,
} from './utils/index';

/**
 * Structural view of the plugin the domain functions need, so `core`,
 * `commands`, `settingsTab` and `main` agree without a circular import.
 */
export interface KnowledgeSystemPlugin {
  app: App;
  settings: KnowledgeSystemSettings;
  saveSettings(): Promise<void>;
  addCommand(command: Command): Command;
  fetchModels(apiKey: string, baseUrl: string): Promise<{ ok: boolean; modelIds: string[]; message: string }>;
}

/** Fallback moment formats tried after the configured format. */
const FALLBACK_FORMATS = ['YYYY-MM-DD', 'YYYY.MM.DD', 'YYYY/MM/DD'];

/** The ordered list of formats used for parsing: configured first, then fallbacks. */
function formatsFor(plugin: KnowledgeSystemPlugin): string[] {
  const f = (plugin.settings.timeFormat || '').trim();
  return [f, ...FALLBACK_FORMATS].filter((x, i, arr) => !!x && arr.indexOf(x) === i);
}

/** Read a file's frontmatter via the metadata cache (empty when unavailable). */
function frontmatterOf(app: App, file: TFile): Record<string, unknown> {
  const cache = app.metadataCache.getFileCache(file);
  return (cache?.frontmatter ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Folders & file discovery
// ---------------------------------------------------------------------------

/** Resolve the configured source folder; falls back to the vault root. */
export function resolveSourceFolder(plugin: KnowledgeSystemPlugin): TFolder {
  const raw = (plugin.settings.sourceFolder || '/').trim();
  if (raw === '/' || raw === '') return vaultRoot(plugin.app);
  const p = raw.replace(/^\/+|\/+$/g, '');
  const found = plugin.app.vault.getAbstractFileByPath(p);
  return found instanceof TFolder ? found : vaultRoot(plugin.app);
}

/** The vault root folder, preferring `getRoot()` when available. */
function vaultRoot(app: App): TFolder {
  const vault = app.vault as App['vault'] & { getRoot?: () => TFolder };
  if (typeof vault.getRoot === 'function') {
    const r = vault.getRoot();
    if (r instanceof TFolder) return r;
  }
  const byEmpty = app.vault.getAbstractFileByPath('');
  return byEmpty instanceof TFolder ? byEmpty : (vault.getRoot?.() as TFolder);
}

/** Recursively collect every Markdown file under the given folder. */
export function getMarkdownFilesInFolder(folder: TFolder): TFile[] {
  const result: TFile[] = [];
  const visit = (f: TFolder) => {
    for (const child of f.children) {
      if (child instanceof TFile && child.extension === 'md') {
        result.push(child);
      } else if (child instanceof TFolder) {
        visit(child);
      }
    }
  };
  visit(folder);
  return result;
}

// ---------------------------------------------------------------------------
// Command 1: count recent files
// ---------------------------------------------------------------------------

/** Number of Markdown files whose timestamp falls within the last N days. */
export function countRecentFiles(plugin: KnowledgeSystemPlugin): number {
  const folder = resolveSourceFolder(plugin);
  const files = getMarkdownFilesInFolder(folder);
  const items = files.map((file) => ({
    isMd: true,
    frontmatter: frontmatterOf(plugin.app, file),
    ctimeMs: file.stat.ctime,
  }));
  const count = countRecent(items, {
    moment: window.moment,
    timeAttr: plugin.settings.timeAttr || '',
    formats: formatsFor(plugin),
    nowMs: Date.now(),
    days: plugin.settings.recentDays,
  });
  new Notice(`源文件夹最近 ${plugin.settings.recentDays} 天共有 ${count} 个文件`);
  return count;
}

// ---------------------------------------------------------------------------
// Command 2: output the latest file's last 100 characters
// ---------------------------------------------------------------------------

/** Join an output folder with a file name (no obsidian normalizePath needed). */
function joinOutputPath(folder: string, name: string): string {
  const raw = (folder || '/').trim();
  const base = raw === '/' || raw === '' ? '' : raw.replace(/^\/+|\/+$/g, '');
  const joined = base ? `${base}/${name}` : name;
  return joined.replace(/\/+/g, '/').replace(/^\/+/, '');
}

/** Ensure the output folder (and any nested parents) exists in the vault. */
async function ensureFolderExists(app: App, folder: string): Promise<void> {
  const raw = (folder || '/').trim();
  const parts = (raw === '/' || raw === '' ? '' : raw.replace(/^\/+|\/+$/g, '')).split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      await app.vault.createFolder(cur);
    }
  }
}

/**
 * Find the newest Markdown file in the source folder and write a new file
 * containing its last 100 characters. Does not call any LLM. Returns the
 * created file's vault-relative path.
 */
export async function outputLatestContent(plugin: KnowledgeSystemPlugin): Promise<string> {
  const folder = resolveSourceFolder(plugin);
  const files = getMarkdownFilesInFolder(folder);
  if (files.length === 0) {
    new Notice('源文件夹中没有可用的 Markdown 文件');
    return '';
  }

  const formats = formatsFor(plugin);
  const timeAttr = plugin.settings.timeAttr || '';
  const tsOf = (file: TFile) =>
    resolveTimestamp(frontmatterOf(plugin.app, file), file.stat.ctime, window.moment, timeAttr, formats);

  let latest = files[0];
  let latestTs = tsOf(latest);
  for (const file of files) {
    const ts = tsOf(file);
    if (ts > latestTs) {
      latestTs = ts;
      latest = file;
    }
  }

  const raw = await plugin.app.vault.read(latest);
  const body = stripFrontmatter(raw);
  const last100 = extractLastChars(body, 100);
  const now = window.moment();

  const frontmatter = buildFrontmatter(
    { source: latest.path, timestampMs: now.valueOf() },
    {
      timestampProperty: plugin.settings.timestampProperty,
      sourceAttr: plugin.settings.sourceAttr || 'source',
      moment: window.moment,
      timeFormat: plugin.settings.timeFormat,
      extraProperties: plugin.settings.extraProperties,
      reviewAttr: plugin.settings.reviewAttr,
      reviewDefault: plugin.settings.reviewDefault,
      categoryAttr: plugin.settings.categoryAttr,
      categoryDefault: plugin.settings.categoryDefault,
    }
  );

  // Milliseconds keep the name unique across back-to-back runs.
  const fileName = `${latest.basename}-最新内容-${now.valueOf()}.md`;
  const outPath = joinOutputPath(plugin.settings.outputFolder, fileName);

  await ensureFolderExists(plugin.app, plugin.settings.outputFolder);
  await plugin.app.vault.create(outPath, `---\n${frontmatter}\n---\n${last100}`);

  new Notice(`已输出：${outPath}`);
  return outPath;
}

// ---------------------------------------------------------------------------
// Settings tab: "test and fetch models"
// ---------------------------------------------------------------------------

/**
 * Map an OpenAI-compatible HTTP status to a readable category. The caller
 * appends `（HTTP <status>）` plus a body snippet, so this returns only the
 * category label (the generic branch is bare to avoid a duplicated status code).
 */
export function mapHttpError(status: number): string {
  if (status === 401 || status === 403) return 'API Key 无效';
  if (status === 402) return '余额不足';
  if (status === 429) return '限流';
  return '请求失败';
}

/** Extract model ids from a requestUrl response; null on non-2xx. */
async function listFromResponse(res: any): Promise<string[] | null> {
  const body =
    typeof res?.json === 'function' ? await res.json() : res?.json;
  if (!(res?.status >= 200 && res?.status < 300)) return null;
  const data = (body as { data?: unknown } | undefined)?.data;
  return Array.isArray(data)
    ? data
        .map((m) => (m && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id : ''))
        .filter((x) => x.length > 0)
    : [];
}

/**
 * Fetch the provider's model list. The endpoint is probed via
 * `modelsEndpointCandidates(baseUrl)` so a base that carries the `/anthropic`
 * chat prefix (e.g. `https://api.deepseek.com/anthropic`) is correctly
 * redirected to the root `/models` route, while a plain base keeps the
 * `{base}/models` → `{base}/v1/models` fallback. Uses the module-level
 * `requestUrl` (no fetch / Node http). Ids come only from the API.
 */
export async function fetchModelList(
  apiKey: string,
  baseUrl: string
): Promise<{ ok: boolean; modelIds: string[]; message: string }> {
  const key = (apiKey || '').trim();
  if (!key) {
    const message = '请先填写 API Key';
    new Notice(message);
    return { ok: false, modelIds: [], message };
  }
  const base = (baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');

  try {
    let lastStatus = 0;
    for (const url of modelsEndpointCandidates(base)) {
      const res = await requestUrl({
        url,
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        throw: false,
      });
      const ids = await listFromResponse(res);
      if (ids && ids.length > 0) {
        const message = `成功获取 ${ids.length} 个模型：${ids[0]}（${url}）`;
        new Notice(message);
        return { ok: true, modelIds: ids, message };
      }
      lastStatus = res.status;
    }
    const message = `${mapHttpError(lastStatus)}（HTTP ${lastStatus}）`;
    new Notice(message);
    return { ok: false, modelIds: [], message };
  } catch (e) {
    const message = '网络错误：' + ((e as { message?: string })?.message ?? '未知错误');
    new Notice(message);
    return { ok: false, modelIds: [], message };
  }
}

// ---------------------------------------------------------------------------
// Anthropic-compatible chat protocol
// ---------------------------------------------------------------------------

export interface AnthropicChatMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

/**
 * If a chat request landed on the `/anthropic`-supplemented candidate while the
 * configured base URL did not carry an `/anthropic` segment, ask the caller to
 * persist the correction (explicit auto-correct: the user is notified).
 */
function maybeAutoCorrect(base: string, url: string, cb?: (url: string) => void): void {
  if (!cb) return;
  if (hasAnthropicPath(base)) return; // user already configured the /anthropic prefix
  if (!/\/anthropic\/v1\/messages$/i.test(url)) return; // success wasn't the correction candidate
  cb(url);
}

/**
 * Fallback chat request: POST the chat endpoint non-streaming via the
 * module-level `requestUrl` (mobile `requestUrl` cannot parse a chunked SSE
 * body). Probes `chatEndpointCandidates(baseUrl)` in order, so a base that
 * lacks the `/anthropic` prefix is auto-corrected. Returns `{ status, text }`
 * (plus `url`/`requestError` when meaningful); `text` is the full JSON body on
 * 2xx, else readable/truncated to 300 chars so the UI can lean on the status.
 * The caller parses `text` with `parseAnthropicResponse`.
 */
export async function fetchAnthropicMessages(
  settings: { baseUrl: string; apiKey: string; model: string },
  messages: AnthropicChatMessage[],
  opts?: { system?: string; tools?: unknown[]; onAutoCorrect?: (url: string) => void }
): Promise<{ status: number; text: string; url?: string; requestError?: string }> {
  const base = (settings.baseUrl || 'https://api.deepseek.com/anthropic').trim().replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: 4096,
    ...(opts?.system ? { system: opts.system } : {}),
    messages,
    ...(opts?.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
    stream: false,
  };

  const candidates = chatEndpointCandidates(base);
  let lastStatus = 0;
  let lastUrl = '';
  let requestError: string | undefined;

  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    lastUrl = url;
    try {
      const res = await requestUrl({
        url,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        throw: false,
      });
      const status = res.status;
      if (status >= 200 && status < 300) {
        maybeAutoCorrect(base, url, opts?.onAutoCorrect);
        return { status, text: await extractResponseText(res), url };
      }
      lastStatus = status;
      // 404 with a candidate left → the route may be missing its /anthropic prefix.
      if (status === 404 && i < candidates.length - 1) continue;
      // Any other non-2xx (or the last 404): keep the status, expose readable text.
      return { status, text: (await extractResponseText(res)).slice(0, 300), url };
    } catch (e) {
      requestError = (e as { message?: string })?.message ?? '网络错误';
      // A network failure on one candidate shouldn't mask a working sibling.
      if (i < candidates.length - 1) continue;
      return { status: 0, text: '', requestError, url: lastUrl };
    }
  }
  return { status: lastStatus, text: '', url: lastUrl, requestError };
}

/**
 * Primary chat request: native `window.fetch` streaming (works on desktop
 * Electron and mobile WebView; the endpoint's CORS preflight allows the headers
 * below). Reads the SSE body chunk-by-chunk with `res.body.getReader()`,
 * accumulates it, then hands each parsed event to `onEvent` so the UI can re-render
 * incrementally. `opts.signal` supports abort. The endpoint is probed via
 * `chatEndpointCandidates(baseUrl)`: a 404 (missing `/anthropic` prefix) moves
 * to the next candidate while any other failure aborts immediately with
 * `{ ok:false, status?, error?, url? }` so the caller can fall back to
 * `fetchAnthropicMessages`. On a successful `/anthropic` correction the caller
 * is asked (via `opts.onAutoCorrect`) to persist the corrected base URL.
 */
export async function streamAnthropicMessages(
  settings: { baseUrl: string; apiKey: string; model: string },
  messages: AnthropicChatMessage[],
  opts: {
    system?: string;
    tools?: unknown[];
    signal?: AbortSignal;
    onEvent: (event: { event: string; data: unknown }) => void;
    onAutoCorrect?: (url: string) => void;
  }
): Promise<{ ok: boolean; status?: number; error?: string; url?: string; chunks?: number; events?: number }> {
  const base = (settings.baseUrl || 'https://api.deepseek.com/anthropic').trim().replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: 4096,
    ...(opts.system ? { system: opts.system } : {}),
    messages,
    ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
    stream: true,
  };

  const candidates = chatEndpointCandidates(base);
  let lastUrl = '';
  let lastStatus = 0;

  try {
    for (let i = 0; i < candidates.length; i++) {
      const url = (lastUrl = candidates[i]);
      const res = await window.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        // Parse the SSE body incrementally: every closed frame is handed to
        // `onEvent` the moment its blank line arrives, so the UI re-renders per
        // token instead of buffering the whole body (the previous fake-streaming
        // cause of "one big block appears at once").
        let chunks = 0;
        let events = 0;
        const parser = createIncrementalSseParser((ev) => {
          events++;
          opts.onEvent(ev);
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks++;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode()); // flush any residual multi-byte sequence
        parser.flush();
        parser.reset(); // release the incremental parser's buffer after a committed flush
        maybeAutoCorrect(base, url, opts.onAutoCorrect);
        // 2xx with a parseable body must still yield at least one frame; a
        // zero-event stream is a parse failure so the caller falls back to the
        // non-streaming path (contract 10.3).
        if (events > 0) {
          return { ok: true, url, chunks, events };
        }
        return { ok: false, status: res.status, error: '流式响应未解析到事件', url, chunks, events };
      }
      lastStatus = res.status;
      // A missing route (404) may be the missing /anthropic prefix → try the next.
      if (res.status === 404 && i < candidates.length - 1) continue;
      // Any other failure: surface the actual requested URL for diagnosis.
      return { ok: false, status: res.status, error: `HTTP ${res.status} POST ${url}`, url };
    }
  } catch (e) {
    return { ok: false, error: (e as { message?: string })?.message ?? '网络错误', url: lastUrl };
  }

  // All candidates 404 (defensive; the loop returns on its last 404 candidate).
  return { ok: false, status: lastStatus, error: `HTTP ${lastStatus} POST ${lastUrl}`, url: lastUrl };
}

/** Read the raw body text from a `requestUrl` response (Obsidian or mock). */
async function extractResponseText(res: any): Promise<string> {
  if (typeof res?.text === 'string' && res.text) return res.text;
  const j = res?.json;
  if (typeof j === 'string') return j;
  if (typeof j === 'function') {
    const v = await j();
    return typeof v === 'string' ? v : JSON.stringify(v ?? '');
  }
  return String(j ?? '');
}
