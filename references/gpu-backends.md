# 渲染后端：WebGL vs WebGPU 的判定与参数选择

以下数据来自实测（Windows 11 + Electron 32 + NVIDIA Turing 独显、但运行在受限沙箱里），
不是文档复述。遇到反直觉行为时先看这张表。

## 1. 判定顺序（从可靠到不可靠）

| 手段 | 可靠性 | 说明 |
|---|---|---|
| `canvas.getContext()` 试探 | ✅ 高 | 见下方「判定的核心技巧」，能同时判断**能力**与**应用实际用了哪个** |
| `navigator.gpu.requestAdapter()` | ✅ 高（WebGPU 侧） | 返回 `null` = WebGPU 真的不可用；非 null 时读 `adapter.info.vendor/architecture/isFallbackAdapter` |
| 源码静态扫描 | 🟡 中 | `three/webgpu`、`WebGPURenderer`、`navigator.gpu`、`WebGLRenderer`、`getContext('webgl2')` |
| `app.getGPUFeatureStatus()` | ❌ 低 | **实测会误导**：本机它报 `webgl: disabled_off`、`webgpu: disabled_off`，但渲染进程里 WebGL2 与 WebGPU 都完全可用。它反映的是 GPU 进程特性开关，不是渲染进程能力 |

### 判定的核心技巧

一个 canvas 只能持有一种 context；用别的类型再 `getContext()` 会返回 `null`。
所以可以这样反查「应用真正在用哪个后端」：

```js
const c = document.querySelector('canvas');
const backend = c.getContext('webgpu') ? 'webgpu'
              : c.getContext('webgl2') ? 'webgl2'
              : c.getContext('webgl')  ? 'webgl1'
              : 'unknown';
```

实测验证（同一台机器）：

| canvas 已有 context | 再取 `webgpu` | 再取 `webgl2` | 再取 `webgl` |
|---|---|---|---|
| webgpu | true | false | false |
| webgl2 | false | true | — |
| webgl1 | false | false | true |

注意顺序：先判 `webgpu`，再 `webgl2`，最后 `webgl`。反过来会把 webgl1 误判成 webgl2。

## 2. 启动参数矩阵（实测）

| 参数 | WebGL2 | WebGPU `requestAdapter()` | 结论 |
|---|---|---|---|
| `--no-sandbox --disable-gpu-sandbox` | ✅ 可用 | ✅ 返回适配器（vendor=nvidia/turing） | **推荐基线** |
| 无任何参数 | ❌ GPU 进程崩溃 | ❌ 进程已挂 | 受限环境直接不可用 |
| `+ --enable-unsafe-webgpu` | ✅ | ✅ 同上（本机无增益） | 无害，个别环境能开软适配器 |
| `+ --use-angle=swiftshader --enable-unsafe-swiftshader` | ✅ 软件渲染 | ❌ 返回 **null** | 只适合纯 WebGL 项目 |
| `--disable-gpu` | ✅ 软件渲染 | ❌ 返回 **null** | **WebGPU 项目禁用此参数** |

### 最要命的一条

`--disable-gpu` 是很多人「启动崩溃」时的第一反应，但对 WebGPU 应用是**静默致命**：

- WebGL 应用：画面变得很慢，但看起来「还能用」；
- WebGPU 应用：`requestAdapter()` 返回 `null`，渲染器初始化失败 → 黑屏/白屏，
  **控制台可能一条错都没有**（取决于框架的降级逻辑）。

所以：先判后端，再选参数。判不出来时按 WebGPU 保守处理（即不加 `--disable-gpu`）。

## 3. 受限环境的典型失败链

无独显 / 远程桌面 / 容器 / 沙箱受限时，启动过程是：

```
1. 主进程正常启动，日志一路打到 "initialized"
2. 页面 target 出现（CDP /json/list 里能看到）
3. GPU 进程以 0xC0000005 反复崩溃
4. renderer 被一起带走 → CDP 报 "Target crashed"
5. 若无人监听，主进程打出 FATAL: GPU process isn't usable. Goodbye.
```

**关键点**：第 2 步会让「启动成功」的判断失效。
只看 `electron.launch()` 是否返回，会误判成成功，随后所有操作全崩。
所以必须做一次真实的 CDP 请求/响应往返（本 skill 的 `launchAdaptive` 就是干这个的），
并按阶梯 `[] → [--disable-gpu-sandbox] → [--no-sandbox --disable-gpu-sandbox]` 降级。

### 老版本还有第二种失败形态：静默不可用

Electron 12.0.18（Chromium 89）在**不加任何沙箱参数**时：

```
1. 主进程正常启动，DevTools listening 正常打印
2. /json/list 里有页面 target，WebSocket 也能连上
3. 但 Runtime.evaluate 永不返回（日志里没有任何报错）
4. 加上 --disable-gpu-sandbox 后立刻正常
```

所以判定「renderer 可用」不能只看「target 存在 + WebSocket 连上」，
还要完成一次求值往返；并且**每个 CDP 请求都要有超时**，
否则表现为「脚本卡死、无输出」，比报错难查得多。

## 4. 判断「到底是资源问题还是渲染问题」

| 现象 | 更可能的原因 |
|---|---|
| 白屏但 DOM 有内容、无 canvas | 还没进主界面（等待时机问题），或路由/视图没挂载 |
| 白屏、有 canvas、`requestAdapter()` 返回 null | WebGPU 不可用（检查是否误加 `--disable-gpu`） |
| 有 canvas 但画面纯色 | 相机/场景为空、尺寸为 0、或渲染循环没启动 |
| 截图 < 8KB | 基本是纯色画面，别怀疑「是不是截错窗口」 |
| `console.error` 为 0 但界面不对 | 断言的时机问题，不是渲染问题 —— 加就绪等待 |

## 5. 软件渲染下的性能预期

- WebGL + SwiftShader：能出图，帧率个位数到十几；
- WebGPU + 真实适配器（即使 `--disable-gpu-sandbox`）：通常几十帧；
- 性能数字不要拿来做验收基线，只用来判断「是否在动」。
