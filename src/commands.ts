import { Notice } from 'obsidian';
import { KnowledgeSystemPlugin, countRecentFiles, outputLatestContent } from './core';

/**
 * Register the plugin's two commands. Both share their implementation with the
 * settings tab (the "测试并获取模型" button is wired to the same fetch that a
 * future chat phase would reuse; the two file-based commands are self-contained).
 */
export function registerCommands(plugin: KnowledgeSystemPlugin): void {
  plugin.addCommand({
    id: 'count-recent-files',
    name: '统计最近文件数',
    callback: () => {
      const count = countRecentFiles(plugin);
      new Notice(`源文件夹最近 ${plugin.settings.recentDays} 天共有 ${count} 个文件`);
    },
  });

  plugin.addCommand({
    id: 'output-latest-content',
    name: '输出最新内容测试',
    callback: async () => {
      await outputLatestContent(plugin);
    },
  });
}
