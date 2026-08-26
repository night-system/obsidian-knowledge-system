import { App, Component, Notice, TFile, setIcon } from 'obsidian';
import type { BasesView, BasesViewFactory, QueryController } from 'obsidian';
import type KnowledgeSystemPlugin from './main';
import { parseAfterDate, renderPromptTemplate } from './utils/review';

/**
 * v0.9.2：整理面板（Obsidian Bases 核心插件自定义视图）——与审核页（reviewView.ts）
 * 完全同构的 Bases 集成四件套：
 * 1) plugin.registerBasesView(viewId, registration) 注册自定义视图；
 * 2) 视图类实现 BasesView 形状（type + onDataUpdated，Component 生命周期）；
 * 3) .base 文件（YAML：filters + views[].type = viewId）定义数据源 = **源文件夹**；
 * 4) 自定义 CSS 类名渲染（styles.css 的 .ks-tidy-*）。
 *
 * 数据流：.base 文件的 filters 限定「源文件夹」（settings.sourceFolder），Bases
 * 查询把该文件夹所有 md 文件（含 frontmatter）交给视图（this.data.data:
 * BasesEntry[]）；视图在 onDataUpdated 里做两层过滤：
 * - 日期：file.stat.mtime（回退 ctime）>= afterDate 当天 00:00（解析失败/留空 = 不限）；
 * - bool 属性：frontmatter[tidyAttr] 缺失、null、空、或 String(值).toLowerCase()
 *   !== 'true' → 需要整理，显示；否则隐藏。
 * 每条提供「打开」（点击文件名）和「聊天」（message-square 图标 → openChatWith：
 * 应用设置里固定的预设 + 预填 tidyChatPrompt 模板渲染结果）。
 */
export const TIDY_VIEW_TYPE = 'ks-tidy';

/**
 * 生成整理面板 .base 文件内容（YAML）。
 * - filters：源文件夹非根（'/'）时用 `file.inFolder("<folder>")` 限定数据源
 *   （整理面板的数据源是源文件夹，不是输出文件夹）。
 * - views[].type = TIDY_VIEW_TYPE（Bases 用这个类型实例化我们的视图）。
 */
export function buildTidyBaseYaml(sourceFolder: string, tidyAttr: string): string {
  const folder = (sourceFolder || '/').replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const conditions: string[] = [];
  if (folder !== '/') conditions.push(`file.inFolder("${folder}")`);
  const lines: string[] = [];
  if (conditions.length > 0) {
    lines.push('filters:');
    lines.push('  and:');
    for (const c of conditions) lines.push(`    - ${c}`);
  }
  lines.push('views:');
  lines.push(`  - type: ${TIDY_VIEW_TYPE}`);
  lines.push('    name: 整理');
  lines.push('    order:');
  lines.push('      - file.name');
  lines.push(`      - note["${tidyAttr}"]`);
  return lines.join('\n') + '\n';
}

/** 整理面板路径（v0.9.2：由设置「整理面板位置」决定）。 */
function tidyBasePathOf(plugin: KnowledgeSystemPlugin): string {
  const p = (plugin.settings.tidyBasePath || '整理.base').replace(/\\/g, '/').trim();
  return p || '整理.base';
}

/** 确保整理面板（.base 文件）存在且内容与当前设置一致。 */
export async function ensureTidyBase(plugin: KnowledgeSystemPlugin): Promise<TFile | null> {
  const vault = plugin.app.vault;
  const path = tidyBasePathOf(plugin);
  const yaml = buildTidyBaseYaml(plugin.settings.sourceFolder, plugin.settings.tidyAttr);
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    try {
      const cur = await vault.read(existing);
      if (cur !== yaml) await vault.modify(existing, yaml);
    } catch {
      /* 读取失败就当作不存在重建 */
    }
    return existing;
  }
  try {
    const created = await vault.create(path, yaml);
    return created instanceof TFile ? created : null;
  } catch (e) {
    new Notice(`创建整理面板失败：${String(e)}`);
    return null;
  }
}

/** v0.9.2：按当前设置重新生成整理面板（已存在则覆盖重建一次）。 */
export async function regenerateTidyBaseFile(plugin: KnowledgeSystemPlugin): Promise<TFile | null> {
  const vault = plugin.app.vault;
  const path = tidyBasePathOf(plugin);
  const yaml = buildTidyBaseYaml(plugin.settings.sourceFolder, plugin.settings.tidyAttr);
  try {
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await vault.modify(existing, yaml);
      return existing;
    }
    const created = await vault.create(path, yaml);
    return created instanceof TFile ? created : null;
  } catch (e) {
    new Notice(`重新生成整理面板失败：${String(e)}`);
    return null;
  }
}

/**
 * 整理视图：列出源文件夹中、afterDate 之后修改/创建、且 bool 属性
 * 缺失/非 true 的文件；每条可「打开」或「聊天」。
 * 不 extends BasesView 抽象类（Bases 在工厂返回后注入 app/config/data），
 * 实现相同形状即可，工厂里 cast（与 ReviewBasesView 同款做法）。
 */
export class TidyBasesView extends Component {
  type = TIDY_VIEW_TYPE;
  app: App;
  config: unknown;
  allProperties: string[] = [];
  data: { data: { file?: TFile }[] } | null = null;

  private containerEl: HTMLElement;
  private plugin: KnowledgeSystemPlugin;

  constructor(controller: QueryController, containerEl: HTMLElement, plugin: KnowledgeSystemPlugin) {
    super();
    void controller;
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.app = plugin.app;
  }

  onload(): void {
    this.containerEl.addClass('ks-tidy-view');
    this.render();
  }

  /** Bases 查询结果变化（vault 文件/frontmatter 变化）时自动重渲染。 */
  onDataUpdated(): void {
    this.render();
  }

  private render(): void {
    this.containerEl.empty();

    // 头部：标题 + 刷新按钮（预设由设置固定，无下拉——与审核页不同）。
    const head = this.containerEl.createDiv({ cls: 'ks-tidy-head' });
    head.createSpan({ cls: 'ks-tidy-title', text: '整理' });
    const refreshBtn = head.createEl('button', { cls: 'clickable-icon ks-tidy-refresh', attr: { 'aria-label': '刷新', 'title': '刷新' } });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.render());
    head.createSpan({ cls: 'ks-tidy-hint', text: '点击笔记标题打开文件；点击聊天图标用设置里的预设进入聊天并引用此文件。把「bool 属性」设为 true 后文件会从这里消失。' });

    // 列表：只显示 afterDate 之后修改/创建、且 bool 属性缺失或非 true 的文件。
    const tidyAttr = (this.plugin.settings.tidyAttr || '').trim();
    const afterMs = parseAfterDate(this.plugin.settings.tidyAfterDate);
    const list = this.containerEl.createDiv({ cls: 'ks-tidy-list' });
    const entries = this.data?.data ?? [];
    let count = 0;
    for (const entry of entries) {
      const file = entry.file;
      if (!file) continue;
      if (afterMs !== null) {
        const mtime = (file.stat && file.stat.mtime) || file.stat.ctime || 0;
        if (mtime < afterMs) continue;
      }
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (tidyAttr) {
        const raw = fm?.[tidyAttr];
        // bool 属性缺失、null、空、或值（字符串化、忽略大小写）非 'true' → 需要整理。
        const isDone = raw !== undefined && raw !== null && raw !== '' && String(raw).toLowerCase() === 'true';
        if (isDone) continue;
      }
      count++;

      const row = list.createDiv({ cls: 'ks-tidy-item' });
      const info = row.createDiv({ cls: 'ks-tidy-item-info' });
      const nameEl = info.createDiv({ cls: 'ks-tidy-item-name', text: file.basename });
      // 点击标题直接打开笔记（与审核页一致：必须用 getLeaf('tab')，Bases 视图
      // 上下文里 getLeaf(false) 会抛「e.getEphemeralState is not a function」）。
      nameEl.addEventListener('click', () => {
        void this.app.workspace.getLeaf('tab').openFile(file);
      });

      const ops = row.createDiv({ cls: 'ks-tidy-item-ops' });
      // 聊天图标按钮（lucide messages-square，与审核页同款）——用「聊天 prompt
      // 模板」替换 {{filename}} → file.basename（不含路径、不含 .md），把**最终
      // prompt 文本**传给聊天视图，预设用设置里固定的 tidyChatPresetId。
      const chatBtn = ops.createEl('button', { cls: 'clickable-icon ks-tidy-chat', attr: { 'aria-label': '聊天', 'title': '聊天' } });
      setIcon(chatBtn, 'messages-square');
      chatBtn.addEventListener('click', () => {
        const template = (this.plugin.settings.tidyChatPrompt || '').trim()
          || '请查看「{{filename}}」并帮我整理，然后把它标记为完成。';
        const prompt = renderPromptTemplate(template, file.basename);
        void this.plugin.openChatWith(prompt, this.plugin.settings.tidyChatPresetId || undefined);
      });
    }
    if (count === 0) {
      list.createDiv({ cls: 'ks-tidy-empty', text: '源文件夹里没有需要整理的文件' });
    } else {
      list.createDiv({ cls: 'ks-tidy-count', text: `共 ${count} 个需要整理的文件` });
    }
  }

  // v0.9.10 bug 修复：视图生命周期安全空实现——Obsidian（尤其移动端）在 leaf
  // 切换/setViewState/关闭时会对视图实例调用 getEphemeralState/focus 等 View 方法；
  // 本类只 extends Component（TaskNotes 形状），缺省会抛 TypeError → 弹 Notice
  // 「e.getEphemeralState is not a function」/「n.focus is not a function」。
  getEphemeralState(): unknown {
    return {};
  }

  setEphemeralState(state: unknown): void {
    void state;
  }

  focus(): void {
    /* no-op */
  }

  onResize(): void {
    /* no-op（Bases 内部视图用 ResizeObserver 调用渲染对象的 onResize，缺省会抛
       TypeError → Notice「e.onResize is not a function」） */
  }
}

/** 注册整理视图到 Bases（Obsidian 1.10.0+ 公开 API）；false = Bases 未启用。 */
export function registerTidyBasesView(plugin: KnowledgeSystemPlugin): boolean {
  if (typeof plugin.registerBasesView !== 'function') return false;
  try {
    const factory = ((controller: QueryController, containerEl: HTMLElement) =>
      new TidyBasesView(controller, containerEl, plugin)) as unknown as BasesViewFactory;
    return plugin.registerBasesView(TIDY_VIEW_TYPE, {
      name: '整理',
      icon: 'list-todo',
      factory,
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes('already exists')) return true;
    return false;
  }
}

/** 注销整理视图（公开 API 无 unregister，用内部 registrations 删除，TaskNotes 同款）。 */
export function unregisterTidyBasesView(app: App): void {
  try {
    const internal = (app as unknown as { internalPlugins?: { getEnabledPluginById?: (id: string) => { registrations?: Record<string, unknown> } | null } }).internalPlugins;
    const bases = internal?.getEnabledPluginById?.('bases');
    if (bases?.registrations) delete bases.registrations[TIDY_VIEW_TYPE];
  } catch {
    /* 忽略：Bases 不可用时无需注销 */
  }
}

// 引用类型，确保 BasesView 形状演进时编译期校验（不实例化）。
export type { BasesView };
