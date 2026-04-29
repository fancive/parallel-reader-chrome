# Parallel Reader

> 为任意网页生成「带原文锚点」的 LLM 摘要卡片。
> 一个按 Tab 与 URL 隔离状态的 Chrome 侧栏，专为「带证据的慢阅读」设计。

[![Manifest V3](https://img.shields.io/badge/manifest-v3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Chrome 114+](https://img.shields.io/badge/chrome-%E2%89%A5114-4285F4?logo=googlechrome&logoColor=white)](manifest.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Biome](https://img.shields.io/badge/lint-Biome-60A5FA?logo=biome&logoColor=white)](biome.json)
[![esbuild](https://img.shields.io/badge/build-esbuild-FFCF00?logo=esbuild&logoColor=black)](esbuild.config.mjs)
[![tests](https://img.shields.io/badge/tests-43%20passing-2EA043)](tests)
[![status](https://img.shields.io/badge/status-prototype%20%C2%B7%20BYOK-orange)](#凭据边界与发布决策)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#贡献)

[English](README.md) · **简体中文**

---

## 目录

- [为什么做这个](#为什么做这个)
- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [侧栏交互](#侧栏交互)
  - [抽取状态](#抽取状态)
  - [重新分析行为](#重新分析行为)
  - [卡片操作](#卡片操作)
  - [键盘与无障碍](#键盘与无障碍)
- [权限与不支持的页面](#权限与不支持的页面)
- [服务商设置](#服务商设置)
- [凭据边界与发布决策](#凭据边界与发布决策)
- [开发](#开发)
- [项目结构](#项目结构)
- [E2E 契约](#e2e-契约)
- [锚点冒烟测试](#锚点冒烟测试)
- [回归门禁](#回归门禁)
- [Roadmap](#roadmap)
- [贡献](#贡献)
- [许可](#许可)

## 为什么做这个

绝大多数「让 LLM 总结这页」的工具，给你的是一段「生成出来的散文」，没法
反向追溯到原文。Parallel Reader 选择反向路径：**每张卡片都包含一段
原文 verbatim 引用 + 一段简短 LLM 概括**，这段引用会锚定到 Live DOM 的
具体位置，便于跳转回原文核对。侧栏按 Tab × URL 维护状态，不同页面互不
干扰。

## 功能特性

- **带锚点的摘要卡片** —— 每张卡片携带原文引用，点击即可跳转到 Live DOM
  对应的文本范围。
- **三路锚点校验** —— 每个锚点同时对照原始页面文本、Mozilla Readability
  正文文本、Live DOM Range，让你诚实地看到哪些卡片仍然能被定位。
- **按 Tab + URL 缓存** —— 切换页面/标签不会丢失卡片；重新分析仅在新一次
  分析成功后才替换缓存。
- **复制引用 / 复制摘要** —— 即使锚点在 Live DOM 已不可定位，复制操作
  仍然可用，DOM-miss 的卡片依旧能用于做笔记和回头阅读。
- **可配置密度与语言** —— 简洁 / 普通 / 详尽三档；中文或英文摘要。
- **可配置卡片数量** —— 每次分析 4–10 张。
- **OpenAI-兼容 BYOK** —— 适配 DeepSeek、DashScope 等 OpenAI 形态的端点；
  API Key 仅存放在当前 Chrome Profile。
- **无障碍侧栏** —— `aria-live` 状态、键盘可导航的卡片右键菜单（方向键 /
  Home / End / Esc / Tab）、持久化「当前活跃卡片」高亮、可见的
  `:focus-visible` 焦点环。
- **锚点冒烟 CLI** —— 批量 URL 端到端打真实服务商，并对 DOM 命中率与可读
  正文长度做回归门禁。

## 快速开始

```bash
npm install
npm run build
```

在 Chrome 中加载未打包扩展：

1. 打开 `chrome://extensions`。
2. 开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择项目下的 `./dist` 目录。
5. 点击工具栏图标打开侧栏。
6. 保存服务商设置（见 [服务商设置](#服务商设置)）。
7. 点击 **分析当前页**。

需要 Chrome **114 及以上** —— 本扩展使用的 Side Panel API 与 MV3
Service Worker 特性在更老版本上不可用。

## 侧栏交互

### 抽取状态

每次分析会展示原始文本长度、Readability 正文长度、最终发给 LLM 的版本，
以及实际选中文本长度。同时给出一行非阻塞的质量提示：

| 标签 | 含义 |
| --- | --- |
| `抽取正常` | 选中文本长度足以正常生成卡片。 |
| `可读文本偏短` | 页面可能仍在加载、被登录态拦截，或并非正文页。 |
| `使用 Raw 文本` | Readability 无法稳定抽取正文，因此回退到原始页面文本。 |

这些提示**不会阻断分析**，目的是在你判断锚点命中率与卡片质量之前，先把
「页面状态可能不完整」这件事公开告诉你。

### 重新分析行为

结果按 Tab + URL 缓存。若当前页面已有缓存卡片，主按钮会从 `分析当前页`
变为 `重新分析当前页`。重新分析会**显式重新抽取**当前页面，并且**只在
新一次分析成功后**才替换缓存结果。新分析进行中时，旧卡片仍然可见，因此
失败的服务商调用或加载不全的页面不会抹掉之前的结果。

### 卡片操作

每张卡片都可以从侧栏直接复制 verbatim 引用或一份紧凑摘要。即便该卡片
在 Live DOM 已不可高亮，复制依旧可用，DOM-miss 卡片仍能用于做笔记和后续
阅读。

### 键盘与无障碍

- 卡片右键菜单完全键盘可达：
  - `↑` / `↓` 在可用菜单项之间循环。
  - `Home` / `End` 跳到首/尾项。
  - `Esc` 关闭菜单。
  - `Tab` 离开菜单并关闭。
- 最近一次激活的卡片会持续保持 `card-active` 强调样式，便于回滚阅读。
- 状态消息位于 `aria-live="polite"` 区域；设置错误通过 `role="alert"`
  的内联段落呈现。
- 所有交互元素（卡片、主按钮、图标按钮、调试开关）都有 `:focus-visible`
  焦点环。

## 权限与不支持的页面

原型阶段声明 `<all_urls>`，因为验证目标是任意英文媒体文章，而非固定白
名单。Content Script 需要从用户打开的具体文章里读取页面文本与 Live DOM
Range。`activeTab` 与 `scripting` 用于扩展重载后侧栏可重新尝试给当前活
跃页注入 Content Script。

以下页面会在分析前被识别为不支持：

- 浏览器内部页面与扩展页面（如 `chrome://extensions`、
  `chrome-extension://...`）无法注入扩展 Content Script。
- 浏览器内置 PDF 查看器页面在原型阶段不支持，请改用文章页或其他可复制
  文本视图。
- `file://` 页面需要在 `chrome://extensions` 为该扩展启用 **允许访问文件
  网址**。
- 其他非 HTTP 协议可能因为 Chrome 不暴露常规页面 DOM 而失败。

## 服务商设置

设置存储于 Chrome local storage，键为 `parallel-reader-settings`。这是一
个本地 BYOK 原型：API Key 存在当前 Chrome Profile，由扩展 Background
Worker 使用。

默认值：

| 项目 | 默认 |
| --- | --- |
| Base URL | `https://api.deepseek.com/v1` |
| Model | `deepseek-chat` |
| 卡片数量 | `4` 到 `10` |
| 摘要语言 | 中文 (`zh-CN`) |
| 卡片密度 | 普通 (`normal`) |
| 文档最大字符数 | `20000` |

阅读英文媒体时可把摘要语言切换为英文。卡片密度可选 **简洁 / 普通 /
详尽**，影响 Prompt 层的要点数和详略预算，但不改变锚点要求。

对接 DashScope 或其他 OpenAI 兼容端点时，把侧栏字段填成你希望扩展使用
的 API Key、Base URL、Model 即可。冒烟 CLI 也接受以下环境变量：

```bash
export DASHSCOPE_CODING_SK=...
export DASHSCOPE_CODING_BASE_URL=...
export DASHSCOPE_CODING_MODEL=qwen3-coder-plus  # 可选；CLI 默认 qwen3-coder-plus
```

## 凭据边界与发布决策

**决策（2026-04-29）：** 本项目暂定为**本地、开发者自用的 BYOK 工具**。
适合「读者明确知道并自愿把自己的服务商 Key 存到自己 Chrome Profile」的
未打包扩展私下使用场景。

这**不是**一个可对外发布的生产凭据模型。在向 Chrome Web Store 或更广的
用户群发布之前，服务商调用必须改造为以下任一形态：

- 后端服务持有服务商凭据，并加上鉴权、限流、请求审计、滥用控制。
- 短期 Token 代理：签发短生命周期、限定权限的临时凭据，避免在扩展
  storage 持久化长期 Key。

发布层面的含义：当前 `storage` + Background Worker 的服务商调用路径是
**原型边界，不是发布边界**。本地继续打磨产品功能没问题，但公开发布前必
须替换并复审凭据模型。

## 开发

```bash
npm run dev        # 监听构建到 dist/
npm run build      # 本地正式构建
npm run check      # test + lint + typecheck + build + audit
npm run e2e        # 项目本地 .e2e 契约门禁（Playwright）
npm run lint       # 对 src/、scripts/、tests/、构建配置跑 Biome
npm test           # node --test 测试
npm run typecheck  # 仅 TypeScript 类型检查
npm audit          # 依赖审计
```

`dist/` 是 Chrome 实际加载的产物。改源码后请重新构建并在
`chrome://extensions` 重新加载未打包扩展。

## 项目结构

```
src/
  background.ts            MV3 Service Worker，编排服务商调用
  content.ts               页面抽取 + DOM Range 定位
  sidepanel.ts             侧栏入口，串联下面的子模块
  sidepanel.html / .css    侧栏 UI
  shared/                  纯函数（不调用 chrome.*）
    anchor.ts              锚点匹配算法
    anchor-repair.ts       锚点定位的模糊兜底
    dom-anchor.ts          Content Script 用的 DOM Range 构建
    extraction-quality.ts  raw / readable / selected 文本质量分级
    json-extract.ts        服务商响应的容错 JSON 解析
    logger.ts              受 debug 标志开关的 console.warn 包装
    page-support.ts        侧栏 URL/协议白名单
    prompt.ts              Prompt 构造
    provider.ts            服务商请求/响应形状
    types.ts               共享 TypeScript 类型
  sidepanel/               拆分出的侧栏子模块
    card-view.ts           DOM-safe 的卡片渲染（不使用 innerHTML）
    clipboard.ts           剪贴板辅助 + 兜底
    concurrency.ts         runWithConcurrency、debounce
    dom.ts                 $、escapeHtml、errorMessage 辅助
    menu.ts                卡片右键菜单（键盘可导航）
    settings-form.ts       设置面板绑定 + 内联错误
tests/                     node --test 用例（共 43 条）
scripts/                   锚点冒烟 CLI
.e2e/                      项目本地 E2E 契约（gate.sh + Playwright）
```

## E2E 契约

项目本地 `.e2e` 门禁会针对本地文章 fixture 跑一次扩展级冒烟：

```bash
npm run e2e
```

该门禁会构建未打包扩展、启动 Chrome、打开侧栏页、验证首启的 Provider
设置守卫，并检查 Content Script 在没有服务商凭据的情况下也能抽取并定位
fixture 文章文本。生成的 CTRF 证据会写入 `.e2e/artifact.json`。

## 锚点冒烟测试

针对真实文章 URL 列表端到端打真实服务商。先准备一个换行分隔的 URL 文件
（空行与 `#` 注释会被忽略）：

```text
https://arstechnica.com/google/2025/09/google-announces-massive-expansion-of-ai-features-in-chrome/
https://aeon.co/essays/sure-ai-can-do-writing-but-memoir-not-so-much
```

运行冒烟：

```bash
npm run anchor:smoke -- \
  --urls urls.txt \
  --output-dir reports \
  --timeout-ms 60000 \
  --network-idle-ms 7000 \
  --settle-ms 2500
```

对每个 URL，冒烟会用 Chrome 打开页面，抽取 raw 和 Readability 文本，调
用服务商，并把每个返回的锚点对照以下三路验证：

- 原始页面文本
- Readability 正文文本
- Live DOM Range 定位

报告以 JSON 与 Markdown 形式写入 `reports/`。

## 回归门禁

需要冒烟以非零退出失败时，加阈值即可：

```bash
npm run anchor:smoke -- --urls urls.txt --min-dom-hit-rate 90% --min-readable-chars 1000
```

也可以对已有 JSON 报告做门禁，无需重跑浏览器或模型：

```bash
npm run anchor:smoke -- \
  --gate-report reports/anchor-smoke-2026-04-29T02-27-25-530Z.json \
  --min-dom-hit-rate 90% --min-readable-chars 1000
```

`--min-dom-hit-rate` 接受 `0.9`、`90`、`90%` 三种形式。
`--min-readable-chars` 校验最终发给模型的选中文本版本。仍在加载或仅能
部分抽取的页面依然可以人工查看；门禁让每个批次自行决定严格度。

## Roadmap

- 后端凭据模型或短期 Token 代理（公开发布的阻塞项 —— 见
  [凭据边界](#凭据边界与发布决策)）。
- 凭据边界替换之后，扩展更多 Provider Profile（Anthropic、原生 OpenAI、
  本地模型）。
- 多语言 UI 字符串（侧栏当前是中英混合，键已存在，完整 i18n 仍待补）。
- 单卡片导出到 Obsidian / Markdown 笔记。

## 贡献

欢迎 Issue / PR —— 尤其欢迎报告真实文章 URL 上的「锚点正确性回归」（请
附上 URL 与 `npm run anchor:smoke` 生成的 JSON 报告）。

提 PR 之前请跑：

```bash
npm run check      # 测试 + lint + typecheck + build + audit
npm run e2e        # 扩展冒烟（Playwright）
```

代码风格由 Biome (`biome.json`) 与 TypeScript (`tsconfig.json`) 强制约
束。请不要把这两份配置和行为变更放在同一个 PR。

## 许可

**尚未指定 License**。在仓库添加 `LICENSE` 文件之前，请把代码视作仓库
作者「保留所有权利」。如果你希望以特定 License 使用本代码，请开 Issue。
