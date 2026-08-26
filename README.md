# obsidian-knowledge-system

配置驱动的 AI 知识系统框架。v0.8.0：**聊天/设置界面图标彻底修复**（先 CDP 实测 Obsidian lucide 图标名：`clipboard-copy`/`square`/`check`/`chevron-*`/`wrench`/`search`/`trash-2`/`x`/`copy`/`arrow-up` 全部可用；再把 `setIcon` 兜底从「仅子节点」升级为「子节点 + color 非透明」，任何主题/任何 Obsidian 版本都可见）+ **预设 UI 布局调整**（**工具启用开关移到折叠头部右侧**——不展开也能开关；**展开 chevron 移左、删除键移右分离**，移动端防误触；设「启用该工具」映射 `enabledTools`、chevrion 仍折叠，功能不变）。v0.7.0：**预设可折叠 + 每工具独立折叠配置**（工具参数逐项解释）；**update_note_yaml 阉割版**（可配置可修改属性+可选值+多行解释，越界拒绝）；**create_note 标题模板**（配置标题级别/是否允许 AI 写/解释，AI 只能写允许的标题，正文按模板组装）；**聊天 icon 可见性修复**（color 主题回退，任何主题可见）。v0.6.0：**聊天 UI 一比一复刻 dsh**（输入卡片改列式：textarea 上 + 按钮行下；预设选择器移入卡内左工具区、删除测试按钮、发送按钮 icon 兜底可见 + 思考块复刻 ReasoningRow 单行摘要/22px 缩进/AI 消息去头行 + 消息操作行 copy 按钮）+ **修复「渲染两份（原文+markdown）」**（单一写入者：文本块一律先 `empty()` 再 `MarkdownRenderer.render`，`renderAll` 不再写文本内容）+ **日志复制按钮**（聊天页「复制诊断日志」打包最近流式/渲染检查/错误，apiKey 脱敏）+ **渲染单份闭环检查**（流结束自动 `[ks-render-check]`）。v0.5.0：**流式期间直接渲染 markdown**（180ms 节流，第一次输出就是 markdown）+ **首 token（TTFT）检测点**（`[ks-stream]` 增 `ttfbMs`/`firstEventMs`）+ **聊天 UI 认真照抄 dsh**（用户气泡胶囊 / 无边框 AI 叙述 / 输入卡片 22px / 时间戳 hover 显现 / 流式状态行 shimmer / 思考块扫光）+ **默认模型建议标注**；v0.4.0 实现**真正逐字流式渲染**：改为**边读边解析边渲染**（增量 SSE 解析器 + 120ms 节流 + 持久容器低闪烁增量 DOM），AI 回复逐词冒出、不再「一大段一大段出现」，并升级**聊天 UI**（气泡化输入条、lucide 图标、AI/模型徽标、流式光标、思考块闪烁、移动端触控）；`create_note` 支持**属性规则**配置（见设置页）。v0.3.2 增加 **Base URL 端点自动探测**：聊天端点自动探测 `/anthropic` 前缀（DeepSeek 官方 `https://api.deepseek.com/anthropic`），模型列表自动探测根端点，404 时**自动纠偏并回写设置**，并在聊天页显示**一键可复制的诊断错误**。v0.3.1 接入 **Anthropic 兼容协议**（`POST {baseUrl}/v1/messages`，`x-api-key`）、**内置工具集**（`list_recent_notes` / `read_note` / `create_note`）、**AI 聊天视图**与「测试任务」按钮；聊天用**原生 `fetch` 流式**（桌面 Electron + 移动端 WebView 均可，端点 CORS 已放行），**兼容性不佳时自动降级为非流式**（`requestUrl` + `stream:false`）；v0.2.0 起还含独立**设置视图**、**动态输出属性**、**测试工具**标签页。

---

## 功能简介

- **AI 聊天视图**：命令面板 "Open Knowledge System chat" 在中间标签页打开聊天，气泡式用户/助手消息，助手用 markdown 渲染，**thinking 块可折叠**，**tool_use 工具卡片**（名称 + 参数摘要 + 结果），支持多轮 tool_use/tool_result 往返，出错在 UI 内显示错误气泡。**真正逐字流式渲染 + 流式期间直接 markdown（v0.5.0）**（`stream:true` 时用增量 SSE 解析器**边读边解析边渲染**，AI 回复逐词冒出；文本块流式期间用 **180ms 节流 MarkdownRenderer 直接渲染 markdown**——**第一次输出就是 markdown**，块结算时立即渲染终稿并冻结，不再「先纯文本、结束后才变 markdown」）；**非流式/不支持自动回退 `requestUrl` 非流式**（复用同一 UI 渲染）。
- **聊天 UI 美化（v0.4.0）**：输入条**卡片化**（带边框圆角 + 圆形发送/停止钮 `interactive-accent` + 测试钮）+ 输入框透明无边框自动增高（`font-size:16px` 防 iOS 缩放）；消息带 **AI/模型徽标**（lucide `bot` 图标）与「你」头行；**流式光标**（`|` 闪烁）在 AI 生成时显示；**思考块**流式时 body 尾加闪烁「…」（lucide `brain` 图标）；移动端收紧间距并放大按钮触控；一律使用 Obsidian 变量与 lucide 图标（无 emoji、无硬编码颜色）。
- **聊天 UI 认真照抄 dsh（v0.5.0）**：**用户气泡**右对齐胶囊（r22px、蓝底 `--background-modifier-hover` 主题自适应、padding 10/16、font 16/24、`max-width:min(525px,82%)`）；**AI 消息**无气泡/无边线/无头像、全栏宽纯文本叙述（font 16/28）；消息列 `max-width:748px; margin:0 auto; gap:16px`；输入卡片 `border-radius:22px` + 1px 边框 + 阴影；发送钮 34×34 圆（`interactive-accent`，disabled opacity .4）；**消息时间戳** `font 14/24`、`--text-faint`、hover 才显现（80ms，触屏常显）；**AI 流式状态行**（输入栏上方，蓝色 shimmer）；**思考块 running 态 300px 扫光**；保留流式光标（用户已习惯）与之并存。
- **聊天 UI 一比一复刻 dsh（v0.6.0）**：**输入卡片改列式**（textarea 上 + 按钮行下，22px 圆角/1px 边框/阴影，gap 12px）；**预设选择器移入卡内左工具区**（`.ks-chat-input-tools` 小下拉，含「默认（全部工具）」+ 各预设，onChange 沿用）；**删除测试按钮**；**发送按钮 icon 兜底可见**（`stroke: currentColor` + icon 名缺失时退化文本 ↑/■）；**思考块复刻 dsh ReasoningRow**（chevron + 标题「思考中」+ **单行摘要省略** + body 缩进 22px + running 300px 扫光）；**AI 消息去头行**（无「AI · 模型名」）；**消息操作行 hover 显现**（`clock` 时间 + `copy` 复制该消息纯文本，28px 圆 hover 高亮）。
- **修复「渲染两份（原文+markdown）」（v0.6.0，核心）**：文本块 `markdownEls[index]` 改为**单一写入者**——流式用 `scheduleMarkdownRender`（180ms 节流）、块结算用 `settleTextMarkdown`，一律**先 `empty()` 再 `MarkdownRenderer.render`**（render 为 append 语义），杜绝「裸 Text 节点 + 渲染子节点」并存；`refreshBlockText` 不再直接写 DOM（只记数据），`renderAll`（120ms）只负责结构调和（新块/工具卡/思考块/光标/滚动）、**不再写文本内容**；并新增**渲染单份闭环检查** `[ks-render-check]`（流结束自动跑，有违规 `console.warn`）。
- **日志复制按钮（v0.6.0）**：聊天页输入卡左工具区新增「复制诊断日志」按钮（lucide `clipboard-copy`），一键打包最近一次流式 `[ks-stream]`、最近一次渲染检查 `[ks-render-check]`、最近一次错误，含版本/模型/平台/Base URL；**apiKey 脱敏**（「已配置(隐藏)」/「未配置」）。
- **首 token（TTFT）检测点（v0.5.0）**：`[ks-stream]` 增加 `ttfbMs`（首个成功候选 fetch 返回响应头，≈网络首字节）、`firstEventMs`（首个 SSE 事件，≈首个 token 到达）、`model`、`toolsCount`；**默认模型建议**：模型下拉名标注 `deepseek-v4-flash（最快）` / `deepseek-v4-pro（质量）`。**首 token 慢多半是 iOS 网络栈缓冲**（服务端 TTFB ≤0.5s，慢在客户端）；反馈首 token 慢问题时请附 DevTools 的 console `[ks-stream]` 输出。
- **Anthropic 兼容协议**：调用 `POST {settings.baseUrl}/v1/messages`，请求头 `x-api-key: <key>` + `anthropic-version: 2023-06-01`；`baseUrl` 默认 `https://api.deepseek.com/anthropic`。
- **内置工具集**（供 AI 调用）：`list_recent_notes`（浏览源文件夹最近笔记）、`read_note`（读取笔记正文，去 YAML）、`create_note`（在输出文件夹创建笔记，防路径穿越）。
- **测试任务按钮**：在聊天视图一键发送内置中文 prompt，要求 AI 依次调用 `list_recent_notes → read_note → create_note`。
- **一键配置 DeepSeek**：在【连接】标签页填写 API Key，点击「测试并获取模型」调用模型列表接口（先 `/models`，回退 `/v1/models`），填充模型下拉框。**模型列表完全来自接口，不硬编码**。
- **源/输出文件夹**：支持输入框 + 文件夹选择器（Obsidian 原生 Suggest）。
- **自定义时间属性 / 最早时间**：可配置读取文件时间的 frontmatter 属性名与 moment 格式；新增**最早时间**限制 AI 工具可见范围。
- **动态输出属性**：输出属性为键值对，可增删；时间戳、来源为固定行。
- **独立设置视图**：命令面板 "Show Knowledge System settings view" 打开同设置 UI。
- **测试工具标签页**：设置页第 5 个标签页一键执行「统计最近文件数」「输出最新内容测试」。
- **工具预设系统 + 两个新工具（v0.5.0）**：新增 **第 6 个「预设」标签页**，可把「启用的工具子集」「工具参数覆写（如 list_recent_notes 天数、禁用 create_note、search 模式）」「自定义系统提示词」保存成预设并在**聊天界面**用下拉选择器随时切换（切换后下次请求生效）。新增工具 `update_note_yaml`（更新源文件夹笔记指定 frontmatter 值，**默认不暴露**，可在全局开关中开启）与 `search_output_notes`（在输出文件夹按「包含匹配」搜索，支持完整/阉割两种模式）。同时「AI 创建属性规则」的可选值改为**逐个 tag/chip 输入**（回车添加、× 删除、自动去重），并把该分组**上移到「输出属性」页顶部**、更名为「AI 创建属性规则（create_note 默认值与约束）」以便发现。
- **预设可折叠 + 每个工具单独折叠（新增）**：设置 → 预设 页的每份预设**默认折叠收起**（v0.8.0 头部布局 = 左展开 chevron + 中间名称输入 + 右删除，删除与展开键分离防移动端误触）；展开后**每个工具**（list_recent_notes / read_note / create_note / update_note_yaml / search_output_notes）各有**独立折叠区**，折叠区标题向用户解释该工具的参数；**启用开关（v0.8.0）移到折叠头部右侧**——不展开也能开关，映射到工具白名单（`enabledTools`），点击不触发折叠；其余参数配置在折叠体内。自定义系统提示在预设展开体内。
- **update_note_yaml 阉割版（新增）**：设置 → 输出属性 页新增「**AI 修改属性规则（update_note_yaml）**」分组，与「AI 创建属性规则」并列。每条规则 = 属性名 + **解释（用大文本框写清该属性及各可选值的含义）** + 可选值（tag 输入，留空=任意）；仅当全局开关「暴露 update_note_yaml 工具」开启时生效；AI 只能修改这些属性，值必须在允许范围内（越界拒绝，不写盘）。
- **create_note 模板 / 标题控制（新增）**：设置 → 输出属性 页新增「**AI 创建模板（create_note 正文结构）**」分组。定义标题模板（标题文本 + 级别 H1/H2/H3… +「允许 AI 写」toggle + 解释，支持上移/下移/删除 + 实时预览）。AI 创建笔记时 `content` 参数改为 `sections`（每个「允许 AI 写」的标题 = 必填参数名，解释 = 该标题的 description）；创建时按模板顺序组装正文（不允许 AI 写的标题如大标题由模板固定输出，AI 只能在允许的标题下写）。**至少一个「允许 AI 写」标题才生效**；未配置模板则保持原样（自由正文）。

---

## 安装

### 方式一：BRAT（推荐）

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件。
2. 打开 BRAT，选择 **Add Beta plugin**，粘贴仓库地址：

   ```
   https://github.com/night-system/obsidian-knowledge-system
   ```

3. 添加后，在 设置 → 第三方插件 中启用 **obsidian-knowledge-system**。

### 方式二：手动

将以下三个文件放入 vault 的插件目录（没有则新建）：

```
<你的 vault>/.obsidian/plugins/obsidian-knowledge-system/
  ├── main.js
  ├── manifest.json
  └── styles.css
```

然后在 设置 → 第三方插件 中启用。

---

## 使用步骤

设置页顶部为 **Tab 布局**（`连接` / `文件夹` / `时间` / `输出属性` / `测试工具`），每个标签页内的设置沿用"分组折叠 + 顶部搜索"：点击分组标题可折叠/展开，搜索框按设置项名称与描述实时过滤当前标签页的条目。

1. 打开 **设置 → obsidian-knowledge-system**（或在命令面板运行 **Show Knowledge System settings view** 以标签页打开独立设置视图）。
2. 在【连接】标签页填写 **API Key**（Anthropic 兼容的 `x-api-key`），点击 **测试并获取模型**，从下拉框选择默认模型。
3. 在【文件夹】标签页设置 **源文件夹**（AI 工具只读这里）和 **输出文件夹**（AI 工具只写这里）。
4. 在【时间】标签页设置 **时间属性名**、**时间戳格式**、**最近 N 天**、**最早时间**。
5. 在【输出属性】标签页设置 **时间戳属性名**、**来源属性名**，并在动态键值对行中添加"属性名 → 默认值"，或点击 **+ 添加属性** 新增。
6. 在【测试工具】标签页点击 **统计最近文件数** 或 **输出最新内容测试**。
7. 在命令面板运行 **Open Knowledge System chat** 打开聊天视图；点击 **测试任务** 按钮体验内置工具调用（`list_recent_notes → read_note → create_note`）。

---

## 设置项说明

### 连接（标签页）

| 名称 | 说明 | 默认值 |
|---|---|---|
| API Key | Anthropic 兼容服务的 API Key（`x-api-key`，掩码显示）。 | 空 |
| 测试并获取模型 | 调用模型列表接口（先 `/models`，回退 `/v1/models`）填充下拉框；401/403"API Key 无效"，402"余额不足"，429"限流"。 | — |
| 默认模型 | 可用的模型列表，来自服务商接口（不硬编码）。 | 空 |

### 自定义服务商（连接标签页内，默认折叠）

| 名称 | 说明 | 默认值 |
|---|---|---|
| Base URL | Anthropic 兼容服务的基础地址。 | `https://api.deepseek.com/anthropic` |
| API Key | 自定义服务商的 API Key（预留）。 | 空 |
| 模型 | 自定义服务商的模型 ID（预留）。 | 空 |

### 文件夹（标签页）

| 名称 | 说明 | 默认值 |
|---|---|---|
| 源文件夹 | 统计最近文件数时扫描的文件夹。 | `/` |
| 输出文件夹 | 输出最新内容测试生成文件的文件夹。 | `/` |

### 时间（标签页）

| 名称 | 说明 | 默认值 |
|---|---|---|
| 时间属性名 | 读取文件时间使用的 frontmatter 属性名；留空则用文件创建时间。 | 空 |
| 时间戳格式 | moment 兼容的时间格式（如 `YYYY-MM-DD`）。 | `YYYY-MM-DD` |
| 最近 N 天 | 统计最近文件数时回看的天数。 | `7` |
| 最早时间 | AI 工具只查看不早于该时间的笔记（按时间戳格式解析）；空=不限。 | 空 |

### 输出属性（标签页）

输出时 frontmatter 由**固定行**与**动态键值对**组成：

| 名称 | 说明 | 默认值 |
|---|---|---|
| 时间戳属性名 | 写入输出文件的当前时间戳属性名（固定行）。 | `created` |
| 来源属性名 | 写入输出文件的来源路径属性名（固定行）。 | `source` |
| （动态行）属性名 | 输出文件的 frontmatter 属性名（键值对，可添加/删除）。 | — |
| （动态行）默认值 | 该属性写入输出的默认值。 | — |
| + 添加属性 | 新增一条"属性名 → 默认值"行。 | — |

> 旧版 `审核状态属性名/默认值` 与 `分类属性名/默认值` 会在首次加载时自动迁移到上面的动态行（`approved → 未审`、`category → 未分类`）；旧字段仍保留读取兼容。

#### AI 创建属性规则（create_note 默认值与约束，v0.4.0 → v0.5.0）

设置 → 输出属性 页（该分组已**上移到页顶**、标题为「**AI 创建属性规则（create_note 默认值与约束）**」）可配置「**AI 创建属性规则**」：每条规则 = frontmatter **属性键名 + 解释 + 可选值列表 + 默认值**。

- 这些规则会随 `create_note` 工具的描述与 JSON Schema（`enum`）一并传给 AI，约束它在 frontmatter 中填写的值——**超出可选值会被拒绝创建**（错误回给 AI 修正，不落盘）。
- AI 未填某键而配置了**默认值**时，创建时**自动补上**；默认值支持 **`{{YYYY.MM.DD}}` 等 moment 模板**（`{{}}` 内为 moment 兼容格式，创建当天自动渲染）。
- 规则之外的键名 AI 仍可随意添加（不校验、不过滤）。
- **可选值改为逐个 tag 输入**：在「可选值」输入框键入后按 **回车** 添加为一个 chip（旁边带 **×** 删除），同值自动去重，显示顺序 = 添加顺序；不再用逗号分隔。

| 字段 | 说明 |
|---|---|
| 属性名 | frontmatter 键名（如 `category`、`approve`）。 |
| 解释 | 该属性的含义说明，随工具描述传给 AI（如「文件的类型分类」）。 |
| 可选值 | 逐个 tag 添加的可选值列表（回车添加 / ×删除 / 自动去重）；**留空 = 任意值**（不校验）。 |
| 默认值 | AI 未填写该键时自动补的值（即「AI 未填此键时创建文件自动插入的值，支持 {{YYYY.MM.DD}}；留空=不插入」）。 |

示例：`approve`（解释「审核状态」，可选值 `未审核、已审核`，默认值 `未审核`）→ AI 未写时自动加 `approve: 未审核`；AI 写「未审核/已审核」允许，写其它值则拒绝创建。

#### AI 修改属性规则（update_note_yaml）

设置 → 输出属性 页（标题「**AI 修改属性规则（update_note_yaml）**」）可配置「AI 只能修改哪些 frontmatter 属性」：每条规则 = **属性名 + 解释（大文本框）+ 可选值列表**。

- 仅当全局开关「暴露 update_note_yaml 工具」开启时生效。
- AI 使用 `update_note_yaml` 时只能修改这些属性，值必须在对应可选值内；**越界会被拒绝（不写盘）**，错误回给 AI 修正。
- 可选值**留空 = 任意**（不校验）；未配置任何规则时维持原样（任意键均可改）。

| 字段 | 说明 |
|---|---|
| 属性名 | frontmatter 键名（如 `status`）。 |
| 解释 | 用**大文本框**写清该属性及各可选值的含义，将随工具描述传给 AI。 |
| 可选值 | 逐个 tag 添加的可选值列表（回车添加 / ×删除 / 自动去重）；**留空 = 任意值**。 |

#### AI 创建模板（create_note 正文结构）

设置 → 输出属性 页（标题「**AI 创建模板（create_note 正文结构）**」）可定义 `create_note` 输出的**正文模板**：每行 = 标题文本 + 级别（H1/H2/H3…）+「允许 AI 写」toggle + 解释（大文本框），支持上移/下移/删除，并**实时预览**组装结果。

- **至少一个「允许 AI 写」标题才生效**；未配置模板则保持原样（自由正文）。
- AI 创建笔记时 `content` 参数改为 **`sections` 对象**：每个「允许 AI 写」的标题 = 一个必填参数（参数名 = 标题文本，说明 = 该标题的解释），值为该标题下的文字。
- 不允许 AI 写的标题（如「大标题」）由模板固定输出，AI 不能在下面写；正文按模板顺序组装。

| 字段 | 说明 |
|---|---|
| 级别 | H1/H2/H3…（对应 `#`/`##`/`###`）。 |
| 标题文本 | 该标题的文字（如「简介」）。 |
| 允许 AI 写 | 是否允许 AI 在该标题下写内容。 |
| 解释 | 该标题下的内容要求（AI 可见）；仅在「允许 AI 写」时随工具描述传给 AI。 |

### 测试工具（标签页）

| 名称 | 说明 |
|---|---|
| 统计最近文件数 | 扫描源文件夹，统计最近 N 天内的 Markdown 文件数，以 Notice 提示。 |
| 输出最新内容测试 | 取源文件夹时间最新的文件，将其正文最后 100 个字符（按 Unicode 字符计，含换行）写入输出文件夹，并生成含可配置属性名的 frontmatter。 |

### 预设（标签页，第 6 个标签页）

「工具预设」把一组「工具配置」保存成预设，并在聊天界面用下拉选择器随时切换。**每份预设默认折叠收起**（头部 = 名称输入 + 展开箭头 + 删除按钮），展开后可编辑：

| 字段 | 说明 |
|---|---|
| 名称 | 预设显示名（聊天选择器里显示，在预设头部直接编辑）。 |
| 系统提示词 | 随预设绑定的自定义系统提示；留空 = 默认（不发送 system）。 |
| （每个工具一个折叠区） | 每个工具（list_recent_notes / read_note / create_note / update_note_yaml / search_output_notes）一个**默认折叠**的配置区；折叠区标题向用户解释该工具的参数。 |
| 启用该工具（toggle） | 每个工具折叠区顶部的「启用该工具」开关，映射到工具白名单（`enabledTools`）；关闭 = 从本预设移除该工具。 |
| list_recent_notes 天数 | 折叠区内「回看天数」，覆写其 `days`；留空 = 用「时间」页的「最近 N 天」。 |
| search_output_notes 模式 | 折叠区内「搜索模式」：完整版（AI 按任意键搜索）/ 阉割版（只能按下方限定键搜索）。 |
| 阉割版限定键 | search 为阉割版时的限定键 + 可选值（chip 填写；留空 = 任意值）。 |

> **全局开关**：设置 → 预设 页可打开「暴露 update_note_yaml 工具」以向 AI 暴露 `update_note_yaml`（默认关闭）；`update_note_yaml` 折叠区的「启用该工具」切换的是该预设是否纳入，实际对 AI 暴露还须全局开关开启。聊天界面输入栏上方的**预设下拉选择器**切换当前预设（默认「默认（全部工具）」= 全部工具 + 设置里的 yaml 规则），切换后**下次请求生效**。

---

## 命令

命令面板仅保留两项（打开设置视图、打开聊天视图）：

| ID | 名称 | 作用 |
|---|---|---|
| `show-knowledge-system-settings-view` | Show Knowledge System settings view | 以普通标签页打开设置视图。 |
| `open-knowledge-chat-view` | Open Knowledge System chat | 以中间标签页打开 AI 聊天视图。 |

> 原先的「统计最近文件数」「输出最新内容测试」已移至【测试工具】标签页，命令面板不再注册。

> 输出的文件 frontmatter 示例：

```yaml
---
created: 2026-08-25
approved: 未审
category: 未分类
source: notes/example.md
---
（源文件正文最后 100 个字符）
```

---

## 移动端说明

- `isDesktopOnly: false`，可在 Obsidian 移动端运行。
- **移动端支持流式（浏览器直连）**：聊天用原生 `window.fetch`（`stream:true`，端点头 `anthropic-dangerous-direct-browser-access: true`，CORS 已放行）；若 `fetch` 流式失败/不支持，自动降级为 `requestUrl` 非流式（`stream:false` + `parseAnthropicResponse`），两者复用同一 UI 渲染。
- 网络请求仅使用 Obsidian 原生 `requestUrl` 通道，不依赖 `fetch` 或 Node 的 `http` / `fs` / `path`。
- 文件夹选择器使用 Obsidian 原生 `AbstractInputSuggest`（设置页、命令、Notice 在移动端均正常）。
- 不使用任何桌面端专属 API，也不引入运行时依赖。

---

## 已知问题与兼容说明（v0.3.2）

- **Base URL 填 `https://api.deepseek.com` 或 `https://api.deepseek.com/anthropic` 均可**：聊天端点自动探测 `/anthropic` 前缀，模型列表自动探测根端点，404 时自动纠偏并在聊天页显示**一键可复制的诊断错误**。
- 若你的服务商把 Anthropic 兼容聊天端点挂在根路径（非 `/anthropic` 前缀），插件会按原样请求 `{base}/v1/messages`，不会强行补 `/anthropic`（避免破坏自建网关）。
- 当探测发现「设置里少了 `/anthropic` 前缀、但 `/anthropic` 端点为成功候选」时，插件会弹 Notice「已自动更正端点：…」，并把设置里的 Base URL 同步更新为含 `/anthropic` 的版本；若你用的是自建网关（根路径本就能 200），不会触发此纠偏。
- 诊断错误块包含流式/非流式的状态码与实际请求的完整 URL，以及针对性的提示，便于定位网络/密钥/模型名问题。

---

## 更新日志

### v0.8.0（聊天/设置界面图标彻底修复 + 预设 UI 布局调整）
- **聊天/设置界面图标彻底修复（A）**：先 CDP 实测 Obsidian lucide 图标名——`clipboard-copy` / `arrow-up` / `copy` / `check` / `square` / `chevron-right` / `chevron-down` / `chevron-up` / `wrench` / `search` / `trash-2` / `x` 在 Obsidian 1.13.7 **全部渲染出可绘制 svg**（子节点 + 非透明 color），**无一处无效图标名**（「clipboard-copy 不在子集」假设不成立）。再把 `setIcon` 兜底从「仅看 svg 是否有子节点」升级为「**子节点 + computed color 非透明**」双条件（`iconVisible`），新增非按钮图标兜底 `setIconSafe`（思考块 chevron / 工具卡 wrench / 设置页 search / 分组 / tag-x / 模板 op / 预设 chevron / 删除键），任何 Obsidian 版本/主题下图标不会再静默消失或透明不可见。
- **预设 UI 布局调整（A）**：① **工具启用开关移到折叠头部右侧**——每个 `ks-tool-config` 折叠区不再把「启用该工具」toggle 放进折叠体内，而是放头部行（左 chevron + 工具名 + **右 toggle**，用 Obsidian `ToggleComponent` 紧凑渲染，点击开关用 `stopPropagation` 防止误触发展开/收起，不展开也能开关）；② **预设项头部重排**——展开 chevron 移**最左**、名称输入 `flex:1` 居中、删除键移**最右**（与展开键分离，移动端防误触）；③ CSS 对齐 version-manager 简化写法（图标元素 `color` + `inline-flex` 居中，`svg` 层面仅留 `fill:none`，`stroke: currentColor` 交由 lucide 自带），保留主题回退变量；`enabledTools` 映射 / chevron 折叠语义/预设折叠**完全不变**。
- **版本**：`manifest.json` / `package.json` = `0.8.0`；`versions.json` 增 `"0.8.0": "1.5.0"`。
- **create_note 模板增强（B）**：「AI 创建模板」分组新增「复制配置 / 粘贴配置」按钮（复制 noteTemplate 的 JSON 到剪贴板，粘贴解析并按标题合并）；create_note 工具描述只暴露「允许 AI 写」的标题，顶部注明「正文结构由系统模板固定，AI 只需填写以下各节内容，禁止以 # 符号创建任何标题」，非 allowAi 标题完全不对 AI 暴露；检测到任一节文本以 `# ` 起始（创建标题）→ 拒绝不落盘。
- **create_note 限制 yaml（B）**：新增全局设置「限制 AI 只能使用已配置的属性（createRestrictYaml，默认关闭）」；开启后 create_note / modify_output_note / modify_output_note_versioned 的 yaml 键必须在「AI 创建属性规则」配置内，规则外键被拒绝。
- **新工具 modify_output_note（B）**：覆盖修改输出文件夹内已有笔记；sections 的键=原文已存在的标题文本，只能改该标题下的文字（不能改/新增标题、禁止 # 开头）；yaml 受属性规则约束，固定默认值写回时自动补上。
- **新工具 modify_output_note_versioned（B）**：接口同 modify_output_note，每次修改前把当前版本追加到归档文件（原文名+版本后缀.md，`## 版本 <N>` + frontmatter + 正文），原文件写入新版本号与归档标记；版本后缀/版本号属性/归档标记属性在「输出属性」页配置（缺失则不工作）。
- **search_output_notes 改版 + 新工具 read_output_note（B）**：search_output_notes 只返回 {path,title}（不再贴全文；需要全文请用 read_output_note）；新增 read_output_note 读取输出文件夹笔记全文（frontmatter+正文）。
- 三个新工具（modify_output_note / modify_output_note_versioned / read_output_note）进入默认基础工具集，可在预设「启用该工具」白名单开关中控制。

### v0.7.0（预设折叠 + 每工具独立折叠配置 + update_note_yaml 阉割版 + create_note 标题模板 + icon 可见性修复）
- **聊天 icon 可见性修复**：根因=`setIcon` 的 lucide svg 以 `currentColor` 绘制，真正开关是元素 `color`（`stroke: currentColor` 近乎空操作）；改为全聊天 icon 显式 `color`（带主题回退：发送钮 `var(--text-on-accent, #fff)`、操作钮 `var(--text-muted, var(--text-normal, #888))`、think/tool 图标回退）+ `svg { stroke: currentColor; fill: none }`，任何主题/移动端均可见。
- **预设可折叠**：预设 tab 每份预设默认折叠收起（头部=名称+展开 chevron+删除），展开态重渲染后恢复（`presetExpanded`）。
- **每工具独立折叠配置**：预设展开区内每个工具一个 `ks-tool-config` 折叠区（默认收起），标题=工具名+一行参数说明（向用户解释参数）；内容=「启用该工具」toggle（映射 `enabledTools`，兼容旧数据）+ 各工具参数（list_recent_notes 天数 / search 模式+限定键 / create_note、update_note_yaml、read_note 说明）。
- **update_note_yaml 阉割版**：新增 `updateYamlRules` 设置（「AI 修改属性规则」分组）：属性名 + **多行 textarea 解释**（可写每个可选值的含义）+ 可选值 tag + 删除；配置后 AI 只能修改这些属性、值必须在可选值内（越界 `{error}` 不写盘）；未配置维持 v0.5.0 任意键行为。
- **create_note 标题模板**：新增 `noteTemplate` 设置（「AI 创建模板」分组）：标题级别 H1-H6 + 标题文本 + 「允许 AI 写」toggle + 解释 textarea + 上移/下移/删除 + 实时预览；配置后 AI 侧 `content` 变为 `sections` 对象（每个允许写的标题=必填参数、参数名=标题、description=解释），创建时按模板顺序组装正文（不允许 AI 写的标题如大标题由模板固定输出）；无模板保持原样。

### v0.6.0（聊天 UI 一比一复刻 dsh + 修复渲染两份 + 日志复制按钮 + 渲染单份闭环检查）
- **A.1 输入区一比一复刻 dsh（结构级）**：`.ks-chat-inputbar` 改为**列式**（卡片 22px 圆角 + 1px 边框 + 阴影，`gap:12px`）= textarea 区（上，auto-grow ≤12em、`font-size:16px`、占位符不变）+ 按钮行 `.ks-chat-input-row`（下）。按钮行左侧 `.ks-chat-input-tools`（**预设选择器移入**，`.ks-preset-select` 小下拉含「默认（全部工具）」+ 各预设，onChange 沿用原 `buildPresetBar` 逻辑）；右侧 `.ks-chat-input-trailing`（发送钮，`margin-left:auto` 钉右）。**删除测试按钮**（`.ks-chat-test` 及 `send(TEST_PROMPT)` 调用；`TEST_PROMPT` 常量已删）。发送钮 34px 圆 `--interactive-accent`、`--text-on-accent`、disabled opacity .4、busy 时 `square`（保留 v0.5.0 stop 行为）；**icon 兜底可见**（`stroke: currentColor` + 颜色显式；`setIcon` 后 svg 无绘制内容时退化文本 ↑/■）。
- **A.2 思考块复刻 dsh ReasoningRow**：`.ks-think`（行头）= chevron（右旋/下旋折叠）+ 标题「思考中」（中文界面保留）+ **单行摘要**（`white-space:nowrap; overflow:hidden; text-overflow:ellipsis`，内容 = thinking 首行/前 80 字，`thinkSummary`）；body 折叠区 `padding-left:22px`（dsh 值）、14/24 `--text-muted`、pre-wrap。running（流式）态保留 300px 扫光（`.ks-think-sweep`/`.ks-think-streaming`）；折叠交互与自动展开/收起保留（`thinkExpanded`）。思考内容仍完整可展开查看。
- **A.3 消息区复刻**：**AI 消息去模型头行**（`.ks-chat-head`「AI · 模型名」删除；模型信息可经预设选择器/诊断日志查看）；AI 消息体 = 纯正文（`.ks-chat-markdown`），时间戳 `.ks-chat-time` hover 显现。**消息操作行**：AI 消息底部 `.ks-chat-msg-actions` 一行 = `clock`（时间，hover 显现）+ `copy`（复制该消息纯文本，`copyText`，28px 圆 hover `--background-modifier-hover`，复制后短暂变 check）；用户消息底部 hover 显现时间（保留）。消息列 748px 居中、gap 16px（保留）。
- **A.4 修复「渲染两份」（核心，P0）**：**单一写入者**——`markdownEls[index]` 只由 `paintMarkdownText`（`el.empty()` 后 `MarkdownRenderer.render`，render 为 append 语义）一条路径写；`refreshBlockText` 的 per-token 入口只记数据、不再直接写 DOM（触发 180ms 节流渲染）；`settleTextMarkdown`（stop）同样 `empty()` + render 终稿；**合并调度器**：`renderAll`（120ms）只做「结构调和」（新块出现/工具卡/思考块/光标/滚动），**不再写文本内容**——文本块 markdown 渲染统一走 `scheduleMarkdownRender`（180ms），两套调度同时触发时文本块只被 md 节流写。
- **A.4b 渲染单份闭环检查**：新增 `validateSingleRender()`（递归检查 body 内每个 `.ks-chat-markdown`：①直接子节点无裸 `#text`（除空白）②「原文+渲染」并存（`children.length>0` 且 `firstChild.nodeType===3`）→ 违规列表）；`finishTurn`/abort（`finishStream`）后自动调用 `runRenderCheck`，无违规 `console.info('[ks-render-check]', '无违规')`、有违规 `console.warn('[ks-render-check]', 违规详情)`；结果记入 `lastRenderCheck` 供诊断日志。*注：不校验 `textContent === 原文`——markdown 渲染后 textContent 是渲染文本，与源不同属正常，只检测能对应到单一来源的回归。*
- **A.5 日志复制按钮**：聊天页输入卡左工具区新增「复制诊断日志」按钮（lucide `clipboard-copy` + title「复制诊断日志」），点击打包：`[Knowledge System 诊断日志]` 版本/模型（toolsCount）/平台（`Platform.isMobile`）/Base URL/API Key（**脱敏**）+「最近一次流式」`[ks-stream]` +「最近一次渲染检查」`[ks-render-check]` +「最近一次错误」（字段从 `lastStreamLog`/`lastRenderCheck`/`lastErrorText` 读取，无则显示「无」）；复用 `copyToClipboard`/`markCopied` 变体（`copyText`，短暂「已复制」）。
- **A.6 保留**：流式光标（`.ks-stream-cursor`）、状态行 shimmer（`.ks-chat-status`）、错误块/一键复制、工具卡、移动端适配（`@media(max-width:480px)`）。`styles.css` 按 dsh 真实值实现；删除 `.ks-chat-test` 相关样式；新增 `.ks-chat-input-row/.ks-chat-input-tools/.ks-chat-input-trailing/.ks-chat-msg-actions/.ks-chat-summary` 等；不破坏 `.ks-tag*`/`.ks-preset*`/`.ks-yaml-values*`。
- **B. yaml 规则默认值不暴露给 AI（v0.6.0）**：`create_note` 属性规则的**默认值不再传给 AI**——`buildAnthropicTools` 生成的工具描述与 JSON Schema 中不再出现任何默认值信息（去掉了描述里的「（默认值：…）」片段）。**有可选值的键仍暴露（带 `enum` 约束），但描述不含默认值**；规则**只有默认值**（`values` 空但 `default` 非空）→ 该键既不出现在描述、也不出现在 schema `properties`/`required`，**AI 完全不知道其存在**；`createNoteTool` 在 AI 调用 `create_note` 后、创建文件前由 `applyDefaults` **自动补上**配置了默认值的键（AI 已提供的键值保留；默认值支持 `{{YYYY.MM.DD}}` 等 moment 模板）。设置页「AI 创建属性规则」仍可配置键名/解释/可选值/默认值（用户可见，只是不传给 AI），文案已注明「默认值不会暴露给 AI——AI 创建文件时自动追加（AI 不知情）」。
- **版本**：`manifest.json` / `package.json` = `0.6.0`；`versions.json` 增 `"0.6.0": "1.5.0"`。

### v0.5.0（流式期间直接 markdown + TTFT 检测点 + UI 照抄 dsh + 预设系统/新工具/yaml tag 输入）
- **A.1 流式期间直接渲染 markdown（核心）**：`chatView` `updateText`/`refreshBlockText` 改为**流式中（未 stop）也做节流 `MarkdownRenderer.render`**——每文本块 180ms 节流一次 `setText` + 全量渲染，**DOM 恒为 markdown、第一次输出就是 markdown**（不再「先纯文本、结束后才变 markdown」）；`content_block_stop` 立即渲染终稿并取消挂起节流（`settleTextMarkdown`），已完成/已 settle 块冻结不重渲（保留 `blockSettled`）；思考块保持 textContent 增量 + 流式扫光。节流期间用户滚动不被打断（保留 v0.4.0 自动滚动逻辑）。
- **A.2 首 token（TTFT）检测点 + 默认模型建议**：`core.ts` `streamAnthropicMessages` 成功路径返回 `ttfbMs`（首个成功候选 fetch 返回响应头，≈网络首字节）/`firstEventMs`（首个 SSE 事件，≈首个 token 到达）；`chatView` 的 `[ks-stream]` 增加 `startAtMs`/`ttfbMs`/`firstEventMs`/`model`/`toolsCount`。模型下拉显示名对 `deepseek-v4-flash` 标注「最快」、`deepseek-v4-pro` 标注「质量」（存值仍是模型 id）。README/设置文案提示「首 token 慢多半是 iOS 网络栈缓冲，已加 TTFT 检测点，反馈时附 console 输出」。
- **A.3 聊天 UI 认真照抄 dsh**：用户气泡 r22px 胶囊 + 主题自适应蓝底 + 右对齐 + `max-width:min(525px,82%)`；AI 消息无气泡/无边线/无头像、全栏宽叙述（font 16/28）；消息列 748px 居中 + gap 16px；输入卡片 22px + 1px 边框 + 阴影；发送钮 34×34 圆（disabled opacity .4）；消息时间戳 `font 14/24`、hover 显现（80ms）触屏常显；AI 流式状态行（输入栏上方，蓝色 shimmer）；思考块 running 态 300px 扫光；保留流式光标与之并存；移动端收紧 padding、输入卡 `--radius-m`、按钮 40px。新增 `.ks-chat-time`/`.ks-chat-status` 与 `.ks-chat-preset-bar` 样式占位（预设选择器 DOM 由工具预设系统部分接入）。
- **版本**：`manifest.json` / `package.json` = `0.5.0`；`versions.json` 增 `"0.5.0": "1.5.0"`。

### v0.4.0（真正逐字流式 + 聊天 UI 美化）
- **修复假流式**：`src/core.ts` `streamAnthropicMessages` 改为 `res.body.getReader()` **边读边解析边渲染**——订阅增量 SSE 解析器，每个 `\n` 闭帧的 `event:`/`data:` 事件即时回调给 UI；不再整段读完再一次性解析（旧「一大段一大段出现」的根因）。返回新增 `chunks`（reader 块数）、`events`（事件数）。
- **新增增量 SSE 解析器** `src/utils/sse.ts` `createIncrementalSseParser(onEvent)`（纯函数，不 import obsidian）：`push`/`flush`/`reset`；状态（event 名、dataLines）跨 chunk 持久；chunk 可切开一行/一条 data；多行 `data:` 用 `\n` join；`\r\n`/`\n` 兼容；`:` 注释忽略；缓冲上限 1MB 超限强制 flush；保留旧 `parseAnthropicSSE`/`parseAnthropicResponse` 与 45 条基线断言语义。
- **低闪烁增量渲染**：`chatView` 为每块保留**持久 DOM 容器**（`blockEls`），**流式期间文本/思考只更新纯文本 `textContent`（O(1)，不做 MarkdownRenderer.render）**；120ms 节流 `renderAll()` 调和「新块出现 / 已停块 MarkdownRenderer 渲染一次 / 光标 / 滚动」；`content_block_stop` 才对该文本块渲染 markdown（一次性）；思考块流式时自动展开并闪烁「…」，结束后收起，用户手动开合状态保留。
- **流式光标与滚动**：AI 生成时末尾显示 `<span class="ks-stream-cursor">`（`|` 闪烁 CSS 动画），流结束移除；自动滚动仅在距底部 <80px 时跟随，用户在某个新用户消息后强制滚一次，流式不劫持上翻。
- **检测点**：流结束后 `console.info('[ks-stream]', { chunks, events, url })`；2xx 但解析出 0 事件时按「流式失败」走非流式回退。错误块/一键复制契约不变。
- **聊天 UI 美化**：输入条**卡片化**（`background-modifier-border` 边框 + 圆角 + 圆形发送/停止钮 `interactive-accent` + 测试钮 `background-secondary`）；输入框透明无边框、`resize:none`、auto-grow ≤12em、`font-size:16px`（防 iOS 缩放）；消息头行「AI · 模型名」徽标（lucide `bot`）与「你」；思考块加 lucide `brain`；移动端 `@media (max-width:480px)` 收紧 padding、气泡 max-width 90%、按钮 40px 触控；一律 Obsidian 变量 + lucide 图标（无 emoji、无硬编码）。
- **版本**：`manifest.json` / `package.json` = `0.4.0`；`versions.json` 增 `"0.4.0": "1.5.0"`。

**致谢**：聊天 UI 的视觉与交互设计参考了 [obsidian-copilot](https://github.com/logancyang/obsidian-copilot)（气泡/输入条/思考块/错误块/滚动手法）；增量渲染的低闪烁节流思路参考了 DSH 对话 UI 的 `useThrottledVisualUpdate` 概念。感谢这些开源项目带来的启发。

---

### v0.3.2（Base URL 端点自动探测）
- 新增纯函数模块 `src/utils/endpoints.ts`：`chatEndpointCandidates` / `modelsEndpointCandidates`（含 `/anthropic` 段补全/去除的候选变换，不硬编码服务商域名）。
- 聊天协议（流式与非流式）改为**逐候选探测**：仅当状态码 404 且还有候选时换下一个；其余失败立即返回，错误文案携带**实际请求的完整 URL**。
- 模型列表改用 `modelsEndpointCandidates`，修复「填了 `/anthropic` 后模型列表 404」的对称问题；成功消息带实际 URL。
- 自动纠偏：当「设置缺 `/anthropic`、第 2 个候选成功」时弹 Notice 并回写 `settings.baseUrl` 为含 `/anthropic` 的版本。
- 聊天页错误气泡改为**可复制错误块**（一键复制，`navigator.clipboard` + `textarea/execCommand` 兜底），流式/非流式/请求异常三条失败路径共用。

---

## 本阶段未实现（后续）

- 不做 Base5 / 多服务商完整 UI（仅保留自定义服务商折叠区作为预留）。
- 不做审批闭环。
- 流式 UI 已用**原生 `fetch` + `res.body.getReader()` + 增量 SSE 解析器**实现（桌面 Electron / 移动端 WebView 均可用）；`fetch` 失败/不支持时回退 `requestUrl` 非流式（`stream:false` + `parseAnthropicResponse`），两者复用同一 UI 渲染路径。
