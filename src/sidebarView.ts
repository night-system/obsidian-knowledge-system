import { ItemView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type KnowledgeSystemPlugin from './main';
import type { SidebarRule } from './settings';
import { evaluateCondition } from './utils/sidebarRules';
import { renderPromptTemplate } from './utils/review';

/** The workspace view type for the sidebar 提醒面板. Contract value. */
export const VIEW_TYPE_SIDEBAR = 'knowledge-system-sidebar';

/** 刷新防抖毫秒数（vault/metadataCache 事件合并）。 */
const REFRESH_DEBOUNCE_MS = 1000;
/** 定时轮询间隔（秒）——兜底 vault 事件覆盖不到的变更（如设置修改）。 */
const POLL_INTERVAL_MS = 60_000;

/**
 * v0.9.0：左侧边栏「提醒面板」。
 *
 * 按规则显示条目：每条规则 = 条件 + 动作；条目形态 = 一行描述文本 + 右侧一个
 * 图标按钮，点图标执行动作（点描述不响应）。
 * - `open_review` 动作：单条（描述 = 规则名（N 个匹配）），图标打开审核面板。
 * - `open_chat` 动作：每个匹配文件一条（描述 = 文件名），图标打开聊天
 *   （应用 presetId 预设 + 预填 promptTemplate 渲染结果，{{filename}} → basename）。
 * - 条件匹配 0 条 → 该规则不显示条目（不显示空行）。
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
    return '提醒面板';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('ks-sidebar-view');
    this.disposed = false;

    this.render();

    // v0.9.0：vault 事件 + metadataCache 事件 → 防抖 1s 重渲染。
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

  /** 全量重渲染：头部（标题 + 刷新按钮）+ 规则条目列表。 */
  private render(): void {
    if (this.disposed) return;
    const container = this.contentEl;
    container.empty();

    // 头部：标题「提醒」+ 手动刷新图标按钮。
    const head = container.createDiv({ cls: 'ks-sidebar-head' });
    head.createSpan({ cls: 'ks-sidebar-title', text: '提醒' });
    const refreshBtn = head.createEl('button', {
      cls: 'clickable-icon ks-sidebar-refresh',
      attr: { 'aria-label': '刷新', 'title': '刷新' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.render());

    const rules = this.plugin.settings.sidebarRules || [];
    const list = container.createDiv({ cls: 'ks-sidebar-list' });

    if (rules.length === 0) {
      list.createDiv({ cls: 'ks-sidebar-empty', text: '未配置规则（请在设置 → 侧边栏 添加规则）' });
      return;
    }

    let shown = 0;
    for (const rule of rules) {
      if (!rule || rule.enabled === false) continue;
      const matches = evaluateCondition(this.app, this.plugin.settings, rule.condition);
      if (matches.length === 0) continue; // 条件匹配 0 条 → 不显示条目（不显示空行）
      shown += this.renderRuleEntries(list, rule, matches);
    }
    if (shown === 0) {
      list.createDiv({ cls: 'ks-sidebar-empty', text: '没有满足条件的规则' });
    }
  }

  /** 渲染一条规则下的条目；返回渲染的条目数。 */
  private renderRuleEntries(list: HTMLElement, rule: SidebarRule, matches: TFile[]): number {
    if (rule.action.type === 'open_review') {
      // 单条：描述 = 规则名（N 个匹配）；图标 = 打开审核面板。
      const row = list.createDiv({ cls: 'ks-sidebar-item' });
      row.createDiv({ cls: 'ks-sidebar-item-desc', text: `${rule.name || '未命名规则'}（${matches.length} 个匹配）` });
      const btn = row.createEl('button', {
        cls: 'clickable-icon ks-sidebar-item-btn',
        attr: { 'aria-label': '打开审核面板', 'title': '打开审核面板' },
      });
      setIcon(btn, 'external-link');
      btn.addEventListener('click', () => {
        void this.plugin.openReviewView();
      });
      return 1;
    }

    // open_chat：每个匹配文件一条；描述 = 文件名；图标 = 聊天。
    const action = rule.action as Extract<SidebarRule['action'], { type: 'open_chat' }>;
    for (const file of matches) {
      const row = list.createDiv({ cls: 'ks-sidebar-item' });
      row.createDiv({ cls: 'ks-sidebar-item-desc', text: this.entryDescription(file, rule) });
      const btn = row.createEl('button', {
        cls: 'clickable-icon ks-sidebar-item-btn',
        attr: { 'aria-label': '打开聊天', 'title': '打开聊天' },
      });
      setIcon(btn, 'message-square');
      btn.addEventListener('click', () => {
        const template = action.promptTemplate || '';
        const prompt = renderPromptTemplate(template, file.basename);
        void this.plugin.openChatWith(prompt, action.presetId || undefined);
      });
    }
    return matches.length;
  }

  /** open_chat 条目的描述文本（文件名；缺属性规则附带说明）。 */
  private entryDescription(file: TFile, rule: SidebarRule): string {
    if (rule.condition.type === 'missing_property') {
      const prop = (rule.condition.property || '').trim();
      const expected = rule.condition.expectedValue;
      if (expected !== undefined && expected !== null && String(expected).trim() !== '') {
        return `${file.basename}.md ${prop}≠${String(expected)}`;
      }
      return `${file.basename}.md 缺${prop || '属性'}`;
    }
    return `${file.basename}.md`;
  }
}
