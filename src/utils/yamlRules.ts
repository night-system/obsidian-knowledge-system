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

/**
 * Normalise the AI's `yaml` argument into a flat `Record<string, unknown>`.
 * - `null` / non-object non-string → `{}`
 * - object → shallow copy (values kept as-is)
 * - string → split on lines; each line split at its first `:`, both sides
 *   trimmed; values kept as strings; empty lines and invalid lines ignored.
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
      const value = line.slice(idx + 1).trim();
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

/** Whether a plain string needs YAML double-quoting. */
function needsQuoting(v: string): boolean {
  if (v === '') return true; // 空串
  if (/^[\s]|\s$/.test(v)) return true; // 开头/结尾空白
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
