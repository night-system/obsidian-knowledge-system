import { App, Component, Modal, Notice, TFile, ToggleComponent, setIcon } from 'obsidian';
import type { BasesView, BasesViewFactory, QueryController } from 'obsidian';
import type KnowledgeSystemPlugin from './main';
import type { KnowledgeSystemSettings, PanelConfig } from './settings';
import { parseAfterDate, renderPromptTemplate } from './utils/review';

/**
 * v0.9.4：删除文件二次确认弹窗（面板条目垃圾桶按钮用）。
 * 确认后把文件移到系统回收站（Obsidian 删除惯例 vault.trash(file, true)），
 * 成功后回调 onDeleted（视图重渲染）并 Notice。
 */
class ConfirmDeleteModal extends Modal {
  private file: TFile;
  private onDeleted: () => void;

  constructor(app: App, file: TFile, onDeleted: () => void) {
    super(app);
    this.file = file;
    this.onDeleted = onDeleted;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '删除文件' });
    contentEl.createDiv({ cls: 'ks-panel-del-modal-text', text: `确定要删除「${this.file.basename}」吗？此操作不可撤销。` });
    const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = btnRow.createEl('button', { cls: 'mod-ghost', text: '取消' });
    cancelBtn.addEventListener('click', () => this.close());
    const confirmBtn = btnRow.createEl('button', { cls: 'mod-warning', text: '删除' });
    confirmBtn.addEventListener('click', () => {
      void this.deleteFile();
    });
  }

  private async deleteFile(): Promise<void> {
    try {
      await this.app.vault.trash(this.file, true);
      new Notice(`已删除 ${this.file.basename}`);
      this.onDeleted();
      this.close();
    } catch (e) {
      new Notice(`删除失败：${String(e)}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * v0.9.3：用户自定义面板（Obsidian Bases 核心插件自定义视图）——泛化自
 * v0.9.2 的整理面板（tidyView.ts）：一个通用 viewType `ks-panel`，所有面板
 * 共用；每个 .base 文件（filters 限定扫描文件夹 + views[].name = 面板名）
 * 实例化一个视图，视图用 `this.config.name` 匹配 `settings.panels` 里同名
 * 的面板配置来渲染。
 *
 * 与 tidyView 相同的 Bases 集成四件套：
 * 1) plugin.registerBasesView(viewId, registration) 注册自定义视图；
 * 2) 视图类实现 BasesView 形状（type + onDataUpdated，Component 生命周期）；
 * 3) .base 文件（YAML：filters + views[].type = viewId）定义数据源 = 扫描文件夹；
 * 4) 自定义 CSS 类名渲染（styles.css 的 .ks-panel-*，复制自 .ks-tidy-*）。
 *
 * 数据流：.base 文件的 filters 限定扫描文件夹（panel.folder 解析出的实际路径），
 * Bases 查询把该文件夹所有 md 文件（含 frontmatter）交给视图（this.data.data:
 * BasesEntry[]）；视图在 onDataUpdated 里做两层过滤：
 * - 日期：file.stat.mtime（回退 ctime）>= afterDate 当天 00:00（解析失败/留空 = 不限）；
 * - bool 属性（v0.9.9）：frontmatter[panel.attr] **必须存在**（缺失/null 不显示）且
 *   String(值).toLowerCase() !== 'true' → 显示；否则隐藏。
 * 每条提供「打开」（点击文件名）、「bool 开关」（v0.9.4：把 frontmatter[panel.attr]
 * 设为 true → 条目消失 / v0.9.9：关闭则写 false → 条目回到面板）和「聊天」
 * （message-square 图标 → openChatWith：应用面板自己的预设 + 预填 panel.chatPrompt
 * 模板渲染结果）；v0.9.4 还提供「垃圾桶」（trash-2，panel.showDelete !== false 时
 * 显示）——二次确认后把文件移到系统回收站。
 */
export const PANEL_VIEW_TYPE = 'ks-panel';

/**
 * 解析面板扫描文件夹 → 实际 vault 路径：'source'/'output' 映射全局设置
 * sourceFolder/outputFolder，其他值 = 自定义路径（留空 = '/' 全库）。
 */
export function resolvePanelFolder(plugin: KnowledgeSystemPlugin, folder: string): string {
  return resolvePanelFolderFromSettings(plugin.settings, folder);
}

/** 同 resolvePanelFolder，但只依赖 settings（v0.9.5：collectPanelMatches 内部用）。 */
function resolvePanelFolderFromSettings(settings: KnowledgeSystemSettings, folder: string): string {
  if (folder === 'source') return settings.sourceFolder || '/';
  if (folder === 'output') return settings.outputFolder || '/';
  return folder || '/';
}

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

/** 解析文件夹：路径 → TFolder（不存在/非法 → 库根）。 */
function resolveFolder(app: App, raw: string): unknown {
  const s = (raw || '/').trim();
  if (s === '/' || s === '') return app.vault.getRoot();
  const p = s.replace(/^\/+|\/+$/g, '');
  if (!p) return app.vault.getRoot();
  const found = app.vault.getAbstractFileByPath(p);
  return isFolderLike(found) ? found : app.vault.getRoot();
}

/**
 * v0.9.5：面板匹配判定提取为公共函数（面板视图与左侧边栏面板导航共用）。
 * - folder 解析（source/output → settings.sourceFolder/outputFolder，其他 = 自定义路径）→
 *   递归取 md → afterDate 过滤（parseAfterDate，mtime 回退 ctime）→
 *   attr 判定（缺失/null/空/`String(v).toLowerCase() !== 'true'` → 匹配）。
 * - 可选 `files` 参数：传入时跳过文件夹扫描，直接过滤给定列表（面板视图的数据来自
 *   Bases，folder 已由 .base filters 限定，传入 entries 的 file 列表即可，行为一致）。
 */
export function collectPanelMatches(
  app: App,
  settings: KnowledgeSystemSettings,
  panel: PanelConfig,
  files?: TFile[]
): TFile[] {
  const list = files ?? getMarkdownFilesInFolder(resolveFolder(app, resolvePanelFolderFromSettings(settings, panel.folder)));
  const afterMs = parseAfterDate(panel.afterDate);
  const attr = (panel.attr || '').trim();
  return list.filter((file) => {
    if (afterMs !== null) {
      const mtime = (file.stat && file.stat.mtime) || file.stat.ctime || 0;
      if (mtime < afterMs) return false;
    }
    if (attr) {
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      const raw = fm?.[attr];
      // v0.9.9：属性**必须存在**（fm[attr] !== undefined && !== null）且值（字符串化、
      // 忽略大小写）不是 'true' → 匹配；属性缺失/null 的文件不再进入面板。
      const exists = raw !== undefined && raw !== null;
      if (!exists) return false;
      if (String(raw).toLowerCase() === 'true') return false;
    }
    return true;
  });
}

/**
 * 生成面板 .base 文件内容（YAML）。
 * - filters：扫描文件夹非根（'/'）时用 `file.inFolder("<folder>")` 限定数据源。
 * - views[].type = PANEL_VIEW_TYPE（Bases 用这个类型实例化我们的视图）；
 *   views[].name = 面板名（视图按它匹配 settings.panels 里的配置）。
 */
export function buildPanelBaseYaml(folder: string, attr: string, name: string): string {
  const f = (folder || '/').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const conditions: string[] = [];
  if (f !== '/') conditions.push(`file.inFolder("${f}")`);
  const lines: string[] = [];
  if (conditions.length > 0) {
    lines.push('filters:');
    lines.push('  and:');
    for (const c of conditions) lines.push(`    - ${c}`);
  }
  lines.push('views:');
  lines.push(`  - type: ${PANEL_VIEW_TYPE}`);
  lines.push(`    name: ${name || '面板'}`);
  lines.push('    order:');
  lines.push('      - file.name');
  lines.push(`      - note["${attr}"]`);
  return lines.join('\n') + '\n';
}

/** 面板 .base 路径（v0.9.3：由面板配置 basePath 决定；缺省 `${name}.base`）。 */
function panelBasePathOf(panel: PanelConfig): string {
  const p = (panel.basePath || `${panel.name || '面板'}.base`).replace(/\\/g, '/').trim();
  return p || `${panel.name || '面板'}.base`;
}

/** 确保面板（.base 文件）存在且内容与当前配置一致。 */
export async function ensurePanelBase(plugin: KnowledgeSystemPlugin, panel: PanelConfig): Promise<TFile | null> {
  const vault = plugin.app.vault;
  const path = panelBasePathOf(panel);
  const yaml = buildPanelBaseYaml(resolvePanelFolder(plugin, panel.folder), panel.attr, panel.name);
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
    new Notice(`创建面板「${panel.name || '未命名'}」失败：${String(e)}`);
    return null;
  }
}

/** v0.9.3：按面板配置重新生成 .base 文件（已存在则覆盖重建一次）。 */
export async function regeneratePanelBaseFile(plugin: KnowledgeSystemPlugin, panel: PanelConfig): Promise<TFile | null> {
  const vault = plugin.app.vault;
  const path = panelBasePathOf(panel);
  const yaml = buildPanelBaseYaml(resolvePanelFolder(plugin, panel.folder), panel.attr, panel.name);
  try {
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await vault.modify(existing, yaml);
      return existing;
    }
    const created = await vault.create(path, yaml);
    return created instanceof TFile ? created : null;
  } catch (e) {
    new Notice(`重新生成面板「${panel.name || '未命名'}」失败：${String(e)}`);
    return null;
  }
}

/**
 * 面板视图：列出扫描文件夹中、afterDate 之后修改/创建、且 bool 属性**存在而
 * 非 true**（v0.9.9：属性缺失的文件不显示）的文件；每条可「打开」或「聊天」。
 * 所有面板共用此视图类，用 config.name 匹配 settings.panels 里的配置。
 * 不 extends BasesView 抽象类（Bases 在工厂返回后注入 app/config/data），
 * 实现相同形状即可，工厂里 cast（与 ReviewBasesView/TidyBasesView 同款做法）。
 */
export class PanelBasesView extends Component {
  type = PANEL_VIEW_TYPE;
  app: App;
  config: unknown;
  allProperties: string[] = [];
  data: { data: { file?: TFile }[] } | null = null;

  private containerEl: HTMLElement;
  private plugin: KnowledgeSystemPlugin;

  constructor(controller: QueryController, containerEl: HTMLElement, plugin: KnowledgeSystemPlugin) {
    super();
    void controller;
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.app = plugin.app;
  }

  onload(): void {
    this.containerEl.addClass('ks-panel-view');
    this.render();
  }

  /** Bases 查询结果变化（vault 文件/frontmatter 变化）时自动重渲染。 */
  onDataUpdated(): void {
    this.render();
  }

  /** 从 .base 的 views[].name（this.config.name）找到同名面板配置；找不到返回 null。 */
  private findPanel(): PanelConfig | null {
    const name = (this.config as { name?: string } | null | undefined)?.name;
    if (!name) return null;
    const panels = this.plugin.settings.panels || [];
    return panels.find((p) => p && p.name === name) || null;
  }

  private render(): void {
    this.containerEl.empty();

    const panel = this.findPanel();
    if (!panel) {
      // 配置找不到（面板被删/改名后旧的 .base 还在）：提示去设置检查。
      this.containerEl.createDiv({ cls: 'ks-panel-empty', text: '未找到面板配置，请在设置 → 面板 检查。' });
      return;
    }

    // 头部：标题 = 面板名 + 刷新按钮（预设由面板配置固定，无下拉）。
    const head = this.containerEl.createDiv({ cls: 'ks-panel-head' });
    head.createSpan({ cls: 'ks-panel-title', text: panel.name || '面板' });
    const refreshBtn = head.createEl('button', { cls: 'clickable-icon ks-panel-refresh', attr: { 'aria-label': '刷新', 'title': '刷新' } });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.render());
    head.createSpan({ cls: 'ks-panel-hint', text: '点击笔记标题打开文件；右侧开关把「bool 属性」设为 true（条目消失）、垃圾桶删除文件（需二次确认，可关）；聊天图标用面板配置的预设进入聊天并引用此文件。' });

    // 列表：只显示匹配的面板文件（v0.9.5：判定提取为公共函数 collectPanelMatches；
    // 视图数据来自 Bases，folder 已由 .base filters 限定，把 entries 的 file 列表传入即可）。
    const attr = (panel.attr || '').trim();
    const list = this.containerEl.createDiv({ cls: 'ks-panel-list' });
    const entries = this.data?.data ?? [];
    const files = entries.map((e) => e.file).filter((f): f is TFile => !!f);
    const matches = collectPanelMatches(this.app, this.plugin.settings, panel, files);
    let count = 0;
    for (const file of matches) {
      count++;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;

      const row = list.createDiv({ cls: 'ks-panel-item' });
      const info = row.createDiv({ cls: 'ks-panel-item-info' });
      const nameEl = info.createDiv({ cls: 'ks-panel-item-name', text: file.basename });
      // 点击标题直接打开笔记（与审核/整理页一致：必须用 getLeaf('tab')，Bases 视图
      // 上下文里 getLeaf(false) 会抛「e.getEphemeralState is not a function」）。
      nameEl.addEventListener('click', () => {
        void this.app.workspace.getLeaf('tab').openFile(file);
      });

      const ops = row.createDiv({ cls: 'ks-panel-item-ops' });
      // v0.9.4：条目右侧操作区 = [垃圾桶] [bool 开关] [聊天]（垃圾桶在开关左边，聊天最右）。
      // 垃圾桶按钮（lucide trash-2，面板配置 showDelete !== false 才显示）——点击弹
      // 二次确认，确认后把文件移到系统回收站（vault.trash(file, true)）。
      if (panel.showDelete !== false) {
        const delBtn = ops.createEl('button', { cls: 'clickable-icon ks-panel-del', attr: { 'aria-label': '删除文件', 'title': '删除文件' } });
        setIcon(delBtn, 'trash-2');
        delBtn.addEventListener('click', () => {
          new ConfirmDeleteModal(this.app, file, () => this.render()).open();
        });
      }
      // bool 开关：状态 = frontmatter[panel.attr] === true（面板判定的 bool 语义）。
      // 开 = 写入布尔 true（条目随即移出面板）；关 = 写 false（v0.9.9：属性必须存在
      // 才显示，写 false 让条目回到面板；delete 会让属性缺失 → 条目消失，语义错误）。
      // 用 fileManager.processFrontMatter 写盘（触发 metadataCache → Bases 重渲染），
      // 再直接 this.render() 兜底刷新开关状态。
      const toggle = new ToggleComponent(ops)
        .setValue(fm?.[attr] === true)
        .setTooltip(`标记为「${attr}」= true（处理后条目消失）`)
        .onChange(async (on) => {
          if (!attr) return;
          try {
            await this.app.fileManager.processFrontMatter(file, (f) => {
              if (on) f[attr] = true;
              else f[attr] = false;
            });
            this.render();
          } catch (e) {
            new Notice(`标记失败：${String(e)}`);
          }
        });
      void toggle;
      // 聊天图标按钮（lucide messages-square，与整理面板同款）——用面板的
      // 「聊天 prompt 模板」替换 {{filename}} → file.basename（不含路径、不含 .md），
      // 把**最终 prompt 文本**传给聊天视图，预设用面板自己的 chatPresetId。
      const chatBtn = ops.createEl('button', { cls: 'clickable-icon ks-panel-chat', attr: { 'aria-label': '聊天', 'title': '聊天' } });
      setIcon(chatBtn, 'messages-square');
      chatBtn.addEventListener('click', () => {
        const template = (panel.chatPrompt || '').trim()
          || '请查看「{{filename}}」并帮我处理。';
        const prompt = renderPromptTemplate(template, file.basename);
        void this.plugin.openChatWith(prompt, panel.chatPresetId || undefined);
      });
    }
    if (count === 0) {
      list.createDiv({ cls: 'ks-panel-empty', text: '该文件夹里没有需要处理的文件' });
    } else {
      list.createDiv({ cls: 'ks-panel-count', text: `共 ${count} 个需要处理的文件` });
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

/** 注册面板视图到 Bases（Obsidian 1.10.0+ 公开 API）；false = Bases 未启用。 */
export function registerPanelBasesView(plugin: KnowledgeSystemPlugin): boolean {
  if (typeof plugin.registerBasesView !== 'function') return false;
  try {
    const factory = ((controller: QueryController, containerEl: HTMLElement) =>
      new PanelBasesView(controller, containerEl, plugin)) as unknown as BasesViewFactory;
    return plugin.registerBasesView(PANEL_VIEW_TYPE, {
      name: '自定义面板',
      icon: 'list-todo',
      factory,
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes('already exists')) return true;
    return false;
  }
}

/** 注销面板视图（公开 API 无 unregister，用内部 registrations 删除，TaskNotes 同款）。 */
export function unregisterPanelBasesView(app: App): void {
  try {
    const internal = (app as unknown as { internalPlugins?: { getEnabledPluginById?: (id: string) => { registrations?: Record<string, unknown> } | null } }).internalPlugins;
    const bases = internal?.getEnabledPluginById?.('bases');
    if (bases?.registrations) delete bases.registrations[PANEL_VIEW_TYPE];
  } catch {
    /* 忽略：Bases 不可用时无需注销 */
  }
}

// 引用类型，确保 BasesView 形状演进时编译期校验（不实例化）。
export type { BasesView };
