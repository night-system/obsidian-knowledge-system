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
 * One configurable frontmatter property rule for the `create_note` tool.
 * `values` empty = any value allowed (no validation); `default` empty = the
 * property is not added when the AI omits it, and may carry a moment template
 * like `{{YYYY.MM.DD}}` rendered at creation time.
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
}

/**
 * One tool preset: a saved combination of enabled tool subset, tool parameter
 * overrides and a custom system prompt. `activePresetId` selects the one in use
 * in the chat view; `''` means the default "all tools + settings rules".
 *
 * `enabledTools` empty = the full base tool set (intersection rules below).
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
  /** Enabled tool-name subset; empty = all (default). */
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
  };
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
};
