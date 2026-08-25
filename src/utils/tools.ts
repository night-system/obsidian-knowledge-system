import { stripFrontmatter } from './index';

/**
 * Anthropic-compatible built-in tools: pure validation / mat[]ching / YAML
 * stripping / path-safety helpers. They accept a duck-typed `ctx` of
 * `{ app, settings, now?, moment? }` and only reach `app.vault` /
 * `app.metadataCache` with Obsidian-native methods, so they can be unit-tested
 * in Node with an in-memory mock. Out-of-contract inputs never throw — they
 * return `{ error }` for the model to read.
 */

export interface ToolCtx {
  app: any;
  settings: {
    sourceFolder?: string;
    outputFolder?: string;
    timeAttr?: string;
    timeFormat?: string;
    recentDays?: number;
    earliestTime?: string;
  };
  now?: number;
  moment?: any;
}

/** Duck-typed shape of an Obsidian `TFile` (the harness uses a plain object). */
interface VaultFile {
  path: string;
  basename?: string;
  name?: string;
  extension?: string;
  stat?: { ctime: number; mtime: number };
  frontmatter?: Record<string, unknown>;
}

const DAY_MS = 86_400_000;
const FALLBACK_FORMATS = ['YYYY-MM-DD', 'YYYY.MM.DD', 'YYYY/MM/DD'];

/** Anthropic `tools` schema for the chat request. */
export const ANTHROPIC_TOOLS = [
  {
    name: 'list_recent_notes',
    description: '列出源文件夹内最近 N 天的 Markdown 笔记（标题 + 时间）。',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: '回看天数；缺省用设置的最近 N 天' } },
      required: [],
    },
  },
  {
    name: 'read_note',
    description: '读取源文件夹内某篇笔记的正文（去除 YAML frontmatter）。',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: '笔记文件名（可带或不带 .md 后缀）' } },
      required: ['name'],
    },
  },
  {
    name: 'create_note',
    description: '在输出文件夹创建一篇新笔记。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文件名（不含 .md 后缀）' },
        yaml: { type: 'object', description: 'frontmatter 键值对' },
        content: { type: 'string', description: '正文' },
      },
      required: ['title'],
    },
  },
];

/** Strip the trailing `.md` extension. */
function stripExt(name: string): string {
  return (name || '').replace(/\.md$/i, '');
}

/** Whether a file path lives under the given vault folder ('/' = anywhere). */
function inFolder(path: string, folder: string): boolean {
  const f = (folder || '/').trim();
  if (f === '/' || f === '') return true;
  return path.startsWith(f + '/');
}

/** Parse the configured earliest time (empty = no limit). */
function parseEarliest(value: string, format: string, zeit: any): number | null {
  const s = (value || '').trim();
  if (!s) return null;
  const m = zeit(s, format, true);
  if (m && typeof m.isValid === 'function' && m.isValid()) return m.valueOf();
  return null;
}

/** A file's timestamp: configured frontmatter attribute, then ctime. */
function fileTimestamp(file: any, ctx: ToolCtx): number {
  const settings = ctx.settings;
  const zeit = ctx.moment ?? (typeof window !== 'undefined' ? window.moment : null);
  const prop = (settings.timeAttr || '').trim();
  const fm = ctx.app.metadataCache.getFileCache(file)?.frontmatter ?? file?.frontmatter ?? {};
  if (prop && fm && fm[prop] != null) {
    const formats = [settings.timeFormat, ...FALLBACK_FORMATS].filter(
      (f, i, arr) => !!f && arr.indexOf(f) === i
    );
    for (const format of formats) {
      const m = zeit(String(fm[prop]), format, true);
      if (m && typeof m.isValid === 'function' && m.isValid()) return m.valueOf();
    }
  }
  return file?.stat?.ctime ?? 0;
}

/** Reject path-traversal / absolute / multi-segment titles. */
function isValidFilename(title: string): boolean {
  const t = (title || '').trim();
  if (!t) return false;
  if (t === '.' || t === '..') return false;
  if (/[/\\]/.test(t)) return false;
  if (/\.\./.test(t)) return false;
  if (/^[A-Za-z]:/.test(t)) return false;
  if (/^\//.test(t)) return false;
  return true;
}

/** Join an output folder with a file name (normalize duplicate slashes). */
function joinVaultPath(folder: string, name: string): string {
  const base = ((folder || '/').trim() === '/' ? '' : (folder || '').trim().replace(/^\/+|\/+$/g, ''));
  return (base ? base + '/' + name : name).replace(/\/+/g, '/').replace(/^\/+/, '');
}

/** Serialize an object/string into YAML frontmatter body lines. */
function serializeYaml(yaml: unknown): string {
  if (yaml == null) return '';
  if (typeof yaml === 'string') return yaml.trim().replace(/^\n+|\n+$/g, '');
  if (typeof yaml === 'object') {
    return Object.entries(yaml as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${v == null ? '' : v}`)
      .join('\n');
  }
  return '';
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

export async function listRecentNotesTool(
  ctx: ToolCtx,
  args: { days?: number }
): Promise<{ result: { title: string; timestamp: number }[] } | { error: string }> {
  const settings = ctx.settings;
  const now = ctx.now ?? Date.now();
  const zeit = ctx.moment ?? (typeof window !== 'undefined' ? window.moment : null);
  const days = typeof args?.days === 'number' ? args.days : (settings.recentDays ?? 7);
  const folder = (settings.sourceFolder || '/').trim();
  const earliest = parseEarliest(settings.earliestTime ?? '', settings.timeFormat ?? '', zeit);

  const files = (ctx.app.vault.getMarkdownFiles?.() ?? []) as VaultFile[];
  const entries = files
    .filter((f) => inFolder(f.path, folder))
    .map((f) => ({ f, ts: fileTimestamp(f, ctx), ctime: f?.stat?.ctime ?? 0 }));

  if (earliest != null && entries.some((e) => e.ts < earliest)) {
    return { error: `ERROR: 快照更早于最早时间 ${settings.earliestTime}` };
  }

  const cutoff = Math.max(now - Math.max(1, Math.floor(days)) * DAY_MS, earliest ?? -Infinity);
  const recent = entries.filter((e) => e.ts >= cutoff);
  recent.sort((a, b) => (b.ts - a.ts) || (a.ctime - b.ctime));

  return {
    result: recent.map((e) => ({ title: stripExt(e.f.basename ?? e.f.name ?? e.f.path), timestamp: e.ts })),
  };
}

export async function readNoteTool(
  ctx: ToolCtx,
  args: { name?: string }
): Promise<{ result: { title: string; content: string } } | { error: string }> {
  const settings = ctx.settings;
  const zeit = ctx.moment ?? (typeof window !== 'undefined' ? window.moment : null);
  const folder = (settings.sourceFolder || '/').trim();
  const target = stripExt((args?.name || '').trim());
  if (!target) return { error: 'ERROR: 未提供文件名' };

  const files = (ctx.app.vault.getMarkdownFiles?.() ?? []) as VaultFile[];
  const match = files.find(
    (f) => inFolder(f.path, folder) && stripExt(f.basename ?? f.name ?? f.path) === target
  );
  if (!match) return { error: 'ERROR: 未找到笔记' };

  const ts = fileTimestamp(match, ctx);
  const earliest = parseEarliest(settings.earliestTime ?? '', settings.timeFormat ?? '', zeit);
  if (earliest != null && ts < earliest) return { error: `ERROR: 笔记早于最早时间 ${settings.earliestTime}` };

  const raw = await ctx.app.vault.read(match);
  return { result: { title: stripExt(match.basename ?? match.name ?? match.path), content: stripFrontmatter(raw) } };
}

export async function createNoteTool(
  ctx: ToolCtx,
  args: { title?: string; yaml?: unknown; content?: string }
): Promise<{ result: { path: string } } | { error: string }> {
  const settings = ctx.settings;
  const title = (args?.title || '').trim();
  if (!isValidFilename(title)) return { error: 'ERROR: 非法文件名' };

  const folder = (settings.outputFolder || '/').trim();
  const name = title.toLowerCase().endsWith('.md') ? title : title + '.md';
  const path = joinVaultPath(folder, name);
  const yamlStr = serializeYaml(args?.yaml);
  const body = `${args?.content ?? ''}`;
  const full = yamlStr ? `---\n${yamlStr}\n---\n${body}` : `---\n---\n${body}`;

  await ctx.app.vault.create(path, full);
  return { result: { path } };
}
