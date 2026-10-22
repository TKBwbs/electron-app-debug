#!/usr/bin/env node
/**
 * main-process.mjs —— 主进程调试（Node inspector，`--inspect`）
 *
 * 为什么单独一个脚本：**Electron 的 bug 有一大半在主进程**（窗口创建、IPC、
 * 文件 IO、协议注册、单实例锁），而这些用 renderer 的 CDP 看不到。
 * 主进程走的是 Node 的 inspector 协议（端口默认 9229），也能用 Runtime.evaluate 求值，
 * 但目标类型是 `node`、没有 Page 域 —— 所以不能复用 inspect.mjs 的 path。
 *
 * 能力：
 *   · 启动时带 `--inspect=PORT`（不阻塞，不是 --inspect-brk）
 *   · 在主进程上下文里求值（读 process.versions / electron API / 模块状态）
 *   · 抓主进程 console（含 console.error 与未捕获异常）
 *   · 附加到已带 --inspect 运行的实例
 *
 * 用法：
 *   node main-process.mjs --project <目录>                      # 只看主进程概况
 *   node main-process.mjs --project <目录> --eval "process.versions.electron"
 *   node main-process.mjs --project <目录> --logs --duration 5
 *   node main-process.mjs --attach 9229 --eval "process.pid"
 *
 * 注意：`--inspect` 只影响主进程，不会出现在 Chromium 的 /json/list 里；
 *       端口默认 9229 是 Node 的约定，别和 Chromium 的 9222/9333/9492 混用。
 */

import { launchElectron, connectPage, listTargets, FAILURE_HINT } from './lib/cdp.mjs';
import { checkRuntime, runtimeInfo, NO_WEBSOCKET_HINT } from './lib/compat.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const PROJECT = arg('project', process.cwd());
const ATTACH = arg('attach', null);
const INSPECT_PORT = Number(arg('inspect-port', 9229));
const EXPR = arg('eval', null);
const SHOW_LOGS = has('logs');
const DURATION = Number(arg('duration', 5));
const AS_JSON = has('json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Node 调试目标：type=node，没有 Page 域。 */
function pickNodeTarget(targets) {
  return (targets || []).find((t) => t.type === 'node' && t.webSocketDebuggerUrl) || null;
}

async function waitNodeTarget(port, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const t = pickNodeTarget(await listTargets(port));
      if (t) return t;
    } catch {
      /* 端口还没监听上 */
    }
    await sleep(250);
  }
  return null;
}

/**
 * 主进程里最重要的那几项，一次问完。
 *
 * ⚠️ 边界（实测）：inspector 的求值上下文**没有 require，也不能动态 import('electron')**
 * （报 `A dynamic import callback was not specified`）。所以拿不到 `app.getName()`
 * 这类 Electron API。要访问它们，只有两条路：
 *   · 应用自己把句柄挂到 globalThis（如 `globalThis.__main = { app }`）；
 *   · 在源码里下断点后求值（需要 Debugger 域，超出本脚本范围）。
 * 这里只报告 `process` 上确定可用的字段，不猜、不吞错。
 */
const INFO_EXPR = `(() => ({
  pid: process.pid,
  type: process.type,
  node: process.versions.node,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  v8: process.versions.v8,
  platform: process.platform + ' ' + process.arch,
  defaultApp: process.defaultApp,
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
  cwd: process.cwd(),
  argv: process.argv.slice(1, 6),
  hasRequire: typeof require === 'function',
}))()`;

function report(obj, title) {
  if (AS_JSON) {
    console.log(JSON.stringify(obj, null, 2));
    return;
  }
  console.log(`\n${title}`);
  const l = (k, v) => console.log(`  ${k.padEnd(14)} ${v}`);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    l(k, Array.isArray(v) ? v.join(' ') : String(v));
  }
}

async function main() {
  const rt = checkRuntime(PROJECT);
  if (!rt.ws) {
    console.error(`\n❌ ${NO_WEBSOCKET_HINT}`);
    process.exit(2);
  }

  let launched = null;
  let port = INSPECT_PORT;

  if (ATTACH) {
    port = Number(ATTACH);
  } else {
    // 主进程 --inspect：不阻塞启动（不要用 --inspect-brk，会让应用停在第一行）
    try {
      launched = await launchElectron({
        projectDir: PROJECT,
        flags: [`--inspect=${INSPECT_PORT}`, '--no-sandbox', '--disable-gpu-sandbox'],
        timeout: 30000,
      });
    } catch (e) {
      console.error(`\n❌ 启动失败：${e.reason || 'unknown'}\n   ${FAILURE_HINT[e.reason] || ''}`);
      console.error((e.logs || '').slice(-1200));
      process.exit(1);
    }
  }

  const target = await waitNodeTarget(port);
  if (!target) {
    if (launched) await launched.stop();
    console.error(
      `\n❌ 端口 ${port} 上没有 Node 调试目标。\n` +
        '  1) 主进程必须带 --inspect=<port> 启动（已运行的实例无法事后开启）；\n' +
        '  2) 确认端口号（Node 默认 9229，不是 Chromium 的 9222）；\n' +
        '  3) 若用了 --inspect-brk，应用会停在第一行，需要先 continue。',
    );
    process.exit(1);
  }

  const client = await connectPage(target, { projectDir: PROJECT, enablePage: false });

  try {
    if (EXPR) {
      const value = await client.evaluate(EXPR);
      // 结构化输出，避免 "[object Object]"
      if (AS_JSON || typeof value === 'object') console.log(JSON.stringify(value, null, 2));
      else console.log(value);
      return;
    }

    const info = await client.evaluate(INFO_EXPR);
    report({ ...info, runtime: `script Node ${runtimeInfo().node}` }, `主进程概况（端口 ${port}）`);

    if (SHOW_LOGS) {
      const logs = [];
      client.on((msg) => {
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
          logs.push(`[${msg.params.type}] ${text}`.slice(0, 300));
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          logs.push(`[exception] ${(d.exception?.description || d.text || '').slice(0, 300)}`);
        }
      });
      console.log(`\n收集主进程日志 ${DURATION}s ...`);
      await sleep(DURATION * 1000);
      if (!logs.length) console.log('  （这段时间内主进程没有输出）');
      else for (const line of logs.slice(0, 60)) console.log(`  ${line}`);
      if (logs.length > 60) console.log(`  ... 另有 ${logs.length - 60} 条`);
    }
  } finally {
    client.close();
    if (launched) await launched.stop();
  }
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
