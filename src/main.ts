import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, KnowledgeSystemSettings, TOOL_NAMES } from './settings';
import type { PanelConfig } from './settings';
import { KnowledgeSystemSettingTab } from './settingsTab';
import { KnowledgeSettingsView, VIEW_TYPE_KS } from './settingsView';
import { KnowledgeChatView, VIEW_TYPE_CHAT } from './chatView';
import { SidebarView, VIEW_TYPE_SIDEBAR } from './sidebarView';
import { fetchModelList, fetchAnthropicMessages, AnthropicChatMessage } from './core';
import { ANTHROPIC_TOOLS } from './utils/tools';
import { migrateExtraProperties } from './utils/index';
import { ensureReviewBase, registerReviewBasesView, unregisterReviewBasesView, regenerateReviewBaseFile } from './reviewView';
import { ensureTidyBase, registerTidyBasesView, unregisterTidyBasesView, regenerateTidyBaseFile } from './tidyView';
import { ensurePanelBase, registerPanelBasesView, unregisterPanelBasesView, regeneratePanelBaseFile } from './panelView';

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
    // v0.9.2：整理面板（tidyView.ts）同机制——与审核合并到同一个重试定时器里，
    // 两者都注册成功（或重试到上限）才停。
    // v0.9.3：用户自定义面板（panelView.ts）同机制——三者都注册成功才停。
    // 旧面板兼容：ks-review / ks-tidy 注册保留，旧 .base 文件仍可打开；新面板用 ks-panel。
    if (!registerReviewBasesView(this) || !registerTidyBasesView(this) || !registerPanelBasesView(this)) {
      let tries = 0;
      this.basesRetryTimer = window.setInterval(() => {
        tries++;
        const reviewOk = registerReviewBasesView(this);
        const tidyOk = registerTidyBasesView(this);
        const panelOk = registerPanelBasesView(this);
        if ((reviewOk && tidyOk && panelOk) || tries >= 12) {
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
    // v0.9.2：整理面板（Bases 视图，与审核页同机制）。
    this.addCommand({
      id: 'open-tidy-view',
      name: 'Open tidy view (打开整理面板)',
      callback: () => {
        void this.openTidyView();
      },
    });
    this.addCommand({
      id: 'regenerate-tidy-base',
      name: 'Regenerate tidy panel (按设置重新生成整理面板)',
      callback: () => {
        void this.regenerateTidyBase();
      },
    });
    // v0.9.3：用户自定义面板——命令作用于第一个启用的面板（无面板时 Notice 提示）。
    this.addCommand({
      id: 'open-panel',
      name: 'Open panel (打开面板)',
      callback: () => {
        void this.openPanel();
      },
    });
    this.addCommand({
      id: 'regenerate-panel',
      name: 'Regenerate panel (重新生成面板)',
      callback: () => {
        void this.regeneratePanel();
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
    unregisterTidyBasesView(this.app);
    unregisterPanelBasesView(this.app);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_KS);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SIDEBAR);
  }

  /**
   * v0.9.7：打开本插件独立设置视图——在当前活跃 leaf 打开（替换当前标签页内容，
   * 不新建标签页；侧边栏「设置」按钮经命令走这里）；无活跃 leaf 时回退新标签页。
   */
  async activateView(): Promise<void> {
    // Guarded so the acceptance harness (which stubs workspace without
    // detachLeavesOfType) can still exercise the command path.
    if (typeof this.app.workspace.detachLeavesOfType === 'function') {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_KS);
    }
    const leaf = this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf('tab');
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
   * 当前输出文件夹），然后在当前活跃 leaf 打开它（v0.9.7：不新建标签页，替换当前
   * 标签页内容；Bases 核心插件按 views[].type 渲染审核视图）。
   */
  async openReviewView(): Promise<void> {
    const baseFile = await ensureReviewBase(this);
    if (!baseFile) return;
    const leaf = this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf('tab');
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
   * v0.9.2：打开「整理」Bases 视图——确保 settings.tidyBasePath 的 .base 存在
   * （filters 跟随当前源文件夹），然后在当前活跃 leaf 打开它（v0.9.7：不新建标签页；
   * Bases 核心插件按 views[].type 渲染整理视图）。由命令「Open tidy view」和设置页
   * 「整理」tab 的按钮调用。
   */
  async openTidyView(): Promise<void> {
    const baseFile = await ensureTidyBase(this);
    if (!baseFile) return;
    const leaf = this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf('tab');
    await leaf.openFile(baseFile);
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * v0.9.2：按当前设置重新生成整理面板（已存在则覆盖重建一次）。
   * 由命令「Regenerate tidy panel」和设置页「整理」tab 的按钮调用。
   */
  async regenerateTidyBase(): Promise<void> {
    const baseFile = await regenerateTidyBaseFile(this);
    if (baseFile) new Notice('整理面板已按当前设置重新生成');
  }

  /** v0.9.3：第一个启用的面板（命令默认目标）；无则 null。 */
  private firstEnabledPanel(): PanelConfig | null {
    const panels = this.settings.panels || [];
    return panels.find((p) => p && p.enabled !== false) || null;
  }

  /**
   * v0.9.3：打开用户自定义面板——panelId 缺省 = 第一个启用的面板。按 id 找面板
   * 配置 → 确保其 .base 存在（filters 跟随面板扫描文件夹），然后在当前活跃 leaf
   * 打开（v0.9.7：不新建标签页，替换当前标签页内容；Bases 核心插件按
   * views[].type = ks-panel 渲染面板视图）。由命令「Open panel」、设置页「面板」
   * tab 的「打开面板」按钮和左侧边栏面板导航行调用。
   */
  async openPanel(panelId?: string): Promise<void> {
    const panels = this.settings.panels || [];
    const panel = panelId
      ? panels.find((p) => p && p.id === panelId)
      : this.firstEnabledPanel();
    if (!panel) {
      new Notice('未找到面板：请在设置 → 面板 创建并启用面板');
      return;
    }
    const baseFile = await ensurePanelBase(this, panel);
    if (!baseFile) return;
    const leaf = this.app.workspace.getLeaf(false) ?? this.app.workspace.getLeaf('tab');
    await leaf.openFile(baseFile);
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * v0.9.3：按面板配置重新生成 .base（已存在则覆盖重建一次）。panelId 缺省 =
   * 第一个启用的面板。由命令「Regenerate panel」和设置页「面板」tab 的
   * 「生成面板」按钮调用。
   */
  async regeneratePanel(panelId?: string): Promise<void> {
    const panels = this.settings.panels || [];
    const panel = panelId
      ? panels.find((p) => p && p.id === panelId)
      : this.firstEnabledPanel();
    if (!panel) {
      new Notice('未找到面板：请在设置 → 面板 创建并启用面板');
      return;
    }
    const baseFile = await regeneratePanelBaseFile(this, panel);
    if (baseFile) new Notice(`面板「${panel.name || '未命名'}」已按当前设置重新生成`);
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
