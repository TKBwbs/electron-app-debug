#!/usr/bin/env node
/**
 * inspect.mjs —— 启动 Electron 应用并做运行时体检（含截图）
 *
 * 这是「让 AI 看见应用」的主入口。一次运行输出：
 *   · 启动用了哪些参数、是否降级、启动耗时；
 *   · 实际渲染后端（WebGPU / WebGL2 / WebGL1），以及是硬件还是回退适配器；
 *   · 页面规模、白屏风险指标；
 *   · console.error / 未捕获异常；
 *   · 一张截图（默认落到 <项目>/artifacts/）。
 *
 * 自适应逻辑（两级）：
 *   1. 参数阶梯 `[] → [--disable-gpu-sandbox] → [--no-sandbox --disable-gpu-sandbox]`；
 *   2. **不仅在启动失败时降级，也在「启动成功但渲染进程崩溃」时降级** ——
 *      实测无 GPU 环境下的表现就是：页面 target 已经出现，随后 GPU 进程崩、
 *      renderer 跟着挂掉，CDP 报 `Target crashed`。只看启动返回值会误判成成功。
 *
 * 绝不自动加 `--disable-gpu`：它会让 WebGPU 的 requestAdapter() 返回 null，
 * 而 WebGL 仍可用 —— 症状是「WebGL 项目一切正常，WebGPU 项目黑屏」，极难排查。
 *
 * 用法：
 *   node inspect.mjs --project <目录>
 *   node inspect.mjs --project <目录> --wait-text "项目管理" --out shot.png
 *   node inspect.mjs --project <目录> --flags "--disable-gpu-sandbox"   # 跳过自适应
 *   node inspect.mjs --project <目录> --keep                            # 不退出，打印 CDP 地址
 *   node inspect.mjs --project <目录> --json
 *
 *   附加到**已在运行**的应用（不重启，需要它启动时带了 --remote-debugging-port）：
 *   node inspect.mjs --attach 9492
 *   node inspect.mjs --attach 9492 --target "设置"        # 多窗口时选窗口
 *
 *   网络与刷新：
 *   node inspect.mjs --project <目录> --network           # 抓包（会自动 reload 一次）
 *   node inspect.mjs --attach 9492 --network              # 附加后抓包
 *   node inspect.mjs --project <目录> --reload            # 只重载再体检
 *   node inspect.mjs --project <目录> --network --no-reload   # 只统计之后的请求
 *
 *   交互探测（写选择器之前先跑）：
 *   node inspect.mjs --project <目录> --dom               # 列出可见按钮/输入框 + 建议选择器
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  launchAdaptive,
  connectPage,
  attachByPort,
  attachErrorCollector,
  attachNetwork,
  reload,
  waitFor,
  reasonOf,
  FAILURE_HINT,
} from './lib/cdp.mjs';
import { checkRuntime, runtimeInfo, NO_WEBSOCKET_HINT } from './lib/compat.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const PROJECT = arg('project', process.cwd());
const WAIT_SELECTOR = arg('wait-selector', null);
const WAIT_TEXT = arg('wait-text', null);
const TIMEOUT = Number(arg('timeout', 30000));
const OUT = arg('out', null);
const AS_JSON = has('json');
const KEEP = has('keep');
const EXPLICIT_FLAGS = arg('flags', null);
// 附加模式：不启动，直接接上已在运行的应用（端口号或 http://host:port）
const ATTACH = arg('attach', null);
// 多窗口应用用它选窗口（按 title/url 子串匹配）
const TARGET_HINT = arg('target', null);
// 抓包必须在页面加载前 enable；而 Network.enable **无法回溯**已经发生的请求。
// 所以 --network 默认自带一次 reload，否则只会拿到 0 个请求（踩过）。
const WITH_NETWORK = has('network');
// 列出可见可交互元素：写选择器之前先看真实 DOM（猜选择器是失败头号原因）
const WITH_DOM = has('dom');
const NO_RELOAD = has('no-reload');
const DO_RELOAD = has('reload') || (WITH_NETWORK && !NO_RELOAD);

const LADDER = EXPLICIT_FLAGS
  ? [EXPLICIT_FLAGS.split(/\s+/).filter(Boolean)]
  : [[], ['--disable-gpu-sandbox'], ['--no-sandbox', '--disable-gpu-sandbox']];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 运行时后端探测：既看「能力」，也看「应用真正用了哪个」。 */
const BACKEND_PROBE = `(async () => {
  const probe = (t) => { try { const c = document.createElement('canvas'); c.width = c.height = 1; return !!c.getContext(t); } catch { return false; } };
  const out = {
    available: { webgpu: probe('webgpu'), webgl2: probe('webgl2'), webgl1: probe('webgl'), canvas2d: probe('2d') },
    hasNavigatorGpu: !!navigator.gpu,
    adapter: null,
    adapterInfo: null,
  };
  if (navigator.gpu) {
    try {
      const a = await navigator.gpu.requestAdapter();
      out.adapter = !!a;
      if (a) {
        const i = a.info || {};
        out.adapterInfo = { vendor: i.vendor || '', architecture: i.architecture || '', description: i.description || '', fallback: !!i.isFallbackAdapter };
      }
    } catch (e) { out.adapterError = String((e && e.message) || e); }
  }
  // 应用真实使用的后端：一个 canvas 只能持有一种 context，用别的类型取会返回 null
  const canvases = [...document.querySelectorAll('canvas')].filter((c) => c.width > 16 && c.height > 16);
  out.canvases = canvases.slice(0, 4).map((c) => {
    const webgpu = !!c.getContext('webgpu');
    const webgl2 = !webgpu && !!c.getContext('webgl2');
    const webgl1 = !webgpu && !webgl2 && !!c.getContext('webgl');
    return { size: c.width + 'x' + c.height, id: c.id || null, backend: webgpu ? 'webgpu' : webgl2 ? 'webgl2' : webgl1 ? 'webgl1' : 'unknown' };
  });
  out.primaryBackend = out.canvases[0] ? out.canvases[0].backend : null;
  return out;
})()`;

/** 页面健康度：白屏/空壳判断的量化依据。 */
const PAGE_PROBE = `(() => {
  const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim();
  const canvases = [...document.querySelectorAll('canvas')].filter((c) => c.width > 16);
  const ua = navigator.userAgent || '';
  const chromeM = ua.match(/Chrome\\/([\\d.]+)/);
  const electronM = ua.match(/Electron\\/([\\d.]+)/);
  return {
    title: document.title,
    url: location.href,
    textLength: text.length,
    textSample: text.slice(0, 160),
    elementCount: document.querySelectorAll('*').length,
    canvasCount: canvases.length,
    hasLoadingMask: !!document.querySelector('.loading, [class*="loading"], [class*="splash"]'),
    chrome: chromeM ? chromeM[1] : null,
    electron: electronM ? electronM[1] : null,
  };
})()`;

/** 崩溃类错误：页面 target 已经出现，但渲染进程随后挂掉。 */
const isCrash = (e) => /Target crashed|Target closed|Session closed|WebSocket is not open|Inspected target navigated or closed/i.test(e?.message || '');

function pickOutPath() {
  if (OUT) return isAbsolute(OUT) ? OUT : join(process.cwd(), OUT);
  // 附加模式下没有"项目"上下文（可能是第三方应用），别往当前目录里扔文件
  const base = ATTACH ? tmpdir() : PROJECT;
  const dir = ATTACH ? base : join(base, 'artifacts');
  mkdirSync(dir, { recursive: true });
  return join(dir, `electron-inspect-${Date.now()}.png`);
}

function judge(page, backend, shotBytes) {
  const issues = [];
  if (page.textLength === 0 && page.canvasCount === 0) issues.push('白屏：既无文本也无 canvas');
  else if (page.textLength < 20 && page.canvasCount === 0) issues.push('疑似空壳：文本极少且无 canvas');
  if (backend.canvases.length === 0 && (backend.available.webgpu || backend.available.webgl2)) {
    issues.push('页面具备渲染能力但没有画布 —— 可能还没进主界面，或渲染初始化失败');
  }
  if (backend.hasNavigatorGpu && backend.adapter === false) {
    issues.push('navigator.gpu 存在但 requestAdapter() 返回 null —— WebGPU 不可用，检查是否误加了 --disable-gpu');
  }
  if (shotBytes && shotBytes < 8000) issues.push(`截图仅 ${(shotBytes / 1024).toFixed(1)} KB，画面很可能是纯色/空白`);
  return { blank: issues.length > 0, issues };
}

/** 启动之后的探测：等就绪 → 读页面 → 读后端 → 截图。 */
async function probe(client, { network = false, doReload = false } = {}) {
  const errs = attachErrorCollector(client);

  // 抓包必须在页面加载前 enable；附加到已运行页面时，靠随后的 reload 补齐首屏请求
  let net = null;
  if (network) {
    net = attachNetwork(client);
    await net.enable();
  }
  if (doReload) await reload(client);

  let ready;
  if (WAIT_SELECTOR) ready = await waitFor(client, `!!document.querySelector(${JSON.stringify(WAIT_SELECTOR)})`, { timeout: TIMEOUT });
  else if (WAIT_TEXT) ready = await waitFor(client, `(document.body.innerText||'').includes(${JSON.stringify(WAIT_TEXT)})`, { timeout: TIMEOUT });
  else {
    ready = await waitFor(
      client,
      `(() => { const t = ((document.body && document.body.innerText) || '').trim(); return t.length > 0 || document.querySelectorAll('canvas').length > 0; })()`,
      { timeout: 15000 },
    ).catch(() => false);
  }

  // 给渲染管线一点时间出首帧（软件渲染会慢）
  await sleep(1200);

  const page = await client.evaluate(PAGE_PROBE);
  const backend = await client.evaluate(BACKEND_PROBE);
  const dom = WITH_DOM ? await client.inventory().catch(() => null) : null;

  let shotPath = pickOutPath();
  let shotBytes = 0;
  try {
    const buf = Buffer.from(await client.screenshot(), 'base64');
    mkdirSync(dirname(shotPath), { recursive: true });
    writeFileSync(shotPath, buf);
    shotBytes = buf.length;
  } catch (e) {
    shotPath = null;
    errs.consoleErrors.push(`截图失败: ${e.message}`);
  }

  return { client, errs, net, page, backend, dom, ready, shotPath, shotBytes };
}

function report(r) {
  if (AS_JSON) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (!r.ok) {
    console.log(`\n❌ 体检失败：${r.reason}${r.hint ? `\n   ${r.hint}` : ''}`);
    if (r.detail) console.log(`\n   ${r.detail.split('\n').join('\n   ')}`);
    for (const a of r.attempts || []) {
      console.log(`   [${a.ok ? 'ok' : 'fail'}] ${a.flags.join(' ') || '(无参数)'}${a.detail ? ' → ' + a.detail : ''}`);
    }
    if (r.logs) console.log(`\n--- 最后日志 ---\n${r.logs}`);
    return;
  }
  const l = (k, v) => console.log(`  ${k.padEnd(16)} ${v}`);
  console.log(r.mode === 'attach' ? `\n✅ 已附加（未重启）：${r.attached.title || r.attached.url}` : `\n✅ 已启动 ${r.project}`);
  if (r.mode === 'attach') {
    l('附加端口', r.attached.port);
    l('目标窗口', `${r.attached.title || '(无标题)'}  ${r.attached.url}`);
    l('运行时', `Node ${r.runtime.node} · WebSocket ${r.runtime.hasGlobalWebSocket ? '全局' : r.runtime.wsFallback === 'ws' ? 'ws 包回退' : '不可用'}`);
  } else {
    l('启动参数', r.launch.usedFlags.join(' ') || '(无)');
    l('启动耗时', `${r.launch.ms}ms${r.launch.degraded ? '（已降级）' : ''}`);
    l('CDP 端口', r.launch.cdpPort);
    l('运行时', `Node ${r.runtime.node} · WebSocket ${r.runtime.hasGlobalWebSocket ? '全局' : r.runtime.wsFallback === 'ws' ? 'ws 包回退' : '不可用'}`);
  }
  l('就绪等待', r.ready ? '命中' : '⚠ 超时（页面可能仍未就绪）');
  console.log('');
  l('标题', r.page.title || '(空)');
  l('URL', r.page.url);
  l('DOM', `${r.page.elementCount} 元素 / 正文 ${r.page.textLength} 字`);
  l('引擎', `Chromium ${r.page.chrome || '?'}${r.page.electron ? ` / Electron ${r.page.electron}` : ''}${r.page.chrome && Number(r.page.chrome.split('.')[0]) < 113 ? '（<113 无 WebGPU）' : ''}`);
  l('画布', `${r.page.canvasCount} 个${r.backend.canvases.length ? ' → ' + r.backend.canvases.map((c) => `${c.size}:${c.backend}`).join(', ') : ''}`);
  console.log('');
  l('后端能力', `webgpu=${r.backend.available.webgpu} webgl2=${r.backend.available.webgl2} webgl1=${r.backend.available.webgl1}`);
  l('应用后端', r.backend.primaryBackend || (r.page.canvasCount === 0 ? '(当前页面没有 canvas)' : '(未检测到)'));
  l(
    'GPU 适配器',
    r.backend.adapter === null
      ? '(无 navigator.gpu)'
      : r.backend.adapter
        ? `${r.backend.adapterInfo?.vendor || '?'}/${r.backend.adapterInfo?.architecture || '?'}${r.backend.adapterInfo?.fallback ? ' (回退适配器)' : ''}`
        : '不可用（requestAdapter 返回 null）',
  );
  l('错误', `console.error ${r.errors.consoleErrorCount} 条 / 异常 ${r.errors.exceptionCount} 条`);
  for (const e of r.errors.sample) console.log(`     ↳ ${e}`);
  if (r.interactive) {
    console.log(`\n可交互元素（${r.interactive.length} 个，用它写选择器，别猜）：`);
    for (const el of r.interactive.slice(0, 25)) {
      const label = `${el.tag}${el.type ? '[' + el.type + ']' : ''}`.padEnd(16);
      const sel = el.selector || `text=${el.text}`;
      console.log(`  ${label} ${el.disabled ? '(disabled) ' : ''}${el.text || '(无文案)'}   →  ${sel}`);
    }
    if (r.interactive.length > 25) console.log(`  ... 另有 ${r.interactive.length - 25} 个`);
  }
  if (r.network) {
    const n = r.network;
    l('网络', `${n.total} 个请求 / ${n.failed} 个失败 / ${(n.bytes / 1024).toFixed(0)} KB`);
    for (const f of n.failedSamples) console.log(`     ✗ ${f.url} → ${f.status ?? f.error}`);
    for (const s of n.slowest) console.log(`     ⏱ ${s.ms}ms  ${s.url}`);
  }
  if (r.health.blank) {
    console.log('\n⚠ 健康检查：');
    for (const i of r.health.issues) console.log(`   · ${i}`);
  }
  if (r.screenshot) console.log(`\n截图: ${r.screenshot} (${(r.screenshotBytes / 1024).toFixed(0)} KB)  ← 直接读图核对界面`);
}

async function main() {
  // 先判运行时能力：Node < 22 且没装 ws 时，连不上 CDP，启动应用也是白搭
  const rt = checkRuntime(PROJECT);
  if (!rt.ws) {
    console.error(`\n❌ ${NO_WEBSOCKET_HINT}`);
    process.exit(2);
  }

  // 启动阶段自适应（含「启动成功但 renderer 崩」的判定）
  let launched = null;
  let attempts = [];
  let client = null;
  let attachedTarget = null;

  if (ATTACH) {
    // 附加模式：不启动、不重启，直接接上已在运行的应用
    try {
      const r = await attachByPort(ATTACH, { hint: TARGET_HINT, projectDir: PROJECT });
      client = r.client;
      attachedTarget = r.target;
    } catch (e) {
      report({
        ok: false,
        reason: e.reason || 'attach-failed',
        hint:
          e.reason === 'no-target'
            ? '应用必须**带着** --remote-debugging-port 启动；已运行的实例无法事后开启。用 serve.mjs 或手动带参数重启一次。'
            : '检查 --target 是否匹配到窗口（先用 listTargets 看有哪些页面）。',
        detail: e.message,
      });
      process.exit(1);
    }
  } else {
    try {
      ({ launched, attempts } = await launchAdaptive({ projectDir: PROJECT, ladder: LADDER, timeout: TIMEOUT }));
      client = await connectPage(launched.page, { projectDir: launched.projectDir });
    } catch (e) {
      const reason = e.reason || 'failed';
      report({
        ok: false,
        reason,
        hint: FAILURE_HINT[reason] || '看日志定位；也可用 --flags 手动指定一组参数',
        detail: e.message,
        attempts: e.attempts || [],
        logs: (e.logs || '').slice(-2000),
      });
      process.exit(1);
    }
  }

  // 探测阶段仍可能崩（例如应用初始化到某个阶段才炸）——如实归类，不要伪装成成功
  let res;
  try {
    res = await probe(client, { network: WITH_NETWORK, doReload: DO_RELOAD });
  } catch (e) {
    if (launched) await launched.stop();
    const reason = reasonOf(e);
    report({
      ok: false,
      reason,
      hint: FAILURE_HINT[reason] || '应用启动后崩溃。看下方日志与 --flags 组合；WebGPU 项目不要加 --disable-gpu。',
      detail: e.message,
      attempts,
      logs: launched ? `${e.message}\n${(launched.logs() || '').slice(-1500)}` : e.message,
    });
    process.exit(1);
  }

  const result = {
    ok: true,
    project: PROJECT,
    mode: ATTACH ? 'attach' : 'launch',
    runtime: runtimeInfo(),
    launch: launched
      ? {
          attempts,
          usedFlags: launched.flags,
          ms: launched.launchMs,
          degraded: attempts.length > 1,
          exeSource: launched.exeSource,
          cdpPort: launched.port,
        }
      : null,
    attached: attachedTarget
      ? { port: ATTACH, title: attachedTarget.title, url: attachedTarget.url, id: attachedTarget.id }
      : null,
    ready: res.ready,
    page: res.page,
    backend: res.backend,
    health: judge(res.page, res.backend, res.shotBytes),
    errors: {
      consoleErrorCount: res.errs.consoleErrors.length,
      exceptionCount: res.errs.exceptions.length,
      sample: [...res.errs.exceptions, ...res.errs.consoleErrors].slice(0, 5),
    },
    network: res.net ? res.net.summary() : null,
    interactive: res.dom,
    screenshot: res.shotPath,
    screenshotBytes: res.shotBytes,
  };

  report(result);

  if (KEEP) {
    if (!launched) {
      console.log('\n附加模式：应用一直都在运行，Ctrl+C 只断开连接，不影响应用。');
      process.on('SIGINT', () => {
        res.client.close();
        process.exit(0);
      });
      return;
    }
    console.log(`\n应用保持运行中。CDP: http://127.0.0.1:${launched.port}`);
    console.log(`  查看页面目标: node -e "fetch('http://127.0.0.1:${launched.port}/json/list').then(r=>r.json()).then(l=>l.filter(t=>t.type==='page'&&!/^devtools/.test(t.url)).forEach(t=>console.log(t.title,t.webSocketDebuggerUrl)))"`);
    console.log(`  挂 MCP: npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:${launched.port}`);
    console.log('\nCtrl+C 结束。');
    process.on('SIGINT', async () => {
      res.client.close();
      await launched.stop();
      process.exit(0);
    });
    return;
  }

  res.client.close();
  await launched.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
