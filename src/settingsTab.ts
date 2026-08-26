import { App, DropdownComponent, Notice, PluginSettingTab, Setting, ToggleComponent, setIcon } from 'obsidian';
import { KnowledgeSystemSettings, TOOL_NAMES, ToolPreset, UpdateYamlRule, NoteTemplateEntry, YamlRule, SidebarRule, PanelConfig } from './settings';
import { FolderSuggest } from './folderSuggest';
import { countRecentFiles, outputLatestContent } from './core';
import { evaluateCondition } from './utils/sidebarRules';
import type KnowledgeSystemPlugin from './main';

/** The settings tabs; `test` is the 5th (test tools), `preset` the 6th (v0.5.0),
 *  `sidebar` the 9th (v0.9.0 侧边栏提醒面板规则), `panel` the 5th (v0.9.3 用户自定义面板；
 *  取代 v0.8.7 审核 / v0.9.2 整理两个固定 tab——旧面板配置字段保留但无 UI)。 */
export type TabId = 'connection' | 'folder' | 'time' | 'output' | 'panel' | 'test' | 'preset' | 'uiPreview' | 'sidebar';

// v0.8.8：TOOL_NAMES 移到 src/settings.ts 导出（main.ts 迁移 / utils/presets.ts 共用）。

// ---------------------------------------------------------------------------
// v0.8.3：每个工具折叠组的配置复制/导入（JSON 剪贴板）。导入前严格校验格式：
// 未知字段或字段类型不符 → 整体拒绝（「保证格式正确才允许导入」）。
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function isStrArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isStr);
}
function isYamlRule(v: unknown): v is YamlRule {
  return (
    isPlainObject(v) &&
    isStr(v.key) &&
    isStr(v.desc) &&
    isStrArr(v.values) &&
    isStr(v.default) &&
    (v.expose === undefined || isBool(v.expose)) &&
    (v.overwrite === undefined || isBool(v.overwrite))
  );
}
function isYamlRules(v: unknown): v is YamlRule[] {
  return Array.isArray(v) && v.every(isYamlRule);
}
function isTmplEntry(v: unknown): v is NoteTemplateEntry {
  return (
    isPlainObject(v) &&
    isStr(v.title) &&
    typeof v.level === 'number' &&
    Number.isInteger(v.level) &&
    v.level >= 1 &&
    v.level <= 6 &&
    isBool(v.allowAi) &&
    isStr(v.desc)
  );
}
function isRestriction(v: unknown): v is { key: string; values: string[] } {
  return isPlainObject(v) && isStr(v.key) && isStrArr(v.values);
}
/** v0.9.1：update_note_yaml 规则（UpdateYamlRule，无 default/expose/overwrite）。
 *  宽松处理：只检查 key/desc/values 的类型，忽略多余字段。 */
function isUpdateYamlRule(v: unknown): v is UpdateYamlRule {
  return isPlainObject(v) && isStr(v.key) && isStr(v.desc) && isStrArr(v.values);
}
function isUpdateYamlRules(v: unknown): v is UpdateYamlRule[] {
  return Array.isArray(v) && v.every(isUpdateYamlRule);
}
/** 字段名白名单：出现未知字段即拒绝（格式不正确的导入不允许）。 */
function rejectUnknownFields(cfg: Record<string, unknown>, allowed: string[]): string | null {
  for (const k of Object.keys(cfg)) {
    if (!allowed.includes(k)) return `未知字段「${k}」`;
  }
  return null;
}

interface ToolConfigIO {
  /** 工具名（按钮/提示用）。 */
  label: string;
  /** 从预设导出该工具的配置子集（JSON 序列化后复制到剪贴板）。 */
  exportFromPreset(p: ToolPreset): Record<string, unknown>;
  /** 从全局设置导出同结构配置（默认预设「全局设置」的工具组用）。 */
  exportFromGlobal(s: KnowledgeSystemSettings): Record<string, unknown>;
  /** 校验剪贴板 JSON；通过才允许导入。 */
  validate(raw: unknown): { ok: true; cfg: Record<string, unknown> } | { ok: false; error: string };
  /** 导入到预设（替换该工具的既有配置，不碰其他工具）。调用前必须已通过 validate；
   *  cfg 用 any 便于把已校验字段写回（字段类型已在 validate 保证）。 */
  applyToPreset(p: ToolPreset, cfg: Record<string, any>): void;
  /** 导入到全局设置。调用前必须已通过 validate。 */
  applyToGlobal(s: KnowledgeSystemSettings, cfg: Record<string, any>): void;
}

const listRecentIo: ToolConfigIO = {
  label: 'list_recent_notes',
  exportFromPreset(p) {
    const cfg: Record<string, unknown> = {};
    if (p.toolOverrides.listRecentDays !== undefined) cfg.listRecentDays = p.toolOverrides.listRecentDays;
    return cfg;
  },
  exportFromGlobal(s) {
    return { listRecentDays: s.recentDays };
  },
  validate(raw) {
    if (!isPlainObject(raw)) return { ok: false, error: '必须是 JSON 对象' };
    const bad = rejectUnknownFields(raw, ['listRecentDays']);
    if (bad) return { ok: false, error: bad };
    if (raw.listRecentDays !== undefined && !(typeof raw.listRecentDays === 'number' && Number.isFinite(raw.listRecentDays))) {
      return { ok: false, error: 'listRecentDays 必须是数字' };
    }
    return { ok: true, cfg: raw };
  },
  applyToPreset(p, cfg) {
    p.toolOverrides.listRecentDays = cfg.listRecentDays as number | undefined;
  },
  applyToGlobal(s, cfg) {
    if (typeof cfg.listRecentDays === 'number') s.recentDays = cfg.listRecentDays;
  },
};

/** v0.8.9：list_recent_output_notes 的配置 IO（日期属性名 / 日期格式，moment 双大括号模板）。 */
const listRecentOutputIo: ToolConfigIO = {
  label: 'list_recent_output_notes',
  exportFromPreset(p) {
    const cfg: Record<string, unknown> = {};
    if (p.toolOverrides.recentOutputAttr) cfg.recentOutputAttr = p.toolOverrides.recentOutputAttr;
    if (p.toolOverrides.recentOutputFormat) cfg.recentOutputFormat = p.toolOverrides.recentOutputFormat;
    return cfg;
  },
  exportFromGlobal() {
    return {};
  },
  validate(raw) {
    if (!isPlainObject(raw)) return { ok: false, error: '必须是 JSON 对象' };
    const bad = rejectUnknownFields(raw, ['recentOutputAttr', 'recentOutputFormat']);
    if (bad) return { ok: false, error: bad };
    if (raw.recentOutputAttr !== undefined && typeof raw.recentOutputAttr !== 'string') {
      return { ok: false, error: 'recentOutputAttr 必须是字符串' };
    }
    if (raw.recentOutputFormat !== undefined && typeof raw.recentOutputFormat !== 'string') {
      return { ok: false, error: 'recentOutputFormat 必须是字符串' };
    }
    return { ok: true, cfg: raw };
  },
  applyToPreset(p, cfg) {
    p.toolOverrides.recentOutputAttr = (cfg.recentOutputAttr as string | undefined) || undefined;
    p.toolOverrides.recentOutputFormat = (cfg.recentOutputFormat as string | undefined) || undefined;
  },
  applyToGlobal() {},
};

const searchIo: ToolConfigIO = {
  label: 'search_output_notes',
  exportFromPreset(p) {
    const cfg: Record<string, unknown> = {};
    if (p.toolOverrides.searchMode !== undefined) cfg.searchMode = p.toolOverrides.searchMode;
    if (p.toolOverrides.searchRestrictions !== undefined && p.toolOverrides.searchRestrictions.length > 0) {
      cfg.searchRestrictions = p.toolOverrides.searchRestrictions;
    }
    if (p.toolOverrides.searchQueryEnabled !== undefined) cfg.searchQueryEnabled = p.toolOverrides.searchQueryEnabled;
    return cfg;
  },
  exportFromGlobal() {
    return {};
  },
  validate(raw) {
    if (!isPlainObject(raw)) return { ok: false, error: '必须是 JSON 对象' };
    const bad = rejectUnknownFields(raw, ['searchMode', 'searchRestrictions', 'searchQueryEnabled']);
    if (bad) return { ok: false, error: bad };
    if (raw.searchMode !== undefined && raw.searchMode !== 'full' && raw.searchMode !== 'restricted') {
      return { ok: false, error: 'searchMode 只能是 full 或 restricted' };
    }
    if (raw.searchRestrictions !== undefined && !Array.isArray(raw.searchRestrictions)) {
      return { ok: false, error: 'searchRestrictions 必须是数组' };
    }
    if (raw.searchRestrictions !== undefined && !raw.searchRestrictions.every(isRestriction)) {
      return { ok: false, error: 'searchRestrictions 每项必须是 {key, values[]}' };
    }
    if (raw.searchQueryEnabled !== undefined && typeof raw.searchQueryEnabled !== 'boolean') {
      return { ok: false, error: 'searchQueryEnabled 必须是布尔值' };
    }
    return { ok: true, cfg: raw };
  },
  applyToPreset(p, cfg) {
    p.toolOverrides.searchMode = cfg.searchMode as 'full' | 'restricted' | undefined;
    p.toolOverrides.searchRestrictions = cfg.searchRestrictions as { key: string; values: string[] }[] | undefined;
    p.toolOverrides.searchQueryEnabled = cfg.searchQueryEnabled as boolean | undefined;
  },
  applyToGlobal() {
    // search 模式无全局配置（只在预设内）。
  },
};

const createIo: ToolConfigIO = {
  label: 'create_note',
  exportFromPreset(p) {
    const oc = p.outputConfig ?? {};
    const cfg: Record<string, unknown> = {};
    if (oc.yamlRulesEnabled !== undefined) cfg.yamlRulesEnabled = oc.yamlRulesEnabled;
    if (oc.yamlRules !== undefined) cfg.yamlRules = oc.yamlRules;
    if (oc.noteTemplateEnabled !== undefined) cfg.noteTemplateEnabled = oc.noteTemplateEnabled;
    if (oc.noteTemplate !== undefined) cfg.noteTemplate = oc.noteTemplate;
    if (oc.createRestrictYamlEnabled !== undefined) cfg.createRestrictYamlEnabled = oc.createRestrictYamlEnabled;
    if (oc.createRestrictYaml !== undefined) cfg.createRestrictYaml = oc.createRestrictYaml;
    return cfg;
  },
  exportFromGlobal(s) {
    return {
      yamlRulesEnabled: true,
      yamlRules: s.yamlRules,
      noteTemplateEnabled: true,
      noteTemplate: s.noteTemplate,
      createRestrictYamlEnabled: true,
      createRestrictYaml: s.createRestrictYaml,
    };
  },
  validate(raw) {
    if (!isPlainObject(raw)) return { ok: false, error: '必须是 JSON 对象' };
    const bad = rejectUnknownFields(raw, ['yamlRulesEnabled', 'yamlRules', 'noteTemplateEnabled', 'noteTemplate', 'createRestrictYamlEnabled', 'createRestrictYaml']);
    if (bad) return { ok: false, error: bad };
    if (raw.yamlRulesEnabled !== undefined && !isBool(raw.yamlRulesEnabled)) return { ok: false, error: 'yamlRulesEnabled 必须是布尔值' };
    if (raw.yamlRules !== undefined && !isYamlRules(raw.yamlRules)) return { ok: false, error: 'yamlRules 每项必须是 {key, desc, values[], default, expose?, overwrite?}' };
    if (raw.noteTemplateEnabled !== undefined && !isBool(raw.noteTemplateEnabled)) return { ok: false, error: 'noteTemplateEnabled 必须是布尔值' };
    if (raw.noteTemplate !== undefined && !Array.isArray(raw.noteTemplate)) return { ok: false, error: 'noteTemplate 必须是数组' };
    if (raw.noteTemplate !== undefined && !raw.noteTemplate.every(isTmplEntry)) return { ok: false, error: 'noteTemplate 每项必须是 {title, level(1-6), allowAi, desc}' };
    if (raw.createRestrictYamlEnabled !== undefined && !isBool(raw.createRestrictYamlEnabled)) return { ok: false, error: 'createRestrictYamlEnabled 必须是布尔值' };
    if (raw.createRestrictYaml !== undefined && !isBool(raw.createRestrictYaml)) return { ok: false, error: 'createRestrictYaml 必须是布尔值' };
    return { ok: true, cfg: raw };
  },
  applyToPreset(p, cfg) {
    const oc = (p.outputConfig = p.outputConfig ?? {});
    if (cfg.yamlRulesEnabled !== undefined) oc.yamlRulesEnabled = cfg.yamlRulesEnabled;
    if (cfg.yamlRules !== undefined) oc.yamlRules = cfg.yamlRules;
    if (cfg.noteTemplateEnabled !== undefined) oc.noteTemplateEnabled = cfg.noteTemplateEnabled;
    if (cfg.noteTemplate !== undefined) oc.noteTemplate = cfg.noteTemplate;
    if (cfg.createRestrictYamlEnabled !== undefined) oc.createRestrictYamlEnabled = cfg.createRestrictYamlEnabled;
    if (cfg.createRestrictYaml !== undefined) oc.createRestrictYaml = cfg.createRestrictYaml;
  },
  applyToGlobal(s, cfg) {
    if (cfg.yamlRules !== undefined) s.yamlRules = cfg.yamlRules;
    if (cfg.noteTemplate !== undefined) s.noteTemplate = cfg.noteTemplate;
    if (cfg.createRestrictYaml !== undefined) s.createRestrictYaml = cfg.createRestrictYaml;
  },
};

const modifyIo: ToolConfigIO = {
  label: 'modify_output_note',
  exportFromPreset(p) {
    const oc = p.outputConfig ?? {};
    const cfg: Record<string, unknown> = {};
    if (oc.modifyYamlRulesEnabled !== undefined) cfg.modifyYamlRulesEnabled = oc.modifyYamlRulesEnabled;
    if (oc.modifyYamlRules !== undefined) cfg.modifyYamlRules = oc.modifyYamlRules;
    return cfg;
  },
  exportFromGlobal(s) {
    return { modifyYamlRulesEnabled: true, modifyYamlRules: s.modifyYamlRules };
  },
  validate(raw) {
    if (!isPlainObject(raw)) return { ok: false, error: '必须是 JSON 对象' };
    const bad = rejectUnknownFields(raw, ['modifyYamlRulesEnabled', 'modifyYamlRules']);
    if (bad) return { ok: false, error: bad };
    if (raw.modifyYamlRulesEnabled !== undefined && !isBool(raw.modifyYamlRulesEnabled)) return { ok: false, error: 'modifyYamlRulesEnabled 必须是布尔值' };
    if (raw.modifyYamlRules !== undefined && !isYamlRules(raw.modifyYamlRules)) return { ok: false, error: 'modifyYamlRules 每项必须是 {key, desc, values[], default, expose?, overwrite?}' };
    return { ok: true, cfg: raw };
  },
  applyToPreset(p, cfg) {
    const oc = (p.outputConfig = p.outputConfig ?? {});
    if (cfg.modifyYamlRulesEnabled !== undefined) oc.modifyYamlRulesEnabled = cfg.modifyYamlRulesEnabled;
    if (cfg.modifyYamlRules !== undefined) oc.modifyYamlRules = cfg.modifyYamlRules;
  },
  applyToGlobal(s, cfg) {
    if (cfg.modifyYamlRules !== undefined) s.modifyYamlRules = cfg.modifyYamlRules;
  },
};

/** v0.9.1：update_note_yaml 的配置 IO（属性规则覆盖：updateYamlRulesEnabled 开关 + 规则列表）。 */
const updateYamlIo: ToolConfigIO = {
  label: 'update_note_yaml',
  exportFromPreset(p) {
    const oc = p.outputConfig ?? {};
    const cfg: Record<string, unknown> = {};
    if (oc.updateYamlRulesEnabled !== undefined) cfg.updateYamlRulesEnabled = oc.updateYamlRulesEnabled;
    if (oc.updateYamlRules !== undefined) cfg.updateYamlRules = oc.updateYamlRules;
    return cfg;
  },
  exportFromGlobal(s) {
    return { updateYamlRulesEnabled: true, updateYamlRules: s.updateYamlRules };
  },
  validate(raw) {
    if (!isPlainObject(raw)) return { ok: false, error: '必须是 JSON 对象' };
    const bad = rejectUnknownFields(raw, ['updateYamlRulesEnabled', 'updateYamlRules']);
    if (bad) return { ok: false, error: bad };
    if (raw.updateYamlRulesEnabled !== undefined && !isBool(raw.updateYamlRulesEnabled)) return { ok: false, error: 'updateYamlRulesEnabled 必须是布尔值' };
    if (raw.updateYamlRules !== undefined && !isUpdateYamlRules(raw.updateYamlRules)) return { ok: false, error: 'updateYamlRules 每项必须是 {key, desc, values[]}' };
    return { ok: true, cfg: raw };
  },
  applyToPreset(p, cfg) {
    const oc = (p.outputConfig = p.outputConfig ?? {});
    if (cfg.updateYamlRulesEnabled !== undefined) oc.updateYamlRulesEnabled = cfg.updateYamlRulesEnabled;
    if (cfg.updateYamlRules !== undefined) oc.updateYamlRules = cfg.updateYamlRules;
  },
  applyToGlobal(s, cfg) {
    if (cfg.updateYamlRules !== undefined) s.updateYamlRules = cfg.updateYamlRules;
  },
};

const archiveIo: ToolConfigIO = {
  label: 'modify_output_note_versioned',
  exportFromPreset(p) {
    const oc = p.outputConfig ?? {};
    const cfg: Record<string, unknown> = {};
    if (oc.archiveEnabled !== undefined) cfg.archiveEnabled = oc.archiveEnabled;
    if (oc.modifyVersionSuffix !== undefined) cfg.modifyVersionSuffix = oc.modifyVersionSuffix;
    if (oc.modifyVersionProperty !== undefined) cfg.modifyVersionProperty = oc.modifyVersionProperty;
    if (oc.modifyArchiveProperty !== undefined) cfg.modifyArchiveProperty = oc.modifyArchiveProperty;
    return cfg;
  },
  exportFromGlobal(s) {
    return {
      archiveEnabled: true,
      modifyVersionSuffix: s.modifyVersionSuffix,
      modifyVersionProperty: s.modifyVersionProperty,
      modifyArchiveProperty: s.modifyArchiveProperty,
    };
  },
  validate(raw) {
    if (!isPlainObject(raw)) return { ok: false, error: '必须是 JSON 对象' };
    const bad = rejectUnknownFields(raw, ['archiveEnabled', 'modifyVersionSuffix', 'modifyVersionProperty', 'modifyArchiveProperty']);
    if (bad) return { ok: false, error: bad };
    if (raw.archiveEnabled !== undefined && !isBool(raw.archiveEnabled)) return { ok: false, error: 'archiveEnabled 必须是布尔值' };
    for (const k of ['modifyVersionSuffix', 'modifyVersionProperty', 'modifyArchiveProperty'] as const) {
      if (raw[k] !== undefined && !isStr(raw[k])) return { ok: false, error: `${k} 必须是字符串` };
    }
    return { ok: true, cfg: raw };
  },
  applyToPreset(p, cfg) {
    const oc = (p.outputConfig = p.outputConfig ?? {});
    if (cfg.archiveEnabled !== undefined) oc.archiveEnabled = cfg.archiveEnabled;
    if (cfg.modifyVersionSuffix !== undefined) oc.modifyVersionSuffix = cfg.modifyVersionSuffix;
    if (cfg.modifyVersionProperty !== undefined) oc.modifyVersionProperty = cfg.modifyVersionProperty;
    if (cfg.modifyArchiveProperty !== undefined) oc.modifyArchiveProperty = cfg.modifyArchiveProperty;
  },
  applyToGlobal(s, cfg) {
    if (cfg.modifyVersionSuffix !== undefined) s.modifyVersionSuffix = cfg.modifyVersionSuffix;
    if (cfg.modifyVersionProperty !== undefined) s.modifyVersionProperty = cfg.modifyVersionProperty;
    if (cfg.modifyArchiveProperty !== undefined) s.modifyArchiveProperty = cfg.modifyArchiveProperty;
  },
};

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
  /** 组折叠状态按 `${tabId}:${title}` 记忆（跨重渲染/切 tab 保持；v0.8.2 修复）。 */
  private groupCollapsedByTitle = new Map<string, boolean>();
  /** Expanded preset item ids (v0.7.0 B.1); default a preset is collapsed. */
  private presetExpanded = new Set<string>();
  /** Expanded per-tool config group keys `${presetId}:${toolName}` (B.2). */
  private toolExpanded = new Set<string>();
  /** v0.9.0：侧边栏规则卡片折叠状态（collapsed 的 rule id；缺省展开）。 */
  private sidebarRuleCollapsed = new Set<string>();
  /** v0.9.3：面板卡片折叠状态（collapsed 的 panel.id；缺省展开）。 */
  private panelCollapsed = new Set<string>();

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
    // groupCollapsedByTitle 跨渲染保留（切 tab 时也保持组折叠状态）

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
      { id: 'panel', label: '面板' },
      { id: 'test', label: '测试工具' },
      { id: 'preset', label: '预设' },
      { id: 'uiPreview', label: 'UI 方案' },
      { id: 'sidebar', label: '侧边栏' },
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
      case 'panel':
        this.renderPanelGroup(containerEl);
        break;
      case 'test':
        this.renderTestGroup(containerEl);
        break;
      case 'preset':
        this.renderPresetGroup(containerEl);
        break;
      case 'uiPreview':
        this.renderUiPreviewGroup(containerEl);
        break;
      case 'sidebar':
        this.renderSidebarGroup(containerEl);
        break;
    }
  }

  private renderSearch(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv({ cls: 'ks-search' });
    const iconEl = wrap.createSpan({ cls: 'ks-search-icon' });
    this.setIconSafe(iconEl, 'search', '');
    const input = wrap.createEl('input', { cls: 'ks-search-input' });
    input.type = 'text';
    input.placeholder = '搜索设置...';
    input.addEventListener('input', () => this.filterSettings(input.value));
  }

  private createGroup(containerEl: HTMLElement, title: string, collapsed: boolean): HTMLElement {
    // v0.8.2：折叠状态按 `${activeTab}:${title}` 记忆，重渲染/切 tab 后恢复。
    const key = `${this.activeTab}:${title}`;
    const remembered = this.groupCollapsedByTitle.get(key);
    const effectiveCollapsed = remembered !== undefined ? remembered : collapsed;
    const groupEl = containerEl.createDiv({ cls: 'ks-group' });
    const headingEl = groupEl.createDiv({ cls: 'ks-group-heading' });
    const iconEl = headingEl.createSpan({ cls: 'ks-group-icon' });
    this.setIconSafe(iconEl, effectiveCollapsed ? 'chevron-right' : 'chevron-down', effectiveCollapsed ? '\u203A' : '\u2304');
    headingEl.createSpan({ cls: 'ks-group-title', text: title });
    const bodyEl = groupEl.createDiv({ cls: 'ks-group-body' });

    if (effectiveCollapsed) groupEl.addClass('ks-collapsed');
    this.groupCollapsed.set(groupEl, effectiveCollapsed);
    this.groupEls.push(groupEl);

    headingEl.addEventListener('click', () => {
      const isCollapsed = groupEl.hasClass('ks-collapsed');
      groupEl.toggleClass('ks-collapsed', !isCollapsed);
      this.groupCollapsed.set(groupEl, !isCollapsed);
      this.groupCollapsedByTitle.set(key, !isCollapsed);
      this.setIconSafe(iconEl, isCollapsed ? 'chevron-down' : 'chevron-right', isCollapsed ? '\u2304' : '\u203A');
    });

    return bodyEl;
  }

  private markSearchable(setting: Setting, text: string): void {
    setting.settingEl.setAttribute('data-search', text);
  }

  /** `setIcon` 后可见性兜底：若 svg 无可绘制子节点或 computed color 为透明，
   *  退化为文本字形 `glyph`，保证图标在任何主题下可见（无 emoji）。
   *  `glyph` 为空时不回退文本。 */
  private setIconSafe(container: HTMLElement, name: string, glyph: string): void {
    setIcon(container, name);
    const svg = container.querySelector('svg');
    const hasDrawable = !!svg && !!svg.querySelector('path, rect, circle, polygon, line');
    const color = svg ? getComputedStyle(svg).color : 'transparent';
    const visible = hasDrawable && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
    if (!visible && glyph) container.setText(glyph);
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
        btn.setIcon('refresh-cw').setButtonText('测试并获取模型').setCta().onClick(async () => {
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

    // v0.8.0：AI 修改输出工具（modify_output_note / modify_output_note_versioned / read_output_note）配置。
    const modifyBody = this.createGroup(containerEl, 'AI 修改输出工具（modify_output_note / modify_output_note_versioned / read_output_note）', false);
    this.renderModifyOutputTools(modifyBody);

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
        btn.setIcon('plus').setButtonText('添加属性').onClick(() => {
          this.plugin.settings.extraProperties.push({ key: '', value: '' });
          void this.plugin.saveSettings();
          this.renderExtraProperties(extraEl);
        })
      );
    this.markSearchable(addBtn, '输出属性 添加属性 增加 添加');
  }

  // -------------------------------------------------------------------------
  // panel（v0.9.3：用户自定义面板配置——扫描文件夹 / bool 属性 / 日期 / 位置 /
  // 聊天预设与 prompt；取代 v0.8.7 审核 / v0.9.2 整理两个固定 tab）
  // -------------------------------------------------------------------------

  private renderPanelGroup(containerEl: HTMLElement): void {
    containerEl.empty();

    const info = new Setting(containerEl)
      .setName('')
      .setDesc('配置用户自定义面板（Bases 核心插件自定义视图）：可创建任意多个面板，每个面板扫描一个文件夹（源文件夹/输出文件夹跟随「文件夹」tab 的全局设置，或填自定义路径），列出 bool 属性缺失或不是 true 的文件；可设最早日期（该日期之后修改/创建的文件才显示）。点击文件名打开文件、点击聊天图标用面板自己的预设 + prompt 模板跳聊天。每个面板可「生成面板」（按配置重建 .base）与「打开面板」。需要 Obsidian 1.10.0+ 并启用 Bases 核心插件。');
    this.markSearchable(info, '面板 说明 Bases 自定义 多面板 扫描文件夹 生成面板 打开面板 聊天预设 prompt');

    const panels = this.plugin.settings.panels || (this.plugin.settings.panels = []);
    panels.forEach((panel, index) => this.renderPanelCard(containerEl, panel, index));

    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setIcon('plus').setButtonText('新建面板').onClick(() => {
          if (!Array.isArray(this.plugin.settings.panels)) this.plugin.settings.panels = [];
          const np: PanelConfig = {
            id: String(Date.now()),
            name: '新面板',
            enabled: true,
            folder: 'source',
            attr: 'tidy',
            afterDate: '',
            basePath: '新面板.base',
            chatPresetId: '',
            chatPrompt: '请查看「{{filename}}」并帮我处理。',
          };
          this.plugin.settings.panels.push(np);
          void this.plugin.saveSettings();
          this.renderPanelGroup(containerEl);
        })
      );
    this.markSearchable(addBtn, '面板 新建 添加 增加 创建');
  }

  /**
   * v0.9.3：渲染一个面板配置卡片（可折叠）：头部 = chevron + 名称输入 + 启用开关 +
   * 删除按钮；主体 = 扫描文件夹（下拉 + 自定义路径）+ bool 属性名 + 最早日期 +
   * 面板位置 + 聊天预设下拉 + 聊天 prompt + 「生成面板」「打开面板」按钮。
   * 折叠状态按 panel.id 记忆（缺省展开）。
   */
  private renderPanelCard(containerEl: HTMLElement, panel: PanelConfig, index: number): void {
    const rerenderAll = () => this.renderPanelGroup(containerEl);
    const collapsed = this.panelCollapsed.has(panel.id);

    const card = containerEl.createDiv({ cls: 'ks-panel-card' });
    const head = card.createDiv({ cls: 'ks-panel-card-head' });
    const chev = head.createSpan({ cls: 'ks-preset-item-chev' });
    this.setIconSafe(chev, collapsed ? 'chevron-right' : 'chevron-down', collapsed ? '\u203A' : '\u2304');
    chev.addEventListener('click', () => {
      const isCollapsed = card.hasClass('ks-panel-card-collapsed');
      if (isCollapsed) this.panelCollapsed.delete(panel.id);
      else this.panelCollapsed.add(panel.id);
      this.setIconSafe(chev, isCollapsed ? 'chevron-down' : 'chevron-right', isCollapsed ? '\u2304' : '\u203A');
      card.toggleClass('ks-panel-card-collapsed', !isCollapsed);
    });
    const nameInput = head.createEl('input', { cls: 'ks-preset-item-name ks-panel-card-name' });
    nameInput.type = 'text';
    nameInput.value = panel.name || '';
    nameInput.placeholder = '面板名，如「审核」「整理」';
    nameInput.addEventListener('input', () => {
      panel.name = nameInput.value;
      void this.plugin.saveSettings();
    });
    // 启用开关（stopPropagation 防止冒泡——头部无折叠监听，这里仅为稳妥）。
    const toggleWrap = head.createSpan({ cls: 'ks-sidebar-rule-toggle' });
    toggleWrap.addEventListener('click', (ev) => ev.stopPropagation());
    new ToggleComponent(toggleWrap)
      .setValue(panel.enabled !== false)
      .setTooltip('启用此面板')
      .onChange((v) => {
        panel.enabled = v;
        void this.plugin.saveSettings();
      });
    const delBtn = head.createEl('button', { cls: 'ks-preset-item-del' });
    delBtn.setAttribute('aria-label', '删除此面板');
    delBtn.setAttribute('title', '删除此面板');
    this.setIconSafe(delBtn, 'trash-2', '\u00d7');
    delBtn.addEventListener('click', () => {
      const a = this.plugin.settings.panels || [];
      a.splice(index, 1);
      void this.plugin.saveSettings();
      rerenderAll();
    });

    const body = card.createDiv({ cls: 'ks-panel-card-body' });
    if (collapsed) card.addClass('ks-panel-card-collapsed');

    // 扫描文件夹：source/output 映射全局设置，custom = 自定义路径（追加输入框）。
    const folder = new Setting(body)
      .setName('扫描文件夹')
      .setDesc('面板列出该文件夹里的 md 文件。源文件夹/输出文件夹跟随「文件夹」tab 的全局设置；选择「自定义路径」后填写 vault 内路径（留空 = 全库）。')
      .addDropdown((drop) => {
        drop.addOption('source', '源文件夹');
        drop.addOption('output', '输出文件夹');
        drop.addOption('custom', '自定义路径');
        const f = panel.folder || 'source';
        drop.setValue(f === 'source' || f === 'output' ? f : 'custom');
        drop.onChange((value) => {
          if (value === 'custom') {
            if (panel.folder === 'source' || panel.folder === 'output') panel.folder = '';
          } else {
            panel.folder = value as 'source' | 'output';
          }
          void this.plugin.saveSettings();
          rerenderAll();
        });
      });
    this.markSearchable(folder, '面板 扫描文件夹 源文件夹 输出文件夹 自定义路径 folder');
    if (panel.folder !== 'source' && panel.folder !== 'output') {
      const folderPath = new Setting(body)
        .setName('自定义路径')
        .setDesc('自定义文件夹路径（vault 内路径；留空 = 斜杠 / 全库）。')
        .addText((text) =>
          text
            .setPlaceholder('如：Inbox')
            .setValue(panel.folder || '')
            .onChange((value) => {
              panel.folder = value;
              void this.plugin.saveSettings();
            })
        );
      this.markSearchable(folderPath, '面板 扫描文件夹 自定义路径 文件夹 路径');
    }

    const attr = new Setting(body)
      .setName('bool 属性名')
      .setDesc('frontmatter 中标记「已处理」的 bool 属性名；缺失或值不是 true 的文件显示在面板，设为 true 后消失。')
      .addText((text) =>
        text
          .setPlaceholder('tidy')
          .setValue(panel.attr || '')
          .onChange((value) => {
            panel.attr = value;
            void this.plugin.saveSettings();
          })
      );
    this.markSearchable(attr, '面板 bool 属性名 attr 属性 已处理');

    const afterDate = new Setting(body)
      .setName('最早日期')
      .setDesc('只看该日期之后（含当天）修改/创建的文件，之前的不看；格式 YYYY-MM-DD（如 2026-08-01）；留空 = 不限。')
      .addText((text) =>
        text
          .setPlaceholder('如：2026-08-01')
          .setValue(panel.afterDate || '')
          .onChange((value) => {
            panel.afterDate = value;
            void this.plugin.saveSettings();
          })
      );
    this.markSearchable(afterDate, '面板 最早日期 日期 时间 修改 创建 afterDate');

    const path = new Setting(body)
      .setName('面板位置')
      .setDesc('面板（.base 文件）在库中的路径；生成后由 Bases 核心插件渲染。留空 = 用面板名（如 新面板.base）。')
      .addText((text) =>
        text
          .setPlaceholder(`${panel.name || '面板'}.base`)
          .setValue(panel.basePath || '')
          .onChange((value) => {
            panel.basePath = value;
            void this.plugin.saveSettings();
          })
      );
    this.markSearchable(path, '面板 面板位置 面板 路径 base');

    const preset = new Setting(body)
      .setName('聊天预设')
      .setDesc('点击面板条目右侧聊天图标时使用的预设；「默认（全部工具）」= 不切换预设。')
      .addDropdown((drop) => {
        drop.addOption('', '默认（全部工具）');
        const presets = this.plugin.settings.toolPresets || [];
        for (const p of presets) {
          if (!p || !p.id) continue;
          drop.addOption(p.id, p.name || p.id);
        }
        drop.setValue(panel.chatPresetId || '');
        drop.onChange((value) => {
          panel.chatPresetId = value;
          void this.plugin.saveSettings();
        });
      });
    this.markSearchable(preset, '面板 聊天预设 预设 下拉 dropdown');

    const prompt = new Setting(body)
      .setName('聊天 prompt 模板')
      .setDesc('点击面板条目右侧聊天图标时，预填到聊天输入框的提示词模板。`{{filename}}` 会被替换为文件名（不含路径）；模板不含 `{{filename}}` 时原样使用。')
      .addTextArea((text) =>
        text
          .setPlaceholder('请查看「{{filename}}」并帮我处理。')
          .setValue(panel.chatPrompt || '')
          .onChange((value) => {
            panel.chatPrompt = value;
            void this.plugin.saveSettings();
          })
      );
    prompt.settingEl.addClass('ks-panel-prompt-row');
    this.markSearchable(prompt, '面板 聊天 prompt 模板 提示词 filename 占位符');

    const ops = new Setting(body)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setIcon('refresh-cw').setButtonText('生成面板').onClick(() => {
          void this.plugin.regeneratePanel(panel.id);
        })
      )
      .addButton((btn) =>
        btn.setIcon('external-link').setButtonText('打开面板').onClick(() => {
          void this.plugin.openPanel(panel.id);
        })
      );
    this.markSearchable(ops, '面板 生成面板 打开面板 重新生成');
  }

  // -------------------------------------------------------------------------
  // sidebar（v0.9.0：侧边栏「提醒面板」规则——条件 + 动作；仿预设折叠卡片模式）
  // -------------------------------------------------------------------------

  private renderSidebarGroup(containerEl: HTMLElement): void {
    containerEl.empty();

    const info = new Setting(containerEl)
      .setName('')
      .setDesc('配置左侧边栏「提醒面板」（命令「Open sidebar panel」或下方按钮打开）的规则：每条规则 = 条件 + 动作。条件匹配 0 条时该规则不显示条目。条件：未审核文件（输出文件夹）或缺少属性（指定文件夹 + 可选最近 N 天）；动作：打开审核面板或打开聊天（应用预设 + 预填 prompt 模板，{{filename}} 会被替换为匹配文件的文件名，不含路径与 .md）。');
    this.markSearchable(info, '侧边栏 提醒面板 规则 条件 动作 未审核 缺少属性 打开审核 打开聊天 filename');

    const openBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setIcon('panel-left').setButtonText('打开左侧边栏面板').onClick(() => {
          void this.plugin.openSidebarPanel();
        })
      );
    this.markSearchable(openBtn, '侧边栏 打开 面板 左侧边栏');

    const rules = this.plugin.settings.sidebarRules || (this.plugin.settings.sidebarRules = []);
    rules.forEach((rule, index) => this.renderSidebarRuleCard(containerEl, rule, index));

    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setIcon('plus').setButtonText('添加规则').onClick(() => {
          const nr: SidebarRule = {
            id: String(Date.now()),
            name: '新规则',
            enabled: true,
            condition: { type: 'unreviewed' },
            action: { type: 'open_review' },
          };
          this.plugin.settings.sidebarRules.push(nr);
          void this.plugin.saveSettings();
          this.renderSidebarGroup(containerEl);
        })
      );
    this.markSearchable(addBtn, '侧边栏 添加规则 增加 新建');
  }

  /**
   * 渲染一条侧边栏规则卡片（可折叠）：头部 = chevron + 名称输入 + 启用开关 +
   * 删除按钮；主体 = 条件编辑器 + 动作编辑器 + 「测试」按钮。折叠状态按 rule.id
   * 记忆（缺省展开）；条件/动作类型下拉切换后整组重绘。
   */
  private renderSidebarRuleCard(containerEl: HTMLElement, rule: SidebarRule, index: number): void {
    const rerenderAll = () => this.renderSidebarGroup(containerEl);
    const collapsed = this.sidebarRuleCollapsed.has(rule.id);

    const card = containerEl.createDiv({ cls: 'ks-sidebar-rule-item' });
    const head = card.createDiv({ cls: 'ks-sidebar-rule-head' });
    const chev = head.createSpan({ cls: 'ks-preset-item-chev' });
    this.setIconSafe(chev, collapsed ? 'chevron-right' : 'chevron-down', collapsed ? '\u203A' : '\u2304');
    chev.addEventListener('click', () => {
      const isCollapsed = card.hasClass('ks-sidebar-rule-collapsed');
      if (isCollapsed) this.sidebarRuleCollapsed.delete(rule.id);
      else this.sidebarRuleCollapsed.add(rule.id);
      this.setIconSafe(chev, isCollapsed ? 'chevron-down' : 'chevron-right', isCollapsed ? '\u2304' : '\u203A');
      card.toggleClass('ks-sidebar-rule-collapsed', !isCollapsed);
    });
    const nameInput = head.createEl('input', { cls: 'ks-preset-item-name ks-sidebar-rule-name' });
    nameInput.type = 'text';
    nameInput.value = rule.name || '';
    nameInput.placeholder = '规则名，如「有未审核文件」';
    nameInput.addEventListener('input', () => {
      rule.name = nameInput.value;
      void this.plugin.saveSettings();
    });
    // 启用开关（stopPropagation 防止冒泡——头部无折叠监听，这里仅为稳妥）。
    const toggleWrap = head.createSpan({ cls: 'ks-sidebar-rule-toggle' });
    toggleWrap.addEventListener('click', (ev) => ev.stopPropagation());
    new ToggleComponent(toggleWrap)
      .setValue(rule.enabled !== false)
      .setTooltip('启用此规则')
      .onChange((v) => {
        rule.enabled = v;
        void this.plugin.saveSettings();
      });
    const delBtn = head.createEl('button', { cls: 'ks-preset-item-del' });
    delBtn.setAttribute('aria-label', '删除此规则');
    delBtn.setAttribute('title', '删除此规则');
    this.setIconSafe(delBtn, 'trash-2', '\u00d7');
    delBtn.addEventListener('click', () => {
      this.plugin.settings.sidebarRules.splice(index, 1);
      this.sidebarRuleCollapsed.delete(rule.id);
      void this.plugin.saveSettings();
      rerenderAll();
    });

    const body = card.createDiv({ cls: 'ks-sidebar-rule-body' });
    if (collapsed) card.addClass('ks-sidebar-rule-collapsed');

    // ---- 条件编辑器 ----
    const condSel = new Setting(body)
      .setName('条件类型')
      .setDesc('「未审核文件」= 输出文件夹中未审核文件数 ≥ 最小数量；「缺少属性」= 指定文件夹里 frontmatter 缺少某属性（或值不等于期望值）的文件。')
      .addDropdown((drop) => {
        drop.addOptions({ unreviewed: '未审核文件', missing_property: '缺少属性' });
        drop.setValue(rule.condition.type);
        drop.onChange((v) => {
          rule.condition = v === 'unreviewed'
            ? { type: 'unreviewed' }
            : { type: 'missing_property', folder: 'output', property: '' };
          void this.plugin.saveSettings();
          rerenderAll();
        });
      });
    this.markSearchable(condSel, '侧边栏 条件类型 未审核文件 缺少属性 条件');

    if (rule.condition.type === 'unreviewed') {
      const cond = rule.condition as Extract<SidebarRule['condition'], { type: 'unreviewed' }>;
      const minCount = new Setting(body)
        .setName('最小数量')
        .setDesc('未审核文件数 ≥ 该值时规则匹配（留空 = 1）。')
        .addText((text) => {
          text.inputEl.type = 'number';
          text.setValue(cond.minCount === undefined ? '' : String(cond.minCount));
          text.onChange((value) => {
            if (value.trim() === '') {
              cond.minCount = undefined;
            } else {
              const n = parseInt(value, 10);
              if (!Number.isNaN(n)) cond.minCount = n;
            }
            void this.plugin.saveSettings();
          });
        });
      this.markSearchable(minCount, '侧边栏 未审核 最小数量 minCount 数量');
    } else {
      const cond = rule.condition as Extract<SidebarRule['condition'], { type: 'missing_property' }>;
      const isCustom = cond.folder !== 'source' && cond.folder !== 'output';
      const folderSel = new Setting(body)
        .setName('文件夹')
        .setDesc('「源文件夹」/「输出文件夹」映射设置里的对应文件夹；「自定义」= 手动填路径。')
        .addDropdown((drop) => {
          drop.addOptions({ source: '源文件夹', output: '输出文件夹', custom: '自定义' });
          drop.setValue(isCustom ? 'custom' : cond.folder);
          drop.onChange((v) => {
            if (v === 'custom') cond.folder = '';
            else cond.folder = v as 'source' | 'output';
            void this.plugin.saveSettings();
            rerenderAll();
          });
        });
      this.markSearchable(folderSel, '侧边栏 缺少属性 文件夹 源文件夹 输出文件夹 自定义');

      if (isCustom) {
        const pathSel = new Setting(body)
          .setName('自定义文件夹路径')
          .setDesc('库内文件夹路径；留空 = 库根目录。')
          .addText((text) =>
            text
              .setPlaceholder('如：工作/待办')
              .setValue(cond.folder)
              .onChange((value) => {
                cond.folder = value;
                void this.plugin.saveSettings();
              })
          );
        this.markSearchable(pathSel, '侧边栏 缺少属性 自定义 文件夹 路径');
      }

      const afterSel = new Setting(body)
        .setName('此日期之后')
        .setDesc('只看此日期之后（含当天）修改的文件，之前的不管；格式 YYYY-MM-DD（如 2026-08-01）；留空 = 不限。')
        .addText((text) =>
          text
            .setPlaceholder('如：2026-08-01')
            .setValue(cond.afterDate ?? '')
            .onChange((value) => {
              cond.afterDate = value.trim() === '' ? undefined : value.trim();
              void this.plugin.saveSettings();
            })
        );
      this.markSearchable(afterSel, '侧边栏 缺少属性 此日期之后 afterDate 日期 时间 修改');

      const propSel = new Setting(body)
        .setName('属性名')
        .setDesc('要检查的 frontmatter 属性名（如 approved）。')
        .addText((text) =>
          text
            .setPlaceholder('如：approved')
            .setValue(cond.property)
            .onChange((value) => {
              cond.property = value;
              void this.plugin.saveSettings();
            })
        );
      this.markSearchable(propSel, '侧边栏 缺少属性 属性名 property frontmatter');

      const expSel = new Setting(body)
        .setName('期望值')
        .setDesc('留空 = 属性缺失即匹配；填写 = 属性缺失或值不等于期望值都匹配。')
        .addText((text) =>
          text
            .setPlaceholder('留空 = 仅属性缺失')
            .setValue(cond.expectedValue ?? '')
            .onChange((value) => {
              cond.expectedValue = value.trim() === '' ? undefined : value;
              void this.plugin.saveSettings();
            })
        );
      this.markSearchable(expSel, '侧边栏 缺少属性 期望值 expectedValue 匹配');
    }

    // ---- 动作编辑器 ----
    const actSel = new Setting(body)
      .setName('动作类型')
      .setDesc('「打开审核面板」= 点击条目右侧图标打开审核页（单条，显示匹配数）；「打开聊天」= 每个匹配文件一条，点击图标打开聊天（应用预设 + 预填 prompt 模板）。')
      .addDropdown((drop) => {
        drop.addOptions({ open_review: '打开审核面板', open_chat: '打开聊天' });
        drop.setValue(rule.action.type);
        drop.onChange((v) => {
          rule.action = v === 'open_review' ? { type: 'open_review' } : { type: 'open_chat' };
          void this.plugin.saveSettings();
          rerenderAll();
        });
      });
    this.markSearchable(actSel, '侧边栏 动作类型 打开审核面板 打开聊天 动作');

    if (rule.action.type === 'open_chat') {
      const act = rule.action as Extract<SidebarRule['action'], { type: 'open_chat' }>;
      const presetSel = new Setting(body)
        .setName('聊天预设')
        .setDesc('点击图标打开聊天时应用的预设；「默认（全部工具）」= 当前聊天预设（全部工具）。')
        .addDropdown((drop) => {
          const presets = this.plugin.settings.toolPresets || [];
          const opts: Record<string, string> = { '': '默认（全部工具）' };
          for (const p of presets) opts[p.id] = p.name;
          drop.addOptions(opts);
          drop.setValue(presets.some((p) => p.id === act.presetId) ? act.presetId ?? '' : '');
          drop.onChange((v) => {
            act.presetId = v || undefined;
            void this.plugin.saveSettings();
          });
        });
      this.markSearchable(presetSel, '侧边栏 打开聊天 预设 preset 全部工具');

      const promptSel = new Setting(body)
        .setName('Prompt 模板')
        .setDesc('点击图标时预填到聊天输入框的提示词；`{{filename}}` 会被替换为匹配文件的文件名（不含路径、不含 .md）。留空 = 只打开聊天、不预填。')
        .addTextArea((text) =>
          text
            .setPlaceholder('请帮我处理笔记「{{filename}}」…')
            .setValue(act.promptTemplate ?? '')
            .onChange((value) => {
              act.promptTemplate = value;
              void this.plugin.saveSettings();
            })
        );
      promptSel.settingEl.addClass('ks-review-prompt-row');
      this.markSearchable(promptSel, '侧边栏 打开聊天 prompt 模板 提示词 filename');
    }

    // ---- 测试按钮 ----
    const testBtn = new Setting(body)
      .setName('')
      .setDesc('立即按当前条件求值一次，显示匹配文件数量。')
      .addButton((btn) =>
        btn.setIcon('play').setButtonText('测试').onClick(() => {
          const matches = evaluateCondition(this.app, this.plugin.settings, rule.condition);
          new Notice(`条件「${rule.name || '未命名规则'}」匹配 ${matches.length} 个文件`);
        })
      );
    this.markSearchable(testBtn, '侧边栏 测试 匹配 数量 求值');
  }

  /**
   * Render the "AI 修改输出工具" group (v0.8.0): 说明 + 归档三配置（版本后缀/版本号属性名/
   * 归档标记属性名）。modify_output_note / modify_output_note_versioned 与 create_note 一样
   * 受「AI 创建属性规则 / 限制仅已配置属性」约束；固定 yaml 默认值写回时自动补上。
   */
  private renderModifyOutputTools(containerEl: HTMLElement): void {
    containerEl.empty();

    const info = new Setting(containerEl)
      .setName('')
      .setDesc('控制 AI 使用 modify_output_note / modify_output_note_versioned（覆盖修改输出文件夹内已有笔记：sections 只能改原文已有标题下的内容，禁止修改/新增标题、禁止 # 开头）。yaml 受下方「AI 修改属性规则」约束（与 create_note 的属性规则分开、结构相同）；开启「限制仅已配置属性」后 AI 只能使用规则内的键；「仅默认值」的键 AI 不可见、每次修改强制覆写为渲染后的默认值（如 created=当前时间；归档版先归档旧状态再写入新时间戳）。read_output_note 读取输出文件夹内笔记全文。');
    this.markSearchable(info, 'AI 修改输出工具 modify_output_note 说明 属性 归档 read_output_note');

    const suffix = new Setting(containerEl)
      .setName('版本后缀（modify_output_note_versioned）')
      .setDesc('归档文件后缀（追加在原文名后，如「-归档」→ 原文名-归档.md）；留空 = 该工具不工作（报错）。')
      .addText((text) =>
        text
          .setPlaceholder('如：-归档')
          .setValue(this.plugin.settings.modifyVersionSuffix)
          .onChange((v) => this.updateSetting('modifyVersionSuffix', v))
      );
    this.markSearchable(suffix, 'AI 修改输出工具 版本后缀 归档 modifyVersionSuffix');

    const vprop = new Setting(containerEl)
      .setName('版本号属性名（modify_output_note_versioned）')
      .setDesc('写入原文件的版本号 yaml 属性名（数字递增）；留空 = 该工具不工作（报错）。')
      .addText((text) =>
        text
          .setPlaceholder('如：version')
          .setValue(this.plugin.settings.modifyVersionProperty)
          .onChange((v) => this.updateSetting('modifyVersionProperty', v))
      );
    this.markSearchable(vprop, 'AI 修改输出工具 版本号属性 modifyVersionProperty');

    const aprop = new Setting(containerEl)
      .setName('归档标记属性名（modify_output_note_versioned）')
      .setDesc('写入原文件的归档 bool 属性名（如 archived，写 true）；留空 = 该工具不工作（报错）。')
      .addText((text) =>
        text
          .setPlaceholder('如：archived')
          .setValue(this.plugin.settings.modifyArchiveProperty)
          .onChange((v) => this.updateSetting('modifyArchiveProperty', v))
      );
    this.markSearchable(aprop, 'AI 修改输出工具 归档标记属性 modifyArchiveProperty');

    // v0.8.2：modify 工具独立的 yaml 属性规则（与 create 的「AI 创建属性规则」结构相同、内容分开）。
    // 包一层子容器：renderModifyYamlRules 内部 empty() 只清这里，不影响归档配置。
    const modifyRulesWrap = containerEl.createDiv();
    this.renderModifyYamlRules(modifyRulesWrap);
  }

  /**
   * Render the "AI 修改属性规则" block (v0.8.2): 与「AI 创建属性规则」结构一致，
   * 数据源 `settings.modifyYamlRules`——仅作用于 modify_output_note / modify_output_note_versioned。
   * 每行：属性名 + 解释 + 默认值 + 「暴露给 AI」开关 + 「覆写默认值」开关（modify 专属）+ 删除；
   * 不暴露时隐藏可选值 tag 区（AI 看不到、也禁止写入）。
   */
  private renderModifyYamlRules(containerEl: HTMLElement): void {
    containerEl.empty(); // 重渲染替换而非追加（修复重复叠加）
    const info = new Setting(containerEl)
      .setName('AI 修改属性规则（modify 工具）')
      .setDesc('控制 AI 使用 modify_output_note / modify_output_note_versioned 时的 frontmatter 键值对（与「AI 创建属性规则」结构相同、内容独立）：属性名 + 「暴露给 AI」开关 + 可选值 + 默认值 + 「覆写默认值」开关。暴露 = AI 可见可改（可选值作约束）；不暴露 = AI 看不到、禁止 AI 写入。「覆写默认值」开 = 每次修改强制覆写默认值（如 created=时间戳，支持 {{moment}} 模板）；关 = 不修改原值（原样保留，如 approve）。');
    this.markSearchable(info, 'AI 修改属性规则 modify 工具 键名 解释 可选值 默认值 暴露 覆写 moment 模板');

    const list = this.plugin.settings.modifyYamlRules || [];
    list.forEach((rule, index) => {
      const hay = `AI 修改属性规则 ${rule.key} ${rule.desc} ${rule.values.join(' ')} ${rule.default}`;
      const row = new Setting(containerEl)
        .setName('')
        .setDesc('')
        .addText((text) =>
          text
            .setPlaceholder('属性名，如 created')
            .setValue(rule.key)
            .onChange((value) => {
              rule.key = value;
              void this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder('解释（暴露时随工具描述传给 AI）')
            .setValue(rule.desc)
            .onChange((value) => {
              rule.desc = value;
              void this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder('默认值（支持 {{YYYY.MM.DD}}；留空=不插入/不覆写）')
            .setValue(rule.default)
            .onChange((value) => {
              rule.default = value;
              void this.plugin.saveSettings();
            })
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.resolveUiExpose(rule))
            .setTooltip('暴露给 AI')
            .onChange((v) => {
              rule.expose = v;
              void this.plugin.saveSettings();
              this.renderModifyYamlRules(containerEl);
            })
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.resolveUiOverwrite(rule))
            .setTooltip('覆写默认值')
            .onChange((v) => {
              rule.overwrite = v;
              void this.plugin.saveSettings();
              this.renderModifyYamlRules(containerEl);
            })
        )
        .addButton((btn) =>
          btn
            .setIcon('trash-2')
            .setTooltip('删除')
            .onClick(() => {
              const a = this.plugin.settings.modifyYamlRules;
              a.splice(index, 1);
              void this.plugin.saveSettings();
              this.renderModifyYamlRules(containerEl);
            })
        );
      row.settingEl.addClass('ks-yaml-rule-row');
      this.markSearchable(row, hay);

      // 可选值 tag 输入区：仅「暴露给 AI」时显示；v0.8.x 起挂在 controlEl 内，
      // 与属性名/解释/默认值三个控件同一行（窄屏由 flex-wrap 自动换行）。
      if (this.resolveUiExpose(rule)) {
        const valuesEl = row.controlEl.createDiv({ cls: 'ks-yaml-values' });
        valuesEl.setAttribute('data-search', hay);
        this.renderYamlValues(valuesEl, rule);
      }
    });

    // 开关说明（modify 有「暴露给 AI」「覆写默认值」两个开关）。
    const legend = new Setting(containerEl)
      .setName('')
      .setDesc(
        '开关说明：\n' +
          '第一个开关（暴露给 AI）：开 = AI 可见此属性，可填写值（可选值用于约束只能选这些值，留空=任意）；关 = AI 完全看不到此属性、也禁止 AI 写入。\n' +
          '第二个开关（覆写默认值）：开 = 每次修改文件时把此属性强制覆写为默认值（如 created + {{YYYY-MM-DD HH:mm}} 记录本次修改时间）；关 = 不修改此属性的原值（原样保留，如 approve）。\n' +
          '默认值输入框：暴露时 = AI 未填此键才自动补入；不暴露且覆写开 = 每次强制覆写；留空 = 不插入/不覆写。\n' +
          '默认值支持 {{YYYY.MM.DD}} 等 moment 模板。'
      );
    this.markSearchable(legend, 'AI 修改属性规则 开关说明 第一个开关 第二个开关 暴露给AI 覆写默认值 默认值 可选值');

    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setIcon('plus').setButtonText('添加规则').onClick(() => {
          this.plugin.settings.modifyYamlRules.push({ key: '', desc: '', values: [], default: '', expose: true, overwrite: false });
          void this.plugin.saveSettings();
          this.renderModifyYamlRules(containerEl);
        })
      );
    this.markSearchable(addBtn, 'AI 修改属性规则 添加规则 增加 添加');
  }

  /** UI 侧 expose 解析（与工具层 resolveRuleExpose 同语义，避免 import 工具模块）。 */
  private resolveUiExpose(rule: { expose?: boolean; values?: string[] }): boolean {
    if (rule.expose === true) return true;
    if (rule.expose === false) return false;
    return Array.isArray(rule.values) && rule.values.length > 0;
  }

  /** UI 侧 overwrite 解析（与工具层 resolveRuleOverwrite 同语义）。 */
  private resolveUiOverwrite(rule: { overwrite?: boolean; values?: string[]; default?: string }): boolean {
    if (rule.overwrite === true) return true;
    if (rule.overwrite === false) return false;
    return (
      (!Array.isArray(rule.values) || rule.values.length === 0) &&
      String(rule.default ?? '').trim() !== ''
    );
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
      .setDesc('控制 AI 使用 create_note 工具时的 frontmatter 键值对：属性名 + 「暴露给 AI」开关 + 可选值 + 默认值。暴露 = AI 可见（可选值作约束，留空=任意），默认值=AI 未填时自动补；不暴露 = AI 完全看不到、也禁止 AI 写入，创建时自动追加默认值。默认值支持 {{YYYY.MM.DD}} 等 moment 模板。');
    this.markSearchable(info, 'AI 创建属性规则 键名 解释 可选值 默认值 暴露 moment 模板 frontmatter');

    // v0.8.0：限制 AI 只能使用「已配置的属性」——create_note / modify_output_note* 的 yaml 键必须在规则集内。
    const restrict = new Setting(containerEl)
      .setName('限制 AI 只能使用已配置的属性')
      .setDesc('开启后，create_note / modify_output_note / modify_output_note_versioned 的 yaml 键只能在对应属性规则里配置；规则外键会被拒绝（默认关闭，兼容现状）。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.createRestrictYaml)
          .onChange((v) => this.updateSetting('createRestrictYaml', v))
      );
    this.markSearchable(restrict, 'AI 创建属性规则 限制 只能使用已配置的属性 createRestrictYaml 规则外键');

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
            .setPlaceholder('解释（暴露时随工具描述传给 AI）')
            .setValue(rule.desc)
            .onChange((value) => {
              rule.desc = value;
              void this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder('默认值（AI 未填此键时自动插入，支持 {{YYYY.MM.DD}}；留空=不插入）')
            .setValue(rule.default)
            .onChange((value) => {
              rule.default = value;
              void this.plugin.saveSettings();
            })
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.resolveUiExpose(rule))
            .setTooltip('暴露给 AI')
            .onChange((v) => {
              rule.expose = v;
              void this.plugin.saveSettings();
              this.renderYamlRules(containerEl);
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

      // 可选值 tag 输入区：仅「暴露给 AI」时显示；v0.8.x 起挂在 controlEl 内，
      // 与属性名/解释/默认值三个控件同一行（窄屏由 flex-wrap 自动换行）。
      if (this.resolveUiExpose(rule)) {
        const valuesEl = row.controlEl.createDiv({ cls: 'ks-yaml-values' });
        valuesEl.setAttribute('data-search', hay);
        this.renderYamlValues(valuesEl, rule);
      }
    });

    // 开关说明（create 有「暴露给 AI」一个开关）。
    const legend = new Setting(containerEl)
      .setName('')
      .setDesc(
        '开关说明：\n' +
          '第一个开关（暴露给 AI）：开 = AI 可见此属性，可填写值（可选值用于约束只能选这些值，留空=任意）；关 = AI 完全看不到此属性、也禁止 AI 写入。\n' +
          '默认值输入框：暴露时 = AI 未填此键才自动补入；不暴露时 = 创建文件自动追加默认值（如 approve → 未审核）；留空 = 不插入。\n' +
          '默认值支持 {{YYYY.MM.DD}} 等 moment 模板。'
      );
    this.markSearchable(legend, 'AI 创建属性规则 开关说明 第一个开关 暴露给AI 默认值 可选值');

    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setIcon('plus').setButtonText('添加规则').onClick(() => {
          this.plugin.settings.yamlRules.push({ key: '', desc: '', values: [], default: '', expose: true });
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
        this.setIconSafe(x, 'x', '\u00d7');
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
        btn.setIcon('plus').setButtonText('添加规则').onClick(() => {
          this.plugin.settings.updateYamlRules.push({ key: '', desc: '', values: [] });
          void this.plugin.saveSettings();
          this.renderUpdateYamlRules(containerEl);
        })
      );
    this.markSearchable(addBtn, 'AI 修改属性规则 添加规则 增加 添加');
  }

  /**
   * v0.9.1：预设内 update_note_yaml 属性规则列表（与全局 renderUpdateYamlRules 同构，
   * 但数据源是预设 outputConfig.updateYamlRules 数组）。每条 = key 输入 + 解释
   * textarea（多行，解释各可选值含义）+ 可选值 chips（复用 renderYamlValues）+
   * 删除；底部「添加规则」按钮 push `{key:'', desc:'', values:[]}`。
   */
  private renderPresetUpdateYamlRules(
    containerEl: HTMLElement,
    rules: UpdateYamlRule[],
    rerender: () => void
  ): void {
    rules.forEach((rule, index) => {
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
              rules.splice(index, 1);
              void this.plugin.saveSettings();
              rerender();
            })
        );
      row.settingEl.addClasses(['ks-yaml-rule-row', 'ks-update-yaml-rule-row']);
      this.markSearchable(row, hay);

      // 可选值 chips 区：与全局版一致，挂在行之后（desc 为多行 textarea，独立成区）。
      const valuesEl = containerEl.createDiv({ cls: 'ks-yaml-values setting-item' });
      valuesEl.setAttribute('data-search', hay);
      this.renderYamlValues(valuesEl, rule);
    });
    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setIcon('plus').setButtonText('添加规则').onClick(() => {
          rules.push({ key: '', desc: '', values: [] });
          void this.plugin.saveSettings();
          rerender();
        })
      );
    this.markSearchable(addBtn, '预设 update_note_yaml AI修改属性规则 添加规则 增加 添加');
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

    // v0.8.0：模板配置导出/导入——「复制配置」把 noteTemplate 的 JSON 复制到剪贴板；
    // 「粘贴配置」从剪贴板解析 JSON 并按标题合并（已存在标题更新级别/允许AI写/解释，否则追加）。
    const cfgRow = new Setting(containerEl)
      .setName('模板配置导出/导入')
      .setDesc('「复制配置」把当前模板配置复制为 JSON 到剪贴板；「粘贴配置」从剪贴板解析 JSON 并合并（按标题文本合并：已存在则更新级别/允许AI写/解释，否则追加）。')
      .addButton((btn) => btn.setIcon('copy').setButtonText('复制配置').onClick(() => this.copyTemplateConfig()))
      .addButton((btn) => btn.setIcon('clipboard').setButtonText('粘贴配置').onClick(async () => this.pasteTemplateConfig(containerEl)));
    this.markSearchable(cfgRow, 'AI 创建模板 模板配置 导出 导入 复制 粘贴');

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
        btn.setIcon('plus').setButtonText('添加标题').onClick(() => {
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

  /** 复制模板配置（noteTemplate 的 JSON）到剪贴板。 */
  private copyTemplateConfig(): void {
    const text = JSON.stringify(this.plugin.settings.noteTemplate || [], null, 2);
    this.writeClipboard(text, '已复制模板配置');
  }

  /** 从剪贴板解析 JSON 并合并到 noteTemplate（按标题合并），然后重绘模板分组。 */
  private async pasteTemplateConfig(bodyEl: HTMLElement): Promise<void> {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = '';
    }
    if (!text.trim()) {
      new Notice('剪贴板为空或无法读取');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      new Notice('粘贴内容不是合法的 JSON');
      return;
    }
    if (!Array.isArray(parsed)) {
      new Notice('粘贴的 JSON 必须是数组（每个元素 = 一个标题配置）');
      return;
    }
    const list = this.plugin.settings.noteTemplate || (this.plugin.settings.noteTemplate = []);
    for (const raw of parsed) {
      const e = (raw ?? {}) as Partial<NoteTemplateEntry>;
      if (!e || typeof e.title !== 'string') continue;
      const title = e.title.trim();
      if (!title) continue;
      const existing = list.find((x) => x.title.trim() === title);
      if (existing) {
        existing.level = typeof e.level === 'number' ? Math.max(1, Math.min(6, e.level)) : existing.level;
        existing.allowAi = !!e.allowAi;
        existing.desc = typeof e.desc === 'string' ? e.desc : existing.desc;
      } else {
        list.push({
          title,
          level: typeof e.level === 'number' ? Math.max(1, Math.min(6, e.level)) : 2,
          allowAi: !!e.allowAi,
          desc: typeof e.desc === 'string' ? e.desc : '',
        });
      }
    }
    void this.plugin.saveSettings();
    // bodyEl 即模板分组的 body；整组重绘以反映合并后的列表。
    this.renderNoteTemplate(bodyEl);
    new Notice('已粘贴并合并模板配置');
  }

  /** 写入剪贴板（navigator.clipboard 优先，失败走 execCommand 兜底）。 */
  private writeClipboard(text: string, onSuccess?: string): void {
    const done = () => {
      if (onSuccess) new Notice(onSuccess);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done, () => this.clipboardFallback(text, done));
    } else {
      this.clipboardFallback(text, done);
    }
  }

  /** textarea + execCommand 兜底复制（Obsidian 里剪贴板 API 不可用时）。 */
  private clipboardFallback(text: string, done: () => void): void {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch {
      new Notice('复制失败');
    }
  }

  /** Small lucide icon button (no emoji) for the template row operations.
   *  v0.8.x：按钮带文字标签（触屏无 hover，title/aria-label 不可见），
   *  图标不可见时回退 glyph，文字始终显示。 */
  private addIconBtn(parent: HTMLElement, icon: string, tooltip: string, onClick: () => void): void {
    const btn = parent.createEl('button', { cls: 'ks-template-op' });
    this.setIconSafe(btn, icon, tooltip === '删除' ? '\u00d7' : '\u203a');
    btn.createSpan({ text: tooltip });
    btn.setAttribute('aria-label', tooltip);
    btn.setAttribute('title', tooltip);
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
        btn.setIcon('list').setButtonText('统计最近文件数').setCta().onClick(() => {
          const n = countRecentFiles(this.plugin);
          new Notice(`源文件夹最近 ${this.plugin.settings.recentDays} 天共有 ${n} 个文件`);
        })
      );
    this.markSearchable(count, '测试 统计 最近文件数 统计最近 统计');

    const output = new Setting(bodyEl)
      .setName('输出最新内容测试')
      .setDesc('取源文件夹时间最新的文件，将其正文最后 100 字符写入输出文件夹。')
      .addButton((btn) =>
        btn.setIcon('file-text').setButtonText('输出最新内容测试').setCta().onClick(async () => {
          await outputLatestContent(this.plugin);
        })
      );
    this.markSearchable(output, '测试 输出 最新内容 输出最新内容 输出');
  }

  // -------------------------------------------------------------------------
  // preset (tool preset management UI, v0.5.0 — 6th tab)
  // -------------------------------------------------------------------------

  /**
   * v0.8.2：默认预设（全局设置）——其他预设未配置的项继承这里。结构与普通预设
   * 一致（可折叠项 + 每工具折叠组），编辑的是全局 settings（yamlRules / noteTemplate /
   * modifyYamlRules / 归档三配置 / createRestrictYaml）。
   */
  private renderDefaultPresetRow(containerEl: HTMLElement, rerender: () => void): void {
    const itemEl = containerEl.createDiv({ cls: 'ks-preset-item' });
    const expanded = this.presetExpanded.has('__default__');
    if (!expanded) itemEl.addClass('ks-preset-item-collapsed');

    const headEl = itemEl.createDiv({ cls: 'ks-preset-item-head' });
    const chev = headEl.createSpan({ cls: 'ks-preset-item-chev' });
    this.setIconSafe(chev, expanded ? 'chevron-down' : 'chevron-right', expanded ? '\u2304' : '\u203A');
    chev.addEventListener('click', () => this.togglePresetItem(itemEl, chev, '__default__'));
    headEl.createSpan({ cls: 'ks-preset-tool-label', text: '默认预设（全局设置）' });
    headEl.createSpan({ cls: 'ks-tool-config-desc', text: '其他预设未启用覆盖的项继承这里的配置；等同于设置页「输出属性」tab。' });

    const bodyEl = itemEl.createDiv({ cls: 'ks-preset-item-body' });

    const toolArea = bodyEl.createDiv({ cls: 'ks-preset-tools' });

    const renderGlobalGroup = (
      name: string,
      explanation: string,
      renderBody: (bodyEl: HTMLElement) => void,
      io?: ToolConfigIO
    ): void => {
      const key = `__default__:${name}`;
      const groupEl = toolArea.createDiv({ cls: 'ks-group ks-tool-config' });
      const head = groupEl.createDiv({ cls: 'ks-tool-config-head' });
      const c = head.createSpan({ cls: 'ks-group-icon' });
      const open = this.toolExpanded.has(key);
      this.setIconSafe(c, open ? 'chevron-down' : 'chevron-right', open ? '\u2304' : '\u203A');
      head.createSpan({ cls: 'ks-preset-tool-label', text: name });
      head.createSpan({ cls: 'ks-tool-config-desc', text: explanation });
      const b = groupEl.createDiv({ cls: 'ks-group-body' });
      if (!open) groupEl.addClass('ks-collapsed');
      head.addEventListener('click', () => {
        const collapsed = groupEl.hasClass('ks-collapsed');
        groupEl.toggleClass('ks-collapsed', !collapsed);
        this.setIconSafe(c, collapsed ? 'chevron-down' : 'chevron-right', collapsed ? '\u2304' : '\u203A');
        if (collapsed) this.toolExpanded.add(key);
        else this.toolExpanded.delete(key);
      });
      // v0.8.3：全局（默认预设）工具组同样支持配置复制/导入（preset=null → global 模式）。
      if (io) this.renderToolIoBar(b, io, null, rerender);
      renderBody(b);
    };

    renderGlobalGroup('create_note（属性规则 / 模板）', '默认预设的创建规则与正文模板（AI 创建属性规则 / AI 创建模板）。', (b) => {
      const yamlBody = b.createDiv();
      this.renderYamlRules(yamlBody);
      const tmplWrap = b.createDiv();
      const tmplHeading = new Setting(tmplWrap)
        .setName('AI 创建模板')
        .setDesc('create_note 正文结构（标题级别 / 允许 AI 写 / 解释）；空 = 自由正文。');
      this.markSearchable(tmplHeading, '默认预设 创建模板 noteTemplate 标题');
      const tmplBody = tmplWrap.createDiv();
      this.renderNoteTemplate(tmplBody);
    }, createIo);

    renderGlobalGroup('modify_output_note（属性规则）', '默认预设的修改属性规则（AI 修改属性规则）。', (b) => {
      const modBody = b.createDiv();
      this.renderModifyYamlRules(modBody);
    }, modifyIo);

    // v0.9.1：默认预设的 update_note_yaml 属性规则（复用全局 renderUpdateYamlRules，
    // 内部 empty/重渲染只作用于自己的容器——包一层 div 避免清掉同组的 io 条）。
    renderGlobalGroup('update_note_yaml（属性规则）', '默认预设的 update_note_yaml 属性规则（允许修改的属性 + 可选值约束）。', (b) => {
      const updateYamlBody = b.createDiv();
      this.renderUpdateYamlRules(updateYamlBody);
    }, updateYamlIo);

    renderGlobalGroup('modify_output_note_versioned（归档配置）', '默认预设的归档配置（版本后缀 / 版本号属性 / 归档标记属性）。', (b) => {
      const suffix = new Setting(b)
        .setName('版本后缀')
        .setDesc('归档文件后缀（如「-归档」→ 原文名-归档.md）。')
        .addText((text) =>
          text
            .setPlaceholder('如：-归档')
            .setValue(this.plugin.settings.modifyVersionSuffix)
            .onChange((v) => this.updateSetting('modifyVersionSuffix', v))
        );
      this.markSearchable(suffix, '默认预设 归档 版本后缀');
      const vprop = new Setting(b)
        .setName('版本号属性名')
        .setDesc('写入原文件的版本号 yaml 属性名（数字递增）。')
        .addText((text) =>
          text
            .setPlaceholder('如：version')
            .setValue(this.plugin.settings.modifyVersionProperty)
            .onChange((v) => this.updateSetting('modifyVersionProperty', v))
        );
      this.markSearchable(vprop, '默认预设 归档 版本号属性');
      const aprop = new Setting(b)
        .setName('归档标记属性名')
        .setDesc('写入归档文件 frontmatter 的 bool 属性名（如 archived，写 true）。')
        .addText((text) =>
          text
            .setPlaceholder('如：archived')
            .setValue(this.plugin.settings.modifyArchiveProperty)
            .onChange((v) => this.updateSetting('modifyArchiveProperty', v))
        );
      this.markSearchable(aprop, '默认预设 归档 归档标记属性');
    });
  }

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

    // v0.8.2：默认预设（全局设置）——其他预设未配置的项继承这里。
    // rerender 回调：默认预设工具组导入配置后重渲染整个预设组。
    this.renderDefaultPresetRow(listBody, () => this.renderPresetGroup(containerEl));

    presets.forEach((preset, index) => this.renderPresetRow(listBody, preset, index, containerEl));

    const addBtn = new Setting(listBody)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setIcon('plus').setButtonText('新建预设').onClick(() => {
          const np: ToolPreset = {
            id: String(Date.now()),
            name: '新预设',
            systemPrompt: '',
            // v0.8.8：显式全开（而不是 []）——空数组现在是「全部关闭」。
            enabledTools: TOOL_NAMES.slice(),
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
    // 预设内配置变化后重渲染整个预设组（保证覆盖开关/列表结构正确刷新）。
    const rerenderAll = () => this.renderPresetGroup(parentEl);
    // B.1：每个预设一个可折叠项（默认收起），头部=名称输入+展开 chevron+删除。
    const itemEl = containerEl.createDiv({ cls: 'ks-preset-item' });
    const expanded = this.presetExpanded.has(preset.id);
    if (!expanded) itemEl.addClass('ks-preset-item-collapsed');

    const headEl = itemEl.createDiv({ cls: 'ks-preset-item-head' });
    // v0.8.0 布局：左 chevron + 中间名称(flex:1) + 右删除，展开键与删除键分开
    // （移动端避免误触）；删除放行尾最右侧远离 chevron。
    const chev = headEl.createSpan({ cls: 'ks-preset-item-chev' });
    this.setIconSafe(chev, expanded ? 'chevron-down' : 'chevron-right', expanded ? '\u2304' : '\u203A');
    chev.addEventListener('click', () => this.togglePresetItem(itemEl, chev, preset.id));
    const nameInput = headEl.createEl('input', { cls: 'ks-preset-item-name' });
    nameInput.type = 'text';
    nameInput.value = preset.name || '';
    nameInput.placeholder = '未命名预设';
    nameInput.addEventListener('input', () => {
      preset.name = nameInput.value;
      void this.plugin.saveSettings();
      // 重命名即时刷新「聊天使用的预设」下拉（v0.8.2 修复）。
      if (this.activePresetDropdown) this.populateActivePresetDropdown(this.activePresetDropdown);
    });
    const delBtn = headEl.createEl('button', { cls: 'ks-preset-item-del' });
    delBtn.setAttribute('aria-label', '删除此预设');
    delBtn.setAttribute('title', '删除此预设');
    this.setIconSafe(delBtn, 'trash-2', '\u00d7');
    delBtn.addEventListener('click', () => {
      this.plugin.settings.toolPresets.splice(index, 1);
      // v0.8.2：删除当前活动预设时清空 activePresetId（避免残留脏数据）。
      if (this.plugin.settings.activePresetId === preset.id) this.updateSetting('activePresetId', '');
      this.presetExpanded.delete(preset.id);
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
        const attrSetting = new Setting(body)
          .setName('日期属性名（可选）')
          .setDesc('每个文件 frontmatter 里记录日期的属性名（如 created）；留空 = 用设置里「时间属性」。')
          .addText((text) =>
            text
              .setPlaceholder('created')
              .setValue(preset.toolOverrides.recentOutputAttr ?? '')
              .onChange((value) => {
                preset.toolOverrides.recentOutputAttr = value.trim() || undefined;
                void this.plugin.saveSettings();
              })
          );
        this.markSearchable(attrSetting, '预设 list_recent_notes 日期属性 时间属性 recentOutputAttr');
        const fmtSetting = new Setting(body)
          .setName('日期格式（可选，moment 双大括号）')
          .setDesc('解析该属性用的 moment 格式，双大括号写法如 {{YYYY.MM.DD}}T{{HH:mm:ss}}；留空 = 用设置里「时间格式」。')
          .addText((text) =>
            text
              .setPlaceholder('{{YYYY.MM.DD}}T{{HH:mm:ss}}')
              .setValue(preset.toolOverrides.recentOutputFormat ?? '')
              .onChange((value) => {
                preset.toolOverrides.recentOutputFormat = value.trim() || undefined;
                void this.plugin.saveSettings();
              })
          );
        this.markSearchable(fmtSetting, '预设 list_recent_notes 日期格式 时间格式 moment recentOutputFormat 双大括号');
      }, listRecentIo, rerenderAll);

    // v0.8.9：列出输出文件夹最近文件（与 list_recent_notes 对称，作用于输出文件夹）。
    this.renderToolConfigGroup(toolArea, preset, 'list_recent_output_notes',
      '列出输出文件夹最近 N 天笔记（参数：days 回看天数）', (body) => {
        const daysSetting = new Setting(body)
          .setName('回看天数')
          .setDesc('覆写 list_recent_output_notes 的 days；留空 = 用设置里「最近 N 天」。')
          .addText((text) => {
            text.inputEl.type = 'number';
            text.setValue(String(preset.toolOverrides.listRecentDays ?? ''));
            text.onChange((value) => {
              const n = parseInt(value, 10);
              preset.toolOverrides.listRecentDays = value.trim() === '' || Number.isNaN(n) ? undefined : n;
              void this.plugin.saveSettings();
            });
          });
        this.markSearchable(daysSetting, '预设 list_recent_output_notes 天数 回看天数');
        const attrSetting = new Setting(body)
          .setName('日期属性名（必填建议）')
          .setDesc('每个文件 frontmatter 里记录日期的属性名（如 created）；留空 = 回退用设置里「时间属性」，再回退文件创建时间。')
          .addText((text) =>
            text
              .setPlaceholder('created')
              .setValue(preset.toolOverrides.recentOutputAttr ?? '')
              .onChange((value) => {
                preset.toolOverrides.recentOutputAttr = value.trim() || undefined;
                void this.plugin.saveSettings();
              })
          );
        this.markSearchable(attrSetting, '预设 list_recent_output_notes 日期属性 时间属性 recentOutputAttr');
        const fmtSetting = new Setting(body)
          .setName('日期格式（必填建议，moment 双大括号）')
          .setDesc('解析该属性用的 moment 格式，双大括号写法如 {{YYYY.MM.DD}}T{{HH:mm:ss}}；留空 = 回退用设置里「时间格式」。')
          .addText((text) =>
            text
              .setPlaceholder('{{YYYY.MM.DD}}T{{HH:mm:ss}}')
              .setValue(preset.toolOverrides.recentOutputFormat ?? '')
              .onChange((value) => {
                preset.toolOverrides.recentOutputFormat = value.trim() || undefined;
                void this.plugin.saveSettings();
              })
          );
        this.markSearchable(fmtSetting, '预设 list_recent_output_notes 日期格式 时间格式 moment recentOutputFormat 双大括号');
      }, listRecentOutputIo, rerenderAll);

    this.renderToolConfigGroup(toolArea, preset, 'read_note',
      '读取源文件夹笔记正文（无参数）', (body) => {
        const info = new Setting(body)
          .setName('参数')
          .setDesc('读取源文件夹内某篇笔记的正文（去除 YAML frontmatter）；参数：name（笔记文件名，可带或不带 .md 后缀）。');
        this.markSearchable(info, '预设 read_note 参数 说明');
      });

    this.renderToolConfigGroup(toolArea, preset, 'create_note',
      '创建新笔记（参数：title 文件名 / yaml 属性规则 / 模板正文）', (body) => {
        const info = new Setting(body)
          .setName('说明')
          .setDesc('描述「创建新笔记」。允许 AI 创建新笔记；正文结构与 frontmatter 属性规则默认继承「默认预设（全局设置）」，也可在本预设内独立配置（见下方）。');
        this.markSearchable(info, '预设 create_note 说明 创建 新建');

        // v0.8.2：预设覆盖 —— AI 创建属性规则（Enabled 开关：关 = 继承默认，不删数据）
        const oc = (preset.outputConfig = preset.outputConfig ?? {});
        const renderCreateRules = () => {
          yamlRulesWrap.empty();
          if (oc.yamlRulesEnabled === true && Array.isArray(oc.yamlRules)) {
            this.renderPresetRuleList(yamlRulesWrap, oc.yamlRules, 'create 属性规则',
              (rule) => `AI 创建属性规则 ${rule.key} ${rule.desc} ${rule.values.join(' ')} ${rule.default}`,
              renderCreateRules);
          }
        };
        const yamlOv = new Setting(body)
          .setName('AI 创建属性规则（覆盖默认预设）')
          .setDesc('开 = 本预设用下方规则；关 = 继承「默认预设（全局设置）」的规则（已有配置保留，重新打开仍可用）。')
          .addToggle((t) =>
            t.setValue(oc.yamlRulesEnabled === true).onChange((v) => {
              oc.yamlRulesEnabled = v;
              if (v && !Array.isArray(oc.yamlRules)) oc.yamlRules = [];
              void this.plugin.saveSettings();
              renderCreateRules(); // 只重建列表容器，不整组重渲染（v0.8.2 修复丢焦点）
            })
          );
        this.markSearchable(yamlOv, '预设 create_note AI创建属性规则 覆盖 yamlRules');
        // v0.8.x：列表容器在开关之后创建，规则列表（含「添加规则」按钮）随开关展开
        // 显示在「AI 创建属性规则」下方、「AI 创建模板」上方；关 = 整个列表收起。
        const yamlRulesWrap = body.createDiv();
        renderCreateRules();

        // v0.8.2：预设覆盖 —— AI 创建模板（Enabled 开关：关 = 继承默认，不删数据）
        const renderPresetTemplate = () => {
          tmplWrap.empty();
          if (oc.noteTemplateEnabled === true && Array.isArray(oc.noteTemplate)) {
            this.renderPresetTemplateList(tmplWrap, oc.noteTemplate, renderPresetTemplate);
          }
        };
        const tmplOv = new Setting(body)
          .setName('AI 创建模板（覆盖默认预设）')
          .setDesc('开 = 本预设用下方模板；关 = 继承「默认预设（全局设置）」的模板（已有配置保留，重新打开仍可用）。')
          .addToggle((t) =>
            t.setValue(oc.noteTemplateEnabled === true).onChange((v) => {
              oc.noteTemplateEnabled = v;
              if (v && !Array.isArray(oc.noteTemplate)) oc.noteTemplate = [];
              void this.plugin.saveSettings();
              renderPresetTemplate(); // 只重建列表容器（v0.8.2 修复丢焦点）
            })
          );
        this.markSearchable(tmplOv, '预设 create_note AI创建模板 覆盖 noteTemplate');
        // v0.8.x：列表容器在开关之后创建，模板列表随开关展开显示在开关下方。
        const tmplWrap = body.createDiv();
        renderPresetTemplate();

        // v0.8.2：预设覆盖 —— 限制仅已配置属性（Enabled 开关：关 = 继承默认）
        const restrictOv = new Setting(body)
          .setName('限制 AI 只能使用已配置的属性（覆盖默认预设）')
          .setDesc('开 = 本预设内 create/modify 的 yaml 键只能在对应规则集内；关 = 继承默认预设。')
          .addToggle((t) =>
            t.setValue(oc.createRestrictYamlEnabled === true).onChange((v) => {
              oc.createRestrictYamlEnabled = v;
              if (v) oc.createRestrictYaml = true;
              void this.plugin.saveSettings();
            })
          );
        this.markSearchable(restrictOv, '预设 create_note 限制 已配置属性 createRestrictYaml 覆盖');
      }, createIo, rerenderAll);

    this.renderToolConfigGroup(toolArea, preset, 'update_note_yaml',
      '修改源文件 frontmatter 属性（需全局开关暴露）', (body) => {
        const info = new Setting(body)
          .setName('说明')
          .setDesc('描述「修改源文件 frontmatter 属性」。实际对 AI 暴露还须开启全局开关「暴露 update_note_yaml 工具」；只能修改设置页配置的属性（值须在允许范围内）。属性规则默认继承「默认预设（全局设置）」，也可在本预设内独立配置（见下方）。');
        this.markSearchable(info, '预设 update_note_yaml 说明 修改 frontmatter');

        // v0.9.1：预设覆盖 —— AI 修改属性规则（Enabled 开关：关 = 继承默认，不删数据）
        const oc = (preset.outputConfig = preset.outputConfig ?? {});
        const renderPresetUpdateRules = () => {
          updateYamlWrap.empty();
          if (oc.updateYamlRulesEnabled === true && Array.isArray(oc.updateYamlRules)) {
            this.renderPresetUpdateYamlRules(updateYamlWrap, oc.updateYamlRules, renderPresetUpdateRules);
          }
        };
        const updateYamlOv = new Setting(body)
          .setName('AI 修改属性规则（覆盖默认预设）')
          .setDesc('开 = 本预设用下方规则；关 = 继承「默认预设（全局设置）」的规则（已有配置保留，重新打开仍可用）。')
          .addToggle((t) =>
            t.setValue(oc.updateYamlRulesEnabled === true).onChange((v) => {
              oc.updateYamlRulesEnabled = v;
              if (v && !Array.isArray(oc.updateYamlRules)) oc.updateYamlRules = [];
              void this.plugin.saveSettings();
              renderPresetUpdateRules(); // 只重建列表容器，不整组重渲染（v0.8.2 修复丢焦点）
            })
          );
        this.markSearchable(updateYamlOv, '预设 update_note_yaml AI修改属性规则 覆盖 updateYamlRules');
        // v0.9.1：列表容器在开关之后创建，规则列表（含「添加规则」按钮）随开关展开
        // 显示在开关下方；关 = 整个列表收起（v0.8.x 教训：容器在开关前创建会导致列表
        // 显示在开关上方）。
        const updateYamlWrap = body.createDiv();
        renderPresetUpdateRules();
      }, updateYamlIo, rerenderAll);

    this.renderToolConfigGroup(toolArea, preset, 'search_output_notes',
      '搜索输出文件夹（参数：模式 完整/阉割）', (body) => {
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
        // v0.8.9：是否允许 query（正文/文件名子串搜索）。缺省允许；关闭后 schema 移除 query、执行时忽略。
        const querySetting = new Setting(body)
          .setName('允许使用 query（正文/文件名搜索）')
          .setDesc('开 = AI 可用 query 按正文/文件名子串搜索；关 = 只能按 filters 属性过滤（schema 移除 query，AI 无法使用）。')
          .addToggle((t) =>
            t.setValue(preset.toolOverrides.searchQueryEnabled !== false).onChange((v) => {
              preset.toolOverrides.searchQueryEnabled = v;
              void this.plugin.saveSettings();
            })
          );
        this.markSearchable(querySetting, '预设 searchQueryEnabled query 正文搜索 文件名搜索');
        const restrEl = body.createDiv({ cls: 'ks-preset-restrictions' });
        this.renderSearchRestrictions(restrEl, preset);
      }, searchIo, rerenderAll);

    // v0.8.0：三个新的输出库工具（modify×2 + read_output_note）进入每预设工具配置区。
    this.renderToolConfigGroup(toolArea, preset, 'modify_output_note',
      '覆盖修改输出文件夹笔记（参数：name / sections / yaml）', (body) => {
        const info = new Setting(body)
          .setName('说明')
          .setDesc('描述「覆盖修改输出文件夹笔记」。sections 的键必须是原文中已存在的标题文本，只能修改标题下的文字（不能修改标题或新增标题，禁止 # 开头）；yaml 规则默认继承「默认预设（全局设置）」，也可在本预设内独立配置（见下方）。');
        this.markSearchable(info, '预设 modify_output_note 说明 修改 输出 覆盖');

        // v0.8.2：预设覆盖 —— AI 修改属性规则（Enabled 开关：关 = 继承默认，不删数据）
        const oc = (preset.outputConfig = preset.outputConfig ?? {});
        const renderModifyRules = () => {
          modYamlRulesWrap.empty();
          if (oc.modifyYamlRulesEnabled === true && Array.isArray(oc.modifyYamlRules)) {
            this.renderPresetRuleList(modYamlRulesWrap, oc.modifyYamlRules, 'modify 属性规则',
              (rule) => `AI 修改属性规则 ${rule.key} ${rule.desc} ${rule.values.join(' ')} ${rule.default}`,
              renderModifyRules);
          }
        };
        const modYamlOv = new Setting(body)
          .setName('AI 修改属性规则（覆盖默认预设）')
          .setDesc('开 = 本预设用下方规则；关 = 继承「默认预设（全局设置）」的修改属性规则（已有配置保留，重新打开仍可用）。')
          .addToggle((t) =>
            t.setValue(oc.modifyYamlRulesEnabled === true).onChange((v) => {
              oc.modifyYamlRulesEnabled = v;
              if (v && !Array.isArray(oc.modifyYamlRules)) oc.modifyYamlRules = [];
              void this.plugin.saveSettings();
              renderModifyRules(); // 只重建列表容器（v0.8.2 修复丢焦点）
            })
          );
        this.markSearchable(modYamlOv, '预设 modify_output_note AI修改属性规则 覆盖 modifyYamlRules');
        // v0.8.x：列表容器在开关之后创建，规则列表随开关展开显示在开关下方。
        const modYamlRulesWrap = body.createDiv();
        renderModifyRules();
      }, modifyIo, rerenderAll);

    this.renderToolConfigGroup(toolArea, preset, 'modify_output_note_versioned',
      '覆盖修改输出文件夹笔记并自动归档（参数：name / sections / yaml）', (body) => {
        const info = new Setting(body)
          .setName('说明')
          .setDesc('描述「覆盖修改并自动归档」。接口同 modify_output_note（{name, sections, yaml}），每次修改前自动把当前版本追加到归档文件并写入新版本号/归档标记；归档配置默认继承「默认预设（全局设置）」，也可在本预设内独立配置（见下方）。');
        this.markSearchable(info, '预设 modify_output_note_versioned 说明 修改 归档');

        // v0.8.2：预设覆盖 —— 归档配置
        const oc = (preset.outputConfig = preset.outputConfig ?? {});
        const archOv = new Setting(body)
          .setName('归档配置（覆盖默认预设）')
          .setDesc('开 = 本预设用下方版本后缀/版本号属性/归档标记属性；关 = 继承「默认预设（全局设置）」的归档配置（已有配置保留，重新打开仍可用）。')
          .addToggle((t) =>
            t.setValue(oc.archiveEnabled === true).onChange((v) => {
              oc.archiveEnabled = v;
              if (v) {
                if (oc.modifyVersionSuffix === undefined) oc.modifyVersionSuffix = '';
                if (oc.modifyVersionProperty === undefined) oc.modifyVersionProperty = '';
                if (oc.modifyArchiveProperty === undefined) oc.modifyArchiveProperty = '';
              }
              void this.plugin.saveSettings();
              rerenderAll();
            })
          );
        this.markSearchable(archOv, '预设 modify_output_note_versioned 归档配置 覆盖');
        if (oc.archiveEnabled === true) {
          const s = new Setting(body)
            .setName('版本后缀')
            .setDesc('归档文件后缀（如「-归档」→ 原文名-归档.md）。')
            .addText((text) =>
              text
                .setPlaceholder('如：-归档')
                .setValue(oc.modifyVersionSuffix ?? '')
                .onChange((v) => {
                  oc.modifyVersionSuffix = v;
                  void this.plugin.saveSettings();
                })
            );
          this.markSearchable(s, '预设 modify_output_note_versioned 归档 版本后缀');
          const vp = new Setting(body)
            .setName('版本号属性名')
            .setDesc('写入原文件的版本号 yaml 属性名（数字递增）。')
            .addText((text) =>
              text
                .setPlaceholder('如：version')
                .setValue(oc.modifyVersionProperty ?? '')
                .onChange((v) => {
                  oc.modifyVersionProperty = v;
                  void this.plugin.saveSettings();
                })
            );
          this.markSearchable(vp, '预设 modify_output_note_versioned 归档 版本号属性');
          const ap = new Setting(body)
            .setName('归档标记属性名')
            .setDesc('写入归档文件 frontmatter 的 bool 属性名（如 archived，写 true）。')
            .addText((text) =>
              text
                .setPlaceholder('如：archived')
                .setValue(oc.modifyArchiveProperty ?? '')
                .onChange((v) => {
                  oc.modifyArchiveProperty = v;
                  void this.plugin.saveSettings();
                })
            );
          this.markSearchable(ap, '预设 modify_output_note_versioned 归档 归档标记属性');
        }
      }, archiveIo, rerenderAll);

    this.renderToolConfigGroup(toolArea, preset, 'read_output_note',
      '读取输出文件夹笔记全文（参数：name）', (body) => {
        const info = new Setting(body)
          .setName('说明')
          .setDesc('描述「读取输出文件夹笔记全文」。返回含 YAML frontmatter 与正文的全文；配合 search_output_notes（只返回标题）获取正文。');
        this.markSearchable(info, '预设 read_output_note 说明 读取 输出 全文');
      });
    void toolArea;
  }

  private renderPresetRuleList(
    containerEl: HTMLElement,
    rules: YamlRule[],
    label: string,
    searchOf: (rule: YamlRule) => string,
    rerender: () => void
  ): void {
    rules.forEach((rule, index) => {
      const hay = searchOf(rule);
      const row = new Setting(containerEl)
        .setName('')
        .setDesc('')
        .addText((text) =>
          text
            .setPlaceholder('属性名')
            .setValue(rule.key)
            .onChange((v) => {
              rule.key = v;
              void this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder('解释（暴露时传给 AI）')
            .setValue(rule.desc)
            .onChange((v) => {
              rule.desc = v;
              void this.plugin.saveSettings();
            })
        )
        .addText((text) =>
          text
            .setPlaceholder('默认值（支持 {{moment}}）')
            .setValue(rule.default)
            .onChange((v) => {
              rule.default = v;
              void this.plugin.saveSettings();
            })
        )
        .addToggle((t) =>
          t
            .setValue(this.resolveUiExpose(rule))
            .setTooltip('暴露给 AI')
            .onChange((v) => {
              rule.expose = v;
              void this.plugin.saveSettings();
              rerender();
            })
        )
        .addButton((btn) =>
          btn
            .setIcon('trash-2')
            .setTooltip('删除')
            .onClick(() => {
              rules.splice(index, 1);
              void this.plugin.saveSettings();
              rerender();
            })
        );
      row.settingEl.addClass('ks-yaml-rule-row');
      this.markSearchable(row, hay);
      // 可选值 tag 输入区：仅「暴露给 AI」时显示；v0.8.x 起挂在 controlEl 内，
      // 与属性名/解释/默认值三个控件同一行（窄屏由 flex-wrap 自动换行）。
      if (this.resolveUiExpose(rule)) {
        const valuesEl = row.controlEl.createDiv({ cls: 'ks-yaml-values' });
        valuesEl.setAttribute('data-search', hay);
        this.renderYamlValues(valuesEl, rule);
      }
    });
    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setIcon('plus').setButtonText('添加规则').onClick(() => {
          rules.push({ key: '', desc: '', values: [], default: '', expose: true });
          void this.plugin.saveSettings();
          rerender();
        })
      );
    this.markSearchable(addBtn, `预设 输出属性 ${label} 添加规则`);
  }

  /** 预设内创建模板列表（标题/级别/允许 AI 写/解释 + 上移下移删除）。 */
  private renderPresetTemplateList(containerEl: HTMLElement, entries: NoteTemplateEntry[], rerender: () => void): void {
    // v0.8.x：条目开关含义解释——触屏无 hover，tooltip 不可见，列表顶部加一行说明。
    const hint = new Setting(containerEl)
      .setName('')
      .setDesc('条目开关说明：第一个开关（允许 AI 写）：开 = AI 可在此标题下写内容；关 = 该标题由模板固定输出，AI 不能写。');
    this.markSearchable(hint, '预设 创建模板 允许AI写 开关 说明 含义');
    entries.forEach((entry, index) => {
      const row = new Setting(containerEl)
        .setName('')
        .setDesc('')
        .addDropdown((drop) => {
          const opts: Record<string, string> = {};
          for (let l = 1; l <= 6; l++) opts[String(l)] = `H${l}（${'#'.repeat(l)} 标题）`;
          drop.addOptions(opts);
          drop.setValue(String(entry.level));
          drop.onChange((v) => {
            entry.level = parseInt(v, 10) || 1;
            void this.plugin.saveSettings();
          });
        })
        .addText((text) =>
          text
            .setPlaceholder('标题文本')
            .setValue(entry.title)
            .onChange((v) => {
              entry.title = v;
              void this.plugin.saveSettings();
            })
        )
        .addToggle((t) =>
          t
            .setValue(entry.allowAi)
            .setTooltip('允许 AI 写')
            .onChange((v) => {
              entry.allowAi = v;
              void this.plugin.saveSettings();
            })
        )
        .addButton((btn) =>
          btn
            .setIcon('chevron-up')
            .setTooltip('上移')
            .onClick(() => {
              if (index > 0) {
                const [e] = entries.splice(index, 1);
                entries.splice(index - 1, 0, e);
                void this.plugin.saveSettings();
                rerender();
              }
            })
        )
        .addButton((btn) =>
          btn
            .setIcon('chevron-down')
            .setTooltip('下移')
            .onClick(() => {
              if (index < entries.length - 1) {
                const [e] = entries.splice(index, 1);
                entries.splice(index + 1, 0, e);
                void this.plugin.saveSettings();
                rerender();
              }
            })
        )
        .addButton((btn) =>
          btn
            .setIcon('trash-2')
            .setTooltip('删除')
            .onClick(() => {
              entries.splice(index, 1);
              void this.plugin.saveSettings();
              rerender();
            })
        );
      row.settingEl.addClass('ks-template-row');
      this.markSearchable(row, `预设 输出属性 创建模板 ${entry.title} ${entry.desc}`);
      const descEl = containerEl.createDiv({ cls: 'ks-template-desc-wrap setting-item' });
      const ta = descEl.createEl('textarea', { cls: 'ks-template-desc' });
      ta.value = entry.desc;
      ta.placeholder = '解释（允许 AI 写时随工具描述传给 AI）';
      ta.addEventListener('input', () => {
        entry.desc = ta.value;
        void this.plugin.saveSettings();
      });
    });
    const addBtn = new Setting(containerEl)
      .setName('')
      .setDesc('')
      .addButton((btn) =>
        btn.setIcon('plus').setButtonText('添加标题').onClick(() => {
          entries.push({ title: '', level: 2, allowAi: true, desc: '' });
          void this.plugin.saveSettings();
          rerender();
        })
      );
    this.markSearchable(addBtn, '预设 输出属性 创建模板 添加标题');
  }

  /** Render one collapsible per-tool config group (B.2): header = chevron + tool
   *  name + 「启用」toggle (right, outside the collapsible body so it can be
   *  toggled without expanding); body = the tool's config (collapsed by default,
   *  restored across re-renders via `toolExpanded`). */
  private renderToolConfigGroup(
    parentEl: HTMLElement,
    preset: ToolPreset,
    name: string,
    explanation: string,
    renderBody: (bodyEl: HTMLElement) => void,
    io?: ToolConfigIO,
    rerenderAll?: () => void
  ): void {
    const key = `${preset.id}:${name}`;
    const groupEl = parentEl.createDiv({ cls: 'ks-group ks-tool-config' });
    const headEl = groupEl.createDiv({ cls: 'ks-tool-config-head' });
    const chev = headEl.createSpan({ cls: 'ks-group-icon' });
    const expanded = this.toolExpanded.has(key);
    this.setIconSafe(chev, expanded ? 'chevron-down' : 'chevron-right', expanded ? '\u2304' : '\u203A');
    headEl.createSpan({ cls: 'ks-preset-tool-label', text: name });
    headEl.createSpan({ cls: 'ks-tool-config-desc', text: explanation });
    // v0.8.0：启用开关放折叠头部右侧（不展开也能开关），点击不触发折叠。
    this.renderToolHeaderToggle(headEl, preset, name);
    const bodyEl = groupEl.createDiv({ cls: 'ks-group-body' });
    if (!expanded) groupEl.addClass('ks-collapsed');
    headEl.addEventListener('click', () => {
      const isCollapsed = groupEl.hasClass('ks-collapsed');
      groupEl.toggleClass('ks-collapsed', !isCollapsed);
      this.setIconSafe(chev, isCollapsed ? 'chevron-down' : 'chevron-right', isCollapsed ? '\u2304' : '\u203A');
      if (isCollapsed) this.toolExpanded.add(key);
      else this.toolExpanded.delete(key);
    });
    // v0.8.3：有配置的工具组顶部加「复制配置 / 粘贴配置」（导入严格校验格式）。
    if (io && rerenderAll) this.renderToolIoBar(bodyEl, io, preset, rerenderAll);
    renderBody(bodyEl);
  }

  /** 工具折叠组的配置复制/导入条（v0.8.3）。复制 = 该工具配置 JSON 到剪贴板；
   *  粘贴 = 读剪贴板 → JSON 解析 → 严格校验（未知字段/类型不符整体拒绝）→ 应用并重渲染。 */
  private renderToolIoBar(bodyEl: HTMLElement, io: ToolConfigIO, preset: ToolPreset | null, rerender: () => void): void {
    const bar = bodyEl.createDiv({ cls: 'ks-tool-io' });
    bar.createSpan({ cls: 'ks-tool-io-label', text: '配置' });
    const copyBtn = bar.createEl('button', { cls: 'ks-tool-io-btn' });
    this.setIconSafe(copyBtn, 'copy', '');
    copyBtn.createSpan({ text: '复制配置' });
    copyBtn.addEventListener('click', () => {
      const cfg = preset ? io.exportFromPreset(preset) : io.exportFromGlobal(this.plugin.settings);
      this.writeClipboard(JSON.stringify(cfg, null, 2), `已复制 ${io.label} 配置（JSON）`);
    });
    const pasteBtn = bar.createEl('button', { cls: 'ks-tool-io-btn' });
    this.setIconSafe(pasteBtn, 'clipboard', '');
    pasteBtn.createSpan({ text: '粘贴配置' });
    pasteBtn.addEventListener('click', async () => {
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        text = '';
      }
      if (!text.trim()) {
        new Notice('剪贴板为空或无法读取');
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        new Notice(`导入失败：不是合法的 JSON`);
        return;
      }
      const r = io.validate(raw);
      if (!r.ok) {
        new Notice(`导入失败：${r.error}`);
        return;
      }
      if (preset) io.applyToPreset(preset, r.cfg);
      else io.applyToGlobal(this.plugin.settings, r.cfg);
      void this.plugin.saveSettings();
      new Notice(`已导入 ${io.label} 配置`);
      rerender();
    });
  }

  /** 折叠头部右侧的「启用该工具」开关（v0.8.0，折叠区外）。映射到 preset
   *  `enabledTools` 白名单；v0.8.8 语义：显式集合（缺省 = 全开，空数组 = 全关）。 */
  private renderToolHeaderToggle(headEl: HTMLElement, preset: ToolPreset, name: string): void {
    const toggleWrap = headEl.createSpan({ cls: 'ks-tool-config-toggle' });
    // 点击开关不触发头部的展开/收起（阻止冒泡到 headEl 的折叠监听）。
    toggleWrap.addEventListener('click', (ev) => ev.stopPropagation());
    new ToggleComponent(toggleWrap)
      .setValue(this.isToolEnabled(preset, name))
      .setTooltip(`启用该工具（${name}）`)
      .onChange((v) => this.setToolEnabled(preset, name, v));
  }

  private togglePresetItem(itemEl: HTMLElement, chev: HTMLElement, id: string): void {
    const collapsed = itemEl.hasClass('ks-preset-item-collapsed');
    itemEl.toggleClass('ks-preset-item-collapsed', !collapsed);
    this.setIconSafe(chev, collapsed ? 'chevron-down' : 'chevron-right', collapsed ? '\u2304' : '\u203A');
    if (collapsed) this.presetExpanded.add(id);
    else this.presetExpanded.delete(id);
  }

  /** v0.8.8：`enabledTools` = 显式启用集合。是数组时返回 includes(name)
   *  （空数组 = 全部关闭）；不是数组（undefined/缺失）时返回 true（缺省 = 全开）。 */
  private isToolEnabled(preset: ToolPreset, name: string): boolean {
    if (!Array.isArray(preset.enabledTools)) return true; // 缺省 = 全部启用（兼容旧数据）
    return preset.enabledTools.includes(name);
  }

  /** v0.8.8：开关工具，写回 `enabledTools` 显式集合。关到空 = 保持空数组
   *  （= 全部关闭），不再回退为全开（v0.8.8 修复反向语义陷阱）。 */
  private setToolEnabled(preset: ToolPreset, name: string, on: boolean): void {
    if (!Array.isArray(preset.enabledTools)) preset.enabledTools = TOOL_NAMES.slice();
    const list = preset.enabledTools;
    if (on) {
      if (!list.includes(name)) preset.enabledTools = list.concat(name);
    } else {
      preset.enabledTools = list.filter((x) => x !== name); // 空数组 = 全部关闭
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
        btn.setIcon('plus').setButtonText('添加键').onClick(() => {
          (preset.toolOverrides.searchRestrictions as { key: string; values: string[] }[]).push({ key: '', values: [] });
          void this.plugin.saveSettings();
          this.renderSearchRestrictions(containerEl, preset);
        })
      );
    this.markSearchable(addBtn, '预设 阉割版 添加键');
  }

  // -------------------------------------------------------------------------
  // UI 方案陈列（v0.8.1：移动端 UI 方案挑选——用户在安卓上对比可用性后决定聊天视图最终布局）
  // -------------------------------------------------------------------------

  /** All lucide icon names worth verifying on mobile (plugin-used + candidates). */
  private readonly UI_ICON_NAMES: string[] = [
    // 插件当前使用
    'arrow-up', 'square', 'copy', 'check', 'clipboard-copy', 'chevron-right', 'chevron-down',
    'chevron-up', 'wrench', 'search', 'trash-2', 'x', 'settings', 'play', 'bot',
    // 候选/常用
    'clipboard', 'clipboard-list', 'send', 'plus', 'minus', 'pencil', 'save', 'download',
    'upload', 'file-text', 'files', 'list', 'book-open', 'bookmark', 'star', 'heart',
    'info', 'alert-circle', 'help-circle', 'external-link', 'refresh-cw', 'rotate-ccw',
    'filter', 'sliders', 'toggle-left', 'toggle-right', 'chevrons-up-down', 'chevrons-down-up',
    'git-commit-vertical', 'git-branch', 'folder-git', 'more-vertical', 'more-horizontal',
    'package', 'mic', 'image', 'paperclip', 'smile', 'sparkles', 'brain', 'cpu', 'zap',
    'file-edit', 'file-pen', 'folder-open', 'folder', 'tag', 'tags', 'link', 'unlink',
    'calendar', 'clock', 'history', 'archive', 'database', 'hard-drive', 'layers', 'columns',
    'panel-left', 'panel-right', 'layout-grid', 'rows', 'scale', 'shield', 'lock', 'eye',
    'eye-off', 'bell', 'mail', 'home', 'menu', 'circle', 'circle-dot', 'dot', 'command',
  ];

  /** Render a grid of lucide icons (name + rendered icon) for mobile verification. */
  private renderUiIconGrid(containerEl: HTMLElement): void {
    const info = new Setting(containerEl)
      .setName('')
      .setDesc('以下是 lucide 图标陈列（每个图标下方是其名字）。请在移动端查看：能正常显示为图形的是可用图标；显示为空白/占位符的是当前 Obsidian 版本不支持的图标名。把「能用哪些、不能用哪些」告诉我，我会据此替换插件里所有用到的图标。');
    this.markSearchable(info, 'lucide 图标 陈列 验证 可用 图标名');

    const grid = containerEl.createDiv({ cls: 'ks-ui-icon-grid' });
    for (const name of this.UI_ICON_NAMES) {
      const cell = grid.createDiv({ cls: 'ks-ui-icon-cell' });
      const iconEl = cell.createDiv({ cls: 'ks-ui-icon-glyph' });
      setIcon(iconEl, name);
      cell.createDiv({ cls: 'ks-ui-icon-name', text: name });
    }
  }

  /** Render a mini chat mockup for one UI scheme. */
  private uiMock(scene: 'chat' | 'input', cls: string, title: string, desc: string): HTMLElement {
    const card = this.containerEl.createDiv({ cls: 'ks-ui-card' });
    const head = card.createDiv({ cls: 'ks-ui-card-head' });
    head.createSpan({ cls: 'ks-ui-card-title', text: title });
    head.createSpan({ cls: 'ks-ui-card-tag', text: cls.replace(/^ks-ui-/, '') });
    card.createDiv({ cls: 'ks-ui-card-desc', text: desc });

    const mock = card.createDiv({ cls: `ks-ui-mock ${cls}` });
    if (scene === 'chat') {
      const u1 = mock.createDiv({ cls: 'ks-ui-msg ks-ui-user' });
      u1.setText('帮我总结一下最近一周的笔记');
      const a1 = mock.createDiv({ cls: 'ks-ui-msg ks-ui-ai' });
      a1.createDiv({ cls: 'ks-ui-ai-head', text: 'AI · 思考中' });
      a1.createDiv({ cls: 'ks-ui-ai-body' }).setText('好的，我先查看最近 7 天的笔记，然后为你整理一份摘要。');
      const u2 = mock.createDiv({ cls: 'ks-ui-msg ks-ui-user' });
      u2.setText('好的，请继续');
      const a2 = mock.createDiv({ cls: 'ks-ui-msg ks-ui-ai' });
      a2.createDiv({ cls: 'ks-ui-ai-head', text: 'AI · 已完成' });
      a2.createDiv({ cls: 'ks-ui-ai-body' }).setText('已完成整理，共 12 篇笔记，要点如下：…');
    } else {
      const ta = mock.createDiv({ cls: 'ks-ui-input' });
      ta.setText('输入消息…（Enter 发送 / Shift+Enter 换行）');
      const row = mock.createDiv({ cls: 'ks-ui-input-row' });
      row.createSpan({ cls: 'ks-ui-input-tools', text: '预设 ▾' });
      row.createSpan({ cls: 'ks-ui-input-send', text: '↑' });
    }
    return card;
  }

  private renderUiPreviewGroup(containerEl: HTMLElement): void {
    const bodyEl = this.createGroup(containerEl, '聊天 UI 方案陈列', false);

    const info = new Setting(bodyEl)
      .setName('')
      .setDesc('以下是聊天界面的候选布局方案（迷你预览）。请在移动端查看每个方案的消息区与输入区效果，然后告诉我你喜欢哪个编号，我会把它实现为聊天视图的实际布局。');
    this.markSearchable(info, 'UI 方案 聊天 布局 气泡 输入框 预览');

    const grid = bodyEl.createDiv({ cls: 'ks-ui-grid' });

    // 方案 1：当前 dsh 风格（用户气泡 + AI 通栏 + 输入卡列式）——现状
    this.uiMock('chat', 'ks-ui-v1', '方案 1：dsh 风格（现状）', '用户右对齐气泡（22px 圆角、浅蓝底）、AI 通栏无边框、输入卡列式（上输入区 + 下按钮行）。桌面美观，移动端需验证窄屏。');
    // 方案 2：双气泡 IM 风格
    this.uiMock('chat', 'ks-ui-v2', '方案 2：双气泡 IM 风格', '用户右对齐深色气泡、AI 左对齐浅色气泡，两者都带圆角与最大宽度。聊天感强，移动端易读。');
    // 方案 3：极简文本流
    this.uiMock('chat', 'ks-ui-v3', '方案 3：极简文本流', '无气泡无边框，用户右对齐浅底、AI 左对齐通栏，消息间细分割线。最朴素，加载最轻。');
    // 方案 4：卡片式消息
    this.uiMock('chat', 'ks-ui-v4', '方案 4：卡片式消息', '每条消息独立圆角卡片（边框 + 背景），上下堆叠。结构清晰，移动端可点区域大。');
    // 方案 5：沉浸单栏
    this.uiMock('chat', 'ks-ui-v5', '方案 5：沉浸单栏', 'AI 全宽 markdown 流 + 用户小胶囊右上角，输入条悬浮底部（半透明）。类似 Claude 桌面观感。');
    // 方案 6：分屏输入
    this.uiMock('input', 'ks-ui-v6', '方案 6：分屏大输入区', '消息区在上、输入区固定底部且更高（4-6 行），适合移动端长输入。输入区独立成面板。');

    const note = new Setting(bodyEl)
      .setName('')
      .setDesc('提示：以上均为静态预览，仅用于挑选布局方向。确定方案后我会把聊天视图改造成该布局，并保留现有全部功能（流式 markdown / 工具卡片 / 思考块 / 错误复制等）。');
    this.markSearchable(note, 'UI 方案 提示 说明 挑选');

    // lucide 图标陈列（移动端可用性验证）
    this.renderUiIconGrid(bodyEl);
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