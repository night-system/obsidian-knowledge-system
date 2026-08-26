import { App, Component, Notice, TFile, ToggleComponent, setIcon } from 'obsidian';
import type { BasesView, BasesViewFactory, QueryController } from 'obsidian';
import type KnowledgeSystemPlugin from './main';
import { parseFrontmatterObj, serializeFileWithFrontmatter } from './utils/yamlRules';
// v0.9.0：未审核/排除判定提取到 utils/review.ts，与侧边栏提醒面板共用（行为不变）。
import { isExcluded, isUnreviewed, renderPromptTemplate } from './utils/review';

/**
 * v0.8.6：审核页（Obsidian Bases 核心插件自定义视图）。
 *
 * 照抄 TaskNotes（repos\_refs\tasknotes）的 Bases 集成四件套：
 * 1) plugin.registerBasesView(viewId, registration) 注册自定义视图（Obsidian 1.10.0+ 公开 API）；
 * 2) 视图类实现 BasesView 形状（type + onDataUpdated，Component 生命周期）；
 * 3) .base 文件（YAML：filters + views[].type = viewId）定义数据源 = 输出文件夹；
 * 4) 自定义 CSS 类名渲染（styles.css 的 .ks-review-*）。
 *
 * 数据流：.base 文件的 filters 限定「输出文件夹」，Bases 查询把该文件夹所有
 * md 文件（含 frontmatter）交给视图（this.data.data: BasesEntry[]）；视图在
 * onDataUpdated 里用 frontmatter 判定「未审核」（reviewAttr 缺失/空/等于
 * reviewDefault），只渲染未审核条目。每条提供「打开」和「AI 修改」（打开聊天
 * 视图，引用此文件 + 调用所选预设）。
 */

/** Bases 视图 id（views[].type 必须等于它）。 */
export const REVIEW_VIEW_TYPE = 'ks-review';

/** 排除值转 Bases 过滤字面量：true/false → 布尔裸写，纯数字 → 裸写，否则带引号。 */
function excludeValueLiteral(value: string): string {
  const v = String(value).trim();
  if (v === 'true' || v === 'false') return v;
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return JSON.stringify(v);
}

/**
 * 生成 .base 文件内容（YAML）。
 * - filters：输出文件夹非根（'/'）时用 `file.inFolder("<folder>")` 限定数据源；
 *   再加排除条件（frontmatter[key] != value，如 note["archived"] != true）。
 * - views[].type = REVIEW_VIEW_TYPE（Bases 用这个类型实例化我们的视图）。
 */
export function buildReviewBaseYaml(
  outputFolder: string,
  reviewAttr: string,
  excludes: { key: string; value: string }[]
): string {
  const folder = (outputFolder || '/').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const conditions: string[] = [];
  if (folder !== '/') conditions.push(`file.inFolder("${folder}")`);
  for (const ex of excludes || []) {
    if (!ex || !ex.key) continue;
    conditions.push(`note["${ex.key}"] != ${excludeValueLiteral(ex.value)}`);
  }
  const lines: string[] = [];
  if (conditions.length > 0) {
    lines.push('filters:');
    lines.push('  and:');
    for (const c of conditions) lines.push(`    - ${c}`);
  }
  lines.push('views:');
  lines.push(`  - type: ${REVIEW_VIEW_TYPE}`);
  lines.push('    name: 审核');
  lines.push('    order:');
  lines.push('      - file.name');
  lines.push(`      - note["${reviewAttr}"]`);
  return lines.join('\n') + '\n';
}

/** 审核面板路径（v0.8.7：由设置「审核面板位置」决定）。 */
function reviewBasePathOf(plugin: KnowledgeSystemPlugin): string {
  const p = (plugin.settings.reviewBasePath || '审核.base').replace(/\\/g, '/').trim();
  return p || '审核.base';
}

/** 确保审核面板（.base 文件）存在且内容与当前设置一致。 */
export async function ensureReviewBase(plugin: KnowledgeSystemPlugin): Promise<TFile | null> {
  const vault = plugin.app.vault;
  const path = reviewBasePathOf(plugin);
  const yaml = buildReviewBaseYaml(plugin.settings.outputFolder, plugin.settings.reviewAttr, plugin.settings.reviewExcludes);
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    try {
      const cur = await vault.read(existing);
      if (cur !== yaml) await vault.modify(existing, yaml);
    } catch {
      /* 读取失败就当作不存在重建 */
    }
    return existing;
  }
  try {
    const created = await vault.create(path, yaml);
    return created instanceof TFile ? created : null;
  } catch (e) {
    new Notice(`创建审核面板失败：${String(e)}`);
    return null;
  }
}

/** v0.8.7：按当前设置重新生成审核面板（已存在则覆盖重建一次）。 */
export async function regenerateReviewBaseFile(plugin: KnowledgeSystemPlugin): Promise<TFile | null> {
  const vault = plugin.app.vault;
  const path = reviewBasePathOf(plugin);
  const yaml = buildReviewBaseYaml(plugin.settings.outputFolder, plugin.settings.reviewAttr, plugin.settings.reviewExcludes);
  try {
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await vault.modify(existing, yaml);
      return existing;
    }
    const created = await vault.create(path, yaml);
    return created instanceof TFile ? created : null;
  } catch (e) {
    new Notice(`重新生成审核面板失败：${String(e)}`);
    return null;
  }
}

/**
 * 审核视图：列出输出文件夹中所有未审核文件，每条可「打开」或「AI 修改」。
 * 不 extends BasesView 抽象类（Bases 在工厂返回后注入 app/config/data），
 * 实现相同形状即可，工厂里 cast（TaskNotes 同款做法）。
 */
export class ReviewBasesView extends Component {
  type = REVIEW_VIEW_TYPE;
  app: App;
  config: unknown;
  allProperties: string[] = [];
  data: { data: { file?: TFile }[] } | null = null;

  private containerEl: HTMLElement;
  private plugin: KnowledgeSystemPlugin;
  /** 审核页头部选中的预设（「AI 修改」用它）；默认 = 当前聊天预设。 */
  private presetId = '';

  constructor(controller: QueryController, containerEl: HTMLElement, plugin: KnowledgeSystemPlugin) {
    super();
    void controller;
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.app = plugin.app;
    this.presetId = plugin.settings.activePresetId || '';
  }

  onload(): void {
    this.containerEl.addClass('ks-review-view');
    this.render();
  }

  /** Bases 查询结果变化（vault 文件/frontmatter 变化）时自动重渲染。 */
  onDataUpdated(): void {
    this.render();
  }

  private render(): void {
    this.containerEl.empty();

    // 头部：标题 + 预设选择 + 刷新按钮。
    const head = this.containerEl.createDiv({ cls: 'ks-review-head' });
    head.createSpan({ cls: 'ks-review-title', text: '审核' });
    const presets = this.plugin.settings.toolPresets || [];
    const sel = head.createEl('select', { cls: 'ks-review-preset' });
    const def = sel.createEl('option');
    def.value = '';
    def.textContent = 'AI 修改预设：默认（全部工具）';
    for (const p of presets) {
      const o = sel.createEl('option');
      o.value = p.id;
      o.textContent = p.name;
      if (p.id === this.presetId) o.selected = true;
    }
    sel.addEventListener('change', () => {
      this.presetId = sel.value;
    });
    const refreshBtn = head.createEl('button', { cls: 'clickable-icon ks-review-refresh', attr: { 'aria-label': '刷新', 'title': '刷新' } });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.render());
    head.createSpan({ cls: 'ks-review-hint', text: '点击笔记标题打开文件；点击聊天图标用所选预设进入聊天并引用此文件。' });

    // 列表：只显示未审核且未被排除的文件。
    const reviewAttr = this.plugin.settings.reviewAttr;
    const reviewDefault = this.plugin.settings.reviewDefault;
    const excludes = this.plugin.settings.reviewExcludes || [];
    const list = this.containerEl.createDiv({ cls: 'ks-review-list' });
    const entries = this.data?.data ?? [];
    let count = 0;
    for (const entry of entries) {
      const file = entry.file;
      if (!file) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!isUnreviewed(fm, reviewAttr, reviewDefault)) continue;
      if (isExcluded(fm, excludes)) continue;
      count++;

      const row = list.createDiv({ cls: 'ks-review-item' });
      const info = row.createDiv({ cls: 'ks-review-item-info' });
      const nameEl = info.createDiv({ cls: 'ks-review-item-name', text: file.basename });
      // 点击标题直接打开笔记（v0.8.9：替代原来的「打开」按钮）。
      // 注意：必须用 getLeaf('tab')——getLeaf(false) 在 Bases 视图上下文会抛
      // 「e.getEphemeralState is not a function」（实测 Obsidian 1.13.7）。
      nameEl.addEventListener('click', () => {
        void this.app.workspace.getLeaf('tab').openFile(file);
      });
      const raw = fm?.[reviewAttr];
      const isDone = raw !== undefined && raw !== null && raw !== '' && String(raw) === this.plugin.settings.reviewDoneValue;

      const ops = row.createDiv({ cls: 'ks-review-item-ops' });
      // v0.8.9：审核开关——打开 = 把该文件 frontmatter[reviewAttr] 写为「已审标记值」，
      // 文件随即移出审核列表（Bases 检测到 frontmatter 变化自动重渲染）。
      const doneToggle = new ToggleComponent(ops)
        .setValue(isDone)
        .setTooltip(`标记为「${this.plugin.settings.reviewDoneValue || '已审核'}」`)
        .onChange((on) => {
          if (on) void this.markFileDone(file, reviewAttr);
          else void this.markFileUndone(file, reviewAttr);
        });
      // v0.8.9：AI 修改改为聊天框图标按钮（lucide），去掉文字与强调背景色。
      // 用「AI 修改提示词」模板替换 {{filename}} → file.basename（不含路径、不含 .md），
      // 把**最终 prompt 文本**传给聊天视图（模板无占位符时原样使用）。
      const chatBtn = ops.createEl('button', { cls: 'clickable-icon ks-review-chat', attr: { 'aria-label': 'AI 修改', 'title': 'AI 修改' } });
      setIcon(chatBtn, 'messages-square');
      chatBtn.addEventListener('click', () => {
        const template = (this.plugin.settings.reviewChatPrompt || '').trim()
          || '请读取输出文件夹中的笔记「{{filename}}」，与我沟通如何修改，然后按我的要求修改它。';
        // v0.9.0：{{filename}} 替换提取为公共函数 renderPromptTemplate（行为不变）。
        const prompt = renderPromptTemplate(template, file.basename);
        void this.plugin.openChatWith(prompt, this.presetId || undefined);
      });
      void doneToggle;
    }
    if (count === 0) {
      list.createDiv({ cls: 'ks-review-empty', text: '输出文件夹里没有未审核的文件' });
    } else {
      list.createDiv({ cls: 'ks-review-count', text: `共 ${count} 个未审核文件` });
    }
  }

  /** v0.8.9：审核开关打开——把该文件 frontmatter[reviewAttr] 写为「已审标记值」，
   *  文件随即移出审核列表（vault.process 触发 metadataCache 更新 → Bases onDataUpdated）。 */
  private async markFileDone(file: TFile, reviewAttr: string): Promise<void> {
    const value = (this.plugin.settings.reviewDoneValue || '').trim() || '已审';
    try {
      await this.app.vault.process(file, (raw) => {
        const fm = parseFrontmatterObj(raw);
        fm[reviewAttr] = value;
        return serializeFileWithFrontmatter(raw, fm);
      });
      new Notice(`已标记「${file.basename}」为 ${value}`);
    } catch (e) {
      new Notice(`标记失败：${String(e)}`);
    }
  }

  /** v0.8.9：审核开关关闭——把该文件 frontmatter[reviewAttr] 写为「未审标记值」，
   *  文件回到审核列表（如误标记后撤销）。 */
  private async markFileUndone(file: TFile, reviewAttr: string): Promise<void> {
    const value = (this.plugin.settings.reviewDefault || '').trim();
    try {
      await this.app.vault.process(file, (raw) => {
        const fm = parseFrontmatterObj(raw);
        fm[reviewAttr] = value || '';
        return serializeFileWithFrontmatter(raw, fm);
      });
      new Notice(`已取消标记「${file.basename}」`);
    } catch (e) {
      new Notice(`取消标记失败：${String(e)}`);
    }
  }

  // v0.9.10 bug 修复：视图生命周期安全空实现——Obsidian（尤其移动端）在 leaf
  // 切换/setViewState/关闭时会对视图实例调用 getEphemeralState/focus 等 View 方法；
  // 本类只 extends Component（TaskNotes 形状），缺省会抛 TypeError → 弹 Notice
  // 「e.getEphemeralState is not a function」/「n.focus is not a function」。
  getEphemeralState(): unknown {
    return {};
  }

  setEphemeralState(state: unknown): void {
    void state;
  }

  focus(): void {
    /* no-op */
  }

  onResize(): void {
    /* no-op（Bases 内部视图用 ResizeObserver 调用渲染对象的 onResize，缺省会抛
       TypeError → Notice「e.onResize is not a function」） */
  }
}

/** 注册审核视图到 Bases（Obsidian 1.10.0+ 公开 API）；false = Bases 未启用。 */
export function registerReviewBasesView(plugin: KnowledgeSystemPlugin): boolean {
  if (typeof plugin.registerBasesView !== 'function') return false;
  try {
    const factory = ((controller: QueryController, containerEl: HTMLElement) =>
      new ReviewBasesView(controller, containerEl, plugin)) as unknown as BasesViewFactory;
    return plugin.registerBasesView(REVIEW_VIEW_TYPE, {
      name: '审核',
      icon: 'check-check',
      factory,
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes('already exists')) return true;
    return false;
  }
}

/** 注销审核视图（公开 API 无 unregister，用内部 registrations 删除，TaskNotes 同款）。 */
export function unregisterReviewBasesView(app: App): void {
  try {
    const internal = (app as unknown as { internalPlugins?: { getEnabledPluginById?: (id: string) => { registrations?: Record<string, unknown> } | null } }).internalPlugins;
    const bases = internal?.getEnabledPluginById?.('bases');
    if (bases?.registrations) delete bases.registrations[REVIEW_VIEW_TYPE];
  } catch {
    /* 忽略：Bases 不可用时无需注销 */
  }
}

// 引用类型，确保 BasesView 形状演进时编译期校验（不实例化）。
export type { BasesView };
