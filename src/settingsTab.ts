import { App, DropdownComponent, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { KnowledgeSystemSettings } from './settings';
import { FolderSuggest } from './folderSuggest';
import { countRecentFiles, outputLatestContent } from './core';
import type KnowledgeSystemPlugin from './main';

/** The settings tabs; `test` is the 5th (test tools). */
export type TabId = 'connection' | 'folder' | 'time' | 'output' | 'test';

/**
 * Render the full settings UI (tab bar + search + active tab) into
 * `containerEl`. Shared by the plugin settings tab (Obsidian settings) and the
 * standalone settings view (workspace leaf). Creates a fresh renderer so the
 * tab and view can each be opened independently.
 */
export function renderSettings(
  app: App,
  plugin: KnowledgeSystemPlugin,
  containerEl: HTMLElement
): void {
  new SettingsRenderer(app, plugin).render(containerEl);
}

/**
 * Encapsulates the settings UI: a top tab bar (连接 / 文件夹 / 时间 / 输出属性 /
 * 测试工具) over grouped, collapsible sections (style-settings-inspired but on
 * Obsidian's native `Setting` controls), with a search box filtering the active
 * tab's rows. All glyphs are Lucide icons — no emoji.
 */
class SettingsRenderer {
  private app: App;
  private plugin: KnowledgeSystemPlugin;

  private containerEl: HTMLElement;
  private activeTab: TabId = 'connection';
  private modelDropdown: DropdownComponent | null = null;
  private currentModels: string[];
  private groupEls: HTMLElement[] = [];
  private groupCollapsed = new Map<HTMLElement, boolean>();

  constructor(app: App, plugin: KnowledgeSystemPlugin) {
    this.app = app;
    this.plugin = plugin;
    this.currentModels = Array.isArray(plugin.settings.models) ? plugin.settings.models.slice() : [];
  }

  render(containerEl: HTMLElement): void {
    this.containerEl = containerEl;
    containerEl.empty();

    this.modelDropdown = null;
    this.groupEls = [];
    this.groupCollapsed.clear();

    this.renderTabs(containerEl);
    this.renderSearch(containerEl);
    this.renderActiveTab(containerEl.createDiv({ cls: 'ks-tab-content' }));
  }

  // -------------------------------------------------------------------------
  // tab bar / search / active tab
  // -------------------------------------------------------------------------

  private renderTabs(containerEl: HTMLElement): void {
    const tabs: { id: TabId; label: string }[] = [
      { id: 'connection', label: '连接' },
      { id: 'folder', label: '文件夹' },
      { id: 'time', label: '时间' },
      { id: 'output', label: '输出属性' },
      { id: 'test', label: '测试工具' },
    ];

    const tabsEl = containerEl.createDiv({ cls: 'ks-tabs' });
    for (const tab of tabs) {
      const tabEl = tabsEl.createDiv({ cls: 'ks-tab' });
      tabEl.setText(tab.label);
      tabEl.dataset.tabId = tab.id;
      if (this.activeTab === tab.id) tabEl.addClass('is-active');
      tabEl.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.render(this.containerEl);
      });
    }
  }

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
      case 'test':
        this.renderTestGroup(containerEl);
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

  private createGroup(containerEl: HTMLElement, title: string, collapsed: boolean): HTMLElement {
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
  // connection
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

  // -------------------------------------------------------------------------
  // folder
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // time
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // output (fixed timestamp/source rows + dynamic key→default-value rows)
  // -------------------------------------------------------------------------

  private renderOutputGroup(containerEl: HTMLElement): void {
    const bodyEl = this.createGroup(containerEl, '输出属性', false);

    const timestampProp = new Setting(bodyEl)
      .setName('时间戳属性名')
      .setDesc('写入输出文件的当前时间戳属性名；值按「时间」页的时间戳格式生成。')
      .addText((text) =>
        text
          .setPlaceholder('created')
          .setValue(this.plugin.settings.timestampProperty)
          .onChange((value) => this.updateSetting('timestampProperty', value))
      );
    this.markSearchable(timestampProp, '输出属性 时间戳属性名 created 时间戳');

    const sourceAttr = new Setting(bodyEl)
      .setName('来源属性名')
      .setDesc('写入输出文件的来源路径属性名。')
      .addText((text) =>
        text
          .setPlaceholder('source')
          .setValue(this.plugin.settings.sourceAttr)
          .onChange((value) => this.updateSetting('sourceAttr', value))
      );
    this.markSearchable(sourceAttr, '输出属性 来源属性名 source 来源');

    const extraEl = bodyEl.createDiv({ cls: 'ks-extra-props' });
    this.renderExtraProperties(extraEl);

    const addBtn = new Setting(bodyEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setButtonText('+ 添加属性').onClick(() => {
          this.plugin.settings.extraProperties.push({ key: '', value: '' });
          void this.plugin.saveSettings();
          this.renderExtraProperties(extraEl);
        })
      );
    this.markSearchable(addBtn, '输出属性 添加属性 增加 添加');
  }

  /** Render each extra property as a row: key input, value input, delete button. */
  private renderExtraProperties(containerEl: HTMLElement): void {
    containerEl.empty();
    const list = this.plugin.settings.extraProperties || [];
    list.forEach((entry, index) => {
      const row = new Setting(containerEl)
        .setName('')
        .setDesc('')
        .addText((text) =>
          text
            .setPlaceholder('属性名')
            .setValue(entry.key)
            .onChange((value) => {
              entry.key = value;
              void this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder('默认值')
            .setValue(entry.value)
            .onChange((value) => {
              entry.value = value;
              void this.plugin.saveSettings();
            })
        )
        .addButton((btn) =>
          btn
            .setIcon('trash-2')
            .setTooltip('删除')
            .onClick(() => {
              const a = this.plugin.settings.extraProperties;
              a.splice(index, 1);
              void this.plugin.saveSettings();
              this.renderExtraProperties(containerEl);
            })
        );
      row.settingEl.addClass('ks-extra-props-row');
      this.markSearchable(row, `输出属性 ${entry.key} ${entry.value}`);
    });
  }

  // -------------------------------------------------------------------------
  // test tools (execute the two commands without the command palette)
  // -------------------------------------------------------------------------

  private renderTestGroup(containerEl: HTMLElement): void {
    const bodyEl = this.createGroup(containerEl, '测试工具', false);

    const count = new Setting(bodyEl)
      .setName('统计最近文件数')
      .setDesc('扫描源文件夹，统计最近 N 天内的 Markdown 文件数。')
      .addButton((btn) =>
        btn.setButtonText('统计最近文件数').setCta().onClick(() => {
          const n = countRecentFiles(this.plugin);
          new Notice(`源文件夹最近 ${this.plugin.settings.recentDays} 天共有 ${n} 个文件`);
        })
      );
    this.markSearchable(count, '测试 统计 最近文件数 统计最近 统计');

    const output = new Setting(bodyEl)
      .setName('输出最新内容测试')
      .setDesc('取源文件夹时间最新的文件，将其正文最后 100 字符写入输出文件夹。')
      .addButton((btn) =>
        btn.setButtonText('输出最新内容测试').setCta().onClick(async () => {
          await outputLatestContent(this.plugin);
        })
      );
    this.markSearchable(output, '测试 输出 最新内容 输出最新内容 输出');
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

/** The plugin settings tab (kept so the plugin still exposes a settings tab). */
export class KnowledgeSystemSettingTab extends PluginSettingTab {
  plugin: KnowledgeSystemPlugin;

  constructor(app: App, plugin: KnowledgeSystemPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    renderSettings(this.app, this.plugin, this.containerEl);
  }
}
