/**
 * Persisted plugin settings and their defaults.
 *
 * Every property that influences how source/output files are interpreted is
 * user-configurable, so the plugin can be adapted to an existing vault with
 * arbitrary frontmatter property names instead of hardcoding them.
 */
export interface KnowledgeSystemSettings {
  /** Main DeepSeek API key (masked text input in the UI). */
  apiKey: string;
  /** Selected model id. Options come exclusively from the /models endpoint. */
  defaultModel: string;
  /** Base URL of the (OpenAI-compatible) provider. Defaults to DeepSeek. */
  baseUrl: string;
  /** Custom provider override: API key (stored for future phases). */
  customApiKey: string;
  /** Custom provider override: model id (stored for future phases). */
  customModel: string;
  /** Folder scanned by the "count recent files" command. */
  sourceFolder: string;
  /** Folder where the "output latest content" command writes files. */
  outputFolder: string;
  /**
   * Frontmatter property holding each file's timestamp. Empty means "use the
   * file creation time (ctime)".
   */
  timePropertyName: string;
  /** moment-compatible format string used to parse / write timestamps. */
  timeFormat: string;
  /** How many days back the "count recent files" command looks. */
  recentDays: number;
  /** Frontmatter property holding the review/审核 status. */
  reviewStatusProperty: string;
  /** Default value written to the review status property. */
  reviewStatusValue: string;
  /** Frontmatter property holding the category/分类. */
  categoryProperty: string;
  /** Default value written to the category property. */
  categoryValue: string;
  /** Frontmatter property holding the output timestamp. */
  timestampProperty: string;
}

export const DEFAULT_SETTINGS: KnowledgeSystemSettings = {
  apiKey: '',
  defaultModel: '',
  baseUrl: 'https://api.deepseek.com',
  customApiKey: '',
  customModel: '',
  sourceFolder: '/',
  outputFolder: '/',
  timePropertyName: '',
  timeFormat: 'YYYY-MM-DD',
  recentDays: 7,
  reviewStatusProperty: 'approved',
  reviewStatusValue: '未审',
  categoryProperty: 'category',
  categoryValue: '未分类',
  timestampProperty: 'created',
};
