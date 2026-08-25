/**
 * Pure logic for the plugin. This module intentionally imports nothing from
 * `obsidian` (and no Node built-ins) so it can be unit-tested in isolation
 * under Node. Obsidian-facing concerns (vault, files, requestUrl, Notice) live
 * in `../core`; here `moment` and `nowMs` are passed in as plain arguments.
 *
 * The exported function names and signatures are part of the acceptance
 * contract (see 验收标准文档 §2). Do not rename them.
 */

/** One source entry used by `countRecent`. */
export interface RecentItem {
  isMd: boolean;
  frontmatter: Record<string, unknown>;
  ctimeMs: number;
}

/** Options for `countRecent`. */
export interface CountOptions {
  moment: any;
  timeAttr: string;
  formats: string[];
  nowMs: number;
  days: number;
}

/** Values used to build the output frontmatter. */
export interface FrontmatterVals {
  source: string;
  timestampMs: number;
}

/** Config used to build the output frontmatter (attribute names + formatter). */
export interface FrontmatterConfig {
  /** Attribute name for the output timestamp (fixed row). */
  timestampProperty: string;
  /** Attribute name for the output source path (fixed row). */
  sourceAttr: string;
  /** moment instance used to render the timestamp (passed in). */
  moment: any;
  /** moment-compatible format used to render the timestamp. */
  timeFormat: string;
  /** Dynamic output properties: each {key,value} is one frontmatter row. */
  extraProperties?: { key: string; value: string }[];
  /** Legacy review attribute (used as fallback when `extraProperties` is empty). */
  reviewAttr?: string;
  /** Legacy review default value. */
  reviewDefault?: string;
  /** Legacy category attribute (used as fallback when `extraProperties` is empty). */
  categoryAttr?: string;
  /** Legacy category default value. */
  categoryDefault?: string;
}

/**
 * A structural view of the object that may carry the dynamic `extraProperties`
 * list and/or the legacy `reviewAttr`/`categoryAttr` output-attribute fields.
 * Any object with these optional fields is accepted (e.g. the settings object).
 */
export interface MigrateInput {
  extraProperties?: { key: string; value: string }[];
  reviewAttr?: string;
  reviewDefault?: string;
  categoryAttr?: string;
  categoryDefault?: string;
}

const DAY_MS = 86_400_000;

/**
 * Parse `value` with each format in order (strict). Returns the epoch ms, or
 * `null` when none of the formats produce a valid date. Numeric / Date inputs
 * are treated as timestamps directly.
 */
export function parseTimestamp(
  value: unknown,
  moment: any,
  formats: string[]
): number | null {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  for (const f of formats) {
    if (!f) continue;
    const m = moment(s, f, true);
    if (m && typeof m.isValid === 'function' && m.isValid()) return m.valueOf();
  }
  return null;
}

/**
 * Resolve a file's timestamp: the configured frontmatter attribute when present
 * and parseable, otherwise the file creation time (`ctimeMs`).
 */
export function resolveTimestamp(
  frontmatter: Record<string, unknown>,
  ctimeMs: number,
  moment: any,
  timeAttr: string,
  formats: string[]
): number {
  if (timeAttr) {
    const v = frontmatter[timeAttr];
    if (v !== undefined && v !== null) {
      const ts = parseTimestamp(v, moment, formats);
      if (ts !== null) return ts;
    }
  }
  return ctimeMs;
}

/**
 * Count how many entries are Markdown files whose resolved timestamp falls
 * within the last `days` days (inclusive of the boundary).
 */
export function countRecent(items: RecentItem[], opts: CountOptions): number {
  const { moment, timeAttr, formats, nowMs, days } = opts;
  const cutoff = nowMs - Math.max(1, Math.floor(days || 1)) * DAY_MS;
  let n = 0;
  for (const item of items) {
    if (!item.isMd) continue;
    const ts = resolveTimestamp(item.frontmatter, item.ctimeMs, moment, timeAttr, formats);
    if (ts >= cutoff) n++;
  }
  return n;
}

/**
 * Return the last `n` characters of `text`, counting Unicode code points so a
 * surrogate pair (e.g. an emoji) is kept as a single character and no code
 * point boundary is split. Newlines count as characters.
 */
export function extractLastChars(text: string, n: number): string {
  return [...text].slice(-n).join('');
}

/**
 * Render the output YAML frontmatter (without the surrounding `---` fences)
 * using the configured attribute names and the provided moment formatter.
 * Values are written unquoted so they read back as plain strings.
 */
/**
 * Render the output YAML frontmatter (without the surrounding `---` fences).
 * Row order is stable and fixed: the timestamp row, then the source row, then
 * every `extraProperties` entry in insertion order. When `extraProperties` is
 * empty, the legacy review/category fields are used instead (back-compat).
 */
export function buildFrontmatter(vals: FrontmatterVals, cfg: FrontmatterConfig): string {
  const lines: string[] = [
    `${cfg.timestampProperty}: ${cfg.moment(vals.timestampMs).format(cfg.timeFormat)}`,
    `${cfg.sourceAttr}: ${vals.source}`,
  ];
  const extra = cfg.extraProperties && cfg.extraProperties.length > 0 ? cfg.extraProperties : null;
  if (extra) {
    for (const { key, value } of extra) lines.push(`${key}: ${value}`);
  } else {
    if (cfg.reviewAttr && cfg.reviewDefault != null) lines.push(`${cfg.reviewAttr}: ${cfg.reviewDefault}`);
    if (cfg.categoryAttr && cfg.categoryDefault != null) lines.push(`${cfg.categoryAttr}: ${cfg.categoryDefault}`);
  }
  return lines.join('\n');
}

/**
 * Migrate legacy output attributes into the dynamic `extraProperties` list:
 * - if `extraProperties` is already non-empty, return it unchanged;
 * - otherwise build `{key,value}` rows from the legacy `reviewAttr`/`categoryAttr`
 *   fields when present;
 * - otherwise return `[]`.
 */
export function migrateExtraProperties(input: MigrateInput): { key: string; value: string }[] {
  const extra = input.extraProperties;
  if (Array.isArray(extra) && extra.length > 0) {
    return extra.map((e) => {
      const item = e as { key?: unknown; value?: unknown };
      return { key: String(item?.key ?? ''), value: String(item?.value ?? '') };
    });
  }
  const out: { key: string; value: string }[] = [];
  const reviewAttr = input.reviewAttr;
  const reviewDefault = input.reviewDefault;
  if (reviewAttr && reviewDefault != null) out.push({ key: String(reviewAttr), value: String(reviewDefault) });
  const categoryAttr = input.categoryAttr;
  const categoryDefault = input.categoryDefault;
  if (categoryAttr && categoryDefault != null) out.push({ key: String(categoryAttr), value: String(categoryDefault) });
  return out;
}
/**
 * Remove a leading YAML frontmatter block (delimited by `---`) from a markdown
 * file's raw content so the following extraction/analysis works on the body
 * only. Returns the input unchanged when there is no frontmatter.
 */
export function stripFrontmatter(content: string): string {
  if (content.startsWith('---')) {
    const idx = content.indexOf('\n---', 3);
    if (idx >= 0) {
      let rest = content.slice(idx + 4);
      if (rest.startsWith('\n')) rest = rest.slice(1);
      return rest;
    }
  }
  return content;
}
