/**
 * Pure helpers for the `create_note` YAML frontmatter rule system (v0.4.0).
 *
 * This module intentionally imports nothing from `obsidian` and no Node
 * built-ins, so it can be unit-tested in isolation under Node. `moment` and
 * `now` are always passed in as plain arguments: the plugin supplies Obsidian's
 * global `window.moment`, while tests supply a tiny shim.
 *
 * Design aims:
 * - Out-of-contract input never throws — `parseYamlObject` falls back to `{}`
 *   and `validateYamlRules` returns a Chinese message for the AI to read.
 * - `applyDefaults` keeps every key the AI supplied in the AI's original order
 *   (rule key or not) and only *appends* a rule's default when the AI omitted
 *   it, so the AI's input order is preserved and defaults are supplemented.
 *   Extra (non-rule) keys are never validated or filtered.
 * - `serializeYamlFromObj` quotes only strings that need it (YAML special
 *   characters / leading+trailing whitespace / empty), matching the existing
 *   `serializeYaml` plain-string behavior so current tests keep passing.
 */
import type { YamlRule } from '../settings';
import { stripFrontmatter } from './index';

/**
 * Normalise the AI's `yaml` argument into a flat `Record<string, unknown>`.
 * - `null` / non-object non-string → `{}`
 * - object → shallow copy (values kept as-is)
 * - string → split on lines; each line split at its first `:`, both sides
 *   trimmed; values kept as strings; empty lines and invalid lines ignored.
 *
 * v0.8.1：字符串分支会剥离 YAML 成对引号并还原 `\"` 转义（自愈旧污染数据），
 * 避免 AI 以「字符串形式 + 带引号值」传参、或 modify 工具读写循环叠加转义时，
 * 引号字符残留在值里被再次加引号。
 */
export function parseYamlObject(yaml: unknown): Record<string, unknown> {
  if (yaml == null) return {};
  if (typeof yaml === 'string') {
    const obj: Record<string, unknown> = {};
    for (const rawLine of yaml.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue; // 空行忽略
      const idx = line.indexOf(':');
      if (idx <= 0) continue; // 非法行（无冒号或冒号在开头）
      // 首个冒号切分：键名、值（值保留字符串）
      const key = line.slice(0, idx).trim();
      const value = unquoteYamlValue(line.slice(idx + 1).trim());
      if (!key) continue;
      obj[key] = value;
    }
    return obj;
  }
  if (typeof yaml === 'object') {
    return { ...(yaml as Record<string, unknown>) }; // 浅拷贝
  }
  return {};
}

/**
 * 还原一个 YAML 值字符串的引号/转义：循环剥离成对引号并还原 `\"` / `\\`，
 * 直到值稳定（上限 4 轮，防多层污染叠加）。例如：
 *   `"2026-08-26 15:30"` → `2026-08-26 15:30`
 *   `"\"2026-08-26 15:30\""`（被 modify 工具转义污染过）→ `2026-08-26 15:30`
 */
function unquoteYamlValue(raw: string): string {
  let v = raw;
  for (let i = 0; i < 4; i++) {
    let changed = false;
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
      changed = true;
    }
    const unescaped = v
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    if (unescaped !== v) {
      v = unescaped;
      changed = true;
    }
    if (!changed) break;
  }
  return v;
}

/**
 * Validate an object against the rules. Returns `null` when every rule passes,
 * otherwise an `ERROR:` message (Chinese, self-diagnostic) for the AI to read.
 *
 * A rule only validates when the key is present with a non-`undefined` value
 * (`undefined` = AI did not provide it → skipped). When `rule.values` is
 * non-empty the trimmed value must be one of them; an empty `values` means
 * arbitrary (no check).
 */
export function validateYamlRules(
  obj: Record<string, unknown>,
  rules: YamlRule[]
): string | null {
  for (const rule of rules) {
    if (obj[rule.key] === undefined) continue; // 未提供 → 跳过校验
    const v = String(obj[rule.key] ?? '').trim();
    if (rule.values && rule.values.length > 0 && !rule.values.includes(v)) {
      return `ERROR: yaml 属性"${rule.key}"的值"${v}"不在可选值[${rule.values.join(' / ')}]内（${rule.desc}）`;
    }
  }
  return null;
}

/**
 * Render a default value, expanding moment templates (`{{YYYY.MM.DD}}`).
 * - no `{{` → returned unchanged
 * - `{{fmt}}` → `moment(now ?? Date.now()).format(fmt)` (fmt = trimmed content)
 * - multiple `{{...}}` are all expanded
 * - an unclosed `{{...` is left untouched (only fully-delimited spans replace)
 * - a missing/odd `moment` → returned unchanged (no throw)
 *
 * `moment` may be either a callable (Obsidian's real moment) or a ready
 * moment-like object with a `.format` method, so the same helper works with the
 * real plugin and with a tiny test shim.
 */
export function renderDefaultValue(raw: string, moment: any, now?: number): string {
  const s = String(raw ?? '');
  if (!s.includes('{{')) return s; // 无 '{{' → 原样
  if (moment == null) return s; // moment 缺失 → 原样
  const zeit = typeof now === 'number' ? now : Date.now();
  return s.replace(/\{\{(.*?)\}\}/g, (match, fmt: string) => {
    const f = String(fmt).trim();
    try {
      if (typeof moment === 'function') {
        return moment(zeit).format(f);
      }
      const m = moment as { format?: (f: string) => string };
      if (typeof m?.format === 'function') {
        return m.format(f);
      }
    } catch {
      return match; // 渲染失败 → 保留原文
    }
    return match;
  });
}

/**
 * Produce the final frontmatter object for `create_note`:
 * - keep every key the AI supplied, in the AI's original order (rule key or
 *   not); a rule key the AI supplied is taken verbatim;
 * - then, for each rule whose key the AI did NOT supply and whose `default` is
 *   non-empty, append the rendered default (in rule order);
 * - rules with no supplied value and an empty default are skipped.
 * Extra (non-rule) keys are neither validated nor filtered.
 */
export function applyDefaults(
  obj: Record<string, unknown>,
  rules: YamlRule[],
  opts: { moment: any; now?: number }
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // 1) 保留 AI 提供的所有键（含规则外键），保持 obj 原始顺序
  for (const key of Object.keys(obj)) {
    out[key] = obj[key];
  }
  // 2) AI 未提供但配了默认值的规则键，按规则顺序补默认值（自动「补」默认）
  for (const rule of rules) {
    if (!rule.key) continue;
    if (obj[rule.key] !== undefined) continue; // AI 已提供 → 直接用（上一步已拷贝）
    if (String(rule.default ?? '').trim() === '') continue; // 无默认 → 跳过
    out[rule.key] = renderDefaultValue(rule.default, opts.moment, opts.now);
  }
  return out;
}

/**
 * 覆写「固定默认」属性（v0.8.2，modify 工具用）：把 yamlRules 中「仅默认值」的键
 * （`values` 空 + `default` 非空，即不暴露给 AI 的固定属性，如 created=时间戳）
 * **每次修改都强制覆写**为渲染后的默认值——与 `applyDefaults` 的「AI 未填才补」
 * 不同：modify 工具每次更新时都刷新这些属性（例如 created 记录本次修改时间）。
 * 返回新对象（不动入参）。
 */
export function applyFixedDefaults(
  obj: Record<string, unknown>,
  rules: YamlRule[],
  opts: { moment: any; now?: number }
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(obj ?? {}) };
  for (const rule of rules ?? []) {
    if (!rule || !rule.key) continue;
    if (rule.values && rule.values.length > 0) continue; // 有可选值约束 = 暴露给 AI，不覆写
    if (String(rule.default ?? '').trim() === '') continue; // 无默认 → 跳过
    out[rule.key] = renderDefaultValue(rule.default, opts.moment, opts.now);
  }
  return out;
}

/**
 * Whether a plain string needs YAML double-quoting.
 * v0.8.1：时间戳形态（`2026-08-26` / `2026.08.26` / `2026-08-26 15:30` /
 * `2026-08-26T15:30:00` 等）即使含冒号也不加引号——时间戳的冒号在 YAML 中
 * 会被解析为普通字符串，加引号反而会在后续读写循环中被转义污染。
 */
function needsQuoting(v: string): boolean {
  if (v === '') return true; // 空串
  if (/^[\s]|\s$/.test(v)) return true; // 开头/结尾空白
  // 时间戳形态豁免（年-月-日[ 或T 时:分[:秒]]，分隔符 . - / 均可）
  if (/^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(v)) return false;
  // eslint-disable-next-line no-useless-escape
  if (/[:#\[\]{}'"]/.test(v)) return true; // YAML 特殊字符
  return false;
}

/** Serialize a single value: numbers/booleans as-is, null/undefined as empty. */
function serializeValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    if (needsQuoting(v)) return '"' + v.replace(/"/g, '\\"') + '"';
    return v;
  }
  // 其它类型（对象/数组，来自对象输入）保持与旧 serializeYaml 相同的 String 结果
  return String(v);
}

/**
 * Serialize a flat object into YAML frontmatter body lines (`key: value`),
 * quoting only strings that need it. Empty object → `''` (caller keeps the
 * `---\n---\n` empty-frontmatter behavior when no YAML is produced).
 */
export function serializeYamlFromObj(obj: Record<string, unknown>): string {
  if (obj == null || typeof obj !== 'object') return '';
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${serializeValue(v)}`)
    .join('\n');
}

/**
 * Extract a file's YAML frontmatter as a flat object, or `{}` when the content
 * has no frontmatter block (leading `---` … `---` fence). Values are parsed the
 * same way as `parseYamlObject` (first-colon split, strings kept). Used by the
 * `update_note_yaml` / `search_output_notes` tools.
 */
export function parseFrontmatterObj(content: string): Record<string, unknown> {
  const m = (content || '').match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return {};
  return parseYamlObject(m[1]);
}

/**
 * Rebuild a file's full text given its current raw content and a desired
 * frontmatter object: the frontmatter region is re-serialized from `fm` and the
 * body (everything after the closing `---`) is preserved verbatim. When the
 * content has no frontmatter, one is prepended.
 */
export function serializeFileWithFrontmatter(content: string, fm: Record<string, unknown>): string {
  const body = stripFrontmatter(content || '');
  const yamlStr = serializeYamlFromObj(fm);
  return yamlStr ? `---\n${yamlStr}\n---\n${body}` : `---\n---\n${body}`;
}
