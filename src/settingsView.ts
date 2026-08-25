import { ItemView, WorkspaceLeaf } from 'obsidian';
import type KnowledgeSystemPlugin from './main';
import { renderSettings } from './settingsTab';

/** The workspace view type for the standalone settings view. Contract value. */
export const VIEW_TYPE_KS = 'knowledge-system-settings-view';

/**
 * A workspace leaf that renders the same settings UI as the plugin settings
 * tab, so the user can open it as a normal tab (via the command palette). The
 * renderer is shared with `PluginSettingTab` through `renderSettings`.
 */
export class KnowledgeSettingsView extends ItemView {
  private plugin: KnowledgeSystemPlugin;

  constructor(plugin: KnowledgeSystemPlugin, leaf: WorkspaceLeaf) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_KS;
  }

  getIcon(): string {
    return 'gear';
  }

  getDisplayText(): string {
    return 'Knowledge System';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('ks-view');
    renderSettings(this.app, this.plugin, container);
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
