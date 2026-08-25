import { ItemView, MarkdownRenderer, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import type KnowledgeSystemPlugin from './main';
import { fetchAnthropicMessages, streamAnthropicMessages, AnthropicChatMessage } from './core';
import { parseAnthropicResponse, AnthropicBlock } from './utils/sse';
import { chatEndpointCandidates, hasAnthropicPath } from './utils/endpoints';
import { ANTHROPIC_TOOLS, listRecentNotesTool, readNoteTool, createNoteTool, ToolCtx } from './utils/tools';

/** The workspace view type for the chat view. Contract value. */
export const VIEW_TYPE_CHAT = 'knowledge-system-chat-view';

/** Built-in Chinese prompt for the test button. */
const TEST_PROMPT =
  '请按顺序完成以下任务，并在每一步简要说明你的思考与依据：\n' +
  '第一步：调用 list_recent_notes 查看源文件夹最近几天的笔记；\n' +
  '第二步：从中选择一篇笔记并调用 read_note 阅读它的正文；\n' +
  '第三步：调用 create_note 在输出文件夹创建一篇总结笔记（frontmatter 包含 来源 source、分类 category、审核状态 approved）。';

function emptyBlock(type: AnthropicBlock['type']): AnthropicBlock {
  return { type, text: '', thinking: '', signature: '', id: '', name: '', input: {}, partialJson: '' };
}

/** Convert blocks to Anthropic content blocks for the API. */
function blocksToApi(blocks: AnthropicBlock[]): unknown[] {
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
  private activeController: AbortController | null = null;
  private turnBlocks: AnthropicBlock[] = [];
  private turnStopReason: string | null = null;
  private turnError: string | undefined;

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
    this.activeController?.abort();
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

  /** Render a copyable, self-diagnosing error block (used by every failure path). */
  private errorBlock(streamErr: string | null, nonStreamErr: string | null): void {
    const root = this.scrollEl.createDiv({ cls: 'ks-chat-msg ks-chat-error' });
    const block = root.createDiv({ cls: 'ks-chat-error-block' });
    const pre = block.createEl('pre', { cls: 'ks-chat-error-text' });
    const lines = ['请求失败'];
    if (streamErr) lines.push(`流式：${streamErr}`);
    if (nonStreamErr) lines.push(`非流式：${nonStreamErr}`);
    lines.push(`提示：${this.errorHint()}`);
    const text = lines.join('\n');
    pre.setText(text);

    const copyBtn = block.createEl('button', { cls: 'ks-chat-copy ks-chat-copy-btn' });
    copyBtn.setText('一键复制');
    copyBtn.addEventListener('click', () => this.copyToClipboard(text, copyBtn));
  }

  /** Build the diagnostic hint line from the current base URL configuration. */
  private errorHint(): string {
    const base = (this.plugin.settings.baseUrl || '').trim();
    if (hasAnthropicPath(base)) {
      return '请检查 API Key、模型名与网络连接。';
    }
    const attemptedAnthropic = !hasAnthropicPath(base) && chatEndpointCandidates(base).length > 1;
    if (attemptedAnthropic) {
      return '已自动尝试补充 /anthropic 前缀仍未成功。若使用 DeepSeek 官方 API，请在设置中将 Base URL 改为 https://api.deepseek.com/anthropic（或保持根地址，本版本每次都会自动探测修正）。';
    }
    return '请检查 API Key、模型名与网络连接。';
  }

  /** Copy `text` to the clipboard, keeping the UI under `btn` in sync. */
  private copyToClipboard(text: string, btn: HTMLElement): void {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(
        () => this.markCopied(btn),
        () => this.clipboardFallback(text, btn)
      );
    } else {
      this.clipboardFallback(text, btn);
    }
  }

  /** Flip the button to「已复制」then back to「一键复制」(short-lived confirmation). */
  private markCopied(btn: HTMLElement): void {
    btn.setText('已复制');
    window.setTimeout(() => btn.setText('一键复制'), 1500);
  }

  /** Legacy textarea+execCommand fallback; request the user to select on failure. */
  private clipboardFallback(text: string, btn: HTMLElement): void {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.markCopied(btn);
    } catch {
      btn.setText('复制失败，请长按文本');
    }
  }

  /** Persist an endpoint auto-correction and notify the user (explicit, not silent). */
  private handleAutoCorrect(url: string): void {
    const corrected = url.replace(/\/v1\/messages$/, '').replace(/\/+$/, '');
    this.plugin.settings.baseUrl = corrected;
    void this.plugin.saveSettings();
    new Notice(`已自动更正端点：${url}（设置中的 Base URL 已同步更新）`);
  }

  async send(text?: string): Promise<void> {
    if (this.busy) return;
    const userText = (text ?? this.inputEl.value).trim();
    if (!userText) return;
    this.inputEl.value = '';
    this.activeController?.abort(); // cancel any in-flight request when sending anew
    this.busy = true;
    try {
      this.apiHistory.push({ role: 'user', content: userText });
      this.userBubble(userText);
      await this.runTurn();
    } catch (e) {
      this.errorBlock('请求异常：' + ((e as { message?: string })?.message ?? '未知错误'), null);
    } finally {
      this.busy = false;
      this.activeController = null;
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    }
  }

  private async runTurn(): Promise<void> {
    const { body } = this.assistantBubble();
    this.turnBlocks = [];
    this.turnStopReason = null;
    this.turnError = undefined;

    const ac = new AbortController();
    this.activeController = ac;
    let streamOk = false;
    let streamErr: string | null = null;
    try {
      const st = await streamAnthropicMessages(this.plugin.settings, this.apiHistory, {
        tools: ANTHROPIC_TOOLS,
        signal: ac.signal,
        onEvent: (event) => this.handleChatEvent(body, event),
        onAutoCorrect: (url) => this.handleAutoCorrect(url),
      });
      if (st.ok) {
        streamOk = true;
      } else {
        streamErr = st.status != null ? `HTTP ${st.status}（POST ${st.url ?? '未知'}）` : (st.error ?? '网络错误');
      }
    } catch (e) {
      streamErr = (e as { message?: string })?.message ?? '网络错误';
    } finally {
      this.activeController = null;
    }

    if (streamOk) {
      if (this.turnError) {
        this.errorBlock(this.turnError, null);
        return;
      }
      await this.finishTurn(body, this.turnBlocks.filter(Boolean), this.turnStopReason);
      return;
    }

    // Fallback: requestUrl + non-stream (mobile requestUrl can't parse chunked SSE).
    let res;
    let nonStreamErr: string | null = null;
    try {
      res = await fetchAnthropicMessages(this.plugin.settings, this.apiHistory, {
        tools: ANTHROPIC_TOOLS,
        onAutoCorrect: (url) => this.handleAutoCorrect(url),
      });
      if (res.requestError != null) {
        nonStreamErr = `网络错误（POST ${res.url ?? '未知'}）：${res.requestError}`;
      } else if (res.status < 200 || res.status >= 300) {
        nonStreamErr = `HTTP ${res.status}（POST ${res.url ?? '未知'}）`;
      }
    } catch (e) {
      nonStreamErr = `网络错误（POST ${res?.url ?? '未知'}）：${(e as { message?: string })?.message ?? '未知'}`;
    }
    if (res && res.status >= 200 && res.status < 300) {
      let json: any = null;
      try {
        json = JSON.parse(res.text);
      } catch {
        json = null;
      }
      const parsed = parseAnthropicResponse(json);
      await this.finishTurn(body, parsed.blocks, parsed.stop_reason ?? null);
      return;
    }
    this.errorBlock(streamErr, nonStreamErr);
  }

  private handleChatEvent(body: HTMLElement, ev: { event: string; data: unknown }): void {
    const d = ev.data as Record<string, any> | null;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'error') {
      this.turnError = `错误：${d.error?.message ?? d.message ?? '未知'}`;
      return;
    }
    if (d.type === 'content_block_start') {
      const cb = d.content_block ?? {};
      const idx = d.index ?? 0;
      this.turnBlocks[idx] = emptyBlock(cb.type ?? 'text');
      this.turnBlocks[idx].id = cb.id ?? '';
      this.turnBlocks[idx].name = cb.name ?? '';
      if (cb.type === 'thinking') this.turnBlocks[idx].signature = cb.signature ?? '';
    } else if (d.type === 'content_block_delta') {
      const blk = this.turnBlocks[d.index];
      const delta = d.delta ?? {};
      if (!blk) return;
      if (delta.type === 'text_delta') blk.text += delta.text ?? '';
      else if (delta.type === 'thinking_delta') blk.thinking += delta.thinking ?? '';
      else if (delta.type === 'signature_delta') blk.signature += delta.signature ?? '';
      else if (delta.type === 'input_json_delta') blk.partialJson += delta.partial_json ?? '';
    } else if (d.type === 'content_block_stop') {
      const blk = this.turnBlocks[d.index];
      if (blk && blk.partialJson) {
        try {
          blk.input = JSON.parse(blk.partialJson);
        } catch {
          blk.input = blk.partialJson;
        }
      }
    } else if (d.type === 'message_delta') {
      this.turnStopReason = d.delta?.stop_reason ?? null;
    }
    this.renderBlocks(body, this.turnBlocks.filter(Boolean), {});
  }

  private async finishTurn(body: HTMLElement, blocks: AnthropicBlock[], stopReason: string | null): Promise<void> {
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

  private renderBlocks(body: HTMLElement, blocks: AnthropicBlock[], toolResults: Record<string, string>): void {
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

  private renderToolCard(body: HTMLElement, block: AnthropicBlock, result?: string): void {
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
