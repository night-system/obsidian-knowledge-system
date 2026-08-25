import { ItemView, MarkdownRenderer, WorkspaceLeaf, setIcon } from 'obsidian';
import type KnowledgeSystemPlugin from './main';
import { fetchAnthropicMessages, AnthropicChatMessage } from './core';
import { parseAnthropicSSE } from './utils/sse';
import { ANTHROPIC_TOOLS, listRecentNotesTool, readNoteTool, createNoteTool, ToolCtx } from './utils/tools';

/** The workspace view type for the chat view. Contract value. */
export const VIEW_TYPE_CHAT = 'knowledge-system-chat-view';

/** Built-in Chinese prompt for the test button. */
const TEST_PROMPT =
  '请按顺序完成以下任务，并在每一步简要说明你的思考与依据：\n' +
  '第一步：调用 list_recent_notes 查看源文件夹最近几天的笔记；\n' +
  '第二步：从中选择一篇笔记并调用 read_note 阅读它的正文；\n' +
  '第三步：调用 create_note 在输出文件夹创建一篇总结笔记（frontmatter 包含 来源 source、分类 category、审核状态 approved）。';

interface Block {
  type: 'thinking' | 'text' | 'tool_use';
  text: string;
  thinking: string;
  signature: string;
  id: string;
  name: string;
  input: unknown;
  partialJson: string;
}

function emptyBlock(type: Block['type']): Block {
  return { type, text: '', thinking: '', signature: '', id: '', name: '', input: {}, partialJson: '' };
}

/** Convert `Block`s to Anthropic content blocks for the API. */
function blocksToApi(blocks: Block[]): unknown[] {
  return blocks.map((b) =>
    b.type === 'tool_use'
      ? { type: 'tool_use', id: b.id, name: b.name, input: b.input }
      : b.type === 'thinking'
        ? { type: 'thinking', thinking: b.thinking, signature: b.signature }
        : { type: 'text', text: b.text }
  );
}

function truncate(s: string, n: number): string {
  const cps = [...(s ?? '')];
  return cps.length > n ? cps.slice(0, n).join('') + '…截断' : s;
}

function summarizeInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return String(input);
  }
}

/**
 * A workspace leaf that renders a streaming Anthropic chat UI: user bubbles as
 * plain text, assistant replies as markdown with collapsible thinking blocks and
 * tool_use cards, and a built-in test task. It drives the tool_use/tool_result
 * round-trip automatically against the local tool set.
 */
export class KnowledgeChatView extends ItemView {
  plugin: KnowledgeSystemPlugin;
  private apiHistory: AnthropicChatMessage[] = [];
  private scrollEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private busy = false;

  constructor(plugin: KnowledgeSystemPlugin, leaf: WorkspaceLeaf) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getIcon(): string {
    return 'message-square';
  }

  getDisplayText(): string {
    return 'Knowledge System Chat';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('ks-chat');

    this.scrollEl = container.createDiv({ cls: 'ks-chat-scroll' });

    const bar = container.createDiv({ cls: 'ks-chat-inputbar' });
    this.inputEl = bar.createEl('textarea', { cls: 'ks-chat-textarea' });
    this.inputEl.placeholder = '输入消息…（Enter 发送 / Shift+Enter 换行）';
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void this.send();
      }
    });

    const sendBtn = bar.createEl('button', { cls: 'mod-cta ks-chat-send' });
    setIcon(sendBtn, 'send');
    sendBtn.addEventListener('click', () => void this.send());

    const testBtn = bar.createEl('button', { cls: 'ks-chat-test' });
    setIcon(testBtn, 'play');
    testBtn.setAttribute('title', '测试任务');
    testBtn.addEventListener('click', () => void this.send(TEST_PROMPT));
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  // -------------------------------------------------------------------------
  // send / render helpers
  // -------------------------------------------------------------------------

  private userBubble(text: string): HTMLElement {
    const el = this.scrollEl.createDiv({ cls: 'ks-chat-msg ks-chat-user' }).createDiv({ cls: 'ks-chat-content' });
    el.style.whiteSpace = 'pre-wrap';
    el.setText(text);
    return el;
  }

  private assistantBubble(): { root: HTMLElement; body: HTMLElement } {
    const root = this.scrollEl.createDiv({ cls: 'ks-chat-msg ks-chat-ai' });
    const body = root.createDiv({ cls: 'ks-chat-content markdown-rendered' });
    return { root, body };
  }

  private errorBubble(text: string): void {
    this.scrollEl.createDiv({ cls: 'ks-chat-msg ks-chat-error' }).setText(text);
  }

  async send(text?: string): Promise<void> {
    if (this.busy) return;
    const userText = (text ?? this.inputEl.value).trim();
    if (!userText) return;
    this.inputEl.value = '';
    this.busy = true;
    try {
      this.apiHistory.push({ role: 'user', content: userText });
      this.userBubble(userText);
      await this.runTurn();
    } catch (e) {
      this.errorBubble('请求异常：' + ((e as { message?: string })?.message ?? '未知错误'));
    } finally {
      this.busy = false;
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    }
  }

  private async runTurn(): Promise<void> {
    const { body } = this.assistantBubble();
    let res;
    try {
      res = await fetchAnthropicMessages(this.plugin.settings, this.apiHistory, { tools: ANTHROPIC_TOOLS });
    } catch (e) {
      this.errorBubble('网络错误：' + ((e as { message?: string })?.message ?? '未知错误'));
      return;
    }
    if (res.status < 200 || res.status >= 300) {
      this.errorBubble(`请求失败：HTTP ${res.status}`);
      return;
    }

    const events = parseAnthropicSSE(res.text.split('\n'));
    const { blocks, stopReason, error } = this.processEvents(events);
    if (error) {
      this.errorBubble(error);
      return;
    }

    this.renderBlocks(body, blocks, {});

    if (stopReason === 'tool_use') {
      const ctx: ToolCtx = { app: this.plugin.app, settings: this.plugin.settings, moment: window.moment };
      const toolResults: Record<string, string> = {};
      for (const b of blocks.filter((x) => x.type === 'tool_use')) {
        toolResults[b.id] = await this.executeTool(ctx, b.name, b.input);
      }
      this.renderBlocks(body, blocks, toolResults);

      this.apiHistory.push({ role: 'assistant', content: blocksToApi(blocks) });
      this.apiHistory.push({
        role: 'user',
        content: Object.keys(toolResults).map((id) => ({ type: 'tool_result', tool_use_id: id, content: toolResults[id] })),
      });
      await this.runTurn();
    } else {
      this.apiHistory.push({ role: 'assistant', content: blocksToApi(blocks) });
    }
  }

  private processEvents(events: { event: string; data: unknown }[]): {
    blocks: Block[];
    stopReason: string | null;
    error?: string;
  } {
    const blocks: Block[] = [];
    let stopReason: string | null = null;
    let error: string | undefined;

    for (const ev of events) {
      const d = ev.data as Record<string, any> | null;
      if (!d || typeof d !== 'object') continue;
      if (d.type === 'error') {
        error = `错误：${d.error?.message ?? d.message ?? '未知'}`;
        continue;
      }
      if (d.type === 'content_block_start') {
        const cb = d.content_block ?? {};
        const idx = d.index ?? 0;
        blocks[idx] = emptyBlock(cb.type ?? 'text');
        blocks[idx].id = cb.id ?? '';
        blocks[idx].name = cb.name ?? '';
        if (cb.type === 'thinking') blocks[idx].signature = cb.signature ?? '';
        continue;
      }
      if (d.type === 'content_block_delta') {
        const blk = blocks[d.index];
        const delta = d.delta ?? {};
        if (!blk) continue;
        if (delta.type === 'text_delta') blk.text += delta.text ?? '';
        else if (delta.type === 'thinking_delta') blk.thinking += delta.thinking ?? '';
        else if (delta.type === 'signature_delta') blk.signature += delta.signature ?? '';
        else if (delta.type === 'input_json_delta') blk.partialJson += delta.partial_json ?? '';
        continue;
      }
      if (d.type === 'content_block_stop') {
        const blk = blocks[d.index];
        if (blk && blk.partialJson) {
          try {
            blk.input = JSON.parse(blk.partialJson);
          } catch {
            blk.input = blk.partialJson;
          }
        }
        continue;
      }
      if (d.type === 'message_delta') stopReason = d.delta?.stop_reason ?? null;
    }

    return { blocks: blocks.filter(Boolean), stopReason, error };
  }

  private renderBlocks(body: HTMLElement, blocks: Block[], toolResults: Record<string, string>): void {
    body.empty();
    for (const block of blocks) {
      if (block.type === 'thinking') {
        this.renderThinking(body, block.thinking);
      } else if (block.type === 'text') {
        const el = body.createDiv({ cls: 'ks-chat-markdown markdown-rendered' });
        void MarkdownRenderer.render(this.app, block.text, el, '', this);
      } else if (block.type === 'tool_use') {
        this.renderToolCard(body, block, toolResults[block.id]);
      }
    }
  }

  private renderThinking(body: HTMLElement, thinking: string): void {
    const wrap = body.createDiv({ cls: 'ks-think is-collapsed' });
    const head = wrap.createDiv({ cls: 'ks-think-head' });
    const chev = head.createSpan({ cls: 'ks-think-icon' });
    setIcon(chev, 'chevron-right');
    head.createSpan({ cls: 'ks-think-label', text: '思考中' }); // 可折叠块，默认收起
    const contentEl = wrap.createDiv({ cls: 'ks-think-body' });
    contentEl.setText(thinking);
    head.addEventListener('click', () => {
      const collapsed = wrap.hasClass('is-collapsed');
      wrap.toggleClass('is-collapsed', !collapsed);
      setIcon(chev, collapsed ? 'chevron-down' : 'chevron-right');
    });
  }

  private renderToolCard(body: HTMLElement, block: Block, result?: string): void {
    const card = body.createDiv({ cls: 'ks-tool-card' });
    const title = card.createDiv({ cls: 'ks-tool-name' });
    setIcon(title.createSpan({ cls: 'ks-tool-icon' }), 'wrench');
    title.createSpan({ text: block.name || 'tool' });
    card.createDiv({ cls: 'ks-tool-input', text: summarizeInput(block.input) });
    const resultEl = card.createDiv({ cls: 'ks-tool-result' });
    resultEl.setText(result == null ? '执行中…' : truncate(result, 300));
  }

  private async executeTool(ctx: ToolCtx, name: string, input: unknown): Promise<string> {
    const a = (input ?? {}) as Record<string, any>;
    try {
      if (name === 'list_recent_notes') {
        const r = await listRecentNotesTool(ctx, { days: a.days });
        return 'error' in r ? `ERROR: ${r.error}` : JSON.stringify(r.result);
      }
      if (name === 'read_note') {
        const r = await readNoteTool(ctx, { name: a.name });
        return 'error' in r ? `ERROR: ${r.error}` : r.result.content;
      }
      if (name === 'create_note') {
        const r = await createNoteTool(ctx, { title: a.title, yaml: a.yaml, content: a.content });
        return 'error' in r ? `ERROR: ${r.error}` : `已创建：${r.result.path}`;
      }
      return `ERROR: 未知工具 ${name}`;
    } catch (e) {
      return `ERROR: ${(e as { message?: string })?.message ?? '工具执行失败'}`;
    }
  }
}
