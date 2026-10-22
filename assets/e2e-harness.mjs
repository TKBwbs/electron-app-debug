/**
 * e2e-harness.mjs —— 复制进目标项目的 Playwright 版 E2E 底座（模板）
 *
 * 什么时候用它：需要**长期回归**（写进 CI / npm test），而不是一次性排查。
 * 一次性排查用 skill 里的 scripts/inspect.mjs 与 scripts/serve.mjs（零依赖）就够了。
 *
 * 前置：在项目里 `npm i -D playwright-core`
 *   —— 只装 playwright-core，**不要装 playwright**（后者会下载浏览器，几百 MB，
 *      而 Electron 测试只需要 Electron 自带的 Chromium）。
 *
 * ⚠️ 版本门槛：Playwright 官方只列 Electron 12.2+ / 13.4+ / 14+，
 *    但实测 **12.0.18 + playwright-core 1.64.1 完全可用**（launch/标题/DOM/截图均通过）。
 *    所以遇到官方没列的老版本先试一次，真报错再退回 skill 的 CDP 方案（scripts/serve.mjs）。
 *    跑脚本的 Node 版本无限制（Playwright 自带 WebSocket 实现）。
 *
 * 复制后按注释改三处：ROOT 推导、READY_LOG（应用自己的启动完成日志）、BASE_ARGS。
 */

import { _electron as electron } from 'playwright-core';
import { mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ARTIFACTS = join(ROOT, 'artifacts');

/**
 * 基础启动参数。
 *
 * `--no-sandbox --disable-gpu-sandbox`：无独显 / 远程桌面 / 容器 / 沙箱受限环境下，
 *   缺了它 Chromium GPU 进程会以 0xC0000005 反复崩溃，最终
 *   `FATAL: GPU process isn't usable. Goodbye.`，表现为启动卡死或 renderer 直接挂。
 *
 * ⚠️ 不要加 `--disable-gpu`：WebGL 项目会静默降级到软件渲染（还「能跑」），
 *    但 WebGPU 项目的 `requestAdapter()` 会直接返回 null —— 黑屏且无报错，极难排查。
 */
export const BASE_ARGS = ['--no-sandbox', '--disable-gpu-sandbox'];

/** 应用「装配完成」时会打的一条日志。改成你自己项目里的那条。 */
const READY_LOG = /ready|initialized|启动完成|已就绪/i;

/**
 * 构造子进程环境。
 *
 * 必须删 `ELECTRON_RUN_AS_NODE`：WorkBuddy / VS Code 等 Electron 工具链会把它注入终端，
 * 带着它启动 electron 会让进程退化成裸 Node，报
 * `TypeError: Cannot read properties of undefined (reading 'exports')`。
 */
export function e2eEnv(extra = {}) {
  const env = { ...process.env, NODE_ENV: 'production', ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  return env;
}

/** 迷你断言器：输出 PASS/FAIL 行 + 汇总行，便于被 runner 用正则收集。 */
export function createReporter(label) {
  let passed = 0;
  let failed = 0;
  return {
    assert(name, cond) {
      cond ? passed++ : failed++;
      console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
    },
    section: (title) => console.log(`\n── ${title} ──`),
    finish() {
      console.log(`\n${label}: ${passed} 通过, ${failed} 失败`);
      if (failed > 0) process.exitCode = 1;
      return { passed, failed };
    },
  };
}

/** 构建新鲜度：E2E 跑的是 dist 产物，src 比产物新时结论不可信。 */
export function staleBuildWarnings(artifacts = ['dist-electron/main/index.js', 'dist/index.html']) {
  const files = artifacts.map((f) => join(ROOT, f));
  const missing = artifacts.filter((_, i) => !existsSync(files[i]));
  if (missing.length) return [`缺少构建产物（${missing.join(', ')}），先 npm run build`];

  const newest = (dir, exts, acc = 0) => {
    if (!existsSync(dir)) return acc;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) acc = newest(full, exts, acc);
      else if (exts.some((x) => e.name.endsWith(x))) acc = Math.max(acc, statSync(full).mtimeMs);
    }
    return acc;
  };

  const builtAt = Math.min(...files.map((f) => statSync(f).mtimeMs));
  const srcAt = newest(join(ROOT, 'src'), ['.js', '.ts', '.tsx', '.jsx', '.vue']);
  if (srcAt > builtAt + 1000) return [`src 比构建产物新约 ${Math.round((srcAt - builtAt) / 60000)} 分钟，测的是旧产物`];
  return [];
}

/**
 * 启动应用，返回主窗口 + 分类后的错误收集。
 * @returns {Promise<{app, win, errors, pageErrors, consoleErrors, consoleLog, mainLog, close}>}
 */
export async function launchApp(opts = {}) {
  mkdirSync(ARTIFACTS, { recursive: true });
  for (const w of staleBuildWarnings(opts.artifacts)) console.log(`WARN  ${w}`);

  const args = [...BASE_ARGS, ...(opts.args || []), opts.appPath || '.'];
  const app = await electron.launch({
    cwd: ROOT,
    args,
    env: e2eEnv(opts.env),
    timeout: opts.timeout ?? 30000,
  });

  const errors = [];
  const pageErrors = [];
  const consoleErrors = [];
  const consoleLog = [];
  const mainLog = [];

  const proc = app.process();
  proc.stdout?.on('data', (d) => mainLog.push(String(d).trim()));
  proc.stderr?.on('data', (d) => {
    const line = String(d).trim();
    if (!/gpu_process_host|GPU process|Fontconfig/.test(line)) mainLog.push(line);
  });

  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  win.on('pageerror', (e) => {
    pageErrors.push(`pageerror: ${e.message}`);
    errors.push(`pageerror: ${e.message}`);
  });
  win.on('console', (m) => {
    consoleLog.push(m.text());
    if (m.type() !== 'error') return;
    const line = `console: ${m.text().slice(0, 300)}`;
    consoleErrors.push(line);
    errors.push(line);
  });

  return { app, win, errors, pageErrors, consoleErrors, consoleLog, mainLog, close: async () => app.close().catch(() => {}) };
}

/** 截图到 artifacts/<name>.png。这是让 AI「看见」界面的唯一可靠通道。 */
export async function shot(win, name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = join(ARTIFACTS, `${name}.png`);
  await win.screenshot({ path: file });
  return file;
}

/**
 * 等 DOM 停止变动（静默期）。
 *
 * 多数编辑器类应用会**整棵重绘**工具栏/面板（状态变化即 re-render），
 * 点击落在重绘窗口会点到已分离的节点上 —— 无报错、无反应，表现为「点了没反应」的偶发。
 * 点击前先等静默，是消除这类偶发的关键。
 */
export async function waitForQuiet(win, selector, { quietMs = 500, timeout = 15000 } = {}) {
  await win.waitForSelector(selector, { timeout });
  await win.evaluate(
    ({ selector, quietMs }) =>
      new Promise((resolve, reject) => {
        const el = document.querySelector(selector);
        if (!el) return reject(new Error(`未找到 ${selector}`));
        let timer = setTimeout(done, quietMs);
        const obs = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, quietMs);
        });
        obs.observe(el, { childList: true, subtree: true, attributes: true });
        function done() {
          obs.disconnect();
          resolve();
        }
      }),
    { selector, quietMs },
  );
}

/**
 * 点击并验证后果；被重绘吞掉时有界重试。
 * 每轮都必须让 check 成真，三轮不成仍判失败 —— 重试只为跨越重绘窗口，不掩盖真故障。
 */
export async function clickUntil(win, selector, check, { attempts = 3, perTry = 5000, quietMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await waitForQuiet(win, selector, { quietMs }).catch(() => {});
    await win.click(selector, { timeout: 5000 }).catch(() => {});
    const ok = await win.waitForFunction(check, null, { timeout: perTry }).then(() => true).catch(() => false);
    if (ok) return { ok: true, attempts: i + 1 };
  }
  return { ok: false, attempts };
}

/**
 * 等应用「真正可用」：布局就绪 → 首帧 → 启动日志 → DOM 静默。
 * 不要用固定 sleep 代替它：不同机器上快慢差好几倍，固定 sleep 不是太慢就是偶发。
 */
export async function waitForAppReady(ctx, { layoutSelector = '#app', timeout = 30000 } = {}) {
  const { win, consoleLog } = ctx;
  await win.waitForSelector(layoutSelector, { timeout });
  await win.waitForFunction(
    () => [...document.querySelectorAll('canvas')].some((c) => c.width > 100 && c.height > 100) || document.body.innerText.trim().length > 0,
    null,
    { timeout },
  );

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (consoleLog.some((l) => READY_LOG.test(l))) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  await waitForQuiet(win, layoutSelector, { quietMs: 600 }).catch(() => {});
}
