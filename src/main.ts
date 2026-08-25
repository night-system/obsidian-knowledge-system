import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, KnowledgeSystemSettings } from './settings';
import { KnowledgeSystemSettingTab } from './settingsTab';
import { KnowledgeSettingsView, VIEW_TYPE_KS } from './settingsView';
import { fetchModelList } from './core';
import { migrateExtraProperties } from './utils/index';

/**
 * obsidian-knowledge-system — 配置驱动的 AI 知识系统框架。
 *
 * Lifecycle only: load settings (with legacy output-property migration),
 * register the settings tab, register the standalone settings view and the
 * "Show Knowledge System settings view" command, and clean up leaves on unload.
 */
export default class KnowledgeSystemPlugin extends Plugin {
  settings: KnowledgeSystemSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new KnowledgeSystemSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_KS, (leaf) => new KnowledgeSettingsView(this, leaf));

    this.addCommand({
      id: 'show-knowledge-system-settings-view',
      name: 'Show Knowledge System settings view',
      callback: () => {
        void this.activateView();
      },
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_KS);
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

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<KnowledgeSystemSettings>
    );
    this.migrateLegacyOutputProps();
  }

  /**
   * Move the legacy `reviewAttr`/`categoryAttr` output attributes into the new
   * `extraProperties` list the first time the plugin loads (only when the
   * dynamic list is empty). The old fields are kept for read compat.
   */
  private migrateLegacyOutputProps(): void {
    this.settings.extraProperties = migrateExtraProperties(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
