# obsidian-knowledge-system

配置驱动的 AI 知识系统框架。v0.3.2 增加 **Base URL 端点自动探测**：聊天端点自动探测 `/anthropic` 前缀（DeepSeek 官方 `https://api.deepseek.com/anthropic`），模型列表自动探测根端点，404 时**自动纠偏并回写设置**，并在聊天页显示**一键可复制的诊断错误**。v0.3.1 接入 **Anthropic 兼容协议**（`POST {baseUrl}/v1/messages`，`x-api-key`）、**内置工具集**（`list_recent_notes` / `read_note` / `create_note`）、**AI 聊天视图**与「测试任务」按钮；聊天用**原生 `fetch` 流式**（桌面 Electron + 移动端 WebView 均可，端点 CORS 已放行），**兼容性不佳时自动降级为非流式**（`requestUrl` + `stream:false`）；v0.2.0 起还含独立**设置视图**、**动态输出属性**、**测试工具**标签页。

---

## 功能简介

- **AI 聊天视图**：命令面板 "Open Knowledge System chat" 在中间标签页打开聊天，气泡式用户/助手消息，助手用 markdown 渲染，**thinking 块可折叠**，**tool_use 工具卡片**（名称 + 参数摘要 + 结果），支持多轮 tool_use/tool_result 往返，出错在 UI 内显示错误气泡。**原生 `fetch` 流式（桌面 + 移动端，浏览器直连）**；若 `fetch` 流式失败/不支持，自动回退 `requestUrl` 非流式（复用同一 UI 渲染）。
- **Anthropic 兼容协议**：调用 `POST {settings.baseUrl}/v1/messages`，请求头 `x-api-key: <key>` + `anthropic-version: 2023-06-01`；`baseUrl` 默认 `https://api.deepseek.com/anthropic`。
- **内置工具集**（供 AI 调用）：`list_recent_notes`（浏览源文件夹最近笔记）、`read_note`（读取笔记正文，去 YAML）、`create_note`（在输出文件夹创建笔记，防路径穿越）。
- **测试任务按钮**：在聊天视图一键发送内置中文 prompt，要求 AI 依次调用 `list_recent_notes → read_note → create_note`。
- **一键配置 DeepSeek**：在【连接】标签页填写 API Key，点击「测试并获取模型」调用模型列表接口（先 `/models`，回退 `/v1/models`），填充模型下拉框。**模型列表完全来自接口，不硬编码**。
- **源/输出文件夹**：支持输入框 + 文件夹选择器（Obsidian 原生 Suggest）。
- **自定义时间属性 / 最早时间**：可配置读取文件时间的 frontmatter 属性名与 moment 格式；新增**最早时间**限制 AI 工具可见范围。
- **动态输出属性**：输出属性为键值对，可增删；时间戳、来源为固定行。
- **独立设置视图**：命令面板 "Show Knowledge System settings view" 打开同设置 UI。
- **测试工具标签页**：设置页第 5 个标签页一键执行「统计最近文件数」「输出最新内容测试」。

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

### 测试工具（标签页）

| 名称 | 说明 |
|---|---|
| 统计最近文件数 | 扫描源文件夹，统计最近 N 天内的 Markdown 文件数，以 Notice 提示。 |
| 输出最新内容测试 | 取源文件夹时间最新的文件，将其正文最后 100 个字符（按 Unicode 字符计，含换行）写入输出文件夹，并生成含可配置属性名的 frontmatter。 |

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
- 聊天 UI 的流式用**原生 `fetch` + `res.body.getReader()`**（桌面 Electron / 移动端 WebView 均可用）；`fetch` 失败/不支持时回退 `requestUrl` 非流式（`stream:false` + `parseAnthropicResponse`）。若某环境 `fetch` 流式被 CORS 拦截，会自动走 `requestUrl` 回退。
