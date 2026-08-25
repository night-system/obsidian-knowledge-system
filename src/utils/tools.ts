import { stripFrontmatter } from './index';
import type { YamlRule } from '../settings';
import {
  applyDefaults,
  parseFrontmatterObj,
  parseYamlObject,
  serializeFileWithFrontmatter,
  serializeYamlFromObj,
  validateYamlRules,
} from './yamlRules';

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
    yamlRules?: YamlRule[];
  };
  now?: number;
  moment?: any;
  /** search_output_notes mode (preset-driven); 'full' by default. */
  searchMode?: 'full' | 'restricted';
  /** Whitelisted keys for the restricted search (preset-driven). */
  searchRestrictions?: { key: string; values: string[] }[];
}

/** Shape of one Anthropic-compatible tool in the request. */
export type AnthropicTool = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
};

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

/**
 * Build the Anthropic `tools` schema for the chat request, embedding the
 * configured `create_note` YAML frontmatter rules so the AI sees the allowed
 * keys, their explanations, and the optional enum of allowed values. With no
 * rules the output is identical to the legacy static array.
 */
export function buildAnthropicTools(yamlRules?: YamlRule[]): AnthropicTool[] {
  const rules = Array.isArray(yamlRules) ? yamlRules : [];
  const yamlDesc =
    'frontmatter 键值对对象（YAML frontmatter 区）。项目已配置以下属性规则：' +
    rules
      .map(
        (r) =>
          `- ${r.key}：${r.desc}` +
          (r.values?.length ? `（可选值：${r.values.join('/')}）` : '') +
          (r.default ? `（默认值：${r.default}）` : '')
      )
      .join('\n') +
    '\n规则未列出的键名可以随意添加；规则内键名请严格遵守可选值，否则创建会被拒绝。';

  const yamlSchema: any = { type: 'object', description: yamlDesc };
  if (rules.length > 0) {
    const props: Record<string, any> = {};
    for (const r of rules) {
      if (!r.key) continue;
      props[r.key] = {
        type: 'string',
        description: r.desc,
        ...(r.values?.length ? { enum: r.values } : {}),
      };
    }
    yamlSchema.properties = props;
    yamlSchema.required = []; // 规则键不强制 AI 填写
  }

  return [
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
          yaml: yamlSchema,
          content: { type: 'string', description: '正文' },
        },
        required: ['title'],
      },
    },
  ];
}

/** Anthropic `tools` schema for the chat request (no YAML rules by default). */
export const ANTHROPIC_TOOLS: AnthropicTool[] = buildAnthropicTools([]);

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

/** Serialize an object/string into YAML frontmatter body lines (kept for import compat). */
export function serializeYaml(yaml: unknown): string {
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

  const rules = settings.yamlRules ?? [];
  const obj = parseYamlObject(args?.yaml);
  const err = validateYamlRules(obj, rules);
  if (err) return { error: err }; // 校验失败：不落盘，错误回给 AI

  const moment = ctx.moment ?? (typeof window !== 'undefined' ? window.moment : null);
  const filled = applyDefaults(obj, rules, { moment, now: ctx.now });

  const folder = (settings.outputFolder || '/').trim();
  const name = title.toLowerCase().endsWith('.md') ? title : title + '.md';
  const path = joinVaultPath(folder, name);
  const yamlStr = serializeYamlFromObj(filled);
  const body = `${args?.content ?? ''}`;
  const full = yamlStr ? `---\n${yamlStr}\n---\n${body}` : `---\n---\n${body}`;

  await ctx.app.vault.create(path, full);
  return { result: { path } };
}

/**
 * Anthropic schema for `update_note_yaml` (v0.5.0, default NOT exposed). The
 * AI updates a source-folder note's frontmatter keys; other keys are preserved.
 */
export function buildUpdateNoteYamlTool(): AnthropicTool {
  return {
    name: 'update_note_yaml',
    description: '更新源文件夹内笔记的 frontmatter 属性值（保留其余属性不变）。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '笔记文件名（可带或不带 .md 后缀）' },
        updates: {
          type: 'array',
          description: '要更新的 frontmatter 键值对列表；只改这些键，其余键保持不变。',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
          },
        },
      },
      required: ['name', 'updates'],
    },
  };
}

/**
 * Anthropic schema for `search_output_notes` (v0.5.0). In `restricted` mode the
 * `filters` object exposes only the whitelisted keys (with enum when provided)
 * and `query` is omitted; in `full` mode `filters` is an arbitrary key-value
 * array plus a free-text `query`.
 */
export function buildSearchOutputNotesTool(
  searchMode?: 'full' | 'restricted',
  restrictions?: { key: string; values: string[] }[]
): AnthropicTool {
  const restricted = searchMode === 'restricted';
  let filtersSchema: any;
  if (restricted) {
    const allowed = Array.isArray(restrictions) ? restrictions : [];
    const props: Record<string, any> = {};
    for (const r of allowed) {
      if (!r.key) continue;
      props[r.key] =
        r.values && r.values.length > 0
          ? { type: 'string', enum: r.values, description: `只允许这些值：${r.values.join('/')}` }
          : { type: 'string' };
    }
    filtersSchema = {
      type: 'object',
      description: '只能按这些键搜索（值为包含匹配、大小写不敏感）：' + allowed.map((r) => r.key).join('、'),
      properties: props,
      required: [],
    };
  } else {
    filtersSchema = {
      type: 'array',
      description: '按 frontmatter 键值对过滤；值为包含匹配（子串、大小写不敏感）。',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, value: { type: 'string' } },
        required: ['key', 'value'],
      },
    };
  }
  const properties: Record<string, any> = { filters: filtersSchema };
  if (!restricted) {
    properties.query = { type: 'string', description: '文件名或正文包含的子串（大小写不敏感）。' };
  }
  properties.limit = { type: 'integer', description: '返回条数上限，默认 20，最大 100。' };
  return {
    name: 'search_output_notes',
    description:
      '在输出文件夹内搜索笔记；filters 的值为包含匹配（子串、大小写不敏感）；query 为正文/文件名子串；limit 默认 20 最大 100。',
    input_schema: { type: 'object', properties, required: [] },
  };
}

export async function updateNoteYamlTool(
  ctx: ToolCtx,
  args: { name?: string; updates?: { key: string; value: string }[] }
): Promise<{ result: { path: string; updated: string[] } } | { error: string }> {
  const settings = ctx.settings;
  const zeit = ctx.moment ?? (typeof window !== 'undefined' ? window.moment : null);
  const folder = (settings.sourceFolder || '/').trim();
  const target = stripExt((args?.name || '').trim());
  if (!target) return { error: 'ERROR: 未提供文件名' };

  const updates = (args?.updates ?? [])
    .filter((u) => u && u != null && typeof (u as { key?: unknown })?.key === 'string' && typeof (u as { value?: unknown })?.value === 'string');
  if (updates.length === 0) return { error: 'ERROR: 未提供要更新的键值对' };

  const files = (ctx.app.vault.getMarkdownFiles?.() ?? []) as VaultFile[];
  const match = files.find(
    (f) => inFolder(f.path, folder) && stripExt(f.basename ?? f.name ?? f.path) === target
  );
  if (!match) return { error: 'ERROR: 未找到笔记' };

  const ts = fileTimestamp(match, ctx);
  const earliest = parseEarliest(settings.earliestTime ?? '', settings.timeFormat ?? '', zeit);
  if (earliest != null && ts < earliest) return { error: `ERROR: 笔记早于最早时间 ${settings.earliestTime}` };

  const raw = await ctx.app.vault.read(match);
  const fm = parseFrontmatterObj(raw);
  for (const u of updates) fm[u.key] = u.value;
  const newContent = serializeFileWithFrontmatter(raw, fm);
  await ctx.app.vault.adapter.write(match.path, newContent);
  return { result: { path: match.path, updated: updates.map((u) => u.key) } };
}

export async function searchOutputNotesTool(
  ctx: ToolCtx,
  args: { filters?: { key: string; value: string }[]; query?: string; limit?: number }
): Promise<
  | { result: { path: string; title: string; frontmatter?: Record<string, unknown>; summary?: string }[] }
  | { error: string }
> {
  const settings = ctx.settings;
  const folder = (settings.outputFolder || '/').trim();
  const filters = Array.isArray(args?.filters) ? (args!.filters as { key: string; value: string }[]) : [];
  const query = typeof args?.query === 'string' ? args.query : '';
  let limit = typeof args?.limit === 'number' ? Math.floor(args.limit) : 20;
  if (!Number.isFinite(limit) || limit <= 0) limit = 20;
  if (limit > 100) limit = 100;

  // 阉割版约束校验：restricted 模式只允许白名单键（schema 已限定，此处再兜底校验）。
  const restricted = ctx.searchMode === 'restricted';
  const allowedKeys = new Set((ctx.searchRestrictions ?? []).map((r) => r.key));
  if (restricted) {
    for (const f of filters) {
      if (!allowedKeys.has(f.key)) {
        return { error: `ERROR: 搜索只能使用允许的键[${[...allowedKeys].join(', ')}]` };
      }
    }
  }

  const files = (ctx.app.vault.getMarkdownFiles?.() ?? []) as VaultFile[];
  const q = query.toLowerCase();
  const results: { path: string; title: string; frontmatter: Record<string, unknown>; summary: string }[] = [];
  for (const f of files) {
    if (!inFolder(f.path, folder)) continue;
    const raw = await ctx.app.vault.read(f);
    const fm = parseFrontmatterObj(raw);
    const body = stripFrontmatter(raw);
    let hit = filters.length === 0;
    for (const flt of filters) {
      const v = fm[flt.key];
      if (v == null || !String(v).toLowerCase().includes(String(flt.value).toLowerCase())) {
        hit = false;
        break;
      }
      hit = true;
    }
    if (!hit) continue;
    if (q) {
      const nameHit = (f.basename ?? f.name ?? f.path).toLowerCase().includes(q);
      const bodyHit = body.toLowerCase().includes(q);
      if (!nameHit && !bodyHit) continue;
    }
    results.push({
      path: f.path,
      title: stripExt(f.basename ?? f.name ?? f.path),
      frontmatter: fm,
      summary: [...body].slice(0, 200).join(''),
    });
    if (results.length >= limit) break;
  }
  return { result: results };
}
