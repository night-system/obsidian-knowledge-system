import { stripFrontmatter } from './index';
import type { YamlRule, UpdateYamlRule, NoteTemplateEntry } from '../settings';
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
    /** update_note_yaml allowed-attribute rules (v0.7.0). */
    updateYamlRules?: UpdateYamlRule[];
    /** create_note body template headings (v0.7.0). */
    noteTemplate?: NoteTemplateEntry[];
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
 *
 * v0.7.0: accepts an optional `noteTemplate` that controls the create_note body
 * structure (see `buildCreateNoteTool`). `buildAnthropicTools([])` stays
 * contract-equal to `ANTHROPIC_TOOLS`.
 */
export function buildAnthropicTools(yamlRules?: YamlRule[], noteTemplate?: NoteTemplateEntry[]): AnthropicTool[] {
  const rules = Array.isArray(yamlRules) ? yamlRules : [];
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
    buildCreateNoteTool(rules, noteTemplate),
  ];
}

/**
 * Build the `create_note` schema with the configured YAML rules plus an optional
 * body template. When a template is present (≥1 allowAi heading) the `content`
 * free-text param is replaced by a `sections` object: each key is a template
 * heading the AI may write, each value is the text for that heading, and the
 * headings are marked required. Non-allowAi headings are listed in the
 * description but 「由模板固定，勿写」. With no template the free `content`
 * (v0.5.0) is preserved.
 */
export function buildCreateNoteTool(
  yamlRules?: YamlRule[],
  noteTemplate?: NoteTemplateEntry[]
): AnthropicTool {
  const rules = Array.isArray(yamlRules) ? yamlRules : [];
  // 只暴露「有可选值约束」的键；否则该键对 AI 隐藏（未配置约束规则，AI 不该知道）。
  const exposedRules = rules.filter((r) => r.key && r.values && r.values.length > 0);
  const yamlDesc =
    'frontmatter 键值对对象（YAML frontmatter 区）。项目已配置以下属性规则：' +
    exposedRules.map((r) => `- ${r.key}：${r.desc}（可选值：${r.values.join('/')}）`).join('\n') +
    '\n规则未列出的键名可以随意添加；规则内键名请严格遵守可选值，否则创建会被拒绝。';

  const yamlSchema: any = { type: 'object', description: yamlDesc };
  if (exposedRules.length > 0) {
    const props: Record<string, any> = {};
    for (const r of exposedRules) {
      props[r.key] = {
        type: 'string',
        description: r.desc,
        ...(r.values.length ? { enum: r.values } : {}),
      };
    }
    yamlSchema.properties = props;
    yamlSchema.required = []; // 规则键不强制 AI 填写
  }

  const template = (noteTemplate || [])
    .filter((e) => e && e.title && e.title.trim())
    .map((e) => ({ ...e, title: e.title.trim() }));
  const allowAi = template.filter((e) => e.allowAi);
  const hasTemplate = template.length > 0 && allowAi.length > 0;

  const props: Record<string, any> = {
    title: { type: 'string', description: '文件名（不含 .md 后缀）' },
    yaml: yamlSchema,
  };
  const required = ['title'];

  let description = '在输出文件夹创建一篇新笔记。';
  if (hasTemplate) {
    const lines = template.map((e) => {
      const heading = '#'.repeat(Math.max(1, Math.min(6, e.level))) + ' ' + e.title;
      return e.allowAi ? `- ${heading}（可填写，AI 在此标题下写内容）` : `- ${heading}（由模板固定，勿写）`;
    });
    description +=
      '\n正文按以下模板结构组装，AI 只能在标注「可填写」的标题下写内容（sections 参数）：\n' +
      lines.join('\n');

    const secProps: Record<string, any> = {};
    for (const e of allowAi) {
      secProps[e.title] = {
        type: 'string',
        description: e.desc ? e.desc : `在「${e.title}」下写内容`,
      };
    }
    props.sections = {
      type: 'object',
      description: '按模板标题填写的正文内容；每个键是模板里允许 AI 写的标题，值为该标题下的文字。',
      properties: secProps,
      required: allowAi.map((e) => e.title),
    };
    required.push('sections');
  } else {
    props.content = { type: 'string', description: '正文' };
  }

  return {
    name: 'create_note',
    description,
    input_schema: { type: 'object', properties: props, required },
  };
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
  args: { title?: string; yaml?: unknown; content?: string; sections?: Record<string, string> }
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

  // v0.7.0 模板正文：配置了模板（且至少一个 allowAi 标题）时，按模板顺序组装正文。
  // AI 只能通过 `sections`（{ 标题: 文本 }）填写「允许 AI 写」的标题；不允许 AI 写的
  // 标题（如大标题）由模板固定输出。AI 未提供某 allowAi 节的文本 → 跳过该节。无模板 → 现状。
  const template = (settings.noteTemplate ?? [])
    .filter((e) => e && e.title && e.title.trim())
    .map((e) => ({ ...e, title: e.title.trim() }));
  const allowAi = template.filter((e) => e.allowAi);
  const sections = args?.sections ?? {};
  let body: string;
  if (template.length > 0 && allowAi.length > 0) {
    const parts: string[] = [];
    for (const e of template) {
      const heading = '#'.repeat(Math.max(1, Math.min(6, e.level))) + ' ' + e.title;
      if (e.allowAi) {
        const text = typeof sections[e.title] === 'string' ? String(sections[e.title]) : '';
        if (!text.trim()) continue; // AI 未提供 → 跳过该节
        parts.push(heading + '\n' + text);
      } else {
        parts.push(heading); // 模板固定标题（大标题等）
      }
    }
    body = parts.join('\n\n');
  } else {
    body = `${args?.content ?? ''}`;
  }

  const folder = (settings.outputFolder || '/').trim();
  const name = title.toLowerCase().endsWith('.md') ? title : title + '.md';
  const path = joinVaultPath(folder, name);
  const yamlStr = serializeYamlFromObj(filled);
  const full = yamlStr ? `---\n${yamlStr}\n---\n${body}` : `---\n---\n${body}`;

  await ctx.app.vault.create(path, full);
  return { result: { path } };
}

/**
 * Anthropic schema for `update_note_yaml` (v0.5.0, default NOT exposed). The
 * AI updates a source-folder note's frontmatter keys; other keys are preserved.
 *
 * v0.7.0 阉割版：传入 `updateRules`（来自 settings.updateYamlRules）时，`updates`
 * 的每个 `key` 被约束为规则键（enum），描述含每条规则的解释与可选值；未配置规则
 * （空数组）→ 维持 v0.5.0 现状「任意键」。规则恒来自全局 settings（预设不覆写）。
 */
export function buildUpdateNoteYamlTool(updateRules?: UpdateYamlRule[]): AnthropicTool {
  const rules = (Array.isArray(updateRules) ? updateRules : []).filter((r) => r && r.key && r.key.trim());
  let description = '更新源文件夹内笔记的 frontmatter 属性值（保留其余属性不变）。';
  let updatesDesc = '要更新的 frontmatter 键值对列表；只改这些键，其余键保持不变。';
  let itemsProps: Record<string, any>;
  if (rules.length > 0) {
    const ruleLines = rules
      .map((r) => `- ${r.key}：${r.desc || '（无解释）'}${r.values && r.values.length > 0 ? `（可选值：${r.values.join('/')}）` : ''}`)
      .join('\n');
    description =
      '更新源文件夹内笔记的 frontmatter 属性值（保留其余属性不变）。\n' +
      '只能修改已配置的属性，值必须在允许范围内：\n' +
      ruleLines;
    itemsProps = {
      key: { type: 'string', enum: rules.map((r) => r.key), description: '只允许这些属性键：' + rules.map((r) => r.key).join('/') },
      value: { type: 'string', description: '要写入的值（须在对应属性的允许范围内）' },
    };
  } else {
    itemsProps = { key: { type: 'string' }, value: { type: 'string' } };
  }
  return {
    name: 'update_note_yaml',
    description,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '笔记文件名（可带或不带 .md 后缀）' },
        updates: {
          type: 'array',
          description: updatesDesc,
          items: {
            type: 'object',
            properties: itemsProps,
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

  // v0.7.0 阉割版兜底校验：配置了 updateYamlRules 时，更新键必须在规则键内，
  // 且值必须在该键的可选值内（可选值空 = 任意）。越界 → {error} 不写盘。
  const rules = Array.isArray(settings.updateYamlRules) ? settings.updateYamlRules : [];
  const ruleMap = new Map(rules.filter((r) => r && r.key).map((r) => [r.key, r]));
  if (ruleMap.size > 0) {
    for (const u of updates) {
      const rule = ruleMap.get(u.key);
      if (!rule) {
        return { error: `ERROR: 不允许修改属性"${u.key}"（只允许：[${[...ruleMap.keys()].join(', ')}]）` };
      }
      const v = String(u.value ?? '').trim();
      if (rule.values && rule.values.length > 0 && !rule.values.includes(v)) {
        return { error: `ERROR: 属性"${u.key}"的值"${v}"不在可选值[${rule.values.join(' / ')}]内（${rule.desc}）` };
      }
    }
  }

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
