/**
 * Persisted plugin settings and their defaults.
 *
 * The key names are part of the acceptance contract (the acceptance scripts set
 * `plugin.settings` directly with these exact keys — see 验收标准文档). Do not
 * rename them. Every attribute name that drives source/output interpretation is
 * user-configurable so the plugin adapts to an existing vault instead of
 * hardcoding frontmatter property names.
 */
/**
 * Stable tool order for the preset tool-config editors and the base tool set.
 * v0.8.8: moved here from settingsTab.ts so main.ts (preset migration) and
 * utils/presets.ts share the same constant. Do NOT change the array contents
 * or order — `enabledTools` persisted values are compared against these names.
 */
export const TOOL_NAMES = ['list_recent_notes', 'read_note', 'create_note', 'update_note_yaml', 'search_output_notes', 'modify_output_note', 'modify_output_note_versioned', 'read_output_note', 'list_recent_output_notes'];

/**
 * One configurable frontmatter property rule for the `create_note` tool.
 * `values` empty = any value allowed (no validation); `default` empty = the
 * property is not added when the AI omits it, and may carry a moment template
 * like `{{YYYY.MM.DD}}` rendered at creation time.
 *
 * v0.8.2 简化 UI：每个属性由「暴露给 AI」开关 + 默认值 + 可选值组成。
 * - `expose`：true = 暴露给 AI（可选值作 enum 约束）；false = AI 不可见、不可修改。
 * - `overwrite`（仅 modify 工具）：true = 每次修改强制覆写默认值（如 created=时间戳）；
 *   false = 原样保留（AI 也不可见，如 approve）。
 * 缺省兼容旧数据：expose 缺省 ≈ values 非空；overwrite 缺省 ≈ values 空且 default 非空。
 */
export interface YamlRule {
  /** Frontmatter property name. */
  key: string;
  /** Human explanation, shown to the AI in the tool description. */
  desc: string;
  /** Allowed values; empty array = arbitrary (no validation). */
  values: string[];
  /** Default value; empty = not added when the AI omits it. */
  default: string;
  /** v0.8.2：是否暴露给 AI（false = AI 不可见不可改）。 */
  expose?: boolean;
  /** v0.8.2（modify 工具）：是否每次修改强制覆写默认值。 */
  overwrite?: boolean;
}

/**
 * One tool preset: a saved combination of enabled tool subset, tool parameter
 * overrides and a custom system prompt. `activePresetId` selects the one in use
 * in the chat view; `''` means the default "all tools + settings rules".
 *
 * v0.8.8 语义（反向陷阱修复）：`enabledTools` = 显式启用集合——缺失/undefined =
 * 全部启用（默认，兼容旧数据）；空数组 = 全部关闭；非空数组 = 白名单（交集）。
 * 旧数据迁移（main.ts loadSettings）把缺失/空数组改写为 TOOL_NAMES.slice()（显式全开）。
 * `toolOverrides.yamlRules` is intentionally NOT supported (per v0.5.0
 * decision) — yaml rules always come from `settings.yamlRules`.
 */
/**
 * One configurable frontmatter property rule for the `update_note_yaml` tool
 * (v0.7.0). Unlike `YamlRule` there is **no default** — updating an existing
 * attribute needs no default value. `values` empty = any value allowed (no
 * validation).
 */
export interface UpdateYamlRule {
  /** Frontmatter property name. */
  key: string;
  /** Human explanation (may be long; shown to the AI in the tool description). */
  desc: string;
  /** Allowed values; empty array = arbitrary (no validation). */
  values: string[];
}

/**
 * One template heading for the `create_note` body (v0.7.0). `allowAi` marks a
 * heading the AI may write beneath; every other heading is emitted verbatim by
 * the template. The body is assembled in template order.
 */
export interface NoteTemplateEntry {
  /** Heading text (e.g. 「大标题」「简介」). */
  title: string;
  /** Heading level: 1 = `#`, 2 = `##`, 3 = `###` … */
  level: number;
  /** Whether the AI may write content under this heading. */
  allowAi: boolean;
  /** Explanation; sent to the AI when `allowAi` (also used in the UI). */
  desc: string;
}

export interface ToolPreset {
  /** Unique id (uuid/timestamp). */
  id: string;
  /** Display name (shown in the chat preset selector). */
  name: string;
  /** Custom system prompt; empty = default (no system message sent). */
  systemPrompt: string;
  /** 显式启用集合（v0.8.8）：缺失 = 全部启用；空数组 = 全部关闭；非空 = 白名单。 */
  enabledTools: string[];
  /** Tool parameter overrides / constraints. */
  toolOverrides: {
    /** Override list_recent_notes days (default uses settings.recentDays). */
    listRecentDays?: number;
    /** false = drop create_note from the exposed tool set. */
    createNoteEnabled?: boolean;
    /** false = drop update_note_yaml from the exposed tool set. */
    updateYamlEnabled?: boolean;
    /** search_output_notes mode (B.5). */
    searchMode?: 'full' | 'restricted';
    /** Whitelisted keys for the restricted search mode. */
    searchRestrictions?: { key: string; values: string[] }[];
    /** v0.8.9：search_output_notes 是否允许使用 query（正文/文件名子串搜索）。
     *  缺省/true = 允许；false = 从 schema 移除 query，执行时忽略 query。 */
    searchQueryEnabled?: boolean;
    /** v0.8.9：list_recent_output_notes 的日期属性名（frontmatter 键）；空 = 回退全局 timeAttr。 */
    recentOutputAttr?: string;
    /** v0.8.9：list_recent_output_notes 的日期格式（moment 双大括号模板，如 {{YYYY.MM.DD}}T{{HH:mm:ss}}）；空 = 回退全局 timeFormat。 */
    recentOutputFormat?: string;
  };
  /**
   * v0.8.2：预设级「输出属性」覆盖（可选；每项未启用 = 该项继承默认预设/全局设置）。
   * 每个覆盖项配一个 `xxxEnabled` 开关：关 = 继承全局（不删数据）；开 = 用预设值。
   * yamlRules（create 属性规则）/ noteTemplate（创建模板）/ modifyYamlRules（modify 属性规则）
   * / updateYamlRules（update_note_yaml 属性规则，v0.9.1）/ 归档三配置 / createRestrictYaml。
   */
  outputConfig?: {
    yamlRulesEnabled?: boolean;
    yamlRules?: YamlRule[];
    noteTemplateEnabled?: boolean;
    noteTemplate?: NoteTemplateEntry[];
    modifyYamlRulesEnabled?: boolean;
    modifyYamlRules?: YamlRule[];
    /** v0.9.1：update_note_yaml 属性规则覆盖（结构同全局 UpdateYamlRule，无 default/expose）。 */
    updateYamlRulesEnabled?: boolean;
    updateYamlRules?: UpdateYamlRule[];
    archiveEnabled?: boolean;
    modifyVersionSuffix?: string;
    modifyVersionProperty?: string;
    modifyArchiveProperty?: string;
    createRestrictYamlEnabled?: boolean;
    createRestrictYaml?: boolean;
  };
}

/**
 * v0.9.3：用户自定义面板（Bases 自定义视图，泛化自 v0.9.2 的整理面板）。
 * - 每个面板扫描一个文件夹（'source'/'output' 映射全局设置 sourceFolder/outputFolder，
 *   其他值 = vault 内自定义路径），列出 bool 属性**存在且值（忽略大小写）不是 'true'**
 *   的文件（v0.9.9：属性缺失/null 的文件不显示）；afterDate 之后（含当天）修改/创建
 *   的文件才显示（留空 = 不限）。
 * - basePath = .base 文件路径（默认 `${name}.base`）；chatPresetId = 跳聊天预设
 *   （空 = 默认全部工具）；chatPrompt = prompt 模板（{{filename}} → basename 不含路径/.md）。
 */
export interface PanelConfig {
  /** 唯一 id（创建时 String(Date.now())）。 */
  id: string;
  /** 面板名（.base 的 views[].name 用它；Bases 视图按 name 匹配本配置）。 */
  name: string;
  /** 面板开关（关 = 命令「打开面板」跳过它；旧 .base 仍可打开）。 */
  enabled: boolean;
  /** 扫描文件夹：'source' | 'output' 映射全局设置，其他值 = 自定义路径。 */
  folder: 'source' | 'output' | string;
  /** bool 属性名（v0.9.9：属性必须存在且值（忽略大小写）非 'true' → 显示；缺失不显示）。 */
  attr: string;
  /** 最早日期 YYYY-MM-DD；留空 = 不限（parseAfterDate 语义）。 */
  afterDate?: string;
  /** .base 文件路径（默认 `${name}.base`，中文名没问题）。 */
  basePath: string;
  /** 跳聊天预设 id（空 = 默认全部工具）。 */
  chatPresetId: string;
  /** prompt 模板（{{filename}} → basename 不含路径/.md）。 */
  chatPrompt: string;
  /**
   * v0.9.4：是否在面板条目右侧显示「垃圾桶删除文件」按钮（点击后二次确认，
   * 删除到系统回收站）。缺省/undefined = 显示（渲染按 `showDelete !== false` 判断）。
   */
  showDelete?: boolean;
}

export interface KnowledgeSystemSettings {
  /** Main provider API key (masked text input). */
  apiKey: string;
  /** Base URL of the OpenAI-compatible provider. Defaults to DeepSeek. */
  baseUrl: string;
  /** Selected default model id (from the /models endpoint). */
  model: string;
  /** Full model list returned by the /models endpoint. */
  models: string[];
  /** Folder scanned by the "count recent files" command. */
  sourceFolder: string;
  /** Folder where the "output latest content" command writes files. */
  outputFolder: string;
  /** Frontmatter attribute holding each file's timestamp; empty = use ctime. */
  timeAttr: string;
  /** moment-compatible format string (parse + write timestamps). */
  timeFormat: string;
  /** How many days back the "count recent files" command looks. */
  recentDays: number;
  /** Frontmatter attribute holding the review/审核 status. */
  reviewAttr: string;
  /** Default value written to the review status attribute. */
  reviewDefault: string;
  /** Frontmatter attribute holding the category/分类. */
  categoryAttr: string;
  /** Default value written to the category attribute. */
  categoryDefault: string;
  /** Frontmatter attribute holding the output timestamp. */
  timestampProperty: string;
  /** Frontmatter attribute holding the source file path. */
  sourceAttr: string;
  /** Earliest time (parsed with timeFormat) the chat/tools may see; empty = any. */
  earliestTime: string;
  /** Custom-provider API key (stored for future phases; UI only). */
  customApiKey: string;
  /** Custom-provider model id (stored for future phases; UI only). */
  customModel: string;
  /** Dynamic output properties: each {key,value} is a frontmatter attribute
   * name plus its default value (written by the output command). Legacy
   * review/category fields are migrated here on first load. */
  extraProperties: { key: string; value: string }[];
  /** Frontmatter property rules applied when the AI creates a note (v0.4.0). */
  yamlRules: YamlRule[];
  /** Saved tool presets (v0.5.0); empty = default tool set only. */
  toolPresets: ToolPreset[];
  /** Active preset id used by the chat view; '' = default (all tools + settings rules). */
  activePresetId: string;
  /** Global switch: expose update_note_yaml to the AI (default off). */
  updateYamlToolEnabled: boolean;
  /** Allowed frontmatter property rules for update_note_yaml (v0.7.0). */
  updateYamlRules: UpdateYamlRule[];
  /** create_note body template headings (v0.7.0); empty = free-text content. */
  noteTemplate: NoteTemplateEntry[];
  /**
   * create_note 限制：开启后（默认 false 兼容现状）AI 的 `yaml` 键必须在
   * `yamlRules` 键集内，规则外键 → `{ error }` 不落盘。desc 加「只能使用已配置的属性」提示。
   */
  createRestrictYaml: boolean;
  /** modify_output_note_versioned 归档文件后缀（如「-归档」）；空 = 未配置不工作。 */
  modifyVersionSuffix: string;
  /** modify_output_note_versioned 版本号 yaml 属性名（数字递增）；空 = 未配置不工作。 */
  modifyVersionProperty: string;
  /** modify_output_note_versioned 归档 bool 属性名（写 true）；空 = 未配置不工作。 */
  modifyArchiveProperty: string;
  /**
   * modify_output_note / modify_output_note_versioned 的 yaml 属性规则（v0.8.2）：
   * 与 create_note 的 `yamlRules` **结构完全一样但内容独立**（键名/解释/可选值/默认值）。
   * 有可选值约束的键 → 暴露给 AI（enum）；「仅默认值」的键 → AI 不可见、每次修改
   * 强制覆写为渲染后的默认值（如 created=当前时间）。
   */
  modifyYamlRules: YamlRule[];
  /**
   * v0.8.7：审核页排除规则——frontmatter[key] 等于 value 的文件不出现在审核列表
   * （如 {key: 'archived', value: 'true'} 排除已归档文件）。
   */
  reviewExcludes: { key: string; value: string }[];
  /** v0.8.7：审核面板（.base 文件）在 vault 中的位置（如「审核.base」）。 */
  reviewBasePath: string;
  /**
   * v0.8.9：审核页每行「审核开关」打开时写入 reviewAttr 的值（如「已审」）。
   * 点击开关 → 把该文件 frontmatter[reviewAttr] 改为该值 → 文件移出审核列表。
   */
  reviewDoneValue: string;
  /**
   * v0.8.9：审核页「AI 修改」预填提示词模板。`{{filename}}` = 被修改笔记的文件名
   * （不含路径，工具以文件名作参数）。留空 = 使用默认模板；模板无 `{{filename}}`
   * 时原样使用（允许完全自定义）。
   */
  reviewChatPrompt: string;
  /**
   * v0.9.2：整理面板（Bases 视图，与审核页同机制）——bool 属性名：源文件夹里
   * 该属性缺失或不是 true 的文件显示在面板；用户处理后设为 true → 文件消失。
   */
  tidyAttr: string;
  /** 整理面板只看此日期之后（含当天）修改/创建的文件（YYYY-MM-DD）；留空 = 不限。 */
  tidyAfterDate: string;
  /** 整理面板（.base 文件）在 vault 中的位置（如「整理.base」）。 */
  tidyBasePath: string;
  /** 整理面板跳聊天用的预设 id（空 = 默认全部工具）。 */
  tidyChatPresetId: string;
  /** 整理面板跳聊天用的 prompt 模板（{{filename}} → 文件名不含路径/.md）。 */
  tidyChatPrompt: string;
  /** v0.9.3：用户自定义面板列表（默认空 = 无面板；每个面板见 PanelConfig）。 */
  panels: PanelConfig[];
  /**
   * v0.9.10：面板/设置「打开方式」——'tab' = 新标签页（默认，最初行为）；
   * 'current' = 当前标签页（替换当前显示的标签；正在编辑笔记时可能替换掉笔记）。
   */
  panelOpenMode: 'tab' | 'current';
}

export const DEFAULT_SETTINGS: KnowledgeSystemSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: '',
  models: [],
  sourceFolder: '/',
  outputFolder: '/',
  timeAttr: '',
  timeFormat: 'YYYY-MM-DD',
  recentDays: 7,
  reviewAttr: 'approved',
  reviewDefault: '未审',
  categoryAttr: 'category',
  categoryDefault: '未分类',
  timestampProperty: 'created',
  sourceAttr: 'source',
  earliestTime: '',
  customApiKey: '',
  customModel: '',
  extraProperties: [],
  yamlRules: [],
  toolPresets: [],
  activePresetId: '',
  updateYamlToolEnabled: false,
  updateYamlRules: [],
  noteTemplate: [],
  createRestrictYaml: false,
  modifyVersionSuffix: '',
  modifyVersionProperty: '',
  modifyArchiveProperty: '',
  modifyYamlRules: [],
  reviewExcludes: [],
  reviewBasePath: '审核.base',
  reviewDoneValue: '已审',
  reviewChatPrompt: '请读取输出文件夹中的笔记「{{filename}}」，与我沟通如何修改，然后按我的要求修改它。',
  tidyAttr: 'tidy',
  tidyAfterDate: '',
  tidyBasePath: '整理.base',
  tidyChatPresetId: '',
  tidyChatPrompt: '请查看「{{filename}}」并帮我整理，然后把它标记为完成。',
  panels: [],
  panelOpenMode: 'tab',
};
