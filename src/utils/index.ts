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
  timestampAttr: string;
  reviewAttr: string;
  reviewDefault: string;
  categoryAttr: string;
  categoryDefault: string;
  sourceAttr: string;
  moment: any;
  timeFormat: string;
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
export function buildFrontmatter(vals: FrontmatterVals, cfg: FrontmatterConfig): string {
  const timeStr = cfg.moment(vals.timestampMs).format(cfg.timeFormat);
  return [
    `${cfg.timestampAttr}: ${timeStr}`,
    `${cfg.reviewAttr}: ${cfg.reviewDefault}`,
    `${cfg.categoryAttr}: ${cfg.categoryDefault}`,
    `${cfg.sourceAttr}: ${vals.source}`,
  ].join('\n');
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
