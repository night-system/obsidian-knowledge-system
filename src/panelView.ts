import { App, Component, Notice, TFile, setIcon } from 'obsidian';
import type { BasesView, BasesViewFactory, QueryController } from 'obsidian';
import type KnowledgeSystemPlugin from './main';
import type { PanelConfig } from './settings';
import { parseAfterDate, renderPromptTemplate } from './utils/review';

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
 * - bool 属性：frontmatter[panel.attr] 缺失、null、空、或 String(值).toLowerCase()
 *   !== 'true' → 显示；否则隐藏。
 * 每条提供「打开」（点击文件名）和「聊天」（message-square 图标 → openChatWith：
 * 应用面板自己的预设 + 预填 panel.chatPrompt 模板渲染结果）。
 */
export const PANEL_VIEW_TYPE = 'ks-panel';

/**
 * 解析面板扫描文件夹 → 实际 vault 路径：'source'/'output' 映射全局设置
 * sourceFolder/outputFolder，其他值 = 自定义路径（留空 = '/' 全库）。
 */
export function resolvePanelFolder(plugin: KnowledgeSystemPlugin, folder: string): string {
  if (folder === 'source') return plugin.settings.sourceFolder || '/';
  if (folder === 'output') return plugin.settings.outputFolder || '/';
  return folder || '/';
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
 * 面板视图：列出扫描文件夹中、afterDate 之后修改/创建、且 bool 属性缺失/非 true
 * 的文件；每条可「打开」或「聊天」。所有面板共用此视图类，用 config.name 匹配
 * settings.panels 里的配置。
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
    head.createSpan({ cls: 'ks-panel-hint', text: '点击笔记标题打开文件；点击聊天图标用面板配置的预设进入聊天并引用此文件。把「bool 属性」设为 true 后文件会从这里消失。' });

    // 列表：只显示 afterDate 之后修改/创建、且 bool 属性缺失或非 true 的文件。
    const attr = (panel.attr || '').trim();
    const afterMs = parseAfterDate(panel.afterDate);
    const list = this.containerEl.createDiv({ cls: 'ks-panel-list' });
    const entries = this.data?.data ?? [];
    let count = 0;
    for (const entry of entries) {
      const file = entry.file;
      if (!file) continue;
      if (afterMs !== null) {
        const mtime = (file.stat && file.stat.mtime) || file.stat.ctime || 0;
        if (mtime < afterMs) continue;
      }
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (attr) {
        const raw = fm?.[attr];
        // bool 属性缺失、null、空、或值（字符串化、忽略大小写）非 'true' → 需要处理。
        const isDone = raw !== undefined && raw !== null && raw !== '' && String(raw).toLowerCase() === 'true';
        if (isDone) continue;
      }
      count++;

      const row = list.createDiv({ cls: 'ks-panel-item' });
      const info = row.createDiv({ cls: 'ks-panel-item-info' });
      const nameEl = info.createDiv({ cls: 'ks-panel-item-name', text: file.basename });
      // 点击标题直接打开笔记（与审核/整理页一致：必须用 getLeaf('tab')，Bases 视图
      // 上下文里 getLeaf(false) 会抛「e.getEphemeralState is not a function」）。
      nameEl.addEventListener('click', () => {
        void this.app.workspace.getLeaf('tab').openFile(file);
      });

      const ops = row.createDiv({ cls: 'ks-panel-item-ops' });
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
