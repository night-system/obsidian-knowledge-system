/**
 * Shared pure review helpers (v0.9.0).
 *
 * Extracted from `src/reviewView.ts` so the 审核页 (Bases review view) and the
 * 侧边栏提醒面板 (`src/sidebarRules.ts`) use the SAME 未审核/排除判定逻辑.
 * This module imports nothing from `obsidian` (no runtime values) so it stays
 * trivially testable; callers pass plain values.
 *
 * v0.9.0 also adds `renderPromptTemplate` — the shared `{{filename}}`
 * substitution used by the review page「AI 修改」button and by sidebar
 * `open_chat` rules.
 */

/**
 * 未审核判定：frontmatter 缺失、属性缺失/空、或值 === reviewDefault。
 * 行为与 v0.8.6+ 审核页完全一致（原样迁移，未改语义）。
 */
export function isUnreviewed(
  fm: Record<string, unknown> | null | undefined,
  reviewAttr: string,
  reviewDefault: string
): boolean {
  if (!fm) return true;
  const v = fm[reviewAttr];
  if (v === undefined || v === null || v === '') return true;
  return String(v) === reviewDefault;
}

/** 排除判定：frontmatter[key] 的字符串形式 === value（如 archived=true 排除归档文件）。 */
export function isExcluded(
  fm: Record<string, unknown> | null | undefined,
  excludes: { key: string; value: string }[]
): boolean {
  if (!fm || !Array.isArray(excludes)) return false;
  for (const ex of excludes) {
    if (!ex || !ex.key) continue;
    const v = fm[ex.key];
    if (v !== undefined && v !== null && String(v) === String(ex.value).trim()) return true;
  }
  return false;
}

/**
 * v0.9.0：把 prompt 模板里的 `{{filename}}` 占位符全部替换为 `filename`
 * （调用方保证 filename = 文件名 basename，不含路径、不含 .md）。
 * 模板不含占位符时原样返回（允许完全自定义的提示词）。
 */
export function renderPromptTemplate(template: string, filename: string): string {
  const s = String(template ?? '');
  if (!s.includes('{{filename}}')) return s;
  return s.replace(/\{\{filename\}\}/g, filename);
}
