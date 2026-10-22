/**
 * cdp.mjs —— 零依赖的 Electron 启动 + CDP 控制库
 *
 * 设计目标：**不给目标项目装任何依赖**。
 *   · 用 Node 18+ 内置的 fetch/WebSocket 直连 Chromium DevTools Protocol；
 *   · 用 `node_modules/electron/path.txt` 定位可执行文件，不 require electron；
 *   · 对「启动失败」做分类，交给调用方决定要不要降级启动参数。
 *
 * 为什么不直接用 Playwright：Playwright 更好用，但需要项目装 `playwright-core`。
 * 排查别人项目（或只需看一眼截图）时，装依赖这件事本身就是成本。
 * 需要写正式 E2E 时再复制 `assets/e2e-harness.mjs`（Playwright 版）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { httpJson, openWebSocket } from './compat.mjs';

/** 取一个空闲本地端口。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 定位项目的 electron 可执行文件。
 * 优先读 `node_modules/electron/path.txt`（electron 官方包用它记录二进制相对路径），
 * 不 require electron —— 避免 ESM/CJS 与 ELECTRON_RUN_AS_NODE 的相互干扰。
 *
 * @returns {{ exe: string, source: string }}
 */
export function findElectronBinary(projectDir) {
  const electronDir = join(projectDir, 'node_modules', 'electron');
  const pathFile = join(electronDir, 'path.txt');

  if (existsSync(pathFile)) {
    const rel = readFileSync(pathFile, 'utf8').trim();
    const exe = join(electronDir, 'dist', rel);
    if (existsSync(exe)) return { exe, source: 'node_modules/electron/path.txt' };
  }

  // 兼容个别包管理器把二进制放在 .bin 下
  const bin = process.platform === 'win32' ? join(projectDir, 'node_modules', '.bin', 'electron.cmd') : join(projectDir, 'node_modules', '.bin', 'electron');
  if (existsSync(bin)) return { exe: bin, source: 'node_modules/.bin/electron' };

  const err = new Error(
    `在 ${projectDir} 找不到 electron 可执行文件。\n` +
      '  请确认：1) 已在该目录执行 npm install；2) electron 是 devDependency；\n' +
      '  国内网络装不上二进制时设置 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 后重装。',
  );
  err.reason = 'no-electron';
  throw err;
}

/**
 * 构造子进程环境。
 *
 * ⚠️ 必须删掉 `ELECTRON_RUN_AS_NODE`：WorkBuddy / VS Code 这类 Electron 工具链会把它
 * 注入当前 shell，带着它启动 electron 会让进程退化成**裸 Node**，报
 * `TypeError: Cannot read properties of undefined (reading 'exports')`。
 */
export function launchEnv(extra = {}) {
  const env = { ...process.env, NODE_ENV: 'production', ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  // Electron 应用自己可能用这些变量判断模式，统一清掉避免串味
  delete env.VITE_DEV_SERVER_URL;
  return env;
}

/**
 * 启动失败分类，用于决定是否降级参数。
 * @param {string} logs 合并后的 stderr/stdout
 * @param {boolean} gotPage 是否拿到应用页面
 */
export function classifyFailure(logs, gotPage) {
  if (gotPage) return null;
  if (/GPU process isn't usable|GPU process exited unexpectedly|0xC0000005|-1073741819/i.test(logs)) return 'gpu-crash';
  if (/Cannot read properties of undefined \(reading 'exports'\)|cjsPreparseModuleExports/i.test(logs)) return 'run-as-node';
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(logs)) return 'dev-server-missing';
  if (/Error: Cannot find module/i.test(logs)) return 'missing-module';
  return 'no-page';
}

/**
 * 哪些失败值得换一组启动参数重试。
 *
 * `unresponsive` 是实测补上的：Electron 12 在**不加任何沙箱参数**时，
 * 页面 target 能拿到、日志里也没有 GPU 崩溃字样，但 `Runtime.evaluate` 直接超时
 * ——renderer 实际不可用。只认 `gpu-crash` 会导致这种情况不降级、直接判失败。
 */
export const RETRYABLE_REASONS = new Set(['gpu-crash', 'unresponsive']);

/** 把任意错误归一成可分类的 reason。 */
export function reasonOf(e) {
  if (e?.reason) return e.reason;
  const msg = e?.message || '';
  if (/CDP 请求超时|目标无响应/.test(msg)) return 'unresponsive';
  if (/Target crashed|Target closed|Session closed|Inspected target navigated or closed/i.test(msg)) return 'gpu-crash';
  return 'failed';
}

/** 失败原因 → 人话 + 下一步建议。 */
export const FAILURE_HINT = {
  'no-electron': '目标目录没有可用的 electron 二进制。先在该目录 npm install；或 --project 指错了。',
  'no-websocket': '当前 Node 无法建立 WebSocket（Node 22 以下没有全局 WebSocket）。装 ws 或换 Node 22+。',
  unresponsive: '页面拿得到但 CDP 不响应：通常是 renderer 不可用（老版本 + 缺沙箱参数）。已在自动降级；若全档失败，用 --flags 手动指定。',
  'gpu-crash': 'GPU 进程崩溃。加 --disable-gpu-sandbox，仍不行再加 --no-sandbox。',
  'run-as-node': '进程退化成裸 Node。启动前必须删除环境变量 ELECTRON_RUN_AS_NODE。',
  'dev-server-missing': '应用要连的开发服务器没起来。先跑 dev 脚本，或改用构建产物启动。',
  'missing-module': '主进程 require 失败。先 npm install / npm run build，并确认 main 指向的产物存在。',
  'no-page': '进程起来了但没有出现可附加页面。检查是否卡在启动早期（日志见上），或窗口使用了 show:false 一直没创建。',
};

/**
 * 启动 Electron 并等到 CDP 可用。
 *
 * @param {object} opts
 * @param {string} opts.projectDir 项目根目录
 * @param {string[]} [opts.flags] Chromium 开关（放在应用路径之前）
 * @param {string} [opts.appPath] 应用路径，默认 '.'（= 读 package.json 的 main）
 * @param {Record<string,string>} [opts.env]
 * @param {number} [opts.timeout] 等页面出现的总超时
 * @param {boolean} [opts.keepLogs]
 */
export async function launchElectron(opts) {
  const { projectDir, flags = [], appPath = '.', env: extraEnv = {}, timeout = 25000 } = opts;
  const { exe, source } = findElectronBinary(projectDir);
  // 允许指定固定端口：常驻调试时 MCP 配置才能写死，不用每次改
  const port = opts.port || (await freePort());

  const args = [...flags, `--remote-debugging-port=${port}`, appPath];
  const t0 = Date.now();
  const proc = spawn(exe, args, {
    cwd: projectDir,
    env: launchEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  const collect = (d) => {
    logs += String(d);
    if (logs.length > 200000) logs = logs.slice(-100000);
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);

  let exited = false;
  proc.on('exit', () => {
    exited = true;
  });

  /** 找出「应用自己的」页面 target。 */
  const findAppPage = async () => {
    let list = [];
    try {
      list = await httpJson(`http://127.0.0.1:${port}/json/list`, 2500);
    } catch {
      return null;
    }
    if (!Array.isArray(list)) return null;
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    // ⚠️ 应用会自动 openDevTools() 时，列表里第一个往往是 devtools:// 的窗口。
    //    必须排掉，否则 eval/screenshot 全落在一个空白 DevTools 页上。
    return pages.find((t) => !/^devtools:\/\//.test(t.url)) || null;
  };

  let page = null;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    page = await findAppPage();
    if (page) break;
    if (exited) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const stop = async () => {
    if (exited) return;
    // Windows 上只 kill 主进程会残留 renderer/GPU 子进程，必须按进程树杀
    if (process.platform === 'win32' && proc.pid) {
      try {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        proc.kill();
      }
    } else {
      proc.kill();
    }
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!exited) proc.kill('SIGKILL');
  };

  if (!page) {
    await stop();
    const reason = classifyFailure(logs, false);
    const err = new Error(`启动失败（${reason}）：${FAILURE_HINT[reason] || ''}`);
    err.reason = reason;
    err.logs = logs;
    throw err;
  }

  return {
    proc,
    port,
    exe,
    exeSource: source,
    page,
    logs: () => logs,
    launchMs: Date.now() - t0,
    flags,
    projectDir,
    stop,
  };
}

/**
 * 连上一个 target，返回极简 CDP 客户端。
 * 只暴露排查时真正用得上的四个能力：eval / screenshot / click / close。
 *
 * @param {object} page /json/list 里的 target（page 或 node）
 * @param {{projectDir?: string, enablePage?: boolean, requestTimeout?: number}} [opts]
 *   enablePage=false 用于 **Node 调试目标**（主进程）：它没有 Page 域，发 Page.enable 会报错。
 */
export async function connectPage(page, opts = {}) {
  // 底层可能是全局 WebSocket（Node 22+）也可能是 ws 包，差异封装在 compat 层
  const conn = await openWebSocket(page.webSocketDebuggerUrl, { projectDir: opts.projectDir });

  let seq = 0;
  const pending = new Map();
  const listeners = [];

  conn.onMessage((text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`)) : resolve(msg.result);
      return;
    }
    if (msg.method) listeners.forEach((fn) => fn(msg));
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      // ⚠️ 必须有超时：老版本 Chromium（实测 Electron 12）某些方法可能不响应，
      //    没有超时的话 Promise 会永久挂起，表现为脚本「卡死且无输出」。
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP 请求超时（${method}）：目标无响应，可能是该 Chromium 版本不支持此方法`));
      }, opts.requestTimeout ?? 20000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      conn.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  if (opts.enablePage !== false) {
    // Node 调试目标（主进程）没有 Page 域，忽略即可
    await send('Page.enable').catch(() => {});
  }

  /**
   * 在页面里求值，自动 await Promise、按值返回。
   *
   * 对「执行上下文被销毁」做**一次**重试：真实导航（登录跳转、boot.html → index.html）
   * 会 tear down JS 上下文，此时 Runtime.evaluate 报 "Execution context was destroyed"，
   * 但 WebSocket 还活着 —— 稍等重发即可。页面自己抛的业务异常不重试（那是真错误）。
   */
  const evaluate = async (expression) => {
    const run = async () => {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error(`页面求值抛异常：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      }
      return r.result?.value;
    };
    try {
      return await run();
    } catch (e) {
      if (/Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(e.message || '')) {
        await new Promise((r) => setTimeout(r, 250));
        return run(); // 只重试一次，避免死循环
      }
      throw e;
    }
  };

  /**
   * 选择器解析：CSS 优先，额外兼容 Playwright 的文本语法。
   *
   * 为什么必须兼容：`:has-text()` / `text=` 是 Playwright 扩展语法，
   * `document.querySelector` 会直接抛 SyntaxError（"not a valid selector"）。
   * 用过 Playwright 的人（包括 AI）几乎必然会写它。
   *
   * 文本匹配必须取**最深命中**：直接 `querySelectorAll('*')` 找 textContent 包含目标文本，
   * 第一个命中的永远是 `<html>`（整页文本都包含它）。所以：
   *   1. 默认只在这些语义标签里找，不乱扫全文档；
   *   2. 命中后过滤掉「子元素也命中」的祖先，取最内层那个。
   */
  const finderExpr = (selector) => {
    const hasText = /:has-text\((['"])([\s\S]*?)\1\)/.exec(selector);
    const textEq = /^text=(.+)$/.exec(String(selector).trim());
    if (!hasText && !textEq) return `document.querySelector(${JSON.stringify(selector)})`;

    const text = (hasText ? hasText[2] : textEq[1]).trim();
    const base =
      selector
        .replace(/:has-text\(['"][\s\S]*?['"]\)/, '')
        .replace(/^text=[\s\S]*$/, '')
        .trim() || 'button,a,input,label,li,td,th,span,div,[role="button"],[role="tab"],[contenteditable="true"]';

    return `(() => {
      const text = ${JSON.stringify(text)};
      const hits = [...document.querySelectorAll(${JSON.stringify(base)})]
        .filter((e) => (e.textContent || '').includes(text));
      const deepest = hits.filter((e) => ![...e.children].some((c) => (c.textContent || '').includes(text)));
      return (deepest.find((e) => e.getBoundingClientRect().height > 0) || deepest[0] || hits[0] || null);
    })()`;
  };

  /** 取元素的可点性信息（含坐标），无副作用。 */
  const describe = (selector) =>
    evaluate(`(() => {
      const el = ${finderExpr(selector)};
      if (!el) return { ok: false, reason: 'not-found' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0,
        disabled: !!el.disabled,
        value: ('value' in el) ? el.value : undefined,
      };
    })()`);

  /**
   * 截当前页面到 PNG（返回 base64）。
   *
   * 超时重试一次：实测偶发 `Page.captureScreenshot` 卡到超时而 `Runtime.evaluate` 仍正常
   * ——说明是 renderer 合成器卡住（不是 CDP 层问题），通常重发一次或 reload 可恢复。
   * 不要把这种情况报成"CDP 版本不支持"，那是误导。
   */
  const screenshot = async ({ retry = 1 } = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        return r.data;
      } catch (e) {
        const transient = /超时|timeout/i.test(e.message || '');
        if (transient && attempt < retry) {
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        if (transient) {
          throw new Error(
            `${e.message}\n  → 截图超时通常意味着 renderer 合成器卡住（此时页面 JS 仍能执行）。\n` +
              '    先试 `node scripts/act.mjs reload`，或重启应用再截图。',
          );
        }
        throw e;
      }
    }
  };

  /**
   * 点击。
   *
   * mode：
   *   · 'auto'（默认）：能拿到坐标就发**真实鼠标事件**（会走命中测试，能暴露"按钮被浮层盖住"这类真 bug）；
   *     元素不可见时退回 `el.click()`（不受遮挡与滚动影响），返回值里标明用了哪条路。
   *   · 'mouse'：只用真实鼠标事件。
   *   · 'dom'  ：只用 `el.click()`，最稳，但可能"点穿"用户点不到的地方。
   *
   * 为什么默认真实事件：`el.click()` 不经过命中测试，一个被 loading 遮罩盖住的按钮它照样能点，
   * 会把真 bug 掩盖掉。
   */
  const click = async (selector, { mode = 'auto' } = {}) => {
    const info = await describe(selector);
    if (!info.ok) return { ...info, clicked: false };
    if (info.disabled) return { ...info, clicked: false, reason: 'disabled' };

    if (mode === 'dom' || (mode === 'auto' && !info.visible)) {
      const res = await evaluate(
        `(() => { const el = ${finderExpr(selector)}; if (!el) return 'NOT_FOUND'; el.click(); return 'OK'; })()`,
      );
      return { ...info, clicked: res === 'OK', method: 'dom', reason: res === 'OK' ? undefined : 'not-found' };
    }

    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type,
        x: info.x,
        y: info.y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      });
    }
    return { ...info, clicked: true, method: 'mouse' };
  };

  /**
   * 填表单。
   *
   * 直接给 `el.value` 赋值会让页面**看起来是对的**，但 Vue `v-model` / React 受控组件
   * 监听的是 `input` 事件，提交时用的仍是旧值 —— 这是最难查的一类失败。
   * 所以这里：清空 → 赋值（走**原生 setter**，React 的 value tracker 才认）→
   * input/change/blur 事件链 → **回读断言**。
   *
   * @returns {Promise<{filled:boolean, matched:boolean, readback?:string, before?:string, reason?:string}>}
   */
  const fill = async (selector, value) => {
    const res = await evaluate(`(() => {
      const el = ${finderExpr(selector)};
      if (!el) return { ok: false, reason: 'not-found' };
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const set = (v) => (setter ? setter.call(el, v) : (el.value = v));
      const emit = (t) => el.dispatchEvent(new Event(t, { bubbles: true }));

      const before = el.value;
      set('');
      emit('input');
      set(${JSON.stringify(String(value))});
      emit('input');
      emit('change');
      el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      return { ok: true, before, readback: el.value, tag: el.tagName.toLowerCase() };
    })()`);

    if (!res?.ok) return { ...res, filled: false, matched: false };
    const matched = res.readback === String(value);
    return { ...res, filled: matched, matched };
  };

  const KEYS = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  };

  /**
   * 按键（Enter / Escape / Tab / 方向键）。用**真实键盘事件**，
   * 这样表单 Enter 提交、快捷键这类默认行为才会触发（纯 dispatchEvent 不会）。
   */
  const press = async (selector, key = 'Enter') => {
    const spec = KEYS[key] || { key, code: key, keyCode: 0 };
    if (selector) {
      const info = await describe(selector);
      if (!info.ok) return { ok: false, reason: info.reason };
      await evaluate(`(() => { const el = ${finderExpr(selector)}; if (el) el.focus(); })()`);
    }
    await send('Input.dispatchKeyEvent', {
      type: spec.text ? 'keyDown' : 'rawKeyDown',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      text: spec.text,
    });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    });
    return { ok: true, key: spec.key };
  };

  /**
   * 列出页面上**可见可交互**的元素，用于「先探测再写选择器」。
   * 猜选择器是自动化失败的头号原因 —— 先看真实 DOM 再动手。
   */
  const inventory = () =>
    evaluate(`(() => {
      const sel = 'button, input, textarea, select, a[href], [role="button"], [contenteditable="true"]';
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (r.width < 4 || r.height < 4) continue;
        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;
        const cls = (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(Boolean).slice(0, 2);
        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          id: el.id || '',
          cls: cls.join('.'),
          text: (el.innerText || el.value || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 36),
          disabled: !!el.disabled,
          selector: el.id ? '#' + el.id : (cls.length ? el.tagName.toLowerCase() + '.' + cls.join('.') : null),
        });
      }
      return out.slice(0, 60);
    })()`);

  const close = () => {
    try {
      conn.close();
    } catch {
      /* ignore */
    }
  };

  /** 订阅 CDP 事件（如 Runtime.consoleAPICalled / Runtime.exceptionThrown）。 */
  const on = (fn) => listeners.push(fn);

  return { send, evaluate, screenshot, click, fill, press, describe, inventory, close, on };
}

/**
 * 按参数阶梯启动，直到「能连上并完成一次求值」为止。
 *
 * 为什么不能只看 launchElectron 是否返回：无 GPU 环境下的真实表现是
 * **页面 target 已经出现，随后 GPU 进程崩溃把 renderer 一起带走**，
 * CDP 才报 `Target crashed`。只看启动返回值会误判成成功，随后所有探测全崩。
 * 所以这里在每一档都做一次真实的 request/response 往返验证。
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string[][]} opts.ladder 参数阶梯，例如 [[], ['--disable-gpu-sandbox'], [...]]
 * @param {number} [opts.port] 固定端口（serve 场景需要）
 * @returns {Promise<{launched: object, attempts: Array}>}
 */
export async function launchAdaptive(opts) {
  const { projectDir, ladder, port, timeout = 25000 } = opts;
  const attempts = [];
  let lastError = null;

  for (const flags of ladder) {
    let launched = null;
    try {
      launched = await launchElectron({ projectDir, flags, port, timeout });
      const probe = await connectPage(launched.page, { projectDir });
      try {
        await probe.evaluate('document.readyState');
      } finally {
        probe.close();
      }
      attempts.push({ flags, ok: true, launchMs: launched.launchMs });
      return { launched, attempts };
    } catch (e) {
      const reason = reasonOf(e);
      attempts.push({ flags, ok: false, reason, detail: (e.message || '').split('\n')[0].slice(0, 120) });
      if (launched) await launched.stop();
      lastError = Object.assign(new Error(e.message), { reason, logs: launched?.logs?.() || e.logs, attempts: [...attempts] });
      // 只有「渲染不可用」这一类值得换参数；其它原因换参数也没用
      if (!RETRYABLE_REASONS.has(reason)) throw lastError;
    }
  }

  throw Object.assign(lastError || new Error('所有启动参数组合都失败'), { attempts });
}

/** 给 CDP 事件里 console.error / 未捕获异常做一个可读抽取。 */
export function attachErrorCollector(client) {
  const consoleErrors = [];
  const exceptions = [];
  client.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(
        msg.params.args
          .map((a) => a.value ?? a.description ?? a.type)
          .join(' ')
          .slice(0, 300),
      );
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push((d.exception?.description || d.text || '').slice(0, 300));
    }
  });
  return { consoleErrors, exceptions };
}

/** 轮询等待某个表达式在页面里返回真值。 */
export async function waitFor(client, expression, { timeout = 20000, interval = 150 } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(expression)) return true;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  if (lastErr) throw lastErr;
  return false;
}

/**
 * 列出一个调试端口上的所有 target。
 * @param {string|number} portOrUrl 端口号或 http://host:port
 * @param {{timeout?: number}} [opts]
 */
export async function listTargets(portOrUrl, opts = {}) {
  const base = /^\d+$/.test(String(portOrUrl))
    ? `http://127.0.0.1:${portOrUrl}`
    : String(portOrUrl).replace(/\/$/, '');
  const list = await httpJson(`${base}/json/list`, opts.timeout ?? 3000);
  return Array.isArray(list) ? list : [];
}

/**
 * 从 target 列表里挑「应用自己的页面」。
 *
 * 规则（顺序敏感）：
 *   1. 只要 type=page 且有 webSocketDebuggerUrl；
 *   2. 排掉 `devtools://`（应用自动开 DevTools 时会多出这个，eval 进去是空页）；
 *   3. 给了 hint 就按 title/url 子串匹配 —— 多窗口应用必须用它选对窗口；
 *   4. 否则取第一个。
 *
 * @param {Array} targets
 * @param {string} [hint]
 */
export function pickTarget(targets, hint) {
  const pages = (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !/^devtools:\/\//.test(t.url));
  if (!pages.length) return null;
  if (hint) {
    const h = hint.toLowerCase();
    const hit = pages.find((p) => `${p.title || ''} ${p.url || ''}`.toLowerCase().includes(h));
    if (hit) return hit;
  }
  return pages[0];
}

/**
 * 附加到**已经在运行**的应用（不启动、不重启）。
 *
 * 为什么需要：很多场景不能重启应用 —— dev server 正在跑、要复现用户现场、
 * 或者干脆是第三方 Electron 应用（Obsidian/Discord…）。只要它启动时带了
 * `--remote-debugging-port=N`，就能从这里接上去。
 *
 * @param {string|number} portOrUrl
 * @param {{hint?: string, projectDir?: string}} [opts]
 * @returns {Promise<{client: object, target: object, targets: Array}>}
 */
export async function attachByPort(portOrUrl, opts = {}) {
  // 带重试：应用刚起来时 renderer 可能正忙着解 JS（几 MB 的首屏包），
  // /json/list 会短暂不响应。实测 3s 单次超时会偶发 "fetch failed"。
  let targets = [];
  let lastErr = null;
  const deadline = Date.now() + (opts.waitMs ?? 12000);
  for (;;) {
    try {
      targets = await listTargets(portOrUrl, { timeout: 5000 });
      if (targets.length) break;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 600));
  }

  if (!targets.length) {
    const err = new Error(
      `端口 ${portOrUrl} 上没有可调试目标${lastErr ? `（最后一次错误：${lastErr.cause?.code || lastErr.message}）` : ''}。\n` +
        '  可能原因：1) 应用启动时没带 --remote-debugging-port；2) 端口号不对；3) 应用还没起来。\n' +
        '  注意：**已经运行**的实例无法事后开启调试端口，必须带参数重启一次。',
    );
    err.reason = 'no-target';
    throw err;
  }
  const target = pickTarget(targets, opts.hint);
  if (!target) {
    const err = new Error(
      `端口 ${portOrUrl} 上只有这些目标，没有可用页面：\n` +
        targets.map((t) => `  [${t.type}] ${t.title || '(无标题)'} ${t.url || ''}`).join('\n') +
        (opts.hint ? `\n  （--target "${opts.hint}" 没匹配到任何页面）` : ''),
    );
    err.reason = 'no-page-target';
    throw err;
  }
  const client = await connectPage(target, { projectDir: opts.projectDir });
  return { client, target, targets };
}

/** 让页面重新加载（改完代码后复验用）。 */
export async function reload(client, { timeout = 20000 } = {}) {
  await client.send('Page.reload', { ignoreCache: false });
  // 等 load 事件；不等的话截图会拍到白屏
  const ok = await waitFor(client, 'document.readyState === "complete"', { timeout }).catch(() => false);
  return ok;
}

/**
 * 抓网络请求（Network 域）。
 *
 * 必须在页面开始加载**之前** enable 才能抓到首屏请求；
 * 附加到已运行的页面时，先 enable 再 reload 才能拿到完整数据。
 */
export function attachNetwork(client) {
  const reqs = new Map();
  client.on((msg) => {
    const { method, params } = msg;
    if (method === 'Network.requestWillBeSent') {
      reqs.set(params.requestId, {
        id: params.requestId,
        url: params.request.url,
        httpMethod: params.request.method,
        type: params.type,
        start: params.timestamp,
        status: null,
        end: null,
        failed: null,
        bytes: 0,
      });
    } else if (method === 'Network.responseReceived') {
      const r = reqs.get(params.requestId);
      if (r) {
        r.status = params.response.status;
        r.mime = params.response.mimeType;
      }
    } else if (method === 'Network.loadingFinished') {
      const r = reqs.get(params.requestId);
      if (r) {
        r.end = params.timestamp;
        r.bytes = params.encodedDataLength || 0;
      }
    } else if (method === 'Network.loadingFailed') {
      const r = reqs.get(params.requestId);
      if (r) r.failed = params.errorText;
    }
  });

  const shortUrl = (u) => {
    try {
      const x = new URL(u);
      return `${x.host}${x.pathname}`.slice(0, 120);
    } catch {
      return String(u).slice(0, 120);
    }
  };
  const ms = (r) => (r.end && r.start ? Math.round((r.end - r.start) * 1000) : null);

  return {
    async enable() {
      await client.send('Network.enable', { maxTotalBufferSize: 50000000 });
    },
    list: () => [...reqs.values()],
    clear: () => reqs.clear(),
    summary() {
      const all = [...reqs.values()];
      const bad = all.filter((r) => r.failed || (r.status !== null && r.status >= 400));
      const timed = all.filter((r) => ms(r) !== null).sort((a, b) => ms(b) - ms(a));
      return {
        total: all.length,
        failed: bad.length,
        failedSamples: bad.slice(0, 5).map((r) => ({ url: shortUrl(r.url), status: r.status, error: r.failed })),
        slowest: timed.slice(0, 3).map((r) => ({ url: shortUrl(r.url), ms: ms(r), status: r.status, type: r.type })),
        bytes: all.reduce((s, r) => s + (r.bytes || 0), 0),
      };
    },
  };
}
