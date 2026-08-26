import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, KnowledgeSystemSettings, TOOL_NAMES } from './settings';
import { KnowledgeSystemSettingTab } from './settingsTab';
import { KnowledgeSettingsView, VIEW_TYPE_KS } from './settingsView';
import { KnowledgeChatView, VIEW_TYPE_CHAT } from './chatView';
import { SidebarView, VIEW_TYPE_SIDEBAR } from './sidebarView';
import { fetchModelList, fetchAnthropicMessages, AnthropicChatMessage } from './core';
import { ANTHROPIC_TOOLS } from './utils/tools';
import { migrateExtraProperties } from './utils/index';
import { ensureReviewBase, registerReviewBasesView, unregisterReviewBasesView, regenerateReviewBaseFile } from './reviewView';

/**
 * obsidian-knowledge-system — 配置驱动的 AI 知识系统框架。
 *
 * Lifecycle only: load settings (with legacy output-property migration),
 * register the settings tab, the standalone settings view + chat view and their
 * commands, and clean up leaves on unload.
 */
export default class KnowledgeSystemPlugin extends Plugin {
  settings: KnowledgeSystemSettings = DEFAULT_SETTINGS;
  /** Bases 视图注册重试定时器（Bases 核心插件可能晚于本插件加载）。 */
  private basesRetryTimer: number | null = null;
  /** v0.8.8：设置写盘串行队列——保证写盘顺序 = 调用顺序、最后一次为最新状态。 */
  private saveChain: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new KnowledgeSystemSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_KS, (leaf) => new KnowledgeSettingsView(this, leaf));
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new KnowledgeChatView(this, leaf));
    // v0.9.0：侧边栏「提醒面板」——左侧边栏视图（命令 + 设置页按钮打开）。
    this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => new SidebarView(this, leaf));

    // v0.8.6：审核页 = Bases 核心插件自定义视图（参考 TaskNotes 的 Bases 集成：
    // registerBasesView 公开 API；Bases 未启用/未加载时 5s 重试，最多 60s）。
    if (!registerReviewBasesView(this)) {
      let tries = 0;
      this.basesRetryTimer = window.setInterval(() => {
        tries++;
        if (registerReviewBasesView(this) || tries >= 12) {
          if (this.basesRetryTimer !== null) {
            window.clearInterval(this.basesRetryTimer);
            this.basesRetryTimer = null;
          }
        }
      }, 5000);
    }

    this.addCommand({
      id: 'show-knowledge-system-settings-view',
      name: 'Show Knowledge System settings view',
      callback: () => {
        void this.activateView();
      },
    });
    this.addCommand({
      id: 'open-knowledge-chat-view',
      name: 'Open Knowledge System chat',
      callback: () => {
        void this.activateChatView();
      },
    });
    this.addCommand({
      id: 'open-review-view',
      name: 'Open review view (审核未审核文件)',
      callback: () => {
        void this.openReviewView();
      },
    });
    this.addCommand({
      id: 'regenerate-review-base',
      name: 'Regenerate review panel (按设置重新生成审核面板)',
      callback: () => {
        void this.regenerateReviewBase();
      },
    });
    // v0.9.0：打开左侧边栏「提醒面板」。
    this.addCommand({
      id: 'open-sidebar-panel',
      name: 'Open sidebar panel (打开左侧边栏面板)',
      callback: () => {
        void this.openSidebarPanel();
      },
    });
  }

  onunload(): void {
    if (this.basesRetryTimer !== null) {
      window.clearInterval(this.basesRetryTimer);
      this.basesRetryTimer = null;
    }
    unregisterReviewBasesView(this.app);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_KS);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SIDEBAR);
  }

  /** Open the standalone settings view in a new tab leaf. */
  async activateView(): Promise<void> {
    // Guarded so the acceptance harness (which stubs workspace without
    // detachLeavesOfType) can still exercise the command path.
    if (typeof this.app.workspace.detachLeavesOfType === 'function') {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_KS);
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_KS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Open the chat view in a new tab leaf. */
  async activateChatView(): Promise<void> {
    if (typeof this.app.workspace.detachLeavesOfType === 'function') {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * v0.8.6：打开「审核」Bases 视图——确保 vault 根「审核.base」存在（filters 跟随
   * 当前输出文件夹），然后在 tab 里打开它（Bases 核心插件按 views[].type 渲染审核视图）。
   */
  async openReviewView(): Promise<void> {
    const baseFile = await ensureReviewBase(this);
    if (!baseFile) return;
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(baseFile);
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * v0.8.7：按当前设置重新生成审核面板（已存在则覆盖重建一次）。
   * 由命令「Regenerate review panel」和设置页「审核」tab 的按钮调用。
   */
  async regenerateReviewBase(): Promise<void> {
    const baseFile = await regenerateReviewBaseFile(this);
    if (baseFile) new Notice('审核面板已按当前设置重新生成');
  }

  /**
   * v0.9.0：打开左侧边栏「提醒面板」——已存在该视图时复用第一个 leaf 并
   * revealLeaf（不新建，避免重复面板）；不存在才新建：优先左侧边栏 leaf
   * （getLeftLeaf(false) 无则回退 getLeaf('tab') 作为普通标签页打开）。
   * 公开方法：命令「Open sidebar panel」与设置页「侧边栏」tab 的按钮都调用它。
   */
  async openSidebarPanel(): Promise<void> {
    // v0.9.0 验收修复：重复调用不再创建重复面板——先复用已有 leaf（参考
    // openChatWith 的复用思路），只在不存在时新建。
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);
    if (existing.length > 0 && existing[0].view) {
      this.app.workspace.revealLeaf(existing[0]);
      new Notice('已打开提醒面板');
      return;
    }
    let leaf = this.app.workspace.getLeftLeaf(false);
    const inSidebar = leaf !== null;
    if (!leaf) leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_SIDEBAR, active: true });
    this.app.workspace.revealLeaf(leaf);
    new Notice(inSidebar ? '已打开提醒面板（左侧边栏）' : '已打开提醒面板（标签页）');
  }

  /**
   * v0.8.6：打开聊天视图并注入上下文（审核页「AI 修改」按钮用）：
   * 预填 prompt 文本（审核页已用「AI 修改提示词」模板替换 {{filename}} → 文件名）
   * + 切换到指定预设。上下文经 setViewState 的 state 传给 KnowledgeChatView.setState。
   *
   * v0.8.9：`prompt` = 最终提示词文本（不含路径；模板无占位符时原样使用）。
   * v0.8.9 修复：聊天视图已打开（leaf 存在）时 setViewState 只调 setState 不重跑
   * onOpen，导致预设/文件引用不生效——此时改为直接调用视图的 applyChatContext。
   */
  async openChatWith(prompt: string, presetId?: string): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (leaves.length > 0 && leaves[0].view) {
      const view = leaves[0].view as KnowledgeChatView;
      await view.applyChatContext(prompt, presetId);
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: VIEW_TYPE_CHAT,
      active: true,
      state: { prompt, presetId },
    });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Issue one Anthropic-compatible chat request (POST {baseUrl}/v1/messages,
   * stream). Exposed so the acceptance harness can assert the protocol headers /
   * endpoint without using the chat UI. Returns the response status + body text.
   */
  async streamChat(messages: AnthropicChatMessage[]): Promise<{ status: number; text: string }> {
    return fetchAnthropicMessages(this.settings, messages, { tools: ANTHROPIC_TOOLS });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<KnowledgeSystemSettings>
    );
    this.migrateLegacyOutputProps();
    // v0.8.8：迁移旧预设 enabledTools（空/缺失 = 全开 → 显式全开），有改动才落盘一次。
    if (this.migratePresetEnabledTools()) await this.saveSettings();
  }

  /**
   * v0.8.8：迁移旧数据——旧语义「空 enabledTools = 全部启用」改为「显式集合」：
   * 缺失或空数组的预设改写为 TOOL_NAMES.slice()（显式全开），迁移后行为与旧版
   * 一致（全开），但磁盘上的数据不再有歧义（空数组现在 = 全部关闭）。
   * @returns 是否有任何预设被改写（有 → 需要保存一次）。
   */
  private migratePresetEnabledTools(): boolean {
    const presets = this.settings.toolPresets ?? [];
    let changed = false;
    for (const p of presets) {
      if (!p || !Array.isArray(p.enabledTools) || p.enabledTools.length === 0) {
        p.enabledTools = TOOL_NAMES.slice();
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Move the legacy `reviewAttr`/`categoryAttr` output attributes into the new
   * `extraProperties` list the first time the plugin loads (only when the
   * dynamic list is empty). The old fields are kept for read compat.
   */
  private migrateLegacyOutputProps(): void {
    this.settings.extraProperties = migrateExtraProperties(this.settings);
  }

  /**
   * v0.8.8：设置保存串行化——连续快速调用时按调用顺序排队写盘（每次写最新
   *  `this.settings`），避免并发写盘顺序无保证/失败静默吞掉造成内存与磁盘分叉。
   */
  async saveSettings(): Promise<void> {
    this.saveChain = this.saveChain.then(() => this.saveData(this.settings)).catch(() => undefined);
    return this.saveChain;
  }

  /**
   * Fetch the provider's model list (GET /models). Exposed publicly so the
   * settings tab button and the harness both call it. On success the returned
   * ids are persisted onto the settings.
   */
  async fetchModels(
    apiKey: string,
    baseUrl: string
  ): Promise<{ ok: boolean; modelIds: string[]; message: string }> {
    const result = await fetchModelList(
      apiKey || this.settings.apiKey,
      baseUrl || this.settings.baseUrl
    );
    if (result.ok) {
      this.settings.models = result.modelIds;
      if (result.modelIds.length > 0) this.settings.model = result.modelIds[0];
      await this.saveSettings();
    }
    return result;
  }
}
