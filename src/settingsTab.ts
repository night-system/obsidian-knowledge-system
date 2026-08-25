import { App, DropdownComponent, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { KnowledgeSystemSettings } from './settings';
import { FolderSuggest } from './folderSuggest';
import type KnowledgeSystemPlugin from './main';

/** The settings tabs. Order matches fast-note-sync's tab header pattern. */
type TabId = 'connection' | 'folder' | 'time' | 'output';

/**
 * Settings tab. A top tab bar (连接 / 文件夹 / 时间 / 输出属性) is layered on top
 * of the existing grouped, collapsible sections (style-settings-inspired but on
 * Obsidian's native `Setting` controls). A search box filters the rows of the
 * currently active tab. The glyphs are Lucide icons — no emoji — so they follow
 * the active theme.
 */
export class KnowledgeSystemSettingTab extends PluginSettingTab {
  plugin: KnowledgeSystemPlugin;

  private activeTab: TabId = 'connection';
  private modelDropdown: DropdownComponent | null = null;
  private currentModels: string[];
  private groupEls: HTMLElement[] = [];
  private groupCollapsed = new Map<HTMLElement, boolean>();

  constructor(app: App, plugin: KnowledgeSystemPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Persist the fetched model list so it survives tab switches / re-opens.
    this.currentModels = Array.isArray(plugin.settings.models) ? plugin.settings.models.slice() : [];
  }

  // -------------------------------------------------------------------------
  // rendering
  // -------------------------------------------------------------------------

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.modelDropdown = null;
    this.groupEls = [];
    this.groupCollapsed.clear();

    this.renderTabs(containerEl);
    this.renderSearch(containerEl);
    this.renderActiveTab(containerEl.createDiv({ cls: 'ks-tab-content' }));
  }

  /** Render the top tab bar: one button per tab, active state + click to switch. */
  private renderTabs(containerEl: HTMLElement): void {
    const tabs: { id: TabId; label: string }[] = [
      { id: 'connection', label: '连接' },
      { id: 'folder', label: '文件夹' },
      { id: 'time', label: '时间' },
      { id: 'output', label: '输出属性' },
    ];

    const tabsEl = containerEl.createDiv({ cls: 'ks-tabs' });
    for (const tab of tabs) {
      const tabEl = tabsEl.createDiv({ cls: 'ks-tab' });
      tabEl.setText(tab.label);
      tabEl.dataset.tabId = tab.id;
      if (this.activeTab === tab.id) tabEl.addClass('is-active');
      tabEl.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.display(); // re-render content for the new tab (fresh, empty search)
      });
    }
  }

  /** Render the settings belonging to the active tab (all groups of that tab). */
  private renderActiveTab(containerEl: HTMLElement): void {
    switch (this.activeTab) {
      case 'connection':
        this.renderConnectionGroup(containerEl);
        this.renderCustomProviderGroup(containerEl);
        break;
      case 'folder':
        this.renderFolderGroup(containerEl);
        break;
      case 'time':
        this.renderTimeGroup(containerEl);
        break;
      case 'output':
        this.renderOutputGroup(containerEl);
        break;
    }
  }

  private renderSearch(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv({ cls: 'ks-search' });
    const iconEl = wrap.createSpan({ cls: 'ks-search-icon' });
    setIcon(iconEl, 'search');
    const input = wrap.createEl('input', { cls: 'ks-search-input' });
    input.type = 'text';
    input.placeholder = '搜索设置...';
    input.addEventListener('input', () => this.filterSettings(input.value));
  }

  private createGroup(
    containerEl: HTMLElement,
    title: string,
    collapsed: boolean
  ): HTMLElement {
    const groupEl = containerEl.createDiv({ cls: 'ks-group' });
    const headingEl = groupEl.createDiv({ cls: 'ks-group-heading' });
    const iconEl = headingEl.createSpan({ cls: 'ks-group-icon' });
    setIcon(iconEl, collapsed ? 'chevron-right' : 'chevron-down');
    headingEl.createSpan({ cls: 'ks-group-title', text: title });
    const bodyEl = groupEl.createDiv({ cls: 'ks-group-body' });

    if (collapsed) groupEl.addClass('ks-collapsed');
    this.groupCollapsed.set(groupEl, collapsed);
    this.groupEls.push(groupEl);

    headingEl.addEventListener('click', () => {
      const isCollapsed = groupEl.hasClass('ks-collapsed');
      groupEl.toggleClass('ks-collapsed', !isCollapsed);
      this.groupCollapsed.set(groupEl, !isCollapsed);
      setIcon(iconEl, isCollapsed ? 'chevron-down' : 'chevron-right');
    });

    return bodyEl;
  }

  private markSearchable(setting: Setting, text: string): void {
    setting.settingEl.setAttribute('data-search', text);
  }

  private updateSetting<K extends keyof KnowledgeSystemSettings>(
    key: K,
    value: KnowledgeSystemSettings[K]
  ): void {
    this.plugin.settings[key] = value;
    void this.plugin.saveSettings();
  }

  // -------------------------------------------------------------------------
  // filter / collapse
  // -------------------------------------------------------------------------

  /** Filter the setting rows of the active tab; expand groups while searching. */
  private filterSettings(query: string): void {
    const q = (query || '').trim().toLowerCase();
    const content = this.containerEl.querySelector('.ks-tab-content');
    if (!content) return;

    content.querySelectorAll('.setting-item').forEach((el) => {
      const elm = el as HTMLElement;
      const hay = ((elm.getAttribute('data-search') || '') + ' ' + (elm.textContent || '')).toLowerCase();
      elm.style.display = q && hay.includes(q) ? '' : q ? 'none' : '';
    });

    for (const groupEl of this.groupEls) {
      if (q) {
        groupEl.removeClass('ks-collapsed');
      } else if (this.groupCollapsed.get(groupEl)) {
        groupEl.addClass('ks-collapsed');
      } else {
        groupEl.removeClass('ks-collapsed');
      }
    }
  }

  // -------------------------------------------------------------------------
  // groups
  // -------------------------------------------------------------------------

  private renderConnectionGroup(containerEl: HTMLElement): void {
    const bodyEl = this.createGroup(containerEl, '连接', false);

    const apiKey = new Setting(bodyEl)
      .setName('API Key')
      .setDesc('DeepSeek 或自定义服务商的 API Key，用于获取模型列表。')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('粘贴你的 API Key')
          .setValue(this.plugin.settings.apiKey)
          .onChange((value) => this.updateSetting('apiKey', value));
      });
    this.markSearchable(apiKey, '连接 api key API Key 密钥');

    const test = new Setting(bodyEl)
      .setName('测试并获取模型')
      .setDesc('调用服务商 GET /models 接口，并填充下方模型下拉框。')
      .addButton((btn) =>
        btn.setButtonText('测试并获取模型').setCta().onClick(async () => {
          await this.refreshModels();
        })
      );
    this.markSearchable(test, '连接 测试 获取 模型 刷新');

    const model = new Setting(bodyEl)
      .setName('默认模型')
      .setDesc('可用的模型列表（来自服务商 /models 接口）。')
      .addDropdown((drop) => {
        this.modelDropdown = drop;
        this.populateModelDropdown(drop);
        drop.onChange((value) => this.updateSetting('model', value));
      });
    this.markSearchable(model, '连接 默认模型 下拉 模型');
  }

  private renderCustomProviderGroup(containerEl: HTMLElement): void {
    const bodyEl = this.createGroup(containerEl, '自定义服务商', true);

    const baseUrl = new Setting(bodyEl)
      .setName('Base URL')
      .setDesc('OpenAI 兼容服务的基础地址，默认 DeepSeek。')
      .addText((text) =>
        text
          .setPlaceholder('https://api.deepseek.com')
          .setValue(this.plugin.settings.baseUrl)
          .onChange((value) => this.updateSetting('baseUrl', value))
      );
    this.markSearchable(baseUrl, '自定义服务商 base_url 地址 base url');

    const customApiKey = new Setting(bodyEl)
      .setName('API Key')
      .setDesc('自定义服务商的 API Key（预留）。')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('粘贴你的 API Key')
          .setValue(this.plugin.settings.customApiKey)
          .onChange((value) => this.updateSetting('customApiKey', value));
      });
    this.markSearchable(customApiKey, '自定义服务商 api_key 密钥');

    const customModel = new Setting(bodyEl)
      .setName('模型')
      .setDesc('自定义服务商的模型 ID（预留）。')
      .addText((text) =>
        text
          .setPlaceholder('model-id')
          .setValue(this.plugin.settings.customModel)
          .onChange((value) => this.updateSetting('customModel', value))
      );
    this.markSearchable(customModel, '自定义服务商 model 模型');
  }

  private renderFolderGroup(containerEl: HTMLElement): void {
    const bodyEl = this.createGroup(containerEl, '文件夹', false);

    const source = new Setting(bodyEl)
      .setName('源文件夹')
      .setDesc('统计最近文件数时扫描的文件夹。')
      .addText((text) => {
        text
          .setPlaceholder('/')
          .setValue(this.plugin.settings.sourceFolder)
          .onChange((value) => this.updateSetting('sourceFolder', value));
        new FolderSuggest(this.app, text.inputEl);
      });
    this.markSearchable(source, '文件夹 源文件夹 输入 目录');

    const output = new Setting(bodyEl)
      .setName('输出文件夹')
      .setDesc('输出最新内容测试生成文件的文件夹。')
      .addText((text) => {
        text
          .setPlaceholder('/')
          .setValue(this.plugin.settings.outputFolder)
          .onChange((value) => this.updateSetting('outputFolder', value));
        new FolderSuggest(this.app, text.inputEl);
      });
    this.markSearchable(output, '文件夹 输出文件夹 输入 目录');
  }

  private renderTimeGroup(containerEl: HTMLElement): void {
    const bodyEl = this.createGroup(containerEl, '时间', false);

    const timeProp = new Setting(bodyEl)
      .setName('时间属性名')
      .setDesc('读取文件时间使用的 frontmatter 属性名；留空则使用文件创建时间。')
      .addText((text) =>
        text
          .setPlaceholder('如：date')
          .setValue(this.plugin.settings.timeAttr)
          .onChange((value) => this.updateSetting('timeAttr', value))
      );
    this.markSearchable(timeProp, '时间 时间属性名 属性 字段');

    const timeFormat = new Setting(bodyEl)
      .setName('时间戳格式')
      .setDesc('moment 兼容的时间格式，例如 YYYY-MM-DD。')
      .addText((text) =>
        text
          .setPlaceholder('YYYY-MM-DD')
          .setValue(this.plugin.settings.timeFormat)
          .onChange((value) => this.updateSetting('timeFormat', value))
      );
    this.markSearchable(timeFormat, '时间 时间戳格式 时间格式');

    const recentDays = new Setting(bodyEl)
      .setName('最近 N 天')
      .setDesc('统计最近文件数时回看的天数。')
      .addText((text) => {
        text.inputEl.type = 'number';
        text
          .setPlaceholder('7')
          .setValue(String(this.plugin.settings.recentDays))
          .onChange((value) => {
            const n = parseInt(value, 10);
            if (!Number.isNaN(n) && n > 0) this.updateSetting('recentDays', n);
          });
      });
    this.markSearchable(recentDays, '时间 最近N天 天数 最近');
  }

  private renderOutputGroup(containerEl: HTMLElement): void {
    const bodyEl = this.createGroup(containerEl, '输出属性', false);

    const reviewProp = new Setting(bodyEl)
      .setName('审核状态属性名')
      .setDesc('写入输出文件的审核状态属性名。')
      .addText((text) =>
        text
          .setPlaceholder('approved')
          .setValue(this.plugin.settings.reviewAttr)
          .onChange((value) => this.updateSetting('reviewAttr', value))
      );
    this.markSearchable(reviewProp, '输出属性 审核状态属性名 状态');

    const reviewVal = new Setting(bodyEl)
      .setName('审核状态默认值')
      .setDesc('写入审核状态属性的默认值。')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.reviewDefault)
          .onChange((value) => this.updateSetting('reviewDefault', value))
      );
    this.markSearchable(reviewVal, '输出属性 审核状态默认值');

    const categoryProp = new Setting(bodyEl)
      .setName('分类属性名')
      .setDesc('写入输出文件的分类属性名。')
      .addText((text) =>
        text
          .setPlaceholder('category')
          .setValue(this.plugin.settings.categoryAttr)
          .onChange((value) => this.updateSetting('categoryAttr', value))
      );
    this.markSearchable(categoryProp, '输出属性 分类属性名 分类');

    const categoryVal = new Setting(bodyEl)
      .setName('分类默认值')
      .setDesc('写入分类属性的默认值。')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.categoryDefault)
          .onChange((value) => this.updateSetting('categoryDefault', value))
      );
    this.markSearchable(categoryVal, '输出属性 分类默认值');

    const timestampProp = new Setting(bodyEl)
      .setName('时间戳属性名')
      .setDesc('写入输出文件的当前时间戳属性名。')
      .addText((text) =>
        text
          .setPlaceholder('created')
          .setValue(this.plugin.settings.timestampAttr)
          .onChange((value) => this.updateSetting('timestampAttr', value))
      );
    this.markSearchable(timestampProp, '输出属性 时间戳属性名 created');

    const sourceAttr = new Setting(bodyEl)
      .setName('来源属性名')
      .setDesc('写入输出文件的来源路径属性名。')
      .addText((text) =>
        text
          .setPlaceholder('source')
          .setValue(this.plugin.settings.sourceAttr)
          .onChange((value) => this.updateSetting('sourceAttr', value))
      );
    this.markSearchable(sourceAttr, '输出属性 来源属性名 source');
  }

  // -------------------------------------------------------------------------
  // model fetching
  // -------------------------------------------------------------------------

  private populateModelDropdown(drop: DropdownComponent): void {
    drop.selectEl.empty();
    if (this.currentModels.length === 0) {
      drop.addOption('', '（请先点击“测试并获取模型”）');
      drop.setValue('');
      drop.setDisabled(true);
      return;
    }
    drop.setDisabled(false);
    const options: Record<string, string> = {};
    for (const model of this.currentModels) options[model] = model;
    drop.addOptions(options);
    const keep = this.plugin.settings.model;
    const value = this.currentModels.includes(keep) ? keep : this.currentModels[0];
    drop.setValue(value);
    this.updateSetting('model', value);
  }

  private async refreshModels(): Promise<void> {
    const result = await this.plugin.fetchModels(
      this.plugin.settings.apiKey,
      this.plugin.settings.baseUrl
    );
    if (result.ok) {
      this.currentModels = result.modelIds;
      if (this.modelDropdown) this.populateModelDropdown(this.modelDropdown);
    }
  }
}
