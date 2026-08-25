import { App, Command, Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import { KnowledgeSystemSettings } from './settings';

/**
 * Structural view of the plugin that the domain functions need. Defined here
 * so `core`, `commands`, `settingsTab` and `main` can all agree on it without
 * creating a circular import between modules.
 */
export interface KnowledgeSystemPlugin {
  app: App;
  settings: KnowledgeSystemSettings;
  saveSettings(): Promise<void>;
  addCommand(command: Command): Command;
}

/** Fallback moment formats tried when the configured format fails to parse. */
const FALLBACK_FORMATS = ['YYYY-MM-DD', 'YYYY.MM.DD', 'YYYY/MM/DD'];

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Folders & file discovery
// ---------------------------------------------------------------------------

/** Resolve the configured source folder. Falls back to the vault root. */
export function resolveSourceFolder(plugin: KnowledgeSystemPlugin): TFolder {
  const raw = (plugin.settings.sourceFolder || '/').trim();
  const path = raw === '/' || raw === '' ? '' : raw.replace(/^\/+|\/+$/g, '');
  const found = path ? plugin.app.vault.getAbstractFileByPath(path) : plugin.app.vault.getRoot();
  return found instanceof TFolder ? found : plugin.app.vault.getRoot();
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
// Timestamp resolution
// ---------------------------------------------------------------------------

function frontmatterOf(app: App, file: TFile): Record<string, unknown> {
  const cache = app.metadataCache.getFileCache(file);
  return (cache?.frontmatter ?? {}) as Record<string, unknown>;
}

/**
 * Parse a frontmatter value into a unix millisecond timestamp. Strings are
 * parsed with the configured format first (strict), then a set of fallback
 * formats, mirroring the spec. Numbers are treated as a timestamp. Returns
 * `null` when the value cannot be interpreted.
 */
export function tryParseTimestamp(value: unknown, format: string): number | null {
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    const formats = [format, ...FALLBACK_FORMATS].filter(
      (f, i, arr) => !!f && arr.indexOf(f) === i
    );
    for (const f of formats) {
      const m = window.moment(s, f, true);
      if (m && m.isValid()) return m.valueOf();
    }
    return null;
  }
  if (typeof value === 'number') {
    // Large values are already milliseconds; smaller ones look like seconds.
    return value > 1e12 ? value : value * 1000;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return null;
}

/**
 * The per-file timestamp used for both commands: the configured frontmatter
 * property when present and parseable, otherwise the file creation time.
 */
export function resolveTimestampMs(plugin: KnowledgeSystemPlugin, file: TFile): number {
  const prop = (plugin.settings.timePropertyName || '').trim();
  if (prop) {
    const value = frontmatterOf(plugin.app, file)[prop];
    if (value !== undefined && value !== null) {
      const ts = tryParseTimestamp(value, plugin.settings.timeFormat);
      if (ts !== null) return ts;
    }
  }
  return file.stat.ctime;
}

// ---------------------------------------------------------------------------
// Command 1: count recent files
// ---------------------------------------------------------------------------

/** Number of Markdown files whose timestamp falls within the last N days. */
export function countRecentFiles(plugin: KnowledgeSystemPlugin): number {
  const folder = resolveSourceFolder(plugin);
  const files = getMarkdownFilesInFolder(folder);
  const days = Math.max(1, Math.floor(plugin.settings.recentDays || 7));
  const cutoff = Date.now() - days * DAY_MS;
  let count = 0;
  for (const file of files) {
    if (resolveTimestampMs(plugin, file) >= cutoff) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Command 2: output the latest file's last 100 characters
// ---------------------------------------------------------------------------

/** Quote a frontmatter scalar so it round-trips as a string. */
function yamlScalar(value: string): string {
  const s = value ?? '';
  if (
    s === '' ||
    /[\s:{}[\]"',#&*!|>%@`\\]/.test(s) ||
    /^[\d.+-]+$/.test(s) ||
    /^(true|false|null|yes|no|on|off)$/i.test(s) ||
    /^\d{4}-\d{2}-\d{2}/.test(s)
  ) {
    return JSON.stringify(s);
  }
  return s;
}

/** Join an output folder with a file name and normalize the result. */
function joinOutputPath(folder: string, name: string): string {
  const raw = (folder || '/').trim();
  const base = raw === '/' || raw === '' ? '' : raw.replace(/^\/+|\/+$/g, '');
  return normalizePath(base ? `${base}/${name}` : name);
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
 * Find the Markdown file with the newest timestamp in the source folder and
 * write a new file containing its last 100 characters. Does not call any LLM.
 * Returns the created file's vault-relative path.
 */
export async function outputLatestContent(plugin: KnowledgeSystemPlugin): Promise<string> {
  const folder = resolveSourceFolder(plugin);
  const files = getMarkdownFilesInFolder(folder);
  if (files.length === 0) {
    new Notice('源文件夹中没有可用的 Markdown 文件');
    return '';
  }

  let latest = files[0];
  let latestTs = resolveTimestampMs(plugin, latest);
  for (const file of files) {
    const ts = resolveTimestampMs(plugin, file);
    if (ts > latestTs) {
      latestTs = ts;
      latest = file;
    }
  }

  const body = await plugin.app.vault.read(latest);
  // Count unicode code points, not UTF-16 units, and keep trailing newlines.
  const last100 = Array.from(body).slice(-100).join('');
  const now = window.moment();
  const nowStr = now.format(plugin.settings.timeFormat);

  const frontmatter = [
    `${plugin.settings.timestampProperty}: ${yamlScalar(nowStr)}`,
    `${plugin.settings.reviewStatusProperty}: ${yamlScalar(plugin.settings.reviewStatusValue)}`,
    `${plugin.settings.categoryProperty}: ${yamlScalar(plugin.settings.categoryValue)}`,
    `source: ${yamlScalar(latest.path)}`,
  ].join('\n');

  // Milliseconds (SSS) avoid a name collision when the command runs twice in a row.
  const fileName = `${latest.basename}-最新内容-${now.format('YYYYMMDD-HHmmss-SSS')}.md`;
  const outPath = joinOutputPath(plugin.settings.outputFolder, fileName);

  await ensureFolderExists(plugin.app, plugin.settings.outputFolder);
  await plugin.app.vault.create(outPath, `---\n${frontmatter}\n---\n${last100}`);

  new Notice(`已输出：${outPath}`);
  return outPath;
}

// ---------------------------------------------------------------------------
// Settings tab: "test and fetch models"
// ---------------------------------------------------------------------------

/** Map a DeepSeek / OpenAI-compatible HTTP status to a readable message. */
function mapHttpError(status: number): string {
  if (status === 401 || status === 403) return 'API Key 无效';
  if (status === 402) return '余额不足';
  if (status === 429) return '限流';
  return `请求失败（HTTP ${status}）`;
}

/**
 * Call GET /models on the configured base URL and return the available model
 * ids. Uses Obsidian's cross-platform `requestUrl` (no fetch / Node http). The
 * list of models comes exclusively from the API — nothing is hardcoded.
 */
export async function fetchDeepSeekModels(
  plugin: KnowledgeSystemPlugin
): Promise<{ ok: boolean; models: string[]; message: string }> {
  const apiKey = (plugin.settings.apiKey || '').trim();
  if (!apiKey) {
    const message = '请先填写 API Key';
    new Notice(message);
    return { ok: false, models: [], message };
  }

  const base = (plugin.settings.baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');

  try {
    const res = await requestUrl({
      url: `${base}/models`,
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      throw: false,
    });

    if (res.status >= 200 && res.status < 300) {
      const data = (res.json as { data?: unknown })?.data;
      const models = Array.isArray(data)
        ? data
            .map((m) => (m && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id : ''))
            .filter((x) => x.length > 0)
        : [];
      const message = models.length > 0 ? `成功获取 ${models.length} 个模型` : '未返回任何模型';
      new Notice(message);
      return { ok: true, models, message };
    }

    const message = mapHttpError(res.status);
    new Notice(message);
    return { ok: false, models: [], message };
  } catch (e) {
    const message = '网络错误：' + ((e as { message?: string })?.message ?? '未知错误');
    new Notice(message);
    return { ok: false, models: [], message };
  }
}
