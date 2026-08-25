import { ItemView, MarkdownRenderer, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import type KnowledgeSystemPlugin from './main';
import { fetchAnthropicMessages, streamAnthropicMessages, AnthropicChatMessage } from './core';
import { parseAnthropicResponse, AnthropicBlock } from './utils/sse';
import { chatEndpointCandidates, hasAnthropicPath } from './utils/endpoints';
import {
  listRecentNotesTool,
  readNoteTool,
  createNoteTool,
  updateNoteYamlTool,
  searchOutputNotesTool,
  ToolCtx,
} from './utils/tools';
import { resolveToolConfig, ResolvedToolConfig } from './utils/presets';

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

/** Per-index DOM sub-elements for a collapsible thinking block. */
interface ThinkSub {
  wrap: HTMLElement;
  chev: HTMLElement;
  body: HTMLElement;
}

/** Per-index DOM sub-elements for a tool-use card. */
interface ToolSub {
  card: HTMLElement;
  inputEl: HTMLElement;
  resultEl: HTMLElement;
}

/**
 * A workspace leaf that renders a streaming Anthropic chat UI: user bubbles as
 * plain text, assistant replies as markdown with collapsible thinking blocks and
 * tool_use cards, and a built-in test task. It drives the tool_use/tool_result
 * round-trip automatically against the local tool set.
 *
 * Streaming rendering is incremental: each block keeps a persistent DOM
 * container (`blockEls`), text/thinking updates its inner element via O(1)
 * `textContent`, and a 120 ms throttle coalesces the heavier reconciliation
 * (markdown settle, cursor, scroll). Markdown is only re-parsed once per block
 * at `content_block_stop`, not on every token — the low-flicker fix.
 */
export class KnowledgeChatView extends ItemView {
  plugin: KnowledgeSystemPlugin;
  private apiHistory: AnthropicChatMessage[] = [];
  private scrollEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private testBtn!: HTMLButtonElement;
  private busy = false;
  private activeController: AbortController | null = null;
  private turnBlocks: AnthropicBlock[] = [];
  private turnStopReason: string | null = null;
  private turnError: string | undefined;

  // Streaming incremental-render state (all reset per assistant turn).
  private bodyEl: HTMLElement | null = null;
  private blockEls: Record<number, HTMLElement> = {};
  private markdownEls: Record<number, HTMLElement> = {};
  private thinkSubs: Record<number, ThinkSub> = {};
  private toolSubs: Record<number, ToolSub> = {};
  private blockStopped: Record<number, boolean> = {};
  private blockSettled: Record<number, boolean> = {};
  /** User's open/collapsed override per thinking block; `null` = follow stream state. */
  private thinkExpanded: Record<number, boolean | null> = {};
  private renderPending = false;
  private renderTimer: number | null = null;
  /** 流式 markdown 节流：每文本块一次进行中的 setTimeout；键存在即节流进行中。 */
  private mdRenderPending: Record<number, boolean> = {};
  /** 与上面的 pending 配对的 timer id，用于在块结算时取消挂起的节流渲染。 */
  private mdRenderTimers: Record<number, number> = {};
  private streamState: 'idle' | 'streaming' | 'done' = 'idle';
  private streamCursorEl: HTMLElement | null = null;
  /** 输入栏上方的 AI 流式状态行（dsh shimmer），流式期间显示。 */
  private statusEl!: HTMLElement;
  /** 预设选择器条（v0.5.0 DOM，input bar 上方一行）。 */
  private presetBarEl: HTMLElement | null = null;
  private presetSelect: HTMLSelectElement | null = null;
  /** 本轮发送时解析的生效工具/系统配置，供 executeTool 读取。 */
  private resolvedConfig: ResolvedToolConfig | null = null;

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

    // 流式状态行：输入栏上方，流式期间显示「正在思考… / DeepSeek 正在输出…」，
    // 用 dsh 的蓝色 shimmer 渐变（`--interactive-accent` 主题自适应）。
    this.statusEl = container.createDiv({ cls: 'ks-chat-status is-hidden' });
    this.statusEl.setText('DeepSeek 正在输出…');

    // 预设选择器条（v0.5.0）：input bar 上方一行，切换即生效。
    this.buildPresetBar(container);

    const bar = container.createDiv({ cls: 'ks-chat-inputbar' });
    this.inputEl = bar.createEl('textarea', { cls: 'ks-chat-textarea' });
    this.inputEl.placeholder = '输入消息…（Enter 发送 / Shift+Enter 换行）';
    this.inputEl.rows = 2;
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void this.send();
      }
    });
    this.inputEl.addEventListener('input', () => this.onInputChanged());

    this.sendBtn = bar.createEl('button', { cls: 'ks-chat-send' });
    this.sendBtn.setAttribute('aria-label', '发送');
    setIcon(this.sendBtn, 'arrow-up');
    this.sendBtn.addEventListener('click', () => {
      if (this.busy) {
        this.activeController?.abort();
      } else {
        void this.send();
      }
    });

    this.testBtn = bar.createEl('button', { cls: 'ks-chat-test' });
    this.testBtn.setAttribute('title', '测试任务');
    setIcon(this.testBtn, 'play');
    this.testBtn.addEventListener('click', () => void this.send(TEST_PROMPT));

    this.streamState = 'idle';
    this.onInputChanged();
  }

  async onClose(): Promise<void> {
    this.activeController?.abort();
    this.resolvePending();
    this.clearMarkdownTimers();
    this.streamState = 'idle';
    this.streamCursorEl = null;
    this.contentEl.empty();
  }

  // -------------------------------------------------------------------------
  // preset selector (v0.5.0)
  // -------------------------------------------------------------------------

  /** Build the preset dropdown bar above the input bar (one-off DOM). */
  private buildPresetBar(container: HTMLElement): void {
    this.presetBarEl = container.createDiv({ cls: 'ks-preset-bar' });
    const label = this.presetBarEl.createSpan({ cls: 'ks-preset-label', text: '预设' });
    const select = this.presetBarEl.createEl('select', { cls: 'ks-preset-select' });
    this.presetSelect = select;
    select.addEventListener('change', () => {
      this.plugin.settings.activePresetId = select.value;
      void this.plugin.saveSettings();
      const p = (this.plugin.settings.toolPresets || []).find((x) => x.id === select.value);
      const name = select.value ? (p ? p.name : select.value) : '默认（全部工具）';
      new Notice(`已切换预设：${name}（下次请求生效）`);
    });
    this.refreshPresetConfig();
    void label;
  }

  /** Repopulate the preset dropdown options from settings (called on open). */
  private refreshPresetConfig(): void {
    if (!this.presetSelect) return;
    const el = this.presetSelect;
    const presets = this.plugin.settings.toolPresets || [];
    el.empty();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = '默认（全部工具）';
    el.appendChild(def);
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      el.appendChild(opt);
    }
    el.value = this.plugin.settings.activePresetId || '';
  }

  // -------------------------------------------------------------------------
  // send / render helpers
  // -------------------------------------------------------------------------

  /** Render a right-aligned capsule user bubble (dsh: r22px capsule, timestamp below). */
  private userBubble(text: string): void {
    const root = this.scrollEl.createDiv({ cls: 'ks-chat-msg ks-chat-user' });
    const el = root.createDiv({ cls: 'ks-chat-content' });
    el.style.whiteSpace = 'pre-wrap';
    el.setText(text);
    root.createDiv({ cls: 'ks-chat-time' }).setText(this.nowLabel());
  }

  /** Render an assistant message: full-width narration, no bubble/edge/avatar,
   *  a muted model caption (dsh has no role label, but the model is useful), and
   *  a hover-reveal timestamp. Returns the markdown body container. */
  private assistantBubble(): { root: HTMLElement; body: HTMLElement } {
    const root = this.scrollEl.createDiv({ cls: 'ks-chat-msg ks-chat-ai' });
    const head = root.createDiv({ cls: 'ks-chat-head' });
    const model = (this.plugin.settings.model || '').trim();
    head.createSpan({ cls: 'ks-chat-head-name', text: model ? `AI · ${model}` : 'AI' });
    const body = root.createDiv({ cls: 'ks-chat-content markdown-rendered' });
    root.createDiv({ cls: 'ks-chat-time' }).setText(this.nowLabel());
    return { root, body };
  }

  /** Current wall-clock time label (HH:mm) for the hover-reveal timestamp. */
  private nowLabel(): string {
    const m = (window as { moment?: (arg?: unknown) => { format?: (f: string) => string } }).moment;
    const notNow = m ? m(new Date()) : null;
    if (notNow && typeof notNow.format === 'function') return notNow.format('HH:mm');
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

  /** Keep the input bar in sync: auto-grow + send button enable/stop state. */
  private onInputChanged(): void {
    const el = this.inputEl;
    el.style.height = 'auto';
    const cap = 12 * 16; // 12em at the 16px mobile-safe font size
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    this.updateSendBtn();
  }

  /** Toggle the send button between arrow-up (send), disabled (empty), and square (stop). */
  private updateSendBtn(): void {
    const btn = this.sendBtn;
    if (this.busy) {
      btn.disabled = false;
      setIcon(btn, 'square');
      btn.addClass('ks-chat-send-stop');
      btn.setAttribute('title', '停止生成');
    } else {
      setIcon(btn, 'arrow-up');
      btn.removeClass('ks-chat-send-stop');
      const empty = !(this.inputEl.value || '').trim();
      btn.disabled = empty;
      btn.setAttribute('title', empty ? '输入消息' : '发送');
    }
  }

  private forceScroll(): void {
    if (this.scrollEl) this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  /** Follow the stream only when the user is near the bottom (<80px of slack). */
  private maybeAutoScroll(): void {
    const el = this.scrollEl;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }

  async send(text?: string): Promise<void> {
    if (this.busy) return;
    const userText = (text ?? this.inputEl.value).trim();
    if (!userText) return;
    this.inputEl.value = '';
    this.activeController?.abort(); // cancel any in-flight request when sending anew
    this.busy = true;
    this.updateSendBtn();
    this.onInputChanged();
    try {
      this.apiHistory.push({ role: 'user', content: userText });
      this.userBubble(userText);
      this.forceScroll();
      await this.runTurn();
    } catch (e) {
      this.errorBlock('请求异常：' + ((e as { message?: string })?.message ?? '未知错误'), null);
    } finally {
      this.busy = false;
      this.updateSendBtn();
      this.forceScroll();
    }
  }

  private async runTurn(): Promise<void> {
    const { body } = this.assistantBubble();
    this.beginTurn(body);

    const ac = new AbortController();
    this.activeController = ac;
    let streamOk = false;
    let streamErr: string | null = null;
    let aborted = false;
    // TTFT 检测点：记录本轮起点，配合 core 返回的 ttfbMs/firstEventMs 归因首 token。
    const startAtMs = performance.now();
    // 解析当前生效的工具/系统配置（预设系统）。存到成员供 executeTool 读取。
    const cfg = resolveToolConfig(this.plugin.settings);
    this.resolvedConfig = cfg;
    const tools = cfg.tools;
    try {
      const st = await streamAnthropicMessages(this.plugin.settings, this.apiHistory, {
        tools,
        system: cfg.systemPrompt || undefined,
        signal: ac.signal,
        onEvent: (event) => this.handleChatEvent(event),
        onAutoCorrect: (url) => this.handleAutoCorrect(url),
      });
      console.info('[ks-stream]', {
        startAtMs,
        ttfbMs: st.ttfbMs,
        firstEventMs: st.firstEventMs,
        chunks: st.chunks,
        events: st.events,
        url: st.url,
        model: this.plugin.settings.model,
        toolsCount: (tools || []).length,
      });
      if (st.ok) {
        // 2xx but no frames parsed → treat as a parse failure and fall back to
        // the non-streaming requestUrl path (more stable than an empty reply).
        if ((st.events ?? 0) > 0) {
          streamOk = true;
        } else {
          streamErr = '流式响应未解析到事件';
        }
      } else {
        streamErr = st.status != null ? `HTTP ${st.status}（POST ${st.url ?? '未知'}）` : (st.error ?? '网络错误');
      }
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError' || ac.signal.aborted) {
        aborted = true;
      } else {
        streamErr = (e as { message?: string })?.message ?? '网络错误';
      }
    } finally {
      this.activeController = null;
    }

    if (aborted) {
      // User pressed stop: keep whatever streamed so far, no non-stream fallback.
      this.finishStream(body);
      return;
    }

    if (streamOk) {
      if (this.turnError) {
        this.errorBlock(this.turnError, null);
        return;
      }
      await this.finishTurn(body, this.turnBlocks.filter(Boolean), this.turnStopReason);
      return;
    }

    // Streaming failed → settle the partial bubble (markdown-render any streamed
    // text, drop the cursor) before we try the non-streaming fallback, so a
    // leftover error leaves a clean bubble instead of a stuck blinking cursor.
    this.streamState = 'done';
    this.hideStatus();
    this.removeStreamCursor();
    this.renderAll();
    this.resolvePending();

    // Fallback: requestUrl + non-stream (mobile requestUrl can't parse chunked SSE).
    let res;
    let nonStreamErr: string | null = null;
    try {
      res = await fetchAnthropicMessages(this.plugin.settings, this.apiHistory, {
        tools,
        system: cfg.systemPrompt || undefined,
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

  /** Reset per-turn streaming/render state before a new assistant bubble. */
  private beginTurn(body: HTMLElement): void {
    this.bodyEl = body;
    this.turnBlocks = [];
    this.turnStopReason = null;
    this.turnError = undefined;
    this.blockEls = {};
    this.markdownEls = {};
    this.thinkSubs = {};
    this.toolSubs = {};
    this.blockStopped = {};
    this.blockSettled = {};
    this.thinkExpanded = {};
    this.mdRenderPending = {};
    this.mdRenderTimers = {};
    this.streamState = 'streaming';
    this.streamCursorEl = null;
    this.resolvePending();
    this.showStatus('DeepSeek 正在输出…');
  }

  /** Finalize an aborted partial turn: paint what streamed, drop the cursor. */
  private finishStream(body: HTMLElement): void {
    this.streamState = 'done';
    this.hideStatus();
    this.renderAll();
    this.resolvePending();
  }

  private handleChatEvent(ev: { event: string; data: unknown }): void {
    const d = ev.data as Record<string, any> | null;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'error') {
      this.turnError = `错误：${d.error?.message ?? d.message ?? '未知'}`;
      this.hideStatus();
      this.renderAll();
      return;
    }
    if (d.type === 'content_block_start') {
      const cb = d.content_block ?? {};
      const idx = d.index ?? 0;
      this.turnBlocks[idx] = emptyBlock(cb.type ?? 'text');
      this.turnBlocks[idx].id = cb.id ?? '';
      this.turnBlocks[idx].name = cb.name ?? '';
      if (cb.type === 'thinking') this.turnBlocks[idx].signature = cb.signature ?? '';
      const container = this.ensureBlockEl(idx);
      this.paintBlock(idx, container, this.turnBlocks[idx], undefined, false);
      this.updateStreamCursor();
      this.updateStatus();
      this.scheduleRender();
    } else if (d.type === 'content_block_delta') {
      const blk = this.turnBlocks[d.index];
      const delta = d.delta ?? {};
      if (!blk) return;
      if (delta.type === 'text_delta') {
        blk.text += delta.text ?? '';
        this.refreshBlockText(d.index, blk.text);
      } else if (delta.type === 'thinking_delta') {
        blk.thinking += delta.thinking ?? '';
        this.refreshThinking(d.index, blk.thinking);
      } else if (delta.type === 'signature_delta') {
        blk.signature += delta.signature ?? '';
      } else if (delta.type === 'input_json_delta') {
        blk.partialJson += delta.partial_json ?? '';
        this.refreshToolSub(d.index, blk);
      }
      this.updateStatus();
      this.scheduleRender();
    } else if (d.type === 'content_block_stop') {
      const blk = this.turnBlocks[d.index];
      if (blk && blk.partialJson) {
        try {
          blk.input = JSON.parse(blk.partialJson);
        } catch {
          blk.input = blk.partialJson;
        }
      }
      this.blockStopped[d.index] = true;
      if (blk?.type === 'text') this.settleTextMarkdown(d.index, blk);
      this.updateStreamCursor();
      this.updateStatus();
      this.scheduleRender();
    } else if (d.type === 'message_delta') {
      this.turnStopReason = d.delta?.stop_reason ?? null;
    }
  }

  /** 按当前进行中的块类型更新状态行文案（思考 vs 输出）。 */
  private updateStatus(): void {
    if (this.streamState !== 'streaming') return;
    let last: AnthropicBlock | null = null;
    for (let i = this.turnBlocks.length - 1; i >= 0; i--) {
      if (this.turnBlocks[i]) {
        last = this.turnBlocks[i];
        break;
      }
    }
    const label = last?.type === 'thinking' ? '正在思考…' : 'DeepSeek 正在输出…';
    this.showStatus(label);
  }

  private showStatus(text: string): void {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    this.statusEl.removeClass('is-hidden');
  }

  private hideStatus(): void {
    if (this.statusEl) this.statusEl.addClass('is-hidden');
  }

  private async finishTurn(body: HTMLElement, blocks: AnthropicBlock[], stopReason: string | null): Promise<void> {
    this.streamState = 'done';
    this.hideStatus();
    this.renderBlocks(body, blocks, {});
    this.resolvePending();
    if (stopReason === 'tool_use') {
      const cfg = this.resolvedConfig;
      const ctx: ToolCtx = {
        app: this.plugin.app,
        settings: this.plugin.settings,
        moment: window.moment,
        searchMode: cfg?.searchMode,
        searchRestrictions: cfg?.searchRestrictions,
      };
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

  // -------------------------------------------------------------------------
  // Streaming render: persistent per-block containers
  // -------------------------------------------------------------------------

  /** Get (or create) the persistent container for block `index` under the body. */
  private ensureBlockEl(index: number): HTMLElement {
    let el = this.blockEls[index];
    if (!el || !el.isConnected) {
      el = this.bodyEl!.createDiv({ cls: 'ks-chat-block' });
      this.blockEls[index] = el;
      // Keep the streaming cursor last: insert new blocks before it.
      if (this.streamCursorEl?.isConnected) {
        this.bodyEl!.insertBefore(el, this.streamCursorEl);
      } else {
        this.bodyEl!.appendChild(el);
      }
    }
    return el;
  }

  /** Repaint every block into its persistent container (throttled 120 ms). */
  private renderAll(): void {
    this.renderPending = false;
    const body = this.bodyEl;
    if (!body) return;
    const blocks = this.turnBlocks;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b) continue;
      const container = this.ensureBlockEl(i);
      const stopped = !!this.blockStopped[i] || this.streamState === 'done';
      this.paintBlock(i, container, b, undefined, stopped);
    }
    this.updateStreamCursor();
    this.maybeAutoScroll();
  }

  /** Coalesce renders to one 120 ms frame (with a per-token textContent fast path). */
  private scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    this.renderTimer = window.setTimeout(() => {
      this.renderPending = false;
      this.renderTimer = null;
      this.renderAll();
    }, 120);
  }

  private resolvePending(): void {
    if (this.renderTimer != null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.renderPending = false;
  }

  private paintBlock(
    index: number,
    container: HTMLElement,
    block: AnthropicBlock,
    toolResult: string | undefined,
    stopped: boolean
  ): void {
    if (block.type === 'thinking') {
      this.ensureThinkingStructure(index, container);
      this.updateThinking(index, block.thinking, stopped);
    } else if (block.type === 'text') {
      this.ensureTextStructure(index, container);
      this.updateText(index, block.text, stopped);
    } else if (block.type === 'tool_use') {
      this.ensureToolStructure(index, container, block);
      this.updateTool(index, block, toolResult);
    }
  }

  // --- text blocks -----------------------------------------------------------

  private ensureTextStructure(index: number, container: HTMLElement): void {
    if (this.markdownEls[index]?.isConnected) return;
    const el = container.createDiv({ cls: 'ks-chat-markdown markdown-rendered' });
    this.markdownEls[index] = el;
  }

  /** Update a text block in place. 流式期间用 180ms 节流 markdown 渲染（DOM 恒为
   *  markdown，不再写纯文本 —— 用户核心诉求「第一次输出就直接 markdown 渲染」）；
   *  块结算（stopped）时立即渲染一次终稿并冻结。 */
  private updateText(index: number, text: string, stopped: boolean): void {
    const el = this.markdownEls[index];
    if (!el?.isConnected) return;
    if (stopped) {
      if (this.blockSettled[index]) return; // 已渲染终稿 → 冻结不重渲
      this.blockSettled[index] = true;
      el.setText(text);
      void MarkdownRenderer.render(this.app, text, el, '', this);
    } else {
      this.scheduleMarkdownRender(index, text);
    }
  }

  /** 流式 per-token 入口：只记数据（text 已存入 blk.text），触发节流 markdown 渲染。 */
  private refreshBlockText(index: number, text: string): void {
    this.scheduleMarkdownRender(index, text);
  }

  /**
   * 节流 markdown 渲染器：同一文本块 180ms 内只进行一次 `setText` + 全量
   * `MarkdownRenderer.render`，让流式途中 DOM 始终是 markdown 但刷新被节流到
   * 每 ~180ms 一次（对常见回复 <2000 字，移动端可接受；卡顿可调大节流）。已
   * settle 的块冻结不重渲（保留 blockSettled 机制）。异步 render 会自替换子节点。
   */
  private scheduleMarkdownRender(index: number, text: string): void {
    if (this.mdRenderPending[index]) return;
    this.mdRenderPending[index] = true;
    this.mdRenderTimers[index] = window.setTimeout(() => {
      this.mdRenderPending[index] = false;
      this.mdRenderTimers[index] = 0;
      const el = this.markdownEls[index];
      if (el?.isConnected && !this.blockSettled[index]) {
        el.setText(text);
        void MarkdownRenderer.render(this.app, text, el, '', this);
      }
    }, 180);
  }

  /** 块 content_block_stop：立即渲染终稿，并取消挂起的节流定时器。 */
  private settleTextMarkdown(index: number, block: AnthropicBlock): void {
    this.blockSettled[index] = true;
    this.clearMarkdownTimer(index);
    const el = this.markdownEls[index];
    if (!el?.isConnected) return;
    el.setText(block.text);
    void MarkdownRenderer.render(this.app, block.text, el, '', this);
  }

  private clearMarkdownTimer(index: number): void {
    const timer = this.mdRenderTimers[index];
    if (timer != null) {
      window.clearTimeout(timer);
      this.mdRenderTimers[index] = 0;
    }
    this.mdRenderPending[index] = false;
  }

  private clearMarkdownTimers(): void {
    for (const index of Object.keys(this.mdRenderTimers)) {
      this.clearMarkdownTimer(Number(index));
    }
  }

  // --- thinking blocks -------------------------------------------------------

  private ensureThinkingStructure(index: number, container: HTMLElement): void {
    if (this.thinkSubs[index]?.wrap.isConnected) return;
    const wrap = container.createDiv({ cls: 'ks-think is-collapsed' });
    const head = wrap.createDiv({ cls: 'ks-think-head' });
    const chev = head.createSpan({ cls: 'ks-think-icon' });
    setIcon(chev, 'chevron-right');
    const icon = head.createSpan({ cls: 'ks-think-icon-2' });
    setIcon(icon, 'brain');
    head.createSpan({ cls: 'ks-think-label', text: '思考中' }); // 可折叠
    const body = wrap.createDiv({ cls: 'ks-think-body' });
    this.thinkExpanded[index] = null; // follow stream state until the user toggles
    wrap.addEventListener('click', () => {
      const collapsed = wrap.hasClass('is-collapsed');
      const newCollapsed = !collapsed;
      wrap.toggleClass('is-collapsed', newCollapsed);
      setIcon(chev, newCollapsed ? 'chevron-right' : 'chevron-down');
      this.thinkExpanded[index] = !newCollapsed;
    });
    this.thinkSubs[index] = { wrap, chev, body };
  }

  private updateThinking(index: number, thinking: string, stopped: boolean): void {
    const sub = this.thinkSubs[index];
    if (!sub?.wrap.isConnected) return;
    sub.body.setText(thinking);
    const streaming = !stopped && this.streamState === 'streaming';
    // Auto: expand while streaming (so the live reasoning + blinking「…」show),
    // collapse when done; a manual click overrides both.
    const override = this.thinkExpanded[index];
    const expanded = override != null ? override : streaming;
    sub.wrap.toggleClass('is-collapsed', !expanded);
    setIcon(sub.chev, expanded ? 'chevron-down' : 'chevron-right');
    sub.wrap.toggleClass('ks-think-streaming', streaming);
  }

  private refreshThinking(index: number, thinking: string): void {
    const sub = this.thinkSubs[index];
    if (sub?.body.isConnected) sub.body.setText(thinking);
  }

  // --- tool_use cards --------------------------------------------------------

  private ensureToolStructure(index: number, container: HTMLElement, block: AnthropicBlock): void {
    if (this.toolSubs[index]?.card.isConnected) return;
    const card = container.createDiv({ cls: 'ks-tool-card' });
    const title = card.createDiv({ cls: 'ks-tool-name' });
    setIcon(title.createSpan({ cls: 'ks-tool-icon' }), 'wrench');
    title.createSpan({ text: block.name || 'tool' });
    const inputEl = card.createDiv({ cls: 'ks-tool-input' });
    const resultEl = card.createDiv({ cls: 'ks-tool-result' });
    this.toolSubs[index] = { card, inputEl, resultEl };
  }

  private toolInputPreview(block: AnthropicBlock): string {
    return block.input && Object.keys(block.input).length > 0 ? summarizeInput(block.input) : (block.partialJson || '');
  }

  private updateTool(index: number, block: AnthropicBlock, toolResult: string | undefined): void {
    const sub = this.toolSubs[index];
    if (!sub?.card.isConnected) return;
    sub.inputEl.setText(this.toolInputPreview(block));
    sub.resultEl.setText(toolResult == null ? '执行中…' : truncate(toolResult, 300));
  }

  private refreshToolSub(index: number, block: AnthropicBlock): void {
    const sub = this.toolSubs[index];
    if (sub?.card.isConnected) sub.inputEl.setText(this.toolInputPreview(block));
  }

  /** Show/hide the AI streaming cursor at the end of the last text/thinking block. */
  private updateStreamCursor(): void {
    const active = this.streamState === 'streaming';
    const blocks = this.turnBlocks;
    let lastIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]) {
        lastIdx = i;
        break;
      }
    }
    const last = lastIdx >= 0 ? blocks[lastIdx] : null;
    const lastStreamingText =
      !!last && (last.type === 'text' || last.type === 'thinking') && !this.blockStopped[lastIdx];
    const shouldShow = active && lastStreamingText;
    if (shouldShow) {
      if (!this.streamCursorEl?.isConnected) {
        const span = this.bodyEl!.createSpan({ cls: 'ks-stream-cursor' });
        this.streamCursorEl = span;
      }
    } else if (this.streamCursorEl?.isConnected) {
      this.streamCursorEl.remove();
      this.streamCursorEl = null;
    }
  }

  private removeStreamCursor(): void {
    if (this.streamCursorEl?.isConnected) this.streamCursorEl.remove();
    this.streamCursorEl = null;
  }

  /** Final static render: clear the body and rebuild every block (used at turn end). */
  private renderBlocks(body: HTMLElement, blocks: AnthropicBlock[], toolResults: Record<string, string>): void {
    this.bodyEl = body;
    this.streamState = 'done';
    this.blockEls = {};
    this.markdownEls = {};
    this.thinkSubs = {};
    this.toolSubs = {};
    this.blockStopped = {};
    this.blockSettled = {};
    this.thinkExpanded = {};
    this.mdRenderPending = {};
    this.mdRenderTimers = {};
    this.removeStreamCursor();
    body.empty();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b) continue;
      const container = body.createDiv({ cls: 'ks-chat-block' });
      this.blockEls[i] = container;
      this.paintBlock(i, container, b, toolResults?.[b.id], true);
    }
  }

  private async executeTool(ctx: ToolCtx, name: string, input: unknown): Promise<string> {
    const a = (input ?? {}) as Record<string, any>;
    const cfg = this.resolvedConfig;
    try {
      if (name === 'list_recent_notes') {
        const days = a.days ?? cfg?.listRecentDays;
        const r = await listRecentNotesTool(ctx, { days });
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
      if (name === 'update_note_yaml') {
        const r = await updateNoteYamlTool(ctx, { name: a.name, updates: a.updates });
        return 'error' in r ? `ERROR: ${r.error}` : `已更新：${r.result.path}（${r.result.updated.join(', ')}）`;
      }
      if (name === 'search_output_notes') {
        const r = await searchOutputNotesTool(ctx, { filters: a.filters, query: a.query, limit: a.limit });
        if ('error' in r) return `ERROR: ${r.error}`;
        if (r.result.length === 0) return '未找到匹配的笔记';
        return JSON.stringify(r.result);
      }
      return `ERROR: 未知工具 ${name}`;
    } catch (e) {
      return `ERROR: ${(e as { message?: string })?.message ?? '工具执行失败'}`;
    }
  }
}
