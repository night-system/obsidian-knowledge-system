import { App, DropdownComponent, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { KnowledgeSystemSettings, ToolPreset } from './settings';
import { FolderSuggest } from './folderSuggest';
import { countRecentFiles, outputLatestContent } from './core';
import type KnowledgeSystemPlugin from './main';

/** The settings tabs; `test` is the 5th (test tools), `preset` the 6th (v0.5.0). */
export type TabId = 'connection' | 'folder' | 'time' | 'output' | 'test' | 'preset';

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
    const groupEl = containerEl.createDiv({ cls: 'ks-group ks-preset-row' });
    const headingEl = groupEl.createDiv({ cls: 'ks-group-heading' });
    const iconEl = headingEl.createSpan({ cls: 'ks-group-icon' });
    setIcon(iconEl, 'settings');
    headingEl.createSpan({ cls: 'ks-group-title', text: preset.name || '未命名预设' });
    const bodyEl = groupEl.createDiv({ cls: 'ks-group-body' });

    const nameSetting = new Setting(bodyEl)
      .setName('名称')
      .setDesc('')
      .addText((text) =>
        text
          .setValue(preset.name)
          .onChange((value) => {
            preset.name = value;
            void this.plugin.saveSettings();
            headingEl.querySelector('.ks-group-title')?.setText(value || '未命名预设');
          })
      );
    this.markSearchable(nameSetting, '预设 名称 ' + preset.name);

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

    const toolsSetting = new Setting(bodyEl)
      .setName('启用工具')
      .setDesc('勾选允许 AI 使用的工具；全部不勾 = 使用默认（全部工具）。');
    this.markSearchable(toolsSetting, '预设 启用工具 工具 白名单 enabledTools');
    const toolNames = ['list_recent_notes', 'read_note', 'create_note', 'update_note_yaml', 'search_output_notes'];
    for (const name of toolNames) {
      const row = bodyEl.createDiv({ cls: 'ks-preset-tool-row' });
      const cb = row.createEl('input', { cls: 'ks-preset-tool-cb' });
      cb.type = 'checkbox';
      cb.checked = (preset.enabledTools || []).includes(name);
      row.createSpan({ cls: 'ks-preset-tool-label', text: name });
      cb.addEventListener('change', () => {
        const list = preset.enabledTools || (preset.enabledTools = []);
        if (cb.checked && !list.includes(name)) list.push(name);
        else if (!cb.checked) preset.enabledTools = list.filter((x) => x !== name);
        void this.plugin.saveSettings();
      });
    }

    const daysSetting = new Setting(bodyEl)
      .setName('list_recent_notes 天数')
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
    this.markSearchable(daysSetting, '预设 listRecentDays 天数 覆写');

    const createSetting = new Setting(bodyEl)
      .setName('create_note')
      .setDesc('false = 从暴露列表移除 create_note（AI 无法创建）。')
      .addDropdown((drop) => {
        drop.addOptions({ '': '默认（启用）', true: '启用', false: '禁用' });
        drop.setValue(preset.toolOverrides.createNoteEnabled === false ? 'false' : preset.toolOverrides.createNoteEnabled === true ? 'true' : '');
        drop.onChange((v) => {
          preset.toolOverrides.createNoteEnabled = v === '' ? undefined : v === 'true';
          void this.plugin.saveSettings();
        });
      });
    this.markSearchable(createSetting, '预设 createNoteEnabled create_note 禁用');

    const updateSetting = new Setting(bodyEl)
      .setName('update_note_yaml')
      .setDesc('全局开关已开启时，false = 从暴露列表移除 update_note_yaml。')
      .addDropdown((drop) => {
        drop.addOptions({ '': '默认', true: '启用', false: '禁用' });
        drop.setValue(preset.toolOverrides.updateYamlEnabled === false ? 'false' : preset.toolOverrides.updateYamlEnabled === true ? 'true' : '');
        drop.onChange((v) => {
          preset.toolOverrides.updateYamlEnabled = v === '' ? undefined : v === 'true';
          void this.plugin.saveSettings();
        });
      });
    this.markSearchable(updateSetting, '预设 updateYamlEnabled update_note_yaml');

    const searchSetting = new Setting(bodyEl)
      .setName('search_output_notes 模式')
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

    const restrEl = bodyEl.createDiv({ cls: 'ks-preset-restrictions' });
    this.renderSearchRestrictions(restrEl, preset);

    const delSetting = new Setting(bodyEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setButtonText('删除此预设').onClick(() => {
          this.plugin.settings.toolPresets.splice(index, 1);
          void this.plugin.saveSettings();
          this.renderPresetGroup(parentEl);
        })
      );
    this.markSearchable(delSetting, '预设 删除 删除预设');
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
