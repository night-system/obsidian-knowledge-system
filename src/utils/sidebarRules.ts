/**
 * Sidebar rule condition evaluation (v0.9.0).
 *
 * Pure-ish logic: this module imports NO runtime values from `obsidian` (only
 * `import type`, erased at compile time), so it cannot pull Obsidian's runtime
 * into any test harness. The `App` is passed in by the caller — evaluation
 * needs `app.metadataCache` (frontmatter) and `app.vault` (file discovery).
 *
 * 未审核判定与审核页共用 `src/utils/review.ts` 的 isUnreviewed / isExcluded。
 */
import type { App, TFile } from 'obsidian';
import type { KnowledgeSystemSettings, SidebarCondition } from '../settings';
import { isExcluded, isUnreviewed, parseAfterDate } from './review';

/** 文件夹判定（duck-typing，避免 instanceof 需要 obsidian 运行时）。 */
function isFolderLike(v: unknown): boolean {
  return typeof v === 'object' && v !== null && Array.isArray((v as { children?: unknown }).children);
}

/** 把 vault 抽象文件按文件夹递归收集其下所有 Markdown 文件（与 core.ts 同语义）。 */
function getMarkdownFilesInFolder(root: unknown): TFile[] {
  const result: TFile[] = [];
  const visit = (folder: { children: unknown[] }): void => {
    for (const child of folder.children) {
      const ext = (child as { extension?: string }).extension;
      if (typeof ext === 'string' && ext === 'md') {
        result.push(child as TFile);
      } else if (isFolderLike(child)) {
        visit(child as { children: unknown[] });
      }
    }
  };
  if (isFolderLike(root)) visit(root as { children: unknown[] });
  return result;
}

/**
 * 解析配置文件夹路径（'source'/'output' → settings.sourceFolder/outputFolder；
 * 其他值原样视为自定义文件夹路径；'/'/'' → 库根）。
 */
function folderPathOf(settings: KnowledgeSystemSettings, folder: string): string {
  if (folder === 'source') return settings.sourceFolder;
  if (folder === 'output') return settings.outputFolder;
  return folder;
}

/** 解析文件夹：路径 → TFolder（不存在/非法 → 库根）。 */
function resolveFolder(app: App, raw: string): unknown {
  const s = (raw || '/').trim();
  if (s === '/' || s === '') return app.vault.getRoot();
  const p = s.replace(/^\/+|\/+$/g, '');
  if (!p) return app.vault.getRoot();
  const found = app.vault.getAbstractFileByPath(p);
  return isFolderLike(found) ? found : app.vault.getRoot();
}

/** frontmatter（统一入口，缺失 → {}）。 */
function frontmatterOf(app: App, file: TFile): Record<string, unknown> {
  return (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
}

/**
 * 求值一条条件，返回匹配文件列表（`unreviewed` 返回未审核且未被排除的文件；
 * `missing_property` 返回缺属性/值不匹配的文件；afterDate 过滤后）。
 * v0.9.2：afterDate 解析用 utils/review.ts 的 parseAfterDate（与整理面板共用）。
 */
export function evaluateCondition(
  app: App,
  settings: KnowledgeSystemSettings,
  condition: SidebarCondition
): TFile[] {
  if (!condition) return [];
  switch (condition.type) {
    case 'unreviewed': {
      const folder = resolveFolder(app, settings.outputFolder);
      const reviewAttr = settings.reviewAttr;
      const reviewDefault = settings.reviewDefault;
      const excludes = settings.reviewExcludes || [];
      const files = getMarkdownFilesInFolder(folder).filter((file) => {
        const fm = frontmatterOf(app, file);
        return isUnreviewed(fm, reviewAttr, reviewDefault) && !isExcluded(fm, excludes);
      });
      const minCount = condition.minCount !== undefined && condition.minCount !== null ? condition.minCount : 1;
      // 未审核文件数 < 最小数量 → 该规则不匹配（返回空列表）。
      return files.length >= Math.max(0, minCount) ? files : [];
    }
    case 'missing_property': {
      const folder = resolveFolder(app, folderPathOf(settings, condition.folder));
      // afterDate 过滤：只看在该日期当天 00:00 及之后修改的文件；解析失败/留空 = 不限。
      const afterMs = parseAfterDate(condition.afterDate);
      const files = getMarkdownFilesInFolder(folder).filter((file) => {
        if (afterMs !== null) {
          const mtime = (file.stat && file.stat.mtime) || file.stat.ctime || 0;
          if (mtime < afterMs) return false;
        }
        const fm = frontmatterOf(app, file);
        const prop = (condition.property || '').trim();
        if (!prop) return false;
        const raw = fm[prop];
        // expectedValue 留空 = 属性缺失即匹配；填写 = 属性缺失或值不相等都匹配。
        if (raw === undefined || raw === null || raw === '') return true;
        const expected = condition.expectedValue;
        if (expected === undefined || expected === null || String(expected).trim() === '') return false;
        return String(raw) !== String(expected);
      });
      return files;
    }
    default:
      return [];
  }
}
