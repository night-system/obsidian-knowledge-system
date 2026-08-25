/**
 * Persisted plugin settings and their defaults.
 *
 * The key names are part of the acceptance contract (the acceptance scripts set
 * `plugin.settings` directly with these exact keys — see 验收标准文档). Do not
 * rename them. Every attribute name that drives source/output interpretation is
 * user-configurable so the plugin adapts to an existing vault instead of
 * hardcoding frontmatter property names.
 */
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
  /** Custom-provider API key (stored for future phases; UI only). */
  customApiKey: string;
  /** Custom-provider model id (stored for future phases; UI only). */
  customModel: string;
  /** Dynamic output properties: each {key,value} is a frontmatter attribute
   * name plus its default value (written by the output command). Legacy
   * review/category fields are migrated here on first load. */
  extraProperties: { key: string; value: string }[];
}

export const DEFAULT_SETTINGS: KnowledgeSystemSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
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
  customApiKey: '',
  customModel: '',
  extraProperties: [],
};
