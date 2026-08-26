import { App, DropdownComponent, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { KnowledgeSystemSettings, ToolPreset, UpdateYamlRule, NoteTemplateEntry } from './settings';
import { FolderSuggest } from './folderSuggest';
import { countRecentFiles, outputLatestContent } from './core';
import type KnowledgeSystemPlugin from './main';

/** The settings tabs; `test` is the 5th (test tools), `preset` the 6th (v0.5.0). */
export type TabId = 'connection' | 'folder' | 'time' | 'output' | 'test' | 'preset';

/** Stable tool order for the preset tool-config editors (v0.7.0 B.2). */
const TOOL_NAMES = ['list_recent_notes', 'read_note', 'create_note', 'update_note_yaml', 'search_output_notes'];

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
  private activePresetDropdown: DropdownComponent | null = null;
  private groupEls: HTMLElement[] = [];
  private groupCollapsed = new Map<HTMLElement, boolean>();
  /** Expanded preset item ids (v0.7.0 B.1); default a preset is collapsed. */
  private presetExpanded = new Set<string>();
  /** Expanded per-tool config group keys `${presetId}:${toolName}` (B.2). */
  private toolExpanded = new Set<string>();

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
      { id: 'preset', label: '预设' },
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
      case 'preset':
        this.renderPresetGroup(containerEl);
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
      .setDesc('Anthropic 兼容服务的 API Key（x-api-key），用于聊天与获取模型列表。')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('粘贴你的 API Key')
          .setValue(this.plugin.settings.apiKey)
          .onChange((value) => this.updateSetting('apiKey', value));
      });
    this.markSearchable(apiKey, '连接 anthropic API Key 密钥');

    const test = new Setting(bodyEl)
      .setName('测试并获取模型')
      .setDesc('调用服务商模型列表接口（先试 /models，回退 /v1/models），填充下方模型下拉框。')
      .addButton((btn) =>
        btn.setButtonText('测试并获取模型').setCta().onClick(async () => {
          await this.refreshModels();
        })
      );
    this.markSearchable(test, '连接 测试 获取 模型 刷新');

    const model = new Setting(bodyEl)
      .setName('默认模型')
      .setDesc('可用的模型列表（来自服务商模型接口，不硬编码）。')
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
      .setDesc('Anthropic 兼容服务的基础地址。填 https://api.deepseek.com 或 https://api.deepseek.com/anthropic 均可：聊天会自动探测 /anthropic 端点，模型列表自动探测根端点。默认 DeepSeek Anthropic 端点。')
      .addText((text) =>
        text
          .setPlaceholder('https://api.deepseek.com/anthropic')
          .setValue(this.plugin.settings.baseUrl)
          .onChange((value) => this.updateSetting('baseUrl', value))
      );
    this.markSearchable(baseUrl, '自定义服务商 base_url 地址 base url anthropic');

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

    const earliestTime = new Setting(bodyEl)
      .setName('最早时间')
      .setDesc('AI 工具只能查看不早于该时间的笔记（格式同时间戳格式）；留空则不限制。')
      .addText((text) =>
        text
          .setPlaceholder('如：2026-01-01')
          .setValue(this.plugin.settings.earliestTime)
          .onChange((value) => this.updateSetting('earliestTime', value))
      );
    this.markSearchable(earliestTime, '时间 最早时间 最早 时间限制');
  }

  // -------------------------------------------------------------------------
  // output (fixed timestamp/source rows + dynamic key→default-value rows)
  // -------------------------------------------------------------------------

  private renderOutputGroup(containerEl: HTMLElement): void {
    // AI 创建属性规则（create_note 默认值与约束）——独立可折叠分组，放最前以便发现（v0.5.0 入口显性化）。
    const yamlRulesBody = this.createGroup(containerEl, 'AI 创建属性规则（create_note 默认值与约束）', false);
    this.renderYamlRules(yamlRulesBody);

    // v0.7.0：AI 修改属性规则（update_note_yaml 阉割版）——可配置「允许修改的属性 + 可选值约束」，解释用大文本框。
    const updateYamlBody = this.createGroup(containerEl, 'AI 修改属性规则（update_note_yaml）', false);
    this.renderUpdateYamlRules(updateYamlBody);

    // v0.7.0：AI 创建模板（create_note 正文结构）——标题模板 + 各标题是否允许 AI 写。
    const templateBody = this.createGroup(containerEl, 'AI 创建模板（create_note 正文结构）', false);
    this.renderNoteTemplate(templateBody);

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

  /**
   * Render the "AI 创建属性规则" group: an info row, then one row per rule
   * (key + desc + values tag input + default + delete), then an add button. The
   * rule objects are mutated in place and persisted immediately (same pattern
   * as renderExtraProperties). Allowed values are stored as an array of trimmed
   * strings (deduped) and edited one-at-a-time as chips (回车添加 / × 删除).
   */
  private renderYamlRules(containerEl: HTMLElement): void {
    containerEl.empty();

    const info = new Setting(containerEl)
      .setName('')
      .setDesc('控制 AI 使用 create_note 工具时的 frontmatter 键值对：键名+解释+可选值（回车逐个添加，显示为 chip）+默认值；默认值支持 {{YYYY.MM.DD}} 等 moment 模板，{{}} 内为 moment 兼容格式；可选值用于约束 AI 只能选这些值，留空=任意。默认值不会暴露给 AI——AI 创建文件时自动追加（AI 不知情）；只配了默认值、无可选值约束的属性键也不对 AI 显示。');
    this.markSearchable(info, 'AI 创建属性规则 键名 解释 可选值 默认值 moment 模板 frontmatter');

    const list = this.plugin.settings.yamlRules || [];
    list.forEach((rule, index) => {
      const hay = `AI 创建属性规则 ${rule.key} ${rule.desc} ${rule.values.join(' ')} ${rule.default}`;
      const row = new Setting(containerEl)
        .setName('')
        .setDesc('')
        .addText((text) =>
          text
            .setPlaceholder('属性名，如 category')
            .setValue(rule.key)
            .onChange((value) => {
              rule.key = value;
              void this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder('解释该属性的含义（随工具描述传给 AI）')
            .setValue(rule.desc)
            .onChange((value) => {
              rule.desc = value;
              void this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder('默认值（AI 未填此键时创建文件自动插入的值，支持 {{YYYY.MM.DD}}；留空=不插入）')
            .setValue(rule.default)
            .onChange((value) => {
              rule.default = value;
              void this.plugin.saveSettings();
            })
        )
        .addButton((btn) =>
          btn
            .setIcon('trash-2')
            .setTooltip('删除')
            .onClick(() => {
              const a = this.plugin.settings.yamlRules;
              a.splice(index, 1);
              void this.plugin.saveSettings();
              this.renderYamlRules(containerEl);
            })
        );
      row.settingEl.addClass('ks-yaml-rule-row');
      this.markSearchable(row, hay);

      // 可选值 tag 输入区：输入后回车添加 chip，chips 带 × 删除；同值去重；顺序=添加顺序。
      const valuesEl = containerEl.createDiv({ cls: 'ks-yaml-values setting-item' });
      valuesEl.setAttribute('data-search', hay);
      this.renderYamlValues(valuesEl, rule);
    });

    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setButtonText('+ 添加规则').onClick(() => {
          this.plugin.settings.yamlRules.push({ key: '', desc: '', values: [], default: '' });
          void this.plugin.saveSettings();
          this.renderYamlRules(containerEl);
        })
      );
    this.markSearchable(addBtn, 'AI 创建属性规则 添加规则 增加 添加');
  }

  /** Render a tag/chip input for an array of values (rule values OR preset restriction values). */
  private renderYamlValues(containerEl: HTMLElement, holder: { values: string[] }): void {
    containerEl.empty();
    const wrap = containerEl.createDiv({ cls: 'ks-yaml-values-wrap' });
    const label = wrap.createSpan({ cls: 'ks-yaml-values-label', text: '可选值' });
    const input = wrap.createEl('input', { cls: 'ks-yaml-values-input' });
    input.type = 'text';
    input.placeholder = '输入可选值后回车添加';
    const chipWrap = containerEl.createDiv({ cls: 'ks-tag-list' });

    const renderChips = () => {
      chipWrap.empty();
      for (const value of holder.values) {
        const chip = chipWrap.createSpan({ cls: 'ks-tag' });
        chip.createSpan({ text: value });
        const x = chip.createSpan({ cls: 'ks-tag-x' });
        setIcon(x, 'x');
        x.addEventListener('click', () => {
          const idx = holder.values.indexOf(value);
          if (idx >= 0) holder.values.splice(idx, 1);
          void this.plugin.saveSettings();
          renderChips();
        });
      }
    };

    const add = () => {
      const v = input.value.trim();
      if (v && !holder.values.includes(v)) {
        holder.values.push(v);
        void this.plugin.saveSettings();
        input.value = '';
        renderChips();
      }
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        add();
      } else if (ev.key === 'Backspace' && input.value === '' && holder.values.length > 0) {
        holder.values.pop();
        void this.plugin.saveSettings();
        renderChips();
      }
    });
    input.addEventListener('blur', () => {
      if (input.value.trim()) add();
    });

    renderChips();
  }

  /**
   * Render the "AI 修改属性规则（update_note_yaml）" group (v0.7.0 B.3): one
   * row per rule = key (single line) + 解释 (**multi-line textarea**, because
   * the explanation explains every allowed value) + 可选值 tag input + delete.
   * Only effective when the global "暴露 update_note_yaml 工具" switch is on;
   * the AI may only modify these attributes and values must be within the
   * allowed set (out-of-range is rejected).
   */
  private renderUpdateYamlRules(containerEl: HTMLElement): void {
    containerEl.empty();

    const info = new Setting(containerEl)
      .setName('')
      .setDesc('控制 AI 使用 update_note_yaml 工具时可修改的 frontmatter 属性：属性名 + 解释（用文本框写清该属性及各可选值的含义）+ 可选值（回车逐个添加，显示为 chip；留空 = 任意）。仅当全局开关「暴露 update_note_yaml 工具」开启时生效；AI 只能修改这些属性，值必须在可选值内，越界会被拒绝。');
    this.markSearchable(info, 'AI 修改属性规则 update_note_yaml 属性 解释 可选值');

    const list = this.plugin.settings.updateYamlRules || [];
    list.forEach((rule, index) => {
      const hay = `AI 修改属性规则 ${rule.key} ${rule.desc} ${rule.values.join(' ')}`;
      const row = new Setting(containerEl)
        .setName('')
        .setDesc('')
        .addText((text) =>
          text
            .setPlaceholder('属性名，如 status')
            .setValue(rule.key)
            .onChange((value) => {
              rule.key = value;
              void this.plugin.saveSettings();
            })
        )
        .addTextArea((text) =>
          text
            .setPlaceholder('解释该属性及各可选值的含义，将随工具描述传给 AI')
            .setValue(rule.desc)
            .onChange((value) => {
              rule.desc = value;
              void this.plugin.saveSettings();
            })
        )
        .addButton((btn) =>
          btn
            .setIcon('trash-2')
            .setTooltip('删除')
            .onClick(() => {
              const a = this.plugin.settings.updateYamlRules;
              a.splice(index, 1);
              void this.plugin.saveSettings();
              this.renderUpdateYamlRules(containerEl);
            })
        );
      // addClass 只接受单个 token；含空格的类名需用 addClasses（Obsidian 接口）一次传入数组。
      row.settingEl.addClasses(['ks-yaml-rule-row', 'ks-update-yaml-rule-row']);
      this.markSearchable(row, hay);

      const valuesEl = containerEl.createDiv({ cls: 'ks-yaml-values setting-item' });
      valuesEl.setAttribute('data-search', hay);
      this.renderYamlValues(valuesEl, rule);
    });

    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setButtonText('+ 添加规则').onClick(() => {
          this.plugin.settings.updateYamlRules.push({ key: '', desc: '', values: [] });
          void this.plugin.saveSettings();
          this.renderUpdateYamlRules(containerEl);
        })
      );
    this.markSearchable(addBtn, 'AI 修改属性规则 添加规则 增加 添加');
  }

  /**
   * Render the "AI 创建模板（create_note 正文结构）" group (v0.7.0 B.4): one
   * row per template heading = level dropdown + title text + "允许 AI 写" toggle
   * + 解释 (multi-line textarea) + up/down/delete, plus a live preview. The body
   * is assembled in template order; the AI may only write under `allowAi`
   * headings. At least one allowAi heading is required for the template to take
   * effect; an empty template keeps the v0.5.0 free `content` behaviour.
   */
  private renderNoteTemplate(containerEl: HTMLElement): void {
    containerEl.empty();

    const info = new Setting(containerEl)
      .setName('')
      .setDesc('定义 create_note 输出的正文模板结构：标题文本 + 级别（H1/H2/H3…）+「允许 AI 写」+ 解释。AI 只能在标注「允许 AI 写」的标题下写内容（sections 参数）；不允许 AI 写的标题由模板固定输出。模板按此顺序组装正文；至少一个「允许 AI 写」标题才生效，未配置模板则保持原样（自由正文）。');
    this.markSearchable(info, 'AI 创建模板 create_note 正文 标题 级别 允许AI写 模板');

    const list = this.plugin.settings.noteTemplate || [];
    const rowsEl = containerEl.createDiv({ cls: 'ks-template-rows' });
    const previewEl = containerEl.createDiv({ cls: 'ks-template-preview' });
    let renderPreview: () => void;

    const renderRows = () => {
      rowsEl.empty();
      list.forEach((entry, index) => {
        const rowEl = rowsEl.createDiv({ cls: 'ks-template-row' });
        const levelSel = rowEl.createEl('select', { cls: 'ks-template-level' });
        for (let lvl = 1; lvl <= 6; lvl++) {
          const opt = levelSel.createEl('option');
          opt.value = String(lvl);
          opt.text = 'H' + lvl;
          if (entry.level === lvl) opt.selected = true;
        }
        levelSel.addEventListener('change', () => {
          entry.level = parseInt(levelSel.value, 10) || 1;
          void this.plugin.saveSettings();
          renderPreview();
        });
        const titleInput = rowEl.createEl('input', { cls: 'ks-template-title' });
        titleInput.type = 'text';
        titleInput.placeholder = '标题文本，如「简介」';
        titleInput.value = entry.title;
        titleInput.addEventListener('input', () => {
          entry.title = titleInput.value;
          void this.plugin.saveSettings();
          renderPreview();
        });
        const toggleWrap = rowEl.createDiv({ cls: 'ks-template-allow' });
        const cb = toggleWrap.createEl('input', { cls: 'ks-template-allow-cb' });
        cb.type = 'checkbox';
        cb.checked = entry.allowAi;
        toggleWrap.createSpan({ cls: 'ks-template-allow-label', text: '允许 AI 写' });
        cb.addEventListener('change', () => {
          entry.allowAi = cb.checked;
          void this.plugin.saveSettings();
          renderPreview();
        });
        const descInput = rowEl.createEl('textarea', { cls: 'ks-template-desc' });
        descInput.placeholder = '解释该标题下的内容要求（AI 可见）';
        descInput.value = entry.desc;
        descInput.rows = 2;
        descInput.addEventListener('input', () => {
          entry.desc = descInput.value;
          void this.plugin.saveSettings();
        });
        const opts = rowEl.createDiv({ cls: 'ks-template-ops' });
        this.addIconBtn(opts, 'chevron-up', '上移', () => this.moveTemplateEntry(containerEl, index, -1));
        this.addIconBtn(opts, 'chevron-down', '下移', () => this.moveTemplateEntry(containerEl, index, 1));
        this.addIconBtn(opts, 'trash-2', '删除', () => {
          list.splice(index, 1);
          void this.plugin.saveSettings();
          renderRows();
          renderPreview();
        });
      });
    };
    renderPreview = () => this.renderNoteTemplatePreview(previewEl, list);
    renderRows();
    renderPreview();

    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setButtonText('+ 添加标题').onClick(() => {
          this.plugin.settings.noteTemplate.push({ title: '', level: 2, allowAi: true, desc: '' });
          void this.plugin.saveSettings();
          renderRows();
          renderPreview();
        })
      );
    this.markSearchable(addBtn, 'AI 创建模板 添加标题 增加 添加');
  }

  /** Live preview of the assemble template body (H1/H2… heading + AI-fills note). */
  private renderNoteTemplatePreview(el: HTMLElement, list: NoteTemplateEntry[]): void {
    el.empty();
    el.createDiv({ cls: 'ks-template-preview-title', text: '模板预览（正文将按此结构组装）' });
    const lines: string[] = [];
    for (const e of list) {
      const h = '#'.repeat(Math.max(1, Math.min(6, e.level))) + ' ' + (e.title || '').trim();
      lines.push(e.allowAi ? `${h}\n（AI 填写）` : h);
    }
    if (lines.length === 0) {
      el.createDiv({ cls: 'ks-template-preview-body', text: '（未配置标题）' });
      return;
    }
    const pre = el.createEl('pre', { cls: 'ks-template-preview-body' });
    pre.setText(lines.join('\n\n'));
  }

  /** Move a template entry by `delta` (±1) then re-render the whole template group. */
  private moveTemplateEntry(containerEl: HTMLElement, index: number, delta: number): void {
    const list = this.plugin.settings.noteTemplate || [];
    const to = index + delta;
    if (to < 0 || to >= list.length) return;
    const tmp = list[index];
    list[index] = list[to];
    list[to] = tmp;
    void this.plugin.saveSettings();
    this.renderNoteTemplate(containerEl);
  }

  /** Small lucide icon button (no emoji) for the template row operations. */
  private addIconBtn(parent: HTMLElement, icon: string, tooltip: string, onClick: () => void): void {
    const btn = parent.createEl('button', { cls: 'ks-template-op' });
    btn.setAttribute('aria-label', tooltip);
    btn.setAttribute('title', tooltip);
    setIcon(btn, icon);
    btn.addEventListener('click', onClick);
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
  // preset (tool preset management UI, v0.5.0 — 6th tab)
  // -------------------------------------------------------------------------

  private renderPresetGroup(containerEl: HTMLElement): void {
    containerEl.empty();

    const activeBody = this.createGroup(containerEl, '当前预设', false);
    const active = new Setting(activeBody)
      .setName('聊天使用的预设')
      .setDesc('选择聊天界面生效的工具/系统提示预设；默认（全部工具）= 所有工具 + 设置里的 yaml 规则。切换后下次请求生效。')
      .addDropdown((drop) => {
        this.activePresetDropdown = drop;
        this.populateActivePresetDropdown(drop);
        drop.onChange((value) => {
          this.updateSetting('activePresetId', value);
          void new Notice(value ? '已选择预设（下次请求生效）' : '已回到默认（全部工具）');
        });
      });
    this.markSearchable(active, '预设 当前预设 activePreset 聊天 生效');

    const yamlEnabled = new Setting(activeBody)
      .setName('暴露 update_note_yaml 工具')
      .setDesc('开启后，AI 可使用 update_note_yaml 更新源文件夹笔记的 frontmatter 属性（默认关闭）。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.updateYamlToolEnabled)
          .onChange((v) => this.updateSetting('updateYamlToolEnabled', v))
      );
    this.markSearchable(yamlEnabled, '预设 update_note_yaml 全局 开关 暴露');

    const listBody = this.createGroup(containerEl, '工具预设', false);
    const presets = this.plugin.settings.toolPresets || [];
    presets.forEach((preset, index) => this.renderPresetRow(listBody, preset, index, containerEl));

    const addBtn = new Setting(listBody)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setButtonText('+ 新建预设').onClick(() => {
          const np: ToolPreset = {
            id: String(Date.now()),
            name: '新预设',
            systemPrompt: '',
            enabledTools: [],
            toolOverrides: {},
          };
          this.plugin.settings.toolPresets.push(np);
          void this.plugin.saveSettings();
          this.renderPresetGroup(containerEl);
        })
      );
    this.markSearchable(addBtn, '预设 新建预设 增加 添加');
  }

  private populateActivePresetDropdown(drop: DropdownComponent): void {
    drop.selectEl.empty();
    const presets = this.plugin.settings.toolPresets || [];
    const opts: Record<string, string> = { '': '默认（全部工具）' };
    for (const p of presets) opts[p.id] = p.name;
    drop.addOptions(opts);
    const keep = this.plugin.settings.activePresetId;
    drop.setValue(presets.some((p) => p.id === keep) ? keep : '');
  }

  private renderPresetRow(
    containerEl: HTMLElement,
    preset: ToolPreset,
    index: number,
    parentEl: HTMLElement
  ): void {
    // B.1：每个预设一个可折叠项（默认收起），头部=名称输入+展开 chevron+删除。
    const itemEl = containerEl.createDiv({ cls: 'ks-preset-item' });
    const expanded = this.presetExpanded.has(preset.id);
    if (!expanded) itemEl.addClass('ks-preset-item-collapsed');

    const headEl = itemEl.createDiv({ cls: 'ks-preset-item-head' });
    const nameInput = headEl.createEl('input', { cls: 'ks-preset-item-name' });
    nameInput.type = 'text';
    nameInput.value = preset.name || '';
    nameInput.placeholder = '未命名预设';
    nameInput.addEventListener('input', () => {
      preset.name = nameInput.value;
      void this.plugin.saveSettings();
    });
    const chev = headEl.createSpan({ cls: 'ks-preset-item-chev' });
    setIcon(chev, expanded ? 'chevron-down' : 'chevron-right');
    chev.addEventListener('click', () => this.togglePresetItem(itemEl, chev, preset.id));
    const delBtn = headEl.createEl('button', { cls: 'ks-preset-item-del' });
    delBtn.setAttribute('aria-label', '删除此预设');
    delBtn.setAttribute('title', '删除此预设');
    setIcon(delBtn, 'trash-2');
    delBtn.addEventListener('click', () => {
      this.plugin.settings.toolPresets.splice(index, 1);
      void this.plugin.saveSettings();
      this.renderPresetGroup(parentEl);
    });

    const bodyEl = itemEl.createDiv({ cls: 'ks-preset-item-body' });

    const sysSetting = new Setting(bodyEl)
      .setName('系统提示词')
      .setDesc('随预设绑定的自定义系统提示；留空 = 默认（不发送 system）。')
      .addTextArea((text) =>
        text
          .setPlaceholder('例如：你是一名严格的分类助手…')
          .setValue(preset.systemPrompt)
          .onChange((value) => {
            preset.systemPrompt = value;
            void this.plugin.saveSettings();
          })
      );
    this.markSearchable(sysSetting, '预设 系统提示词 systemPrompt');

    // B.2：每个工具一个可折叠分组（默认收起），标题/说明向用户解释该工具的参数。
    const toolArea = bodyEl.createDiv({ cls: 'ks-preset-tools' });

    this.renderToolConfigGroup(toolArea, preset, 'list_recent_notes',
      '列出源文件夹最近 N 天笔记（参数：days 回看天数，默认=全局最近 N 天）', (body) => {
        this.renderToolEnableToggle(body, preset, 'list_recent_notes');
        const daysSetting = new Setting(body)
          .setName('回看天数')
          .setDesc('覆写 list_recent_notes 的 days；留空 = 用设置里「最近 N 天」。')
          .addText((text) => {
            text.inputEl.type = 'number';
            text.setValue(String(preset.toolOverrides.listRecentDays ?? ''));
            text.onChange((value) => {
              const n = parseInt(value, 10);
              preset.toolOverrides.listRecentDays = value.trim() === '' || Number.isNaN(n) ? undefined : n;
              void this.plugin.saveSettings();
            });
          });
        this.markSearchable(daysSetting, '预设 listRecentDays 天数 覆写 回看天数');
      });

    this.renderToolConfigGroup(toolArea, preset, 'read_note',
      '读取源文件夹笔记正文（无参数）', (body) => {
        this.renderToolEnableToggle(body, preset, 'read_note');
        const info = new Setting(body)
          .setName('参数')
          .setDesc('读取源文件夹内某篇笔记的正文（去除 YAML frontmatter）；参数：name（笔记文件名，可带或不带 .md 后缀）。');
        this.markSearchable(info, '预设 read_note 参数 说明');
      });

    this.renderToolConfigGroup(toolArea, preset, 'create_note',
      '创建新笔记（参数：title 文件名 / yaml 属性规则 / 模板正文）', (body) => {
        this.renderToolEnableToggle(body, preset, 'create_note');
        const info = new Setting(body)
          .setName('说明')
          .setDesc('描述「创建新笔记」。允许 AI 创建新笔记；正文结构与 frontmatter 属性规则由设置页「输出属性」的「AI 创建模板 / AI 创建属性规则」配置。');
        this.markSearchable(info, '预设 create_note 说明 创建 新建');
      });

    this.renderToolConfigGroup(toolArea, preset, 'update_note_yaml',
      '修改源文件 frontmatter 属性（需全局开关暴露）', (body) => {
        this.renderToolEnableToggle(body, preset, 'update_note_yaml');
        const info = new Setting(body)
          .setName('说明')
          .setDesc('描述「修改源文件 frontmatter 属性」。实际对 AI 暴露还须开启全局开关「暴露 update_note_yaml 工具」；只能修改设置页配置的属性（值须在允许范围内）。');
        this.markSearchable(info, '预设 update_note_yaml 说明 修改 frontmatter');
      });

    this.renderToolConfigGroup(toolArea, preset, 'search_output_notes',
      '搜索输出文件夹（参数：模式 完整/阉割）', (body) => {
        this.renderToolEnableToggle(body, preset, 'search_output_notes');
        const searchSetting = new Setting(body)
          .setName('搜索模式')
          .setDesc('完整版 = AI 按任意键搜索；阉割版 = 只能按下方限定键搜索。')
          .addDropdown((drop) => {
            drop.addOptions({ full: '完整版（任意键搜索）', restricted: '阉割版（仅限定键）' });
            drop.setValue(preset.toolOverrides.searchMode ?? 'full');
            drop.onChange((v) => {
              preset.toolOverrides.searchMode = v as 'full' | 'restricted';
              void this.plugin.saveSettings();
            });
          });
        this.markSearchable(searchSetting, '预设 searchMode search_output_notes 模式 完整 阉割');
        const restrEl = body.createDiv({ cls: 'ks-preset-restrictions' });
        this.renderSearchRestrictions(restrEl, preset);
      });
    void toolArea;
  }

  /** Render one collapsible per-tool config group (B.2): header = tool name +
   *  one-line parameter explanation; body = the tool's config (collapsed by
   *  default, restored across re-renders via `toolExpanded`). */
  private renderToolConfigGroup(
    parentEl: HTMLElement,
    preset: ToolPreset,
    name: string,
    explanation: string,
    renderBody: (bodyEl: HTMLElement) => void
  ): void {
    const key = `${preset.id}:${name}`;
    const groupEl = parentEl.createDiv({ cls: 'ks-group ks-tool-config' });
    const headEl = groupEl.createDiv({ cls: 'ks-tool-config-head' });
    const chev = headEl.createSpan({ cls: 'ks-group-icon' });
    const expanded = this.toolExpanded.has(key);
    setIcon(chev, expanded ? 'chevron-down' : 'chevron-right');
    headEl.createSpan({ cls: 'ks-preset-tool-label', text: name });
    headEl.createSpan({ cls: 'ks-tool-config-desc', text: explanation });
    const bodyEl = groupEl.createDiv({ cls: 'ks-group-body' });
    if (!expanded) groupEl.addClass('ks-collapsed');
    headEl.addEventListener('click', () => {
      const isCollapsed = groupEl.hasClass('ks-collapsed');
      groupEl.toggleClass('ks-collapsed', !isCollapsed);
      setIcon(chev, isCollapsed ? 'chevron-down' : 'chevron-right');
      if (isCollapsed) this.toolExpanded.add(key);
      else this.toolExpanded.delete(key);
    });
    renderBody(bodyEl);
  }

  /** 「启用该工具」toggle at the top of each tool config group; it maps to the
   *  preset `enabledTools` whitelist. Legacy data compat: when `enabledTools` is
   *  non-empty it seeds the toggle state; toggling writes back `enabledTools`. */
  private renderToolEnableToggle(bodyEl: HTMLElement, preset: ToolPreset, name: string): void {
    const label: Record<string, string> = {
      list_recent_notes: '启用该工具（list_recent_notes）',
      read_note: '启用该工具（read_note）',
      create_note: '允许 AI 创建文件（create_note）',
      update_note_yaml: '启用该工具（update_note_yaml）',
      search_output_notes: '启用该工具（search_output_notes）',
    };
    const s = new Setting(bodyEl)
      .setName(label[name] || name)
      .setDesc('开关是否把该工具纳入本预设；关闭 = 从本预设的工具白名单移除。')
      .addToggle((t) =>
        t.setValue(this.isToolEnabled(preset, name)).onChange((v) => this.setToolEnabled(preset, name, v))
      );
    this.markSearchable(s, `预设 工具 ${name} 启用 禁用`);
  }

  private togglePresetItem(itemEl: HTMLElement, chev: HTMLElement, id: string): void {
    const collapsed = itemEl.hasClass('ks-preset-item-collapsed');
    itemEl.toggleClass('ks-preset-item-collapsed', !collapsed);
    setIcon(chev, collapsed ? 'chevron-down' : 'chevron-right');
    if (collapsed) this.presetExpanded.add(id);
    else this.presetExpanded.delete(id);
  }

  /** Whether tool `name` is enabled in the preset (empty enabledTools = all on). */
  private isToolEnabled(preset: ToolPreset, name: string): boolean {
    const list = preset.enabledTools || [];
    if (list.length === 0) return true; // 空 = 全部启用（默认）
    return list.includes(name);
  }

  /** Toggle tool `name` in the preset, writing back `enabledTools`. Empty list
   *  means all-enabled; turning one off materialises the whitelist explicitly. */
  private setToolEnabled(preset: ToolPreset, name: string, on: boolean): void {
    const list = preset.enabledTools || [];
    if (list.length === 0) {
      // 空 = 全部启用；要关某工具才写出「除它之外的全部」
      preset.enabledTools = on ? [] : TOOL_NAMES.filter((x) => x !== name);
    } else {
      if (on) {
        if (!list.includes(name)) preset.enabledTools = list.concat(name);
      } else {
        const next = list.filter((x) => x !== name);
        preset.enabledTools = next.length === 0 ? [] : next; // 关到空 = 回退默认全部（同 v0.5.0）
      }
    }
    void this.plugin.saveSettings();
  }

  private renderSearchRestrictions(containerEl: HTMLElement, preset: ToolPreset): void {
    containerEl.empty();
    const heading = new Setting(containerEl)
      .setName('阉割版限定键')
      .setDesc('search 模式为「阉割版」时，只允许 AI 按这些键搜；可选值以 chip 填写（留空 = 任意值）。')
      .setHeading();
    this.markSearchable(heading, '预设 阉割版 限定键 searchRestrictions');
    const list = preset.toolOverrides.searchRestrictions || (preset.toolOverrides.searchRestrictions = []);
    list.forEach((item, index) => {
      const hay = `预设 阉割版 ${item.key} ${item.values.join(' ')}`;
      const row = new Setting(containerEl)
        .setName('')
        .setDesc('')
        .addText((text) =>
          text
            .setPlaceholder('键名，如 category')
            .setValue(item.key)
            .onChange((value) => {
              item.key = value;
              void this.plugin.saveSettings();
            })
        )
        .addButton((btn) =>
          btn
            .setIcon('trash-2')
            .setTooltip('删除')
            .onClick(() => {
              const a = preset.toolOverrides.searchRestrictions as { key: string; values: string[] }[];
              a.splice(index, 1);
              void this.plugin.saveSettings();
              this.renderSearchRestrictions(containerEl, preset);
            })
        );
      row.settingEl.addClass('ks-yaml-rule-row');
      this.markSearchable(row, hay);
      const valuesEl = containerEl.createDiv({ cls: 'ks-yaml-values setting-item' });
      valuesEl.setAttribute('data-search', hay);
      this.renderYamlValues(valuesEl, item);
    });
    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setButtonText('+ 添加键').onClick(() => {
          (preset.toolOverrides.searchRestrictions as { key: string; values: string[] }[]).push({ key: '', values: [] });
          void this.plugin.saveSettings();
          this.renderSearchRestrictions(containerEl, preset);
        })
      );
    this.markSearchable(addBtn, '预设 阉割版 添加键');
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
    for (const model of this.currentModels) options[model] = this.modelOptionLabel(model);
    drop.addOptions(options);
    const keep = this.plugin.settings.model;
    const value = this.currentModels.includes(keep) ? keep : this.currentModels[0];
    drop.setValue(value);
    this.updateSetting('model', value);
  }

  /**
   * 模型下拉显示名标注（存值仍是模型 id 本身）：deepseek-v4-flash → 最快；
   * deepseek-v4-pro → 质量。帮助新用户按「首 token 快慢」选默认模型（TTFT 实测
   * flash total 0.5s 最快 / pro 2.0s 质量优先）；不影响已选模型。
   */
  private modelOptionLabel(model: string): string {
    const m = (model || '').trim().toLowerCase();
    if (m.includes('flash') || m.includes('fast')) return `${model}（最快）`;
    if (m.includes('pro') || m.includes('reasoner') || m.includes('max')) return `${model}（质量）`;
    return model;
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
