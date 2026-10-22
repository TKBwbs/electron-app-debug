# 版本支持矩阵

本 skill 的脚本跑在**系统 Node** 上（不是 Electron 内置的 Node），
所以要区分两个版本维度：**跑脚本的 Node** 和 **被测的 Electron**。

先自查：

```bash
node <skill>/scripts/doctor.mjs --project <项目目录>
```

它会打印「脚本运行时」与「版本能力」两块，直接告诉你哪些能力不可用、原因是什么。

---

## 一、跑脚本的 Node（决定 inspect / serve 能不能用）

| Node | `doctor.mjs`（静态） | `inspect.mjs` / `serve.mjs`（需要连 CDP） | 说明 |
|---|---|---|---|
| ≥ 22 | ✅ | ✅ | 原生 `globalThis.WebSocket`，零依赖（推荐） |
| 21 | ✅ | ⚠️ 需 `--experimental-websocket` | 不作为支持目标；建议升到 22 |
| 18 – 20 | ✅ | ⚠️ 需 `npm i -D ws` | 无全局 `WebSocket`，走 `ws` 回退（**实测 20.18.1 + ws 8.22 跑通**） |
| 16 | ✅ | ⚠️ 需 `ws`，且**未验证** | 无 `fetch` 时内部走 `http.request` 回退；ESM/顶层 await 可用 |
| ≤ 14.8 | ❌ | ❌ | 不支持 top-level await，`.mjs` 直接语法报错 |
| Deno / Bun | ⚠️ | ⚠️ | 有全局 `WebSocket`，但 `node:http` 等内置模块的兼容层未验证 |

`ws` 的解析顺序：目标项目 `node_modules` → skill 自身 `node_modules` → `NODE_PATH`。
所以三种装法都认：装到项目里、装到 skill 目录、或全局 `NODE_PATH` 指向。

**不支持时的表现**（不是默默失败）：`inspect/serve` 会以退出码 `2` 结束，并打印三选一的解决办法。

---

## 二、被测的 Electron（决定「哪些结论成立」）

| Electron | CDP 调试（inspect/serve） | Playwright `_electron` E2E | WebGPU | 备注 |
|---|---|---|---|---|
| 32.3.27（实测） | ✅ | ✅ | ✅ | Chromium 128；需降级到 `--no-sandbox --disable-gpu-sandbox` |
| ≥ 25 | ✅ | ✅ | ✅ | Chromium ≥ 114，推荐 |
| 22.3.27（实测） | ✅ | 未单独测 | ❌（实测 `webgpu=false`） | Chromium 108；同样需 `--no-sandbox --disable-gpu-sandbox` |
| 21 – 24 | ✅ | ✅ | ❌ | 无 WebGPU：**黑屏不要往渲染后端方向查** |
| 14 – 20 | ✅ | ✅ | ❌ | `--enable-unsafe-swiftshader`（Chromium 105+）不认，用 `--use-angle=swiftshader` |
| 12（12.0.18 实测） | ✅ | ✅ **实测可用** | ❌ | Chromium 89；只需 `--disable-gpu-sandbox` 一档即可 |
| 5 – 11 | ✅ | 未实测 | ❌ | 官方支持列表里没有；先试 Playwright，失败退回 CDP |

> **修正记录**：早前版本把「Electron ≤12」标为「Playwright 不可用」，这是照搬官方支持列表
> （12.2+/13.4+/14+）的推断，**实测被推翻**：Electron **12.0.18** 配 playwright-core **1.64.1**
> 可以正常 `launch` / 取标题 / 读 DOM / 截图。结论改成「官方未列，但先试再说」。

判断「Electron 是哪个版本」，三条来源优先级：

1. `node_modules/electron/package.json` 的 `version`（**实际安装**，最准）；
2. `package.json` 的 `dependencies.electron` 范围（只是声明）；
3. 运行期从 `navigator.userAgent` 读 `Chrome/x.y.z`（`inspect.mjs` 会打印「引擎」一行）。

---

## 三、明确无法支持 / 未验证的情形

写完这部分是为了让失败可预期，而不是让脚本在奇怪环境下给出**看起来正常**的结论。

| 情形 | 结论 | 替代做法 |
|---|---|---|
| Node ≤ 14.8 | **不支持**（语法层就跑不起来） | 升级 Node；或在 CI 里单独准备一个 22 |
| Node 16 + 无 `ws` | 只有 `doctor` 可用 | 装 `ws`；或换 Node 22 跑 `inspect` |
| Electron ≤ 24 | **WebGPU 不可用**（不是配置问题） | 按 WebGL 项目排查；不要加 `--enable-unsafe-webgpu` 折腾 |
| Chromium < 113 | 同上，`navigator.gpu` 不存在 | 同上 |
| Electron < 12 | **Playwright 未实测**（不是已知不行） | 先试；失败改用 CDP 方案（`serve.mjs`） |
| 应用使用 `show: false` 且从不创建窗口 | 拿不到 page target，`no-page` | 改代码临时 `show: true`，或先 `loadURL` 再显示 |
| 应用主进程在启动早期 `process.exit()` | 同上 | 看 `inspect` 打印的最后日志定位退出原因 |
| 打包后的安装包（asar） | 未验证 | `--project` 指向**开发目录**，用 `npm run build` 产物启动；对已安装包只能试 `--app` 方式 |
| 需要登录/许可证的多窗口应用 | 只能验证首窗 | 先用 `serve.mjs` 手动走完登录，再用 CDP 继续 |

### 一个反例：不要照搬「官方支持列表」

Playwright 文档只列 Electron 12.2+/13.4+/14+，但**实测 12.0.18 完全可用**。
所以遇到「官方没列」的版本，正确做法是**跑一次试试**，而不是提前下结论。
这也是为什么 `doctor.mjs` 对这类情况输出 `⚠️`（未验证）而不是 `❌`（不支持）。

---

## 四、`--remote-debugging-port` 的版本差异

- Electron 全系支持 Chromium 的 `--remote-debugging-port`，`/json/version`、`/json/list`、
  `Page.captureScreenshot`、`Runtime.evaluate` 在 Chromium 60+ 行为稳定；
- 较新 Chromium 需要 `--remote-allow-origins`（WebSocket 握手校验来源），
  否则 `serve.mjs` 这类附加可能被拒。本 skill 的启动器**没有**默认加它 ——
  若遇到 403/握手被拒，手动补：`--flags "--disable-gpu-sandbox --remote-allow-origins=*"`；
- `chrome-devtools-mcp` 依赖的 CDP 方法随 Chromium 版本增减，
  老 Chromium（< 100）上部分工具会失败，属上游限制。
