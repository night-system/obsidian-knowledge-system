import { Notice, requestUrl, TFile, TFolder } from 'obsidian';
import type { App, Command } from 'obsidian';
import { KnowledgeSystemSettings } from './settings';
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

/** Render a short (≤100 char) diagnostic snippet of an HTTP response body. */
function bodySnippet(body: unknown): string {
  if (body == null) return '';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.slice(0, 100);
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
  return countRecent(items, {
    moment: window.moment,
    timeAttr: plugin.settings.timeAttr || '',
    formats: formatsFor(plugin),
    nowMs: Date.now(),
    days: plugin.settings.recentDays,
  });
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
      timestampAttr: plugin.settings.timestampAttr,
      reviewAttr: plugin.settings.reviewAttr,
      reviewDefault: plugin.settings.reviewDefault,
      categoryAttr: plugin.settings.categoryAttr,
      categoryDefault: plugin.settings.categoryDefault,
      sourceAttr: plugin.settings.sourceAttr,
      moment: window.moment,
      timeFormat: plugin.settings.timeFormat,
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

/**
 * Call GET /models on the base URL and return the model ids. Uses Obsidian's
 * module-level `requestUrl` (no fetch / Node http) and reads the response json
 * whether it is already parsed (Obsidian) or a resolver function (test
 * harness). The id list comes exclusively from the API — nothing is hardcoded.
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
    const res = await requestUrl({
      url: `${base}/models`,
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      throw: false,
    });

    const body =
      typeof (res as { json?: unknown }).json === 'function'
        ? await ((res as { json: () => unknown }).json)()
        : (res as { json?: unknown }).json;

    if (res.status >= 200 && res.status < 300) {
      const data = (body as { data?: unknown } | undefined)?.data;
      const modelIds = Array.isArray(data)
        ? data
            .map((m) => (m && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id : ''))
            .filter((x) => x.length > 0)
        : [];
      const message = modelIds.length > 0 ? `成功获取 ${modelIds.length} 个模型：${modelIds[0]}` : '未返回任何模型';
      new Notice(message);
      return { ok: true, modelIds, message };
    }

    const detail = bodySnippet(body);
    const message = detail
      ? `${mapHttpError(res.status)}（HTTP ${res.status}）：${detail}`
      : `${mapHttpError(res.status)}（HTTP ${res.status}）`;
    new Notice(message);
    return { ok: false, modelIds: [], message };
  } catch (e) {
    const message = '网络错误：' + ((e as { message?: string })?.message ?? '未知错误');
    new Notice(message);
    return { ok: false, modelIds: [], message };
  }
}
