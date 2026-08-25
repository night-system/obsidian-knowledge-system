# obsidian-knowledge-system

配置驱动的 AI 知识系统框架。v0.5.0：**流式期间直接渲染 markdown**（180ms 节流，第一次输出就是 markdown）+ **首 token（TTFT）检测点**（`[ks-stream]` 增 `ttfbMs`/`firstEventMs`）+ **聊天 UI 认真照抄 dsh**（用户气泡胶囊 / 无边框 AI 叙述 / 输入卡片 22px / 时间戳 hover 显现 / 流式状态行 shimmer / 思考块扫光）+ **默认模型建议标注**；v0.4.0 实现**真正逐字流式渲染**：改为**边读边解析边渲染**（增量 SSE 解析器 + 120ms 节流 + 持久容器低闪烁增量 DOM），AI 回复逐词冒出、不再「一大段一大段出现」，并升级**聊天 UI**（气泡化输入条、lucide 图标、AI/模型徽标、流式光标、思考块闪烁、移动端触控）；`create_note` 支持**属性规则**配置（见设置页）。v0.3.2 增加 **Base URL 端点自动探测**：聊天端点自动探测 `/anthropic` 前缀（DeepSeek 官方 `https://api.deepseek.com/anthropic`），模型列表自动探测根端点，404 时**自动纠偏并回写设置**，并在聊天页显示**一键可复制的诊断错误**。v0.3.1 接入 **Anthropic 兼容协议**（`POST {baseUrl}/v1/messages`，`x-api-key`）、**内置工具集**（`list_recent_notes` / `read_note` / `create_note`）、**AI 聊天视图**与「测试任务」按钮；聊天用**原生 `fetch` 流式**（桌面 Electron + 移动端 WebView 均可，端点 CORS 已放行），**兼容性不佳时自动降级为非流式**（`requestUrl` + `stream:false`）；v0.2.0 起还含独立**设置视图**、**动态输出属性**、**测试工具**标签页。

---

## 功能简介

- **AI 聊天视图**：命令面板 "Open Knowledge System chat" 在中间标签页打开聊天，气泡式用户/助手消息，助手用 markdown 渲染，**thinking 块可折叠**，**tool_use 工具卡片**（名称 + 参数摘要 + 结果），支持多轮 tool_use/tool_result 往返，出错在 UI 内显示错误气泡。**真正逐字流式渲染 + 流式期间直接 markdown（v0.5.0）**（`stream:true` 时用增量 SSE 解析器**边读边解析边渲染**，AI 回复逐词冒出；文本块流式期间用 **180ms 节流 MarkdownRenderer 直接渲染 markdown**——**第一次输出就是 markdown**，块结算时立即渲染终稿并冻结，不再「先纯文本、结束后才变 markdown」）；**非流式/不支持自动回退 `requestUrl` 非流式**（复用同一 UI 渲染）。
- **聊天 UI 美化（v0.4.0）**：输入条**卡片化**（带边框圆角 + 圆形发送/停止钮 `interactive-accent` + 测试钮）+ 输入框透明无边框自动增高（`font-size:16px` 防 iOS 缩放）；消息带 **AI/模型徽标**（lucide `bot` 图标）与「你」头行；**流式光标**（`|` 闪烁）在 AI 生成时显示；**思考块**流式时 body 尾加闪烁「…」（lucide `brain` 图标）；移动端收紧间距并放大按钮触控；一律使用 Obsidian 变量与 lucide 图标（无 emoji、无硬编码颜色）。
- **聊天 UI 认真照抄 dsh（v0.5.0）**：**用户气泡**右对齐胶囊（r22px、蓝底 `--background-modifier-hover` 主题自适应、padding 10/16、font 16/24、`max-width:min(525px,82%)`）；**AI 消息**无气泡/无边线/无头像、全栏宽纯文本叙述（font 16/28）；消息列 `max-width:748px; margin:0 auto; gap:16px`；输入卡片 `border-radius:22px` + 1px 边框 + 阴影；发送钮 34×34 圆（`interactive-accent`，disabled opacity .4）；**消息时间戳** `font 14/24`、`--text-faint`、hover 才显现（80ms，触屏常显）；**AI 流式状态行**（输入栏上方，蓝色 shimmer）；**思考块 running 态 300px 扫光**；保留流式光标（用户已习惯）与之并存。
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

### 测试工具（标签页）

| 名称 | 说明 |
|---|---|
| 统计最近文件数 | 扫描源文件夹，统计最近 N 天内的 Markdown 文件数，以 Notice 提示。 |
| 输出最新内容测试 | 取源文件夹时间最新的文件，将其正文最后 100 个字符（按 Unicode 字符计，含换行）写入输出文件夹，并生成含可配置属性名的 frontmatter。 |

### 预设（标签页，v0.5.0 第 6 个标签页）

「工具预设」把一组「工具配置」保存成预设，并在聊天界面用下拉选择器随时切换。一份预设包含：

| 字段 | 说明 |
|---|---|
| 名称 | 预设显示名（聊天选择器里显示）。 |
| 系统提示词 | 随预设绑定的自定义系统提示；留空 = 默认（不发送 system）。 |
| 启用工具 | 勾选允许 AI 使用的工具（list_recent_notes / read_note / create_note / update_note_yaml / search_output_notes）；全部不勾 = 默认（全部工具）。 |
| list_recent_notes 天数 | 覆写其 `days`；留空 = 用「时间」页的「最近 N 天」。 |
| create_note / update_note_yaml | false = 从暴露列表移除对应工具。 |
| search_output_notes 模式 | 完整版（AI 按任意键搜索）/ 阉割版（只能按下方限定键搜索）。 |
| 阉割版限定键 | search 为阉割版时的限定键 + 可选值（chip 填写；留空 = 任意值）。 |

> **全局开关**：设置 → 预设 页可打开「update_yaml_tool_enabled」以向 AI 暴露 `update_note_yaml`（默认关闭）。聊天界面输入栏上方的**预设下拉选择器**切换当前预设（默认「默认（全部工具）」= 全部工具 + 设置里的 yaml 规则），切换后**下次请求生效**。

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
