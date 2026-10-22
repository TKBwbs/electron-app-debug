# electron-app-debug

> 一个给 AI 用的 Electron 调试技能：**跑起来 → 看得见 → 点得动 → 验得了**。
> 零依赖、自适应 WebGL / WebGPU 与 Electron 版本。

**English TL;DR** — A zero-dependency agent skill for debugging Electron apps over CDP:
launch with an adaptive flag ladder, detect WebGL vs WebGPU, screenshot what the agent
actually sees, drive the UI (click/fill/press) with readback assertions, inspect the main
process via Node inspector, and turn one-off debugging into a regression test.

```bash
npx skills add TKBwbs/electron-app-debug -s electron-app-debug -g -y
```

---

## 它解决什么

多数「Electron 调试 skill」是 CDP 的薄封装：连上、eval、截图。真正耗时间的不在那儿，
而在这四件事上：

| 卡点 | 本 skill 的做法 |
|---|---|
| 应用起不来（GPU 崩溃 / `ELECTRON_RUN_AS_NODE` / 单实例锁 / 端口占用） | 启动器按参数阶梯自动降级，并把失败**分类**成 `gpu-crash` / `run-as-node` / `no-target` …，每类给一条可执行的下一步 |
| 分不清是"没渲染"还是"没就绪" | 把"就绪"变成可判定信号：canvas 定尺寸 / 面板文案 / 启动日志 / DOM 静默 |
| 不知道黑屏是配置问题还是版本天花板 | 运行时探测真实后端（WebGPU/WebGL2/WebGL1）+ 适配器信息，配一张实测参数矩阵 |
| 改完不知道有没有修好 | `--then` / `clickUntil` 把"动作是否生效"变成退出码与断言 |

它**不是** Playwright 的替代品：要长期回归请用 `assets/e2e-harness.mjs`（Playwright 模板）；
要"看一眼、点一下、查一下"，用这里的零依赖脚本更快。

---

## 安装

### 方式 1：skills CLI（一条命令）

```bash
# 全局安装到所有检测到的 AI 客户端
npx skills add TKBwbs/electron-app-debug -s electron-app-debug -g -y

# 只装到指定客户端，并复制文件（默认是软链）
npx skills add TKBwbs/electron-app-debug -s electron-app-debug -a claude -g -y --copy

# 先看看仓库里有哪些技能，不安装
npx skills add TKBwbs/electron-app-debug -l
```

### 方式 2：git clone + 安装器（不依赖 skills CLI）

```bash
git clone https://github.com/TKBwbs/electron-app-debug.git /tmp/eas \
  && node /tmp/eas/install.mjs --force
```

`install.mjs` 会自动探测本机已有的技能目录并装进去：

```
[workbuddy] C:\Users\you\.workbuddy\skills
[claude]    /Users/you/.claude/skills
```

指定目录、只预览、覆盖旧版：

```bash
node install.mjs --to ~/.your-tool/skills
node install.mjs --list
node install.mjs --dry-run
node install.mjs --force      # 已存在时覆盖
```

安装器会做一次**结构校验**（SKILL.md 存在、`name` 字段匹配），装错包会直接报错，
而不是留一个"看起来装好了但 AI 读不到"的目录。

### 方式 3：手动

把整个目录复制到 `<你的工具>/skills/electron-app-debug/`，确保 `SKILL.md` 在**该目录根**。
装完**重启 AI 客户端**（技能在会话启动时加载）。

### 方式 4：让 AI 自己装（把这段话发给它）

> 请把 `https://github.com/TKBwbs/electron-app-debug` clone 到本机技能目录
> （WorkBuddy 用 `~/.workbuddy/skills/`，Claude Code 用 `~/.claude/skills/`），
> 目录名为 `electron-app-debug`，确认 `SKILL.md` 在该目录根且 frontmatter 里 `name: electron-app-debug`，
> 装完告诉我需不需要重启。

---

## 五个入口，各管一段

| 脚本 | 干什么 | 什么时候用 |
|---|---|---|
| `doctor.mjs` | 静态体检：入口、产物新鲜度、版本能力、后端线索、建议参数、项目雷 | **开工先跑**，秒级、不启动 |
| `inspect.mjs` | 启动（自适应降级）+ 后端探测 + 白屏判据 + console + 截图；`--attach` 只连不起来，`--network` 抓包，`--dom` 列元素 | 要看界面 / 判断后端 / 抓包 |
| `serve.mjs` | 常驻 + 固定调试端口 + 打印 MCP 配置 | 要反复交互 |
| `act.mjs` | 单次动作：`dom` / `click` / `fill` / `press` / `eval` / `wait` / `shot` / `reload` | **"点一下看看"不用写 JS** |
| `main-process.mjs` | 主进程调试（Node inspector）：概况 / `--eval` / `--logs` | IPC、窗口创建、启动即退出 |

```bash
S=~/.workbuddy/skills/electron-app-debug   # 或你的安装位置

node $S/scripts/doctor.mjs    --project /path/to/your-app
node $S/scripts/inspect.mjs   --project /path/to/your-app --wait-text "项目管理"
node $S/scripts/serve.mjs     --project /path/to/your-app --port 9492
node $S/scripts/act.mjs       --attach 9492 click 'text=新建项目' --then '!!document.querySelector(".modal")'
node $S/scripts/main-process.mjs --project /path/to/your-app --eval "process.versions.electron"
```

`inspect.mjs` 的输出长这样：

```
✅ 已启动 /path/to/your-app
  启动参数      --no-sandbox --disable-gpu-sandbox
  启动耗时      605ms（已降级）
  引擎         Chromium 128.0.6613.186 / Electron 32.3.3
  画布         1 个 → 832x538:webgpu
  后端能力      webgpu=true webgl2=true webgl1=true
  应用后端      webgpu
  GPU 适配器    nvidia/turing
  错误         console.error 0 条 / 异常 0 条
  网络         7 个请求 / 0 失败 / 5300 KB
截图: .../artifacts/electron-inspect-*.png
```

---

## 自适应：WebGL 还是 WebGPU

判定的核心技巧 —— 一个 canvas 只能持有一种 context，用别的类型再取会返回 `null`，
所以可以反查**应用真正在用哪个后端**：

```js
const c = document.querySelector('canvas');
const backend = c.getContext('webgpu') ? 'webgpu'
              : c.getContext('webgl2') ? 'webgl2'
              : c.getContext('webgl')  ? 'webgl1' : 'unknown';
```

三条硬规则（都是实测算出来的，不是文档复述）：

1. **不要用 `app.getGPUFeatureStatus()` 判断能力**。它可能报 `webgl: disabled_off`，
   而渲染进程里 WebGL2/WebGPU 完全可用 —— 它反映的是 GPU 进程特性开关。
2. **WebGPU 项目绝不要加 `--disable-gpu`**。实测该参数让 `requestAdapter()` 返回 `null`：
   WebGL 项目只是变慢（还"能用"），WebGPU 项目直接黑屏且可能一条错都不报。
3. 启动参数按阶梯降级，且**只在判定为渲染不可用时**降级：

```
[]  →  [--disable-gpu-sandbox]  →  [--no-sandbox --disable-gpu-sandbox]
```

| 参数组合 | WebGL2 | WebGPU `requestAdapter()` |
|---|---|---|
| `--no-sandbox --disable-gpu-sandbox` | ✅ | ✅ 返回硬件适配器 |
| 无任何参数（受限环境） | ❌ GPU 进程崩溃 | ❌ |
| `+ --use-angle=swiftshader` | ✅ 软件渲染 | ❌ **返回 null** |
| `--disable-gpu` | ✅ 软件渲染 | ❌ **返回 null** |

---

## 版本支持

两个维度分开看：**跑脚本的 Node** 与**被测的 Electron**。

| 跑脚本的 Node | `doctor` | `inspect` / `serve` / `act` |
|---|---|---|
| ≥ 22 | ✅ | ✅ 原生 WebSocket，零依赖 |
| 18 – 20 | ✅ | ⚠️ 需在项目里 `npm i -D ws`（实测 Node 20.18.1 + ws 8.22 全功能通过） |
| 16 | ✅ | ⚠️ 需 `ws`，未充分验证 |
| ≤ 14.8 | ❌ | ❌ 语法层跑不起来 |

| 被测 Electron | CDP 调试 | Playwright E2E | WebGPU |
|---|---|---|---|
| 32.3.27（实测） | ✅ | ✅ | ✅ |
| 25 – 32 | ✅ | ✅ | ✅ |
| 22.3.27（实测） | ✅ | — | ❌ |
| 12.0.18（实测） | ✅ | ✅ 实测可用 | ❌ |
| ≤ 24 | ✅ | 未实测 | ❌ 版本天花板，调参无效 |

> 实测记录：Electron **12.0.18** 配 playwright-core **1.64.1** 可以正常 launch / 取标题 / 读 DOM / 截图。
> 尽管 Playwright 官方支持列表只写到 12.2+/13.4+/14+ —— 官方没列的版本，先试再说。

完整矩阵与「明确不适用」清单见 [`references/version-support.md`](references/version-support.md)。

---

## 已知限制（不粉饰）

- **Node ≤ 14.8 不支持**；Node 18–20 需要项目里有 `ws` 才能连 CDP，否则只有 `doctor` 可用。
- **Electron < 25 没有 WebGPU**（Chromium < 113）。此时黑屏是版本天花板，不是配置问题。
- **主进程 inspector 里没有 `require`**，也不能 `import('electron')`，
  所以拿不到 `app.getName()` 这类 API。要访问只能让应用挂到 `globalThis`，或用 Debugger 域。
- **打包后的 asar 安装包未验证**，建议把 `--project` 指向开发目录、跑构建产物。
- **截图偶发卡死**：`Page.captureScreenshot` 有时会超时（`Runtime.evaluate` 仍正常），
  说明 renderer 合成器卡住。已内建一次重试 + `act.mjs reload` 恢复，但**根因未定位**。
- **`el.click()` 的取舍**：默认发真实鼠标事件（会走命中测试，能暴露"按钮被浮层盖住"），
  元素不可见时才退回 `el.click()`，并在返回值里标 `method: 'dom'` —— 看到它就该警惕。

---

## 与同类项目的差异

| 项目 | 它擅长 | 本 skill 的取舍 |
|---|---|---|
| agent-browser 系（`*skills/electron`） | 控制第三方应用，snapshot/ref 交互 | 不引入 agent-browser 依赖，自带 CDP 客户端；补上"启动体检 / 主进程 / 回归" |
| [electron-cdp-automation](https://github.com/blessleon/electron-cdp-automation) | 总结 4 个必踩坑（load 事件、上下文销毁、`:has-text`、受控组件） | 全部吸收；但不用 `el.click()` 当默认（会掩盖遮挡类 bug） |
| Playwright `_electron` | 长期回归、可操作性检查最完善 | 提供 `assets/e2e-harness.mjs` 模板，而不是强制依赖 |

---

## 目录结构

```
electron-app-debug/
├── SKILL.md                  # 技能主文档（AI 读这个）
├── install.mjs               # 跨平台安装器（含结构校验）
├── scripts/
│   ├── doctor.mjs            # 静态体检
│   ├── inspect.mjs           # 启动 + 探测 + 截图（--attach / --network / --dom）
│   ├── serve.mjs             # 常驻（--attach 只连不启）
│   ├── act.mjs               # 单次动作
│   ├── main-process.mjs      # 主进程调试
│   └── lib/
│       ├── cdp.mjs           # 零依赖 CDP 客户端（启动/附加/求值/截图/点击/填表/抓包）
│       └── compat.mjs        # Node / WebSocket / fetch 版本兼容层
├── assets/
│   └── e2e-harness.mjs       # 复制进项目的 Playwright 模板
└── references/
    ├── gpu-backends.md       # 后端判定 + 参数矩阵（实测）
    ├── version-support.md    # Node / Electron 版本矩阵
    └── pitfalls.md           # 26 条坑，按症状反查
```

---

## 安全提醒

`--remote-debugging-port` 意味着**本机任何进程都能完全控制该应用**。
只在排查/测试时加；构建配置里不要保留
`app.commandLine.appendSwitch('remote-debugging-port', ...)`。

同时：调试端口有固定分工，撞了极难排查 —— `9222` 归 Chrome / Playwright MCP，
`9229` 归 Node 主进程 inspector，Electron renderer 用 `9333+` 或本 skill 默认的 `9492`。

---

## License

MIT
