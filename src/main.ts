import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, KnowledgeSystemSettings } from './settings';
import { registerCommands } from './commands';
import { KnowledgeSystemSettingTab } from './settingsTab';

/**
 * obsidian-knowledge-system — 配置驱动的 AI 知识系统框架（第一阶段 MVP）。
 *
 * This entry module only wires up the plugin lifecycle: load settings, register
 * the two commands and expose the settings tab. All feature logic lives in
 * `core.ts` (files + DeepSeek models), `commands.ts` and `settingsTab.ts`.
 */
export default class KnowledgeSystemPlugin extends Plugin {
  settings: KnowledgeSystemSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    registerCommands(this);
    this.addSettingTab(new KnowledgeSystemSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<KnowledgeSystemSettings>);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
