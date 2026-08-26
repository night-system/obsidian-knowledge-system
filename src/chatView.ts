import { ItemView, MarkdownRenderer, WorkspaceLeaf, Notice, setIcon, Platform } from 'obsidian';
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
  modifyOutputNoteTool,
  modifyOutputNoteVersionedTool,
  readOutputNoteTool,
  ToolCtx,
} from './utils/tools';
import { resolveToolConfig, ResolvedToolConfig } from './utils/presets';

/** The workspace view type for the chat view. Contract value. */
export const VIEW_TYPE_CHAT = 'knowledge-system-chat-view';

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

/** Join the plain text of every text block (used for the AI message copy). */
function joinTextBlocks(blocks: AnthropicBlock[]): string {
  return blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

/** One-line thinking summary: first line, clamped to ~80 chars (CSS ellipsis). */
function thinkSummary(thinking: string): string {
  const text = thinking ?? '';
  const lineEnd = text.indexOf('\n');
  const first = lineEnd === -1 ? text : text.slice(0, lineEnd);
  const cps = [...first];
  return cps.length > 80 ? cps.slice(0, 80).join('') : first;
}

/** Per-index DOM sub-elements for a collapsible thinking block. */
interface ThinkSub {
  wrap: HTMLElement;
  chev: HTMLElement;
  summary: HTMLElement;
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
 * tool_use cards, driving the tool_use/tool_result round-trip automatically
 * against the local tool set.
 *
 * v0.6.0 渲染契约：**单一写入者**。每个文本块的 `markdownEls[index]` 只由一条路径写
 * ——流式期间 `scheduleMarkdownRender`（180ms 节流）、块结算 `settleTextMarkdown`
 * ——一律**先 `empty()` 再 `MarkdownRenderer.render`**（render 为 append 语义），
 * 杜绝「裸 Text 节点 + 渲染子节点」并存造成的「渲染两份」。`renderAll`（120ms 结构
 * 调和）只负责「新块出现 / 工具卡 / 思考块 / 光标 / 滚动」，**不再写文本内容**。
 */
export class KnowledgeChatView extends ItemView {
  plugin: KnowledgeSystemPlugin;
  private apiHistory: AnthropicChatMessage[] = [];
  private scrollEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private copyLogBtn!: HTMLButtonElement;
  private busy = false;
  private activeController: AbortController | null = null;
  private turnBlocks: AnthropicBlock[] = [];
  private turnStopReason: string | null = null;
  private turnError: string | undefined;

  // Streaming incremental-render state (all reset per assistant turn).
  private bodyEl: HTMLElement | null = null;
  private currentAiBody: HTMLElement | null = null;
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
  /** 预设选择器条（v0.5.0 DOM，现移入输入卡左工具区）。 */
  private presetBarEl: HTMLElement | null = null;
  private presetSelect: HTMLSelectElement | null = null;
  /** 本轮发送时解析的生效工具/系统配置，供 executeTool 读取。 */
  private resolvedConfig: ResolvedToolConfig | null = null;

  // 诊断日志数据（A.5）：最近一次流式统计 / 渲染检查 / 错误，供「复制诊断日志」打包。
  private lastStreamLog: Record<string, unknown> | null = null;
  private lastRenderCheck: string[] | null = null;
  private lastErrorText: string | null = null;
  /** 已定型消息的纯文本缓存（keyed by 消息 body），供多轮历史消息的复制按钮使用。 */
  private aiMsgTextCache = new WeakMap<HTMLElement, string>();

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

    // 流式状态行：输入栏上方（dsh 的 shimmer），流式期间显示。
    this.statusEl = container.createDiv({ cls: 'ks-chat-status is-hidden' });
    this.statusEl.setText('DeepSeek 正在输出…');

    // 输入卡片（dsh InputBar .card）：列式——上部 textarea 区 + 下部按钮行 .row。
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

    // 按钮行（dsh .row）：左 .tools（预设选择器 + 复制日志）、右 .trailing（发送）。
    const row = bar.createDiv({ cls: 'ks-chat-input-row' });
    const tools = row.createDiv({ cls: 'ks-chat-input-tools' });
    this.buildPresetBar(tools);

    // 复制诊断日志按钮（A.5，放工具区，与预设选择器同排；lucide clipboard-copy）。
    this.copyLogBtn = tools.createEl('button', { cls: 'ks-chat-action ks-chat-copy-log' });
    this.copyLogBtn.setAttribute('aria-label', '复制诊断日志');
    this.copyLogBtn.setAttribute('title', '复制诊断日志');
    this.setIconWithFallback(this.copyLogBtn, 'clipboard-copy', '复制');
    this.copyLogBtn.addEventListener('click', () => this.copyDiagnosticLog());

    const trailing = row.createDiv({ cls: 'ks-chat-input-trailing' });
    this.sendBtn = trailing.createEl('button', { cls: 'ks-chat-send' });
    this.sendBtn.setAttribute('aria-label', '发送');
    this.setIconWithFallback(this.sendBtn, 'arrow-up', '↑');
    this.sendBtn.addEventListener('click', () => {
      if (this.busy) {
        this.activeController?.abort();
      } else {
        void this.send();
      }
    });

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
  // preset selector (v0.5.0) — moved into the input card's tools row
  // -------------------------------------------------------------------------

  /** Build the preset dropdown inside `parent` (the input card's tools row). */
  private buildPresetBar(parent: HTMLElement): void {
    this.presetBarEl = parent.createDiv({ cls: 'ks-preset-bar' });
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

  /** Render a right-aligned capsule user bubble (dsh UserStyleBubble, r22px). */
  private userBubble(text: string): void {
    const root = this.scrollEl.createDiv({ cls: 'ks-chat-msg ks-chat-user' });
    const el = root.createDiv({ cls: 'ks-chat-content' });
    el.style.whiteSpace = 'pre-wrap';
    el.setText(text);
    // 底部 hover 显现时间（触屏常显）。
    root.createDiv({ cls: 'ks-chat-time' }).setText(this.nowLabel());
  }

  /** Render an assistant message: pure body (no model header, dsh has none),
   *  a hover-reveal timestamp and a hover-reveal IconActions row (clock + copy).
   *  Returns the markdown body container. */
  private assistantBubble(): { root: HTMLElement; body: HTMLElement } {
    const root = this.scrollEl.createDiv({ cls: 'ks-chat-msg ks-chat-ai' });
    const body = root.createDiv({ cls: 'ks-chat-content markdown-rendered' });
    // 消息操作行（dsh MessageIconActions）：copy 图标常显，clock（时间）hover 显现。
    const actions = root.createDiv({ cls: 'ks-chat-msg-actions' });
    actions.createSpan({ cls: 'ks-chat-time', text: this.nowLabel() });
    const copyBtn = actions.createEl('button', { cls: 'ks-chat-action ks-chat-copy-msg' });
    copyBtn.setAttribute('aria-label', '复制消息');
    this.setIconWithFallback(copyBtn, 'copy', '复制');
    copyBtn.addEventListener('click', () => this.copyText(this.aiMsgText(body), copyBtn, 'copy'));
    this.currentAiBody = body;
    return { root, body };
  }

  /** Plain text of an assistant message body: finalized cache when available,
   *  else the live text blocks of the current turn (summarizable while streaming). */
  private aiMsgText(body: HTMLElement): string {
    const cached = this.aiMsgTextCache.get(body);
    if (cached !== undefined) return cached;
    return joinTextBlocks(this.turnBlocks);
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
    this.lastErrorText = text;

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

  /** Copy `text` to the clipboard, keeping the UI under `btn` in sync (text
   *  button variant:「一键复制」↔「已复制」). */
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

  /** Icon-button copy variant (message / log copy): swap to a check glyph and
   *  restore `iconName` after 1.5s. */
  private copyText(text: string, btn: HTMLElement, iconName: string): void {
    const done = () => {
      btn.setText('');
      this.setIconWithFallback(btn, 'check', '✓');
      window.setTimeout(() => {
        btn.setText('');
        this.setIconWithFallback(btn, iconName, '复制');
      }, 1500);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done, () => this.clipboardFallback(text, btn));
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

  /** `setIcon` 后兜底：若渲染出的 svg 无可见绘制内容（icon 名不存在/字体缺失）
   *  或 computed color 为 transparent（某些主题下不可见），则退化为文本字形，
   *  确保按钮图标始终可见（dsh 风格白描图标）。 */
  private setIconWithFallback(btn: HTMLElement, name: string, glyph: string): void {
    btn.empty();
    setIcon(btn, name);
    const svg = btn.querySelector('svg');
    if (!this.iconVisible(svg)) btn.setText(glyph);
  }

  /** 校验一个 `setIcon` 产物是否可见：有可绘制子节点（lucide 描边路径）且
   *  computed color 非透明。供 `setIconWithFallback`/`setIconSafe` 共用。 */
  private iconVisible(svg: SVGElement | null): boolean {
    if (!svg) return false;
    const hasDrawable = !!svg.querySelector('path, rect, circle, polygon, line');
    if (!hasDrawable) return false;
    const color = getComputedStyle(svg).color;
    return color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
  }

  /** 非按钮图标的可见性兜底（思考块 chevron / 工具卡 wrench 等）：同
   *  `setIconWithFallback`，但传入 `glyph` 为空时不回退文本。 */
  private setIconSafe(container: HTMLElement, name: string, glyph: string): void {
    setIcon(container, name);
    const svg = container.querySelector('svg');
    if (!this.iconVisible(svg) && glyph) container.setText(glyph);
  }

  /** Toggle the send button between arrow-up (send), disabled (empty), and square (stop). */
  private updateSendBtn(): void {
    const btn = this.sendBtn;
    if (this.busy) {
      btn.disabled = false;
      this.setIconWithFallback(btn, 'square', '■');
      btn.addClass('ks-chat-send-stop');
      btn.setAttribute('title', '停止生成');
    } else {
      this.setIconWithFallback(btn, 'arrow-up', '↑');
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
      const streamLog = {
        startAtMs,
        ttfbMs: st.ttfbMs,
        firstEventMs: st.firstEventMs,
        chunks: st.chunks,
        events: st.events,
        url: st.url,
        model: this.plugin.settings.model,
        toolsCount: (tools || []).length,
      };
      this.lastStreamLog = streamLog;
      console.info('[ks-stream]', streamLog);
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

  /** Finalize an aborted partial turn: paint what streamed, drop the cursor,
   *  cache the message text for its copy button, then run the render check. */
  private finishStream(body: HTMLElement): void {
    this.streamState = 'done';
    this.hideStatus();
    this.renderAll();
    this.resolvePending();
    this.aiMsgTextCache.set(body, joinTextBlocks(this.turnBlocks));
    this.runRenderCheck(body);
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
      // v0.8.2：工具执行用「生效配置」——预设 outputConfig 覆盖后的 yamlRules/
      // modifyYamlRules/归档三配置/restrict 合并进 settings（未覆盖的用全局）。
      const effSettings: ToolCtx['settings'] = {
        ...this.plugin.settings,
        yamlRules: cfg?.yamlRules,
        modifyYamlRules: cfg?.modifyYamlRules,
        noteTemplate: cfg?.noteTemplate,
        modifyVersionSuffix: cfg?.modifyVersionSuffix,
        modifyVersionProperty: cfg?.modifyVersionProperty,
        modifyArchiveProperty: cfg?.modifyArchiveProperty,
        createRestrictYaml: cfg?.createRestrictYaml,
      };
      const ctx: ToolCtx = {
        app: this.plugin.app,
        settings: effSettings,
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
    this.aiMsgTextCache.set(body, joinTextBlocks(blocks));
    this.runRenderCheck(body);
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

  /** 结构调和（120ms 节流）：新块出现 / 工具卡 / 思考块 / 光标 / 滚动。**不再写文本
   *  内容**——文本块的 markdown 渲染统一由 `scheduleMarkdownRender`（180ms）或
   *  `settleTextMarkdown`（stop）完成，保证每个 `markdownEls[index]` 单一写入者。 */
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

  /** Coalesce structural renders to one 120 ms frame. */
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
      // 文本内容不在此写：仅在「已停/未 settle」时安排一次终稿渲染（其余由
      // scheduleMarkdownRender 节流写），保证单一写入者。
      if ((stopped || !!this.blockStopped[index]) && !this.blockSettled[index]) {
        this.settleTextMarkdown(index, block);
      }
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

  /** 单一写入者：`el.empty()` 后调 `MarkdownRenderer.render`（append 语义），
   *  杜绝「裸 Text 节点 + 渲染子节点」并存。已 settle 的块冻结不重渲。 */
  private paintMarkdownText(index: number, text: string): void {
    const el = this.markdownEls[index];
    if (!el?.isConnected || this.blockSettled[index]) return;
    el.empty();
    void MarkdownRenderer.render(this.app, text ?? '', el, '', this);
  }

  /** 流式 per-token 入口：只记数据（text 已存入 blk.text），触发节流 markdown 渲染。 */
  private refreshBlockText(index: number, text: string): void {
    this.scheduleMarkdownRender(index, text);
  }

  /**
   * 节流 markdown 渲染器：同一文本块 180ms 内只进行一次 `empty()` + 全量
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
      // 取触发时刻的最新文本（而非计划时快照），减少节流期间的滞后。
      const latest = this.turnBlocks[index]?.text ?? text ?? '';
      this.paintMarkdownText(index, latest);
    }, 180);
  }

  /** 块 content_block_stop：立即渲染终稿，并取消挂起的节流定时器。 */
  private settleTextMarkdown(index: number, block: AnthropicBlock): void {
    if (this.blockSettled[index]) {
      this.clearMarkdownTimer(index);
      return;
    }
    this.blockSettled[index] = true;
    this.clearMarkdownTimer(index);
    const el = this.markdownEls[index];
    if (!el?.isConnected) return;
    el.empty();
    void MarkdownRenderer.render(this.app, block.text ?? '', el, '', this);
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

  // --- thinking blocks (dsh ReasoningRow 复刻) -------------------------------
  // dsh：title「Think」+ chevron + 单行摘要（省略号）+ body 缩进 22px + running
  // 300px 扫光。经用户拍板，标题保留中文「思考中」。

  private ensureThinkingStructure(index: number, container: HTMLElement): void {
    if (this.thinkSubs[index]?.wrap.isConnected) return;
    const wrap = container.createDiv({ cls: 'ks-think is-collapsed' });
    const head = wrap.createDiv({ cls: 'ks-think-head' });
    const chev = head.createSpan({ cls: 'ks-think-icon' });
    this.setIconSafe(chev, 'chevron-right', '\u203A');
    head.createSpan({ cls: 'ks-think-title', text: '思考中' }); // 可折叠
    const summary = head.createSpan({ cls: 'ks-think-summary' });
    const body = wrap.createDiv({ cls: 'ks-think-body' });
    this.thinkExpanded[index] = null; // follow stream state until the user toggles
    wrap.addEventListener('click', () => {
      const collapsed = wrap.hasClass('is-collapsed');
      const newCollapsed = !collapsed;
      wrap.toggleClass('is-collapsed', newCollapsed);
      this.setIconSafe(chev, newCollapsed ? 'chevron-right' : 'chevron-down', newCollapsed ? '\u203A' : '\u2304');
      this.thinkExpanded[index] = !newCollapsed;
    });
    this.thinkSubs[index] = { wrap, chev, summary, body };
  }

  private updateThinking(index: number, thinking: string, stopped: boolean): void {
    const sub = this.thinkSubs[index];
    if (!sub?.wrap.isConnected) return;
    sub.summary.setText(thinkSummary(thinking));
    sub.body.setText(thinking);
    const streaming = !stopped && this.streamState === 'streaming';
    // Auto: expand while streaming (so the live reasoning shows), collapse when
    // done; a manual click overrides both.
    const override = this.thinkExpanded[index];
    const expanded = override != null ? override : streaming;
    sub.wrap.toggleClass('is-collapsed', !expanded);
    this.setIconSafe(sub.chev, expanded ? 'chevron-down' : 'chevron-right', expanded ? '\u2304' : '\u203A');
    sub.wrap.toggleClass('ks-think-streaming', streaming);
  }

  private refreshThinking(index: number, thinking: string): void {
    const sub = this.thinkSubs[index];
    if (!sub?.wrap.isConnected) return;
    sub.summary.setText(thinkSummary(thinking));
    sub.body.setText(thinking);
  }

  // --- tool_use cards --------------------------------------------------------

  private ensureToolStructure(index: number, container: HTMLElement, block: AnthropicBlock): void {
    if (this.toolSubs[index]?.card.isConnected) return;
    const card = container.createDiv({ cls: 'ks-tool-card' });
    const title = card.createDiv({ cls: 'ks-tool-name' });
    this.setIconSafe(title.createSpan({ cls: 'ks-tool-icon' }), 'wrench', '');
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

  // -------------------------------------------------------------------------
  // 渲染单份闭环检查（用户点名：输出后检查，有问题就循环修复）
  // -------------------------------------------------------------------------

  /** 递归检查 body 下每个 `.ks-chat-markdown`：① 直接子节点无非空裸 `#text`
   *  （markdown 渲染后应是元素子节点；裸文本 = 原文泄漏/未渲染）②「原文+渲染」
   *  并存（`children.length>0` 且首子为裸文本）——返回违规说明列表。
   *  注意：不校验 `textContent === 原文`——markdown 渲染后 textContent 是渲染文本，
   *  与源不同是正常现象；这里只检测「能否对应到单一来源」的回归。 */
  private validateSingleRender(body: HTMLElement): string[] {
    const violations: string[] = [];
    const mdEls = body?.querySelectorAll('.ks-chat-markdown') ?? [];
    for (let i = 0; i < mdEls.length; i++) {
      const el = mdEls[i] as HTMLElement;
      let bareText = '';
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === 3) {
          const t = (child.textContent ?? '').trim();
          if (t) bareText += t;
        }
      }
      if (bareText) {
        violations.push(`文本块#${i}: 存在非空裸文本「${bareText.slice(0, 30)}」（疑似原文泄漏）`);
      }
      if (el.children.length > 0 && el.firstChild?.nodeType === 3) {
        violations.push(`文本块#${i}: 原文+渲染并存（children=${el.children.length} 且首子=裸文本）`);
      }
    }
    return violations;
  }

  /** 在流结束（finishTurn / abort 后）调用：跑一遍渲染检查，记录 `lastRenderCheck`
   *  并输出 `[ks-render-check]`（无违规 info、有违规 warn），供闭环测试断言。 */
  private runRenderCheck(body: HTMLElement): void {
    const violations = this.validateSingleRender(body);
    this.lastRenderCheck = violations;
    if (violations.length === 0) {
      console.info('[ks-render-check]', '无违规');
    } else {
      console.warn('[ks-render-check]', violations);
    }
  }

  // -------------------------------------------------------------------------
  // 诊断日志复制（A.5）
  // -------------------------------------------------------------------------

  /** 打包全部诊断字段；apiKey 脱敏。字段来自 view 成员，缺失则显示「无」。 */
  private buildDiagnosticLog(): string {
    const settings = this.plugin.settings;
    const stream = this.lastStreamLog;
    const render = this.lastRenderCheck;
    const err = this.lastErrorText;
    const lines: string[] = [];
    lines.push('[Knowledge System 诊断日志]');
    // 版本号动态取当前插件 manifest，避免随版本迭代漏改硬编码值。
    const version = this.plugin.manifest?.version ?? '未知';
    lines.push(`版本: ${version}`);
    const model = (settings.model || '').trim();
    lines.push(`模型: ${model || '（未设置）'}${stream?.toolsCount != null ? `（toolsCount: ${stream.toolsCount}）` : ''}`);
    lines.push(`平台: ${Platform.isMobile ? '移动端' : '桌面'}`);
    lines.push(`Base URL: ${(settings.baseUrl || '').trim() || '（未设置）'}`);
    // 脱敏：不把 apiKey 打进日志。
    lines.push(`API Key: ${settings.apiKey ? '已配置(隐藏)' : '未配置'}`);
    lines.push('=== 最近一次流式 ===');
    lines.push(stream != null ? `[ks-stream]: ${JSON.stringify(stream)}` : '无');
    lines.push('=== 最近一次渲染检查 ===');
    lines.push(!render || render.length === 0 ? '[ks-render-check]: 无违规' : `[ks-render-check]: ${JSON.stringify(render)}`);
    lines.push('=== 最近一次错误 ===');
    lines.push(err || '无');
    return lines.join('\n');
  }

  /** 复制诊断日志到剪贴板（按钮短暂显示「已复制」）。 */
  private copyDiagnosticLog(): void {
    this.copyText(this.buildDiagnosticLog(), this.copyLogBtn, 'clipboard-copy');
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
        const r = await createNoteTool(ctx, { title: a.title, yaml: a.yaml, content: a.content, sections: a.sections });
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
      if (name === 'modify_output_note') {
        const r = await modifyOutputNoteTool(ctx, { name: a.name, sections: a.sections, yaml: a.yaml });
        return 'error' in r ? `ERROR: ${r.error}` : `已修改：${r.result.path}`;
      }
      if (name === 'modify_output_note_versioned') {
        const r = await modifyOutputNoteVersionedTool(ctx, { name: a.name, sections: a.sections, yaml: a.yaml });
        return 'error' in r ? `ERROR: ${r.error}` : `已修改（已归档）：${r.result.path}`;
      }
      if (name === 'read_output_note') {
        const r = await readOutputNoteTool(ctx, { name: a.name });
        return 'error' in r ? `ERROR: ${r.error}` : r.result.content;
      }
      return `ERROR: 未知工具 ${name}`;
    } catch (e) {
      return `ERROR: ${(e as { message?: string })?.message ?? '工具执行失败'}`;
    }
  }
}
