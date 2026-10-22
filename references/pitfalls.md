# Electron 调试坑清单

按「启动 / 交互 / 断言 / 工程」四类。每条都带症状，方便从现象反查。

## 一、启动类

### 1. `ELECTRON_RUN_AS_NODE=1` 让 electron 退化成裸 Node

**症状**：`electron .` 报
`TypeError: Cannot read properties of undefined (reading 'exports')`，栈顶是
`cjsPreparseModuleExports (node:internal/modules/esm/translators)`；
或者 Playwright 报 `Process failed to launch!`。

**原因**：WorkBuddy / VS Code 这类 Electron 工具链会把 `ELECTRON_RUN_AS_NODE=1`
注入集成终端。带着它执行，electron 不启 Chromium，而是当作 node 跑你的脚本。

**解法**：启动前从子进程 env 里 `delete env.ELECTRON_RUN_AS_NODE`。
本 skill 的脚本已内置；手写命令时用 `env -u ELECTRON_RUN_AS_NODE electron .`。

### 2. GPU 进程崩溃导致启动卡死或 renderer 挂掉

**症状**：stderr 刷 `GPU process exited unexpectedly: exit_code=-1073741819`（即 `0xC0000005`），
最终 `FATAL: GPU process isn't usable. Goodbye.`；或页面 target 出现了但立刻 `Target crashed`。

**解法**：按阶梯加参数 `--disable-gpu-sandbox` → `--no-sandbox --disable-gpu-sandbox`。
**不要**用 `--disable-gpu`（会杀死 WebGPU 适配器，见 `gpu-backends.md`）。

### 3. 单实例锁让第二个实例直接退出

**症状**：测试启动后进程瞬间结束，没有窗口，日志里也没有明显错误。

**原因**：主进程调了 `requestSingleInstanceLock()`，而测试实例和开发实例共用同一个 userData。

**解法**：启动时传独立的 userData 目录：
`--user-data-dir=<临时目录>`（Chromium 层）或让主进程读 `setPath('userData', ...)` 环境变量。
同时避免测试与开发实例抢同一份缓存、同一份单实例锁。

### 4. 端口占用（应用自带本地服务时）

**症状**：应用能开，但资源加载失败、图片 404、场景加载不出来。

**原因**：很多 Electron 编辑器内置 file server / WebSocket 桥，端口写死。
第二个实例启动时 EADDRINUSE，但代码里通常 `.catch(() => {})` 吞掉了。

**解法**：把端口做成环境变量（如 `DT_FILE_PORT` / `DT_WS_PORT`），或保证测试串行。

### 5. 开发模式启动走 dev server，产物启动走 dist

**症状**：Playwright 启动后白屏，日志里有 `ERR_CONNECTION_REFUSED`。

**原因**：主进程里 `if (process.env.VITE_DEV_SERVER_URL) loadURL(...)`，但没起 vite。

**解法**：二选一 ——（a）先跑构建产物，并把 `VITE_DEV_SERVER_URL` 从 env 里删掉；
（b）先起 dev server 再启动 electron。本 skill 默认走 (a)，并在 `launchEnv` 里删掉该变量。

### 6. `openDevTools()` 会多出一个 page target

**症状**：CDP 的 `/json/list` 里第一个 page 是
`devtools://devtools/bundled/devtools_app.html...`，对它 `Runtime.evaluate` 得到空结果，
截图是一张空的 DevTools 窗口。

**解法**：附加时过滤掉 `url` 以 `devtools://` 开头的 target（`lib/cdp.mjs` 已处理）；
更好的做法是让主进程在测试模式下跳过 `openDevTools()`（用 `E2E` 环境变量控制）。

## 二、交互类

### 7. 全量重绘会吞掉点击（最隐蔽的偶发源）

**症状**：E2E 偶发「点了按钮完全没反应」，无报错、无状态变化；复跑又通过（实测约 1/3）。

**原因**：工具栏/面板在状态变化（`TOOL_CHANGED` / `HISTORY_CHANGED` / 模式切换）时
**整棵重绘**，节点被替换。点击恰好落在重绘窗口，就点到已分离的节点上。

**解法**：点击前等 DOM 静默（MutationObserver 连续 N ms 无变动），点击后验证后果，
被吞时有界重试。见 `assets/e2e-harness.mjs` 的 `waitForQuiet` / `clickUntil`。

### 8. 按坐标点击对「隐藏但存在」的元素无效

**症状**：元素在 DOM 里、选择器能选中、`click` 不报错，但什么也没发生。

**检查**：宽高为 0、`display:none`、`visibility:hidden`、被遮挡、或在视口外。
CDP 的 `Input.dispatchMouseEvent` 只按坐标派发，**不会**自动滚动或做可操作性检查
（Playwright 的 `click()` 会，这是两者的关键差异）。

### 9. 键盘快捷键与按钮走的是两条链路

同一个动作如果既有按钮又有快捷键，两者可能绑到不同的 handler。
排查「按钮没反应」时顺手试一下快捷键：**快捷键能跑说明业务逻辑没问题，问题在绑定或重绘**。

## 三、断言类

### 10. 异步装配的界面不能「点完就断言」

**症状**：断言「面板不存在」，但截图一看是「只有工具栏的半成品」，再等两秒就正常。

**原因**：布局系统（golden-layout 等）先建容器，再异步插面板；视角/场景加载又是另一轮。

**解法**：等**业务级就绪信号** —— 视口 canvas 定尺寸、面板文案出现、启动日志打印 ——
而不是固定 sleep，也不是只看「主容器挂载了」。

### 11. 轮询回填的数值不能立刻读

**症状**：`#debug-entities` 读到 0，但一秒钟后是 9。

**解法**：`waitForFunction(值满足条件)`，而不是「读一次然后断言」。

### 12. 断言构建产物的用例与 build 不能并行

**症状**：改完代码跑测试，一堆「产物里缺少 xxx 文件」；单独跑又全过。

**原因**：`vite build` 的 `emptyOutDir` 正在清 `dist/`。

**解法**：串行执行；并加构建新鲜度检查（src 比 dist 新就 WARN）。

## 四、工程类

### 13. 构建被安全删除拦截器打断

**症状**：`npm run build` 报
`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`，且 `dist/` 被清了一半。

**原因**：构建工具递归删 `dist/`，文件数超过宿主工具（WorkBuddy）的安全删除阈值。

**解法**：先把旧产物移出项目再构建（`mv` 不触发删除拦截）：
`mv dist /tmp/old-dist && npm run build`。普通终端没有这个问题。

### 14. 原生模块 ABI 不匹配

**症状**：`Error: Cannot find module '../build/Release/xxx.node'` 或
`NODE_MODULE_VERSION xxx` 不匹配。

**解法**：`npx electron-rebuild -f -w <模块>`；或确认没有在 Node 下直接 require 只能在 Electron 里用的模块。

### 15. macOS 代码签名 / Windows Defender 首次启动

**症状**：CI 上能跑，本机第一次启动卡很久或直接被拦。

**解法**：Windows 把 electron.exe 加入白名单；macOS 本地调试用未签名构建并允许「仍要打开」，
CI 上注意公证与 `--no-quarantine`。

## 五、版本类

### 16. `inspect.mjs` 立刻退出、退出码 2

**症状**：什么都没做就打印「当前 Node 没有 WebSocket 能力」，退出码 2。

**原因**：Node < 22 没有全局 `WebSocket`，且项目里没有 `ws` 包 —— CDP 连不上。

**解法**：换 Node 22+，或在项目里 `npm i -D ws`。此时 `doctor.mjs` 仍然可用（纯静态）。
详见 `version-support.md`。

### 17. WebGPU 项目在黑屏，但 Chromium 版本是 114 以下

**症状**：`navigator.gpu` 是 `undefined`，控制台没有任何 WebGPU 相关报错。

**原因**：Chromium 113 才开始在桌面端启用 WebGPU，对应 Electron 25+。
**这是版本天花板，不是配置问题** —— 调 `--enable-unsafe-webgpu` 没用。

**确认**：`inspect.mjs` 的「引擎」一行会打印 `Chromium x.y.z`，
低于 113 时会直接标注 `（<113 无 WebGPU）`。

### 18. 老版本 Electron：页面能附加，但 `Runtime.evaluate` 超时

**症状**：CDP 能连上、`/json/list` 里也有页面，但第一次求值就卡住（没有超时的话会永久挂起），
日志里没有任何异常。

**原因**：实测 Electron **12.0.18** 在不加任何沙箱参数时就是这个表现 —— renderer 实际不可用，
但不像新版本那样直接打 GPU 崩溃日志。加 `--disable-gpu-sandbox` 后一切正常。

**解法**：

- 用 `inspect.mjs` 的自适应阶梯（已把这种情况归类为 `unresponsive` 并自动降级）；
- 自己写脚本时务必给每个 CDP 请求加超时，否则是「脚本卡死且无输出」这种最难查的形态；
- 不想折腾就用 `--flags "--disable-gpu-sandbox"` 明确指定。

### 19. 以为「官方支持列表外 = 不可用」

**反例**：Playwright 文档只列 Electron 12.2+/13.4+/14+，但实测 **12.0.18 完全可用**。
同理 `--enable-unsafe-swiftshader` 之类的开关，老 Chromium 只是「不认」，通常无害。

**结论**：官方没列的版本先跑一次再下判断。`doctor.mjs` 对这类情况输出 `⚠️ 未验证` 而不是 `❌ 不支持`，
就是为了不把「没试过」说成「做不到」。

### 20. 想调试第三方 Electron 应用（Obsidian / Discord / VS Code…）

这类应用同样基于 Chromium，一样能用 CDP，但有两个硬性前提：

1. **必须带 `--remote-debugging-port` 启动**，事后无法补开；
2. 多数应用有单实例锁，**要先完全退出**（含托盘），否则新参数会被旧实例吞掉。

```bash
# Windows
"C:\Users\<you>\AppData\Local\Obsidian\Obsidian.exe" --remote-debugging-port=9333
# macOS
/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=9333
# Linux
obsidian --remote-debugging-port=9333
```

然后 `node scripts/inspect.mjs --attach 9333`。

注意：

- **不要用 `taskkill /IM Obsidian.exe /F`** 这类按映像名全杀的写法 —— 可能连带用户未保存的会话一起杀掉；
  让用户自己退出，或按 PID 精确结束；
- 应用自动更新后会换 exe 路径（Windows 上常见 `app-<version>` 目录），写死的注册表会失效；
- 第三方应用通常开了 `contextIsolation`，能 eval 的只有页面上下文，碰不到 preload 暴露之外的东西；
- 打包应用的主进程一般没有 `--inspect`，主进程调试只能对自己构建的应用做。

## 六、交互进阶：CDP 自动化的四个必踩坑

这一组坑的共同点：**都不报错**，只是"看起来对、实际没生效"。全部实测过。

| 症状 | 原因 | 对策 |
|---|---|---|
| `await` 永久挂起，无错误 | `Page.loadEventFired` 在 `Page.enable()` 之前就发过了 | **不要**等 load 事件；轮询 URL + 目标元素 |
| `Execution context was destroyed` | 真实导航销毁了 JS 上下文（SPA hash 路由不会） | `evaluate` 内建一次重连/重试 |
| `Failed to execute 'querySelector'` | 用了 Playwright 的 `:has-text()` / `text=` | 原生 CSS + JS 文本过滤（本 skill 已内建翻译） |
| 输入框显示正确，提交却是旧值 | Vue/React 监听 `input` 事件，不是 `value` 属性 | 原生 setter + input/change/blur 事件链 + **回读断言** |

### 21. 等 load 事件 = 永久挂起

Electron 首个 HTML 在启动瞬间就加载完了，`load` 早于你的 `Page.enable()`。
网上 Puppeteer 教程里的 `waitForNavigation` 不要搬到裸 CDP 上。

正确做法是轮询「URL + 目标元素同时满足」，本 skill 的 `waitFor()` 就是这个思路。
判据要**同时**看 URL 与元素：登录跳转后 URL 对了，DOM 往往还没渲染完。

### 22. 上下文销毁后必须重试一次

`location.reload()`、登录跳转、`boot.html → index.html` 都会销毁执行上下文。
此时 `Runtime.evaluate` 报 `Execution context was destroyed`，但 WebSocket 还活着 ——
等价于「换个上下文重发」即可。本 skill 的 `evaluate()` 已内建**一次**重试（不无限重试，
页面自己抛的业务异常不重试）。

### 23. `:has-text()` / `text=` 不是 CSS

`document.querySelector('button:has-text("提交")')` 直接抛 SyntaxError。
本 skill 的 `click` / `fill` / `describe` 已内建翻译，两种写法都支持：

```js
await client.click('text=提交');            // 按文本
await client.click('button:has-text("提交")'); // 按文本 + 限定标签
```

**文本匹配要取最深命中**，否则 `querySelectorAll('*')` 的第一个命中永远是 `<html>`
（整页文本都包含目标词）。另外中文按钮常被排版成「确 定」带空格，文本匹配前先
用 `--dom` 看真实文案。

### 24. 表单：赋值 ≠ 填写

直接 `el.value = 'xxx'` 会让页面**看起来是对的**，但受控组件提交时仍用旧值。
必须：清空 → 走**原生 value setter** → dispatch `input` → `change` → `blur` → **回读比对**。
本 skill 的 `fill()` 全部内建，返回 `matched` 字段；`matched: false` 就是没填进去。

实测（首页搜索框）：`fill('#search-projects', 'Demo')` 后可见卡片 3 → 1，清空后恢复 3 ——
这说明事件链真的被应用的事件监听吃到了，而不只是改了 DOM 属性。

### 25. 点击：坐标点击 vs `el.click()`

两者不可互换，别只用一个：

| | 真实鼠标事件（`Input.dispatchMouseEvent`） | `el.click()` |
|---|---|---|
| 走命中测试 | ✅ 能暴露「被浮层盖住」这类真 bug | ❌ 能点穿一切遮挡 |
| 受滚动/视口影响 | 需要先 `scrollIntoView` | 不受影响 |
| 触发事件 | `mousedown/mouseup/click` 完整序列 | 只有 `click` |

本 skill 的 `click()` 默认 `mode: 'auto'`：能拿到坐标就发真实事件，不可见时退回 `el.click()`，
返回值里的 `method` 字段标明用了哪条路 —— 看到 `method: 'dom'` 就该警惕：那个元素用户其实点不到。

### 26. 截图超时，但页面 JS 还能跑

**症状**：`Page.captureScreenshot` 一直等到超时（20s），而 `Runtime.evaluate` 正常返回。

**含义**：不是 CDP 协议不支持，而是 **renderer 合成器卡住**了 —— JS 主线程活着，出不了帧。
别把它误判成"版本太老不支持截图"。

**实测记录**（2026-10）：「打开模态弹窗 → 对 body 发 Escape → 截图」这个序列在两次会话里
连续失败（第二次截图也失败，属持续卡住），但同样操作再跑三次都正常 —— **无法稳定复现，
未定位到根因**。因此这里只给恢复办法，不编造原因：

1. `node scripts/act.mjs reload` 重载页面（多数情况恢复）；
2. 重载无效就重启应用；
3. 本 skill 的 `screenshot()` 已内建一次重试，并在最终失败时提示上述路径。

**排查提示**：如果每次都在同一个交互后卡住，先怀疑该交互触发的 CSS 动画/`backdrop-filter`
图层、或它调用了会让渲染挂起的原生接口（`showModal` / `alert` / 全屏切换）。

### 写交互脚本前的自检清单（出现任一条就停下改）

- 用 `Page.loadEventFired` / `domContentEventFired` 判就绪
- 选择器里出现 `:has-text(`、`text=`、`>>`（本 skill 支持前两种，`>>` 不支持）
- `evaluate` 没有上下文重试分支（自定义脚本时）
- 填完输入框没有回读断言
- 用固定 `sleep(3000)` 代替轮询等待
- 没跑 `--dom` 就凭想象写选择器（猜选择器是失败的头号原因）
