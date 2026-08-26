import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type KnowledgeSystemPlugin from './main';
import { collectPanelMatches } from './panelView';

/** The workspace view type for the sidebar 面板导航. Contract value. */
export const VIEW_TYPE_SIDEBAR = 'knowledge-system-sidebar';

/** 刷新防抖毫秒数（vault/metadataCache 事件合并）。 */
const REFRESH_DEBOUNCE_MS = 1000;
/** 定时轮询间隔（秒）——兜底 vault 事件覆盖不到的变更（如设置修改）。 */
const POLL_INTERVAL_MS = 60_000;

/**
 * v0.9.5：左侧边栏「面板导航」（重写自 v0.9.0 的「提醒面板」规则列表）。
 *
 * 每行一个启用的面板：左侧 = 面板名称，右侧 = 匹配文件数
 * （collectPanelMatches(app, settings, panel).length）；点击行 → 打开对应面板
 * （plugin.openPanel(panel.id)，确保 .base 存在并打开）。底部固定「设置」按钮 →
 * 优先打开设置页并定位本插件 tab（app.setting.open + openTabById），不可用时
 * 回退独立设置视图（plugin.activateView()）。
 *
 * 刷新触发：vault create/delete/rename/modify + metadataCache changed/resolved
 * （防抖 1s 重渲染）、60 秒定时轮询、手动刷新按钮。
 */
export class SidebarView extends ItemView {
  private plugin: KnowledgeSystemPlugin;
  /** 防抖定时器（vault/metadataCache 事件合并）。 */
  private debounceTimer: number | null = null;
  /** 60 秒轮询定时器。 */
  private pollTimer: number | null = null;
  /** onClose 后置位，防止挂起的防抖回调在视图关闭后仍渲染。 */
  private disposed = false;

  constructor(plugin: KnowledgeSystemPlugin, leaf: WorkspaceLeaf) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_SIDEBAR;
  }

  getIcon(): string {
    return 'panel-left';
  }

  getDisplayText(): string {
    return '面板';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('ks-sidebar-view');
    this.disposed = false;

    this.render();

    // vault 事件 + metadataCache 事件 → 防抖 1s 重渲染。
    this.registerEvent(this.app.vault.on('create', () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on('rename', () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on('modify', () => this.scheduleRefresh()));
    this.registerEvent(this.app.metadataCache.on('changed', () => this.scheduleRefresh()));
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.scheduleRefresh()));

    // 兜底轮询：设置变更等不触发 vault 事件的场景（60s）。
    this.pollTimer = window.setInterval(() => this.render(), POLL_INTERVAL_MS);
  }

  async onClose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.contentEl.empty();
  }

  /** 防抖刷新：1 秒内的连续事件合并为一次重渲染。 */
  private scheduleRefresh(): void {
    if (this.disposed) return;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      if (!this.disposed) this.render();
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * 打开设置：优先设置页 + 定位本插件 tab（openTabById('obsidian-knowledge-system')）；
   * app.setting 不在公开类型里（Settings 核心插件），运行时存在，用安全 cast；
   * 不可用/抛错则回退独立设置视图。
   */
  private openSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    }).setting;
    try {
      if (setting && typeof setting.open === 'function' && typeof setting.openTabById === 'function') {
        setting.open();
        setting.openTabById('obsidian-knowledge-system');
        return;
      }
    } catch {
      /* 回退独立设置视图 */
    }
    void this.plugin.activateView();
  }

  /** 全量重渲染：头部（标题 + 刷新按钮）+ 启用的面板导航列表 + 底部设置按钮。 */
  private render(): void {
    if (this.disposed) return;
    const container = this.contentEl;
    container.empty();

    // 头部：标题「面板」+ 手动刷新图标按钮。
    const head = container.createDiv({ cls: 'ks-sidebar-head' });
    head.createSpan({ cls: 'ks-sidebar-title', text: '面板' });
    const refreshBtn = head.createEl('button', {
      cls: 'clickable-icon ks-sidebar-refresh',
      attr: { 'aria-label': '刷新', 'title': '刷新' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.render());

    const panels = (this.plugin.settings.panels || []).filter((p) => p && p.enabled !== false);
    const list = container.createDiv({ cls: 'ks-sidebar-list' });

    if (panels.length === 0) {
      list.createDiv({ cls: 'ks-sidebar-empty', text: '未配置面板（请在设置 → 面板 添加）' });
    } else {
      for (const panel of panels) {
        const count = collectPanelMatches(this.app, this.plugin.settings, panel).length;
        const row = list.createDiv({ cls: 'ks-sidebar-item ks-sidebar-panel-row' });
        row.createDiv({ cls: 'ks-sidebar-item-name', text: panel.name || '未命名面板' });
        row.createDiv({ cls: 'ks-sidebar-item-count', text: `${count} 个` });
        row.addEventListener('click', () => {
          void this.plugin.openPanel(panel.id);
        });
      }
    }

    // 底部固定「设置」按钮。
    const footer = container.createDiv({ cls: 'ks-sidebar-footer' });
    const settingsBtn = footer.createEl('button', { cls: 'ks-sidebar-settings-btn', text: '设置' });
    settingsBtn.addEventListener('click', () => this.openSettings());
  }
}
