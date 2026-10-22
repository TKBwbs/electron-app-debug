---
name: electron-app-debug
description: Electron 桌面应用的调试与自动化验证。用于「应用能不能起来 / 为什么白屏黑屏 / 怎么改完自己验一遍」这类任务，包括：启动崩溃与 GPU 进程崩溃定位、判断渲染后端是 WebGL 还是 WebGPU 并选对启动参数、用 CDP 远程调试并截图、让智能体看着界面改代码、把一次性排查固化成可回归的 E2E。适用于任何 Electron 项目（vite-plugin-electron / electron-vite / electron-forge / 裸 electron）。触发词：electron 调试、electron 白屏、electron 黑屏、renderer 崩溃、webgpu、webgl、playwright electron、remote-debugging-port、electron 自动化测试。
agent_created: true
---

# Electron 应用调试

## 用途

把「Electron 应用跑起来 → 看见界面 → 定位问题 → 改完自验」变成一条可重复的流程，
并且**自适应渲染后端**（WebGL / WebGPU），避免用错启动参数导致的黑屏假象。

核心判断：**Electron 调试的瓶颈不是启动命令，而是「验证信号」**。
让智能体拿到四类可读信号，它就能自己闭环：

| 信号 | 获取方式 |
|---|---|
| 进程活着的证据 | CDP `/json/list` 里有非 devtools 的 page target，且能完成一次 `Runtime.evaluate` 往返 |
| 界面长什么样 | `Page.captureScreenshot` → PNG 落盘 → 直接读图 |
| 运行时错误 | CDP 的 `Runtime.exceptionThrown` 与 `Runtime.consoleAPICalled(type=error)` |
| 业务是否就绪 | 页面里的就绪信号（canvas 定尺寸 / 面板文案 / 启动日志） |
| **请求有没有发出去 / 慢在哪** | `Network.*` 事件：总数、失败、耗时 Top3（`--network`） |
| **主进程状态** | Node inspector（`--inspect`）：`process.versions` / cwd / argv / 主进程 console |

## 脚本一览

| 脚本 | 作用 | 什么时候用 |
|---|---|---|
| `scripts/doctor.mjs` | 静态体检：入口、产物新鲜度、版本能力、后端线索、建议参数、项目雷 | **每次开工先跑**，秒级、不启动 |
| `scripts/inspect.mjs` | 启动（自适应降级）+ 后端探测 + 白屏判据 + console + 截图；支持 `--attach` / `--network` / `--reload` | 要看界面、要判断后端、要抓包 |
| `scripts/serve.mjs` | 常驻 + 固定调试端口 + 打印 MCP 配置；`--attach` 只连不起来 | 要反复交互（点按钮、改完复验） |
| `scripts/act.mjs` | 单次动作：`dom` / `click` / `fill` / `press` / `eval` / `wait` / `shot` / `reload` | **「点一下看看」不用写 JS**，用完即走 |
| `scripts/main-process.mjs` | 主进程调试（Node inspector）：概况 / `--eval` / `--logs` | IPC、窗口创建、文件 IO、启动即退出 |
| `scripts/lib/cdp.mjs` | 零依赖底座：启动、附加、求值、截图、点击、抓包、超时 | 写自己的调试脚本时 import |
| `assets/e2e-harness.mjs` | 可复制进项目的 Playwright 模板 | 要把排查固化成回归 |

## 何时使用

- 需要启动一个 Electron 项目做验证、截图、点两下试试；
- 应用白屏 / 黑屏 / 闪退 / 启动卡死，要定位是资源问题还是渲染问题；
- 怀疑 WebGL 与 WebGPU 参数用错（尤其「WebGL 正常、WebGPU 黑屏」）；
- 想给 Electron 项目补一套能长期回归的 E2E；
- 用户说「你跑一下看看」，而项目里没有现成的测试入口。

## 工作流

### 第 1 步：体检（不启动，秒级）

```bash
node <skill>/scripts/doctor.mjs --project <项目目录>
```

输出：入口与产物、构建新鲜度、工具链、**静态推测的渲染后端**、建议启动参数、
以及该项目的已知雷（单实例锁、自动开 DevTools、当前 shell 的 `ELECTRON_RUN_AS_NODE`）。

先看两个字段再动手：

- `构建产物` 为空或 `产物新鲜度 ⚠ 过期` → 先 `npm run build`，否则测的是旧代码；
- `后端（静态推测）` 为 `unknown` → 靠第 2 步运行时探测确定，别凭猜。

### 第 2 步：看见（启动 + 探测 + 截图）

```bash
node <skill>/scripts/inspect.mjs --project <项目目录>
node <skill>/scripts/inspect.mjs --project <项目目录> --wait-text "项目名" --json
```

一次运行给出：实际渲染后端（WebGPU/WebGL2/WebGL1）、GPU 适配器是硬件还是回退、
DOM 规模、白屏风险指标、console 错误、一张截图路径。

**必须真的读那张截图**（多模态），不要只读 JSON —— 「有没有画出来」只有图能回答。

启动失败时脚本会自动按参数阶梯降级，并打印每一档的结果，直接据此判断：

| 打印 | 含义 | 下一步 |
|---|---|---|
| `gpu-crash` | GPU 进程崩溃 | 已在降级；若全档失败，见 `references/pitfalls.md` §2 |
| `run-as-node` | 退化成裸 Node | 环境里有 `ELECTRON_RUN_AS_NODE`，必须清除 |
| `dev-server-missing` | 要连的开发服务器没起 | 先跑 dev，或改用构建产物启动 |
| `missing-module` | 主进程 require 失败 | `npm i` / `npm run build`，核对 `main` 指向的产物 |

### 第 3 步：交互与定位（常驻调试）

一次性探查用常驻模式，应用不退出、调试端口开放：

```bash
node <skill>/scripts/serve.mjs --project <项目目录> --port 9492
node <skill>/scripts/serve.mjs --attach 9492            # 只连已在运行的实例，不启动
```

它会打印可直接粘贴的 `mcpServers` 片段（chrome-devtools MCP）与零依赖的替代命令。
之后可以点击、读 DOM、截图、看 console，反复验证。

**写选择器之前先看真实 DOM**（猜选择器是自动化失败的头号原因）：

```bash
node <skill>/scripts/inspect.mjs --project <项目目录> --dom
# 输出：每个可见按钮/输入框的 tag、文案、disabled，以及建议选择器（#id / .cls / text=…）
```

**临时操作不用写脚本**，`act.mjs` 一条命令一个动作（连完即走，端口默认 9492）：

```bash
node <skill>/scripts/act.mjs dom
node <skill>/scripts/act.mjs click 'text=新建项目'
node <skill>/scripts/act.mjs fill '#search-projects' 'Demo'
node <skill>/scripts/act.mjs press '#search-projects' Enter
node <skill>/scripts/act.mjs eval 'document.title'
node <skill>/scripts/act.mjs shot --out after.png
node <skill>/scripts/act.mjs reload          # 改完代码复验 / 截图卡住时恢复
```

把「点完之后是否真的生效」变成可判定结果，用 `--then`：

```bash
node <skill>/scripts/act.mjs click '#btn-new-project' --then '!!document.querySelector(".modal-overlay")'
# 退出码 0 = 点击生效且条件成立；1 = 没生效（可直接进 CI 或 && 链）
```

需要写脚本驱动时，从 `scripts/lib/cdp.mjs` 取能力（零依赖）：

```js
import { launchAdaptive, connectPage, attachByPort, waitFor } from '<skill>/scripts/lib/cdp.mjs';

const { launched } = await launchAdaptive({
  projectDir,
  ladder: [[], ['--disable-gpu-sandbox'], ['--no-sandbox', '--disable-gpu-sandbox']],
});
const client = await connectPage(launched.page, { projectDir });

await waitFor(client, `!!document.querySelector('.ready')`);

// 选择器：CSS，或 text= / :has-text() 两种文本写法（内部翻译，不会抛 SyntaxError）
await client.click('#btn-play');                       // 默认真实鼠标事件；不可见时自动退回 el.click()
await client.click('text=新建项目');
await client.fill('#search-projects', 'Demo');         // 事件链 + 回读断言，返回 { matched }
await client.press('#search-projects', 'Enter');       // 真实键盘事件，表单提交等默认行为才会触发
await client.inventory();                              // 可见可交互元素清单（= CLI 的 --dom）
await client.screenshot();                             // → base64 PNG，落盘后直接读图
await launched.stop();
```

两个容易踩的返回值，要检查而不是假设成功：

- `click()` 返回 `method: 'dom'` ⇒ 该元素**用户其实点不到**（被遮挡/不可见），值得追查；
- `fill()` 返回 `matched: false` ⇒ 没真正填进去（受控组件没认这次赋值）。

### 第 4 步：需要连"已经在跑"的应用时，附加而不是重启

很多场景不能重启：dev server 正在跑、要复现用户现场、或者根本不是自己的应用。

```bash
# 前提：那个实例启动时带了 --remote-debugging-port=N（事后无法补开）
node <skill>/scripts/inspect.mjs --attach 9492
node <skill>/scripts/inspect.mjs --attach 9492 --target "设置"   # 多窗口时按标题/URL 子串选窗口
```

`--attach` 只读不写：不改代码、不重启、不动状态。要长期观察就用 `serve.mjs` 起一个带端口的实例。

### 第 5 步：深挖 —— 网络与主进程

**网络**（"页面加载慢 / 接口没调到"）：`Network.enable` 不能回溯已发生的请求，
所以 `--network` 会自动 reload 一次，再统计。

```bash
node <skill>/scripts/inspect.mjs --project <目录> --network
# 输出：请求数 / 失败数 / 传输量 / 失败样本 / 最慢 3 条（含 ms 与类型）
```

**主进程**（IPC、窗口创建、文件 IO、协议注册 —— 这些 renderer 的 CDP 看不到）：

```bash
node <skill>/scripts/main-process.mjs --project <目录>
node <skill>/scripts/main-process.mjs --project <目录> --eval "process.versions.electron"
node <skill>/scripts/main-process.mjs --project <目录> --logs --duration 5
node <skill>/scripts/main-process.mjs --attach 9229 --eval "process.pid"
```

边界（实测，别绕）：inspector 的求值上下文**没有 `require`，也不能动态 `import('electron')`**
（报 `A dynamic import callback was not specified`），所以拿不到 `app.getName()` 这类 API。
要访问它们，只能让应用自己挂到 `globalThis`（如 `globalThis.__main = { app }`），
或用 Debugger 域下断点。

### 第 6 步：把一次性排查固化成回归

排查完不要停在「我试过了」。复制 `assets/e2e-harness.mjs` 到项目的 `tests/e2e/`，
`npm i -D playwright-core`（**不要装 `playwright`**，那会下载几百 MB 浏览器），
然后按项目改三处：`ROOT` 推导、`READY_LOG`、`BASE_ARGS`。

模板已内置四个关键机制，不要绕过：

| 机制 | 解决什么 |
|---|---|
| `e2eEnv()` | 删 `ELECTRON_RUN_AS_NODE`，否则进程退化成裸 Node |
| `waitForAppReady()` | 等业务就绪信号，替代固定 `sleep` |
| `waitForQuiet()` | 工具栏全量重绘会吞点击，点击前等 DOM 静默 |
| `clickUntil()` | 点击后验证后果，被吞时有界重试（三轮不成照样失败） |

## 按症状定位

拿到 `inspect` / `main-process` 的输出后，按症状决定下一步看哪里，不要盲试：

| 症状 | 先看哪个字段 | 大概率是什么 |
|---|---|---|
| 白屏，但 DOM 有内容 | 截图、`DOM 元素数`、`画布` | 还没进主界面（就绪时机）或视图没挂载 —— 加 `--wait-text` |
| 白屏，有 canvas，画面纯色 | `后端能力`、`应用后端` | WebGPU 不可用（Electron < 25 或误加 `--disable-gpu`） |
| 黑屏，连 canvas 都没有 | `后端能力`、`是否有画布` 警告 | renderer 崩了 / 渲染初始化就失败 |
| 点按钮没反应 | `console.error` 条数；用 `--target` 确认窗口对不对 | 事件没绑、被整棵重绘吞掉、选择器过时 |
| 页面加载慢 | `--network` 的 `⏱ 最慢 3 条` | 首屏 JS 体积、串行请求 |
| 数据不对 / 接口没调到 | `--network` 的 `✗ 失败样本` + `main-process --logs` | 请求 4xx/5xx、IPC 没发出去 |
| 启动就退出 | `inspect` 的启动日志 + `main-process --logs` | 单实例锁、缺模块、端口占用、`process.exit` |
| 界面状态不刷新 | 模式机相关按钮的 disabled / 文案 | 全量重绘时序问题（见 `references/pitfalls.md` §7） |

## 版本支持

两个维度要分开看：**跑脚本的 Node** 与**被测的 Electron**。开工前先跑 `doctor.mjs`，
它会打印「脚本运行时」和「版本能力」两行结论，不用自己推。

| 维度 | 可用 | 降级 | 不支持 / 未验证 |
|---|---|---|---|
| 跑脚本的 Node | ≥ 22（原生 WebSocket，零依赖） | 18–20 装 `ws` 可全功能；16 未验证 | ≤ 14.8（语法层跑不起来） |
| 被测 Electron | ≥ 25（CDP + Playwright + WebGPU） | 12–24 可调试但**无 WebGPU**（12.0.18 / 22.3.27 已实测） | < 12 的 Playwright 未实测 |
| 渲染后端 | Electron ≥ 25 / Chromium ≥ 113 才有 WebGPU | 更低版本只有 WebGL | — |

三个硬边界，不要试着绕：

1. `inspect` / `serve` 需要 WebSocket。Node < 22 且没装 `ws` 时它们会**以退出码 2 明确拒绝执行**
   并给出三种解决办法，不会静默降级成半残结果；此时 `doctor.mjs` 仍可用。
2. Electron < 25 没有 WebGPU。此时黑屏**不是**后端配置问题，别去调 `--enable-unsafe-webgpu`。
3. 老版本 Electron 的失败形态和崩溃日志不一样：**页面 target 能拿到、日志无异常，
   但 `Runtime.evaluate` 超时**（实测 Electron 12 不加参数时如此）。这属于「renderer 不可用」，
   启动器的自适应阶梯会识别并降级，不要因为它「没报错」就以为启动成功。

完整矩阵、各版本的具体差异、以及「明确无法支持」的清单见 `references/version-support.md`。

## 渲染后端：先判后选

判定的核心技巧 —— 一个 canvas 只能持有一种 context，用别的类型再取会返回 `null`：

```js
const c = document.querySelector('canvas');
const backend = c.getContext('webgpu') ? 'webgpu'
              : c.getContext('webgl2') ? 'webgl2'
              : c.getContext('webgl')  ? 'webgl1' : 'unknown';
```

三条硬规则：

1. **不要用 `app.getGPUFeatureStatus()` 判断能力**。实测它会报 `webgl: disabled_off`，
   而渲染进程里 WebGL2/WebGPU 完全可用 —— 它反映的是 GPU 进程特性开关。
2. **WebGPU 项目绝不要加 `--disable-gpu`**。实测该参数让 `requestAdapter()` 返回 `null`：
   WebGL 项目只是变慢（还「能用」），WebGPU 项目直接黑屏且可能一条错都不报。
   同理 `--use-angle=swiftshader` 也会让 WebGPU 适配器为 null，只适合纯 WebGL 项目。
3. 判不出来时按 WebGPU 保守处理（不加 `--disable-gpu`），运行后再用第 2 步确认。

参数阶梯与实测矩阵见 `references/gpu-backends.md`。

## 硬性约束

- 启动子进程时**必须删除** `ELECTRON_RUN_AS_NODE`（宿主工具会注入）；
- 受限环境（无独显 / 远程桌面 / 容器 / 沙箱）先加 `--disable-gpu-sandbox`，
  仍崩再加 `--no-sandbox`；这两个参数只用于调试，不要写进发布产物；
- 判断「启动成功」必须做一次真实的 CDP 往返 —— 页面 target 出现不代表活着，
  GPU 崩溃会把 renderer 一起带走；
- **端口分工固定**：`9222` 属于 Chrome / Playwright MCP，`9229` 属于 Node 主进程 inspector，
  Electron renderer 用 `9333+` 或本 skill 默认的 `9492`。撞了就极难排查；
- 已运行的实例**无法事后**开启调试端口，必须带参重启（或用 `serve.mjs` 起一个带端口的实例）；
- 附加 target 时过滤 `devtools://`，否则 eval 到的是空的 DevTools 窗口；
- 断言前先等就绪信号，**不要**用固定 `sleep` 猜时间；
- 不要用 `taskkill /IM <exe>` 这类按映像名全杀的写法 —— 会把用户正在用的实例一起杀掉。
  用 spawn 拿到的 PID 精确结束（`stop()` 内部按进程树杀）；
- **调试端口绝不能带进发布产物**：`--remote-debugging-port` 意味着本机任何进程都能完全控制该应用。
  只在排查/测试时加，构建配置里不要留 `app.commandLine.appendSwitch('remote-debugging-port', ...)`；
- 涉及真实用户数据的操作（打开项目、播放、发布）先确认副作用再执行。

## 参考

- `references/version-support.md` —— Node / Electron 版本矩阵、能力门槛、**明确不支持的清单**
- `references/gpu-backends.md` —— 后端判定顺序、参数矩阵（实测）、失败链、白屏归因
- `references/pitfalls.md` —— 15 条坑，按启动 / 交互 / 断言 / 工程分类，带症状便于反查
