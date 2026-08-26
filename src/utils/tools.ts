import { stripFrontmatter } from './index';
import type { YamlRule, UpdateYamlRule, NoteTemplateEntry } from '../settings';
import {
  applyDefaults,
  applyFixedDefaults,
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
    /** create_note/modify_output_note*: 限制 yaml 键必须在 yamlRules 内（v0.8.0）。 */
    createRestrictYaml?: boolean;
    /** modify_output_note_versioned 归档文件后缀（v0.8.0）。 */
    modifyVersionSuffix?: string;
    /** modify_output_note_versioned 版本号属性名（v0.8.0）。 */
    modifyVersionProperty?: string;
    /** modify_output_note_versioned 归档 bool 属性名（v0.8.0）。 */
    modifyArchiveProperty?: string;
    /** modify_output_note* 独立 yaml 规则（v0.8.2，与 create 的 yamlRules 分开）。 */
    modifyYamlRules?: YamlRule[];
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
export function buildAnthropicTools(
  yamlRules?: YamlRule[],
  noteTemplate?: NoteTemplateEntry[],
  options?: { createRestrictYaml?: boolean }
): AnthropicTool[] {
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
    buildCreateNoteTool(rules, noteTemplate, options),
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
/**
 * 构建 `create_note` / `modify_output_note*` 共用的 yaml 属性 schema 与描述：
 * 只暴露「有可选值约束」的键（否则该键对 AI 隐藏）；`restrictYaml` 开启时描述加
 * 「只能使用已配置的属性」提示。`rejectWord` 控制越界时的措辞（创建/修改）。
 */
function buildYamlSchema(rules: YamlRule[], restrictYaml: boolean, rejectWord: string): { yamlSchema: any; yamlDesc: string } {
  const exposedRules = rules.filter((r) => r.key && r.values && r.values.length > 0);
  const yamlDesc =
    'frontmatter 键值对对象（YAML frontmatter 区）。' +
    (restrictYaml
      ? '只能使用已配置的属性（下面的属性规则）——规则未列出的键名不允许使用。'
      : '项目已配置以下属性规则：') +
    exposedRules.map((r) => `- ${r.key}：${r.desc}（可选值：${r.values.join('/')}）`).join('\n') +
    (restrictYaml
      ? (exposedRules.length > 0 ? `\n规则内键名请严格遵守可选值，否则会被拒绝。` : '')
      : `\n规则未列出的键名可以随意添加；规则内键名请严格遵守可选值，否则${rejectWord}会被拒绝。`);
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
  return { yamlSchema, yamlDesc };
}

export function buildCreateNoteTool(
  yamlRules?: YamlRule[],
  noteTemplate?: NoteTemplateEntry[],
  options?: { createRestrictYaml?: boolean }
): AnthropicTool {
  const rules = Array.isArray(yamlRules) ? yamlRules : [];
  const restrictYaml = options?.createRestrictYaml === true;
  const { yamlSchema } = buildYamlSchema(rules, restrictYaml, '创建');

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
    // v0.8.0：非 allowAi 标题完全不对 AI 暴露（不使用「勿写」标记列出），
    // 顶部说明正文结构由系统模板固定，并明确禁止 AI 创建任何 `#` 标题。
    description +=
      '\n正文结构由系统模板固定，AI 只需填写以下各节内容，禁止以 # 符号创建任何标题。';
    const lines = allowAi.map((e) => {
      const heading = '#'.repeat(Math.max(1, Math.min(6, e.level))) + ' ' + e.title;
      return `- ${heading}（可填写，AI 在此标题下写内容）`;
    });
    description +=
      '\n可填写的各节（sections 参数）：\n' +
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

// ---------------------------------------------------------------------------
// shared helpers (v0.8.0): yaml 白名单约束、`#` 标题检测、正文标题结构修改
// ---------------------------------------------------------------------------

/** 某段文本是否有以 `# ` 起始的 markdown 标题行（`#` + 空格 = 任何级别标题）。 */
function hasHeadingStart(text: string): boolean {
  return /^#\s/m.test(text || '');
}

/**
 * 校验 AI 提供的 yaml 键值对：`restrictYaml` 开启时，键必须在 `yamlRules` 键集内
 * （规则外键 → 错误，不落盘）；随后再按 `validateYamlRules` 校验每个规则键的值
 * （可选值空 = 任意）。返回 `null` 表示通过，否则返回给 AI 看的 `ERROR:` 中文消息。
 */
function validateAiYaml(obj: Record<string, unknown>, rules: YamlRule[], restrictYaml: boolean): string | null {
  if (restrictYaml) {
    const ruleKeys = (rules || []).filter((r) => r && r.key).map((r) => r.key);
    const allowed = new Set(ruleKeys);
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) {
        return `ERROR: 不允许使用未配置的属性"${k}"（只能使用：[${ruleKeys.join(', ')}]）`;
      }
    }
  }
  return validateYamlRules(obj, rules);
}

/** 在输出文件夹内按「去 .md 后缀的文件名」找文件；找不到返回 null。 */
function findOutputFile(ctx: ToolCtx, folder: string, target: string): VaultFile | null {
  const files = (ctx.app.vault.getMarkdownFiles?.() ?? []) as VaultFile[];
  return files.find(
    (f) => inFolder(f.path, folder) && stripExt(f.basename ?? f.name ?? f.path) === target
  ) ?? null;
}

/** 解析正文里所有 markdown 标题（`^#{1,6} `），带行号/级别/文本。 */
function parseBodyHeadings(body: string): { lineIndex: number; level: number; text: string }[] {
  const lines = body.split('\n');
  const headings: { lineIndex: number; level: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m) headings.push({ lineIndex: i, level: m[1].length, text: (m[2] || '').trim() });
  }
  return headings;
}

/**
 * 对正文应用 `sections`（{ 标题文本: 新内容 }）：每个键必须命中原文**已存在**的标题，
 * 用新内容替换该标题下的文字（直到下一个同级别或更高级标题），标题行与后续标题行保持不动。
 * 键不存在 → `{ error }`；任一节文本含 `# ` 开头行 → `{ error }`；全部校验通过才返回新正文。
 */
function applySectionsToBody(
  body: string,
  sections: Record<string, string>
): { result: string } | { error: string } {
  const keys = Object.keys(sections || {});
  if (keys.length === 0) return { result: body };

  const lines = body.split('\n');
  const headings = parseBodyHeadings(body);
  const firstByText = new Map<string, number>();
  for (const h of headings) if (!firstByText.has(h.text)) firstByText.set(h.text, h.lineIndex);

  const replacements: { start: number; end: number; text: string; key: string }[] = [];
  for (const [key, value] of Object.entries(sections)) {
    if (typeof value !== 'string') return { error: `ERROR: 节"${key}"的内容必须是字符串` };
    if (hasHeadingStart(value)) return { error: 'ERROR: 禁止在正文中创建标题（# 开头）' };
    const start = firstByText.get(key);
    if (start == null) {
      return { error: `ERROR: 原文中不存在此标题"${key}"，只能修改已存在的标题下的内容` };
    }
    const level = headings.find((h) => h.lineIndex === start)!.level;
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
      const m = lines[j].match(/^(#{1,6})\s+(.*)$/);
      if (m && m[1].length <= level) { end = j; break; }
    }
    replacements.push({ start, end, text: value, key });
  }

  // 从下往上替换，保证行号在分批重写时保持有效。
  replacements.sort((a, b) => b.start - a.start);
  let out = lines;
  for (const r of replacements) {
    const before = out.slice(0, r.start + 1); // 保留标题行
    const after = out.slice(r.end);           // 保留下一个标题开始处
    const valueLines = r.text === '' ? [] : r.text.split('\n');
    out = [...before, ...valueLines, ...after];
  }
  return { result: out.join('\n') };
}

/**
 * 归档文件里一个版本块（v0.8.1 新格式）：
 *   `# 版本 <N>`（一级标题）
 *   `# 属性`（一级标题）+ 每行 `key: value`（yaml 属性，**强制含当前版本号**，
 *   不再复制 `---` frontmatter 围栏）
 *   + 该版本正文。
 * `versionProperty` 为原文件版本属性名（用户配置）：块内强制写入 `version: N`，
 * 使每个版本块自包含版本号（修复「块 N 记录的是修改前状态导致版本号错位」）。
 */
function buildArchiveBlock(version: number, fm: Record<string, unknown>, body: string, versionProperty: string): string {
  const props: Record<string, unknown> = { ...(fm ?? {}) };
  props[versionProperty] = version; // 强制写入当前版本号
  const yamlStr = serializeYamlFromObj(props);
  return `# 版本 ${version}\n\n# 属性\n${yamlStr}\n\n${body}`;
}

/**
 * 从归档文件内容解析「最新版本号」：统计所有 `# 版本 <N>`（一级标题）的块，
 * 取最大 N；无有效版本块 → 0。
 */
function latestVersionFromArchive(content: string): number {
  const lines = (content || '').split('\n');
  let max = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^# 版本[ \t]+(\d+)[ \t]*$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max;
}

export async function createNoteTool(
  ctx: ToolCtx,
  args: { title?: string; yaml?: unknown; content?: string; sections?: Record<string, string> }
): Promise<{ result: { path: string } } | { error: string }> {
  const settings = ctx.settings;
  const title = (args?.title || '').trim();
  if (!isValidFilename(title)) return { error: 'ERROR: 非法文件名' };

  const rules = settings.yamlRules ?? [];
  const restrictYaml = settings.createRestrictYaml === true;
  const obj = parseYamlObject(args?.yaml);
  const err = validateAiYaml(obj, rules, restrictYaml);
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
    // v0.8.0：检测 AI 各节文本是否以 `# ` 开头（创建标题），有 → 拒绝不落盘。
    for (const e of allowAi) {
      const text = typeof sections[e.title] === 'string' ? String(sections[e.title]) : '';
      if (hasHeadingStart(text)) return { error: 'ERROR: 禁止在正文中创建标题（# 开头）' };
    }
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
      '在输出文件夹内搜索笔记，只返回匹配的标题（path + title）；需要正文全文请用 read_output_note。' +
      'filters 的值为包含匹配（子串、大小写不敏感）；query 为正文/文件名子串；limit 默认 20 最大 100。',
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
): Promise<{ result: { path: string; title: string }[] } | { error: string }> {
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
  const results: { path: string; title: string }[] = [];
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
    // v0.8.0：只返回标题，不再贴出 frontmatter/正文全文（需要全文用 read_output_note）。
    results.push({
      path: f.path,
      title: stripExt(f.basename ?? f.name ?? f.path),
    });
    if (results.length >= limit) break;
  }
  return { result: results };
}

/**
 * Anthropic schema for `modify_output_note` (v0.8.0): 覆盖修改输出文件夹内已有
 * 笔记。`sections` 的键必须是原文中已存在的标题文本（动态，用 additionalProperties），
 * 值 = 该标题下要写入的新内容；yaml 受 yamlRules/createRestrictYaml 约束（同 create_note）。
 */
export function buildModifyOutputNoteTool(
  yamlRules?: YamlRule[],
  options?: { createRestrictYaml?: boolean }
): AnthropicTool {
  const rules = Array.isArray(yamlRules) ? yamlRules : [];
  const restrictYaml = options?.createRestrictYaml === true;
  const { yamlSchema } = buildYamlSchema(rules, restrictYaml, '修改');
  return {
    name: 'modify_output_note',
    description:
      '在输出文件夹内覆盖修改一篇已有笔记的正文与 frontmatter。' +
      'sections 的键必须是原文中已存在的标题文本（值=该标题下要写入的新内容）：' +
      '只能修改标题下的文字，不能修改标题文字或新增标题，禁止以 # 符号创建任何标题。' +
      'frontmatter 只能使用已配置的属性（若开启限制）。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '输出文件夹内笔记文件名（可带或不带 .md 后缀）' },
        sections: {
          type: 'object',
          description: '要修改的正文各节：键=原文中已存在的标题文本，值=该标题下要写入的新内容；键必须与原文标题完全一致，否则会被拒绝。',
          additionalProperties: { type: 'string' },
          required: [],
        },
        yaml: yamlSchema,
      },
      required: ['name'],
    },
  };
}

/**
 * Anthropic schema for `modify_output_note_versioned` (v0.8.0): 接口与
 * `modify_output_note` 完全一样（{name, sections, yaml}），版本计算/归档全部自动；
 * 需用户先配置归档后缀/版本属性/归档属性，缺失则工具直接报错不工作。
 */
export function buildModifyOutputNoteVersionedTool(
  yamlRules?: YamlRule[],
  options?: { createRestrictYaml?: boolean }
): AnthropicTool {
  const rules = Array.isArray(yamlRules) ? yamlRules : [];
  const restrictYaml = options?.createRestrictYaml === true;
  const { yamlSchema } = buildYamlSchema(rules, restrictYaml, '修改');
  return {
    name: 'modify_output_note_versioned',
    description:
      '在输出文件夹内覆盖修改一篇已有笔记并自动归档（与 modify_output_note 相同的参数，版本/归档自动处理）。' +
      'sections 的键必须是原文中已存在的标题文本（值=该标题下要写入的新内容）：' +
      '只能修改标题下的文字，不能修改标题文字或新增标题，禁止以 # 符号创建任何标题。' +
      '每次修改前把当前文件版本自动追加到该文件的归档文件（原文名+归档后缀.md），并写入新版本号与归档标记。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '输出文件夹内笔记文件名（可带或不带 .md 后缀）' },
        sections: {
          type: 'object',
          description: '要修改的正文各节：键=原文中已存在的标题文本，值=该标题下要写入的新内容；键必须与原文标题完全一致，否则会被拒绝。',
          additionalProperties: { type: 'string' },
          required: [],
        },
        yaml: yamlSchema,
      },
      required: ['name'],
    },
  };
}

/**
 * Anthropic schema for `read_output_note` (v0.8.0): 读取输出文件夹内笔记全文
 * （含 YAML frontmatter 与正文），文件名匹配/防穿越与 readNoteTool 相同但作用于输出文件夹。
 */
export function buildReadOutputNoteTool(): AnthropicTool {
  return {
    name: 'read_output_note',
    description: '读取输出文件夹内某篇笔记的全文（含 YAML frontmatter 与正文）。',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: '输出文件夹内笔记文件名（可带或不带 .md 后缀）' } },
      required: ['name'],
    },
  };
}

export async function readOutputNoteTool(
  ctx: ToolCtx,
  args: { name?: string }
): Promise<{ result: { path: string; title: string; content: string } } | { error: string }> {
  const settings = ctx.settings;
  const folder = (settings.outputFolder || '/').trim();
  const target = stripExt((args?.name || '').trim());
  if (!target) return { error: 'ERROR: 未提供文件名' };
  if (!isValidFilename(target)) return { error: 'ERROR: 非法文件名' };

  const match = findOutputFile(ctx, folder, target);
  if (!match) return { error: 'ERROR: 未找到笔记' };

  const raw = await ctx.app.vault.read(match);
  return {
    result: {
      path: match.path,
      title: stripExt(match.basename ?? match.name ?? match.path),
      content: raw, // 含 frontmatter 与正文的全文
    },
  };
}

export async function modifyOutputNoteTool(
  ctx: ToolCtx,
  args: { name?: string; sections?: Record<string, string>; yaml?: unknown }
): Promise<{ result: { path: string } } | { error: string }> {
  const settings = ctx.settings;
  const folder = (settings.outputFolder || '/').trim();
  const target = stripExt((args?.name || '').trim());
  if (!target) return { error: 'ERROR: 未提供文件名' };
  if (!isValidFilename(target)) return { error: 'ERROR: 非法文件名' };

  const match = findOutputFile(ctx, folder, target);
  if (!match) return { error: 'ERROR: 未找到笔记' };

  const raw = await ctx.app.vault.read(match);
  const originalFM = parseFrontmatterObj(raw);
  const body = stripFrontmatter(raw);

  // yaml 白名单/规则校验（modify 用独立的 modifyYamlRules，与 create 的 yamlRules 分开）。
  const rules = settings.modifyYamlRules ?? [];
  const restrictYaml = settings.createRestrictYaml === true;
  const aiYaml = parseYamlObject(args?.yaml);
  const yamlErr = validateAiYaml(aiYaml, rules, restrictYaml);
  if (yamlErr) return { error: yamlErr };

  // sections 校验（标题必须已存在、禁 # 标题），全部通过才写盘。
  const bodyResult = applySectionsToBody(body, (args?.sections ?? {}) as Record<string, string>);
  if ('error' in bodyResult) return { error: bodyResult.error };

  // 写回：保留原 frontmatter + AI 改的键 + 自动补默认 yaml；
  // v0.8.2：再覆写「固定默认」属性——create 与 modify **共用同一份 yamlRules**，
  // 其中「仅默认值」的键（values 空 + default 非空、不暴露给 AI，如 created=当前时间）
  // 每次修改都强制覆写为渲染后的默认值（与 create 的「AI 未填才补」语义不同）。
  const moment = ctx.moment ?? (typeof window !== 'undefined' ? window.moment : null);
  let newFM = applyDefaults({ ...originalFM, ...aiYaml }, rules, { moment, now: ctx.now });
  newFM = applyFixedDefaults(newFM, rules, { moment, now: ctx.now });
  const newContent = serializeFileWithFrontmatter(bodyResult.result, newFM);

  await ctx.app.vault.adapter.write(match.path, newContent);
  return { result: { path: match.path } };
}

export async function modifyOutputNoteVersionedTool(
  ctx: ToolCtx,
  args: { name?: string; sections?: Record<string, string>; yaml?: unknown }
): Promise<{ result: { path: string } } | { error: string }> {
  const settings = ctx.settings;
  const folder = (settings.outputFolder || '/').trim();
  const target = stripExt((args?.name || '').trim());
  if (!target) return { error: 'ERROR: 未提供文件名' };
  if (!isValidFilename(target)) return { error: 'ERROR: 非法文件名' };

  // 必填归档配置缺失 → 不进行任何写操作。
  const versionSuffix = (settings.modifyVersionSuffix || '').trim();
  const versionProperty = (settings.modifyVersionProperty || '').trim();
  const archiveProperty = (settings.modifyArchiveProperty || '').trim();
  if (!versionSuffix || !versionProperty || !archiveProperty) {
    return { error: 'ERROR: 归档工具未配置（版本后缀/版本属性/归档属性）' };
  }

  const match = findOutputFile(ctx, folder, target);
  if (!match) return { error: 'ERROR: 未找到笔记' };

  const raw = await ctx.app.vault.read(match);
  const originalFM = parseFrontmatterObj(raw);
  const body = stripFrontmatter(raw);

  // yaml + sections 校验（modify 用独立的 modifyYamlRules，与 create 的 yamlRules 分开）。
  const rules = settings.modifyYamlRules ?? [];
  const restrictYaml = settings.createRestrictYaml === true;
  const aiYaml = parseYamlObject(args?.yaml);
  const yamlErr = validateAiYaml(aiYaml, rules, restrictYaml);
  if (yamlErr) return { error: yamlErr };
  const bodyResult = applySectionsToBody(body, (args?.sections ?? {}) as Record<string, string>);
  if ('error' in bodyResult) return { error: bodyResult.error };

  // 当前文件的「当前版本号」：归档文件最新版本 + 1（无归档 → 1）。
  // 归档块 = 修改前状态，版本号 = 当前版本；原文件写回 = 当前版本 + 1（下一版本）。
  // 例：首次调用 → 归档 `# 版本 1`，原文件 version: 2；再次 → 归档 `# 版本 2`，原文件 version: 3。
  const archiveName = target + versionSuffix + '.md';
  const archivePath = joinVaultPath(folder, archiveName);
  const archiveFile = findOutputFile(ctx, folder, target + versionSuffix);
  let currentVersion = 1;
  let existingArchiveRaw = '';
  if (archiveFile) {
    existingArchiveRaw = await ctx.app.vault.read(archiveFile);
    currentVersion = latestVersionFromArchive(existingArchiveRaw) + 1;
  }

  // 归档：把当前（修改前）原文 yaml 区全部属性 + 全部正文打包为一个版本块（版本号=当前版本）；
  // v0.8.1：新版本块插到归档文件【最上面】（最新版本在最上），块内 `# 属性`
  // 强制含当前版本号（versionProperty: N）。
  // 归档文件自身带 frontmatter：仅含归档标记属性（archiveProperty: true）——
  // v0.8.1 修正：archived 属于归档文件，不再写入最新版（原文件）的 yaml 区。
  const archiveBlock = buildArchiveBlock(currentVersion, originalFM, body, versionProperty);
  const archiveHeader = `---\n${serializeYamlFromObj({ [archiveProperty]: true })}\n---\n`;
  if (archiveFile) {
    // 旧归档文件：保留其 frontmatter（归档标记不变），新版本块插到 frontmatter 之后（body 顶部）。
    const existingBody = stripFrontmatter(existingArchiveRaw);
    const sep = existingBody.trimStart() ? '\n\n' : '';
    await ctx.app.vault.adapter.write(archivePath, archiveHeader + '\n' + archiveBlock + sep + existingBody);
  } else {
    await ctx.app.vault.create(archivePath, archiveHeader + '\n' + archiveBlock);
  }

  // 写回原文件：保留原 yaml + AI 改的键 + 自动补默认 + versionProperty=当前版本+1。
  // （archiveProperty 不再写入原文件——它属于归档文件。）
  // v0.8.2：**先归档（上面用修改前 originalFM 的旧时间戳）再写回**——此处才覆写
  // 「固定默认」属性（create 与 modify 共用 yamlRules 中「仅默认值」的键，如
  // created=当前时间），防止新时间戳被同步到已归档的旧版本中。
  const moment = ctx.moment ?? (typeof window !== 'undefined' ? window.moment : null);
  let newFM = applyDefaults({ ...originalFM, ...aiYaml }, rules, { moment, now: ctx.now });
  newFM = applyFixedDefaults(newFM, rules, { moment, now: ctx.now });
  newFM[versionProperty] = currentVersion + 1;
  const newContent = serializeFileWithFrontmatter(bodyResult.result, newFM);

  await ctx.app.vault.adapter.write(match.path, newContent);
  return { result: { path: match.path } };
}
