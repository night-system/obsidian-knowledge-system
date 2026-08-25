/**
 * Tool preset resolution (v0.5.0). Pure logic — no `obsidian` import and no
 * Node built-ins — so `resolveToolConfig` / `buildSystemPrompt` can be unit
 * tested in Node. It assembles the effective Anthropic `tools` array, system
 * prompt and tool parameter overrides from the currently active preset plus the
 * global settings, following the "high freedom" rules below.
 *
 * Rules (per v0.5.0 契约 B.4):
 * - Base tool set = [list_recent_notes, read_note, create_note]
 *   + (updateYamlToolEnabled ? [update_note_yaml] : []) + [search_output_notes].
 * - A non-empty preset `enabledTools` acts as a whitelist (intersection).
 * - `createNoteEnabled === false` drops create_note; `updateYamlEnabled ===
 *   false` drops update_note_yaml (even when whitelisted).
 * - yamlRules ALWAYS come from `settings.yamlRules` (preset-level yaml override
 *   is intentionally not supported).
 * - `listRecentDays` = preset override ?? settings.recentDays.
 * - No active preset (`activePresetId` empty / missing) → default behaviour.
 */
import type { KnowledgeSystemSettings, ToolPreset, YamlRule } from '../settings';
import { buildAnthropicTools, buildSearchOutputNotesTool, buildUpdateNoteYamlTool, AnthropicTool } from './tools';

/** The resolved, effective tool/system configuration for one chat send. */
export interface ResolvedToolConfig {
  /** The Anthropic tools array sent with the request. */
  tools: AnthropicTool[];
  /** The system prompt (preset override; '' = no system message). */
  systemPrompt: string;
  /** The effective yaml rules (always from settings.yamlRules). */
  yamlRules: YamlRule[];
  /** Override for list_recent_notes `days` (default = settings.recentDays). */
  listRecentDays?: number;
  /** search_output_notes mode. */
  searchMode: 'full' | 'restricted';
  /** Whitelisted keys for the restricted search mode. */
  searchRestrictions?: { key: string; values: string[] }[];
}

/** Find the preset referenced by `settings.activePresetId`; null when inactive. */
export function findActivePreset(settings: KnowledgeSystemSettings): ToolPreset | null {
  const id = (settings.activePresetId || '').trim();
  if (!id) return null;
  return (settings.toolPresets ?? []).find((p) => p.id === id) ?? null;
}

/** Build the default system prompt ('' = none); appends the preset prompt. */
export function buildSystemPrompt(preset?: ToolPreset | null): string {
  const p = preset?.systemPrompt ?? '';
  return (p || '').trim();
}

/** Resolve the effective tool/system configuration for a chat send. */
export function resolveToolConfig(settings: KnowledgeSystemSettings): ResolvedToolConfig {
  const preset = findActivePreset(settings);
  const yamlRules = Array.isArray(settings.yamlRules) ? settings.yamlRules : [];
  const baseTools = buildAnthropicTools(yamlRules);

  // 1) base tool names in stable order.
  let names = ['list_recent_notes', 'read_note', 'create_note'];
  if (settings.updateYamlToolEnabled) names.push('update_note_yaml');
  names.push('search_output_notes');

  // 2) enabledTools whitelist (non-empty ⇒ intersection).
  const enabled = preset?.enabledTools;
  if (Array.isArray(enabled) && enabled.length > 0) {
    names = names.filter((n) => enabled.includes(n));
  }

  // 3) per-tool enable/disable overrides.
  if (preset?.toolOverrides?.createNoteEnabled === false) names = names.filter((n) => n !== 'create_note');
  if (preset?.toolOverrides?.updateYamlEnabled === false) names = names.filter((n) => n !== 'update_note_yaml');

  // 4) assemble the Anthropic tool array in the same stable order.
  const findBase = (name: string): AnthropicTool | undefined => baseTools.find((t) => t.name === name);
  const tools: AnthropicTool[] = [];
  for (const n of names) {
    if (n === 'list_recent_notes' || n === 'read_note' || n === 'create_note') {
      const t = findBase(n);
      if (t) tools.push(t);
    } else if (n === 'update_note_yaml') {
      tools.push(buildUpdateNoteYamlTool());
    } else if (n === 'search_output_notes') {
      tools.push(
        buildSearchOutputNotesTool(
          preset?.toolOverrides?.searchMode ?? 'full',
          preset?.toolOverrides?.searchRestrictions
        )
      );
    }
  }

  const searchMode = preset?.toolOverrides?.searchMode ?? 'full';
  return {
    tools,
    systemPrompt: buildSystemPrompt(preset),
    yamlRules,
    listRecentDays: preset?.toolOverrides?.listRecentDays ?? settings.recentDays,
    searchMode,
    searchRestrictions: preset?.toolOverrides?.searchRestrictions,
  };
}
