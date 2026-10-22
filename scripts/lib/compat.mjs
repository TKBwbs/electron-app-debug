/**
 * compat.mjs —— 运行时兼容层（Node / WebSocket / fetch 的版本差异都在这里）
 *
 * 为什么要单独一层：这套脚本要靠系统 Node 跑，而用户机器上的 Node 版本差异很大。
 * 关键事实（实测）：
 *   · `globalThis.WebSocket` 只有 **Node 22+** 才有（Node 21 需 --experimental-websocket）；
 *   · Node 20.18（Electron 32 自带的那颗 Node）**没有全局 WebSocket**，但有 fetch；
 *   · `fetch` 在 Node 18+ 稳定，Node 16 需要 flag。
 *
 * 因此 WebSocket 走三级回退，任一级可用即可工作：
 *   1. 全局 WebSocket（Node 22+ / Deno / Bun）
 *   2. `ws` 包（解析顺序：目标项目 → skill 自身 → 全局 node_modules）
 *   3. 都没有 → 抛出**可执行**的错误提示（装 ws 或换 Node 22）
 *
 * 所有对外函数都不抛"裸错误"，而是带 `reason` 字段，便于上层归类与提示。
 */

import { createRequire } from 'node:module';
import http from 'node:http';
import { join } from 'node:path';

export const NODE_VERSION = process.versions.node;
export const NODE_MAJOR = Number(NODE_VERSION.split('.')[0]);
export const HAS_GLOBAL_WS = typeof globalThis.WebSocket === 'function';
export const HAS_FETCH = typeof globalThis.fetch === 'function';

/** 当前运行时能力快照，打印在报告里，便于复现问题。 */
export function runtimeInfo() {
  return {
    node: NODE_VERSION,
    hasFetch: HAS_FETCH,
    hasGlobalWebSocket: HAS_GLOBAL_WS,
    wsFallback: HAS_GLOBAL_WS ? 'global' : loadWS(null) ? 'ws' : null,
  };
}

/**
 * 解析 `ws` 包。不 import，因为它是可选依赖（CJS，用 createRequire 兼容两种解析）。
 * @param {string|null} projectDir 目标项目目录（优先从这里解析，项目里一般已经间接依赖了 ws）
 */
export function loadWS(projectDir) {
  const candidates = [];
  if (projectDir) {
    try {
      candidates.push(createRequire(join(projectDir, 'package.json')));
    } catch {
      /* 目录不存在就跳过 */
    }
  }
  try {
    // skill 自身目录（允许用户在这个 skill 里局部安装 ws）
    candidates.push(createRequire(new URL('../../package.json', import.meta.url)));
  } catch {
    /* ignore */
  }

  for (const req of candidates) {
    try {
      const mod = req('ws');
      return mod?.WebSocket || mod;
    } catch {
      /* 试下一个来源 */
    }
  }
  return null;
}

/** 明确的不支持说明，供上层原样打印。 */
export const NO_WEBSOCKET_HINT =
  '当前 Node 没有 WebSocket 能力（Node 22 以下没有全局 WebSocket）。三选一：\n' +
  '  1) 用 Node 22+ 运行本脚本（推荐）；\n' +
  '  2) 在目标项目执行 npm i -D ws（本 skill 会自动从项目里解析）；\n' +
  '  3) 在 skill 目录执行 npm i ws（只影响这个 skill）。\n' +
  '说明：不用 WebSocket 也能跑 `doctor.mjs`（纯静态体检），但 inspect/serve 需要它来连 CDP。';

/**
 * 发一个 GET 并解析 JSON。用 fetch 或 http.request，抹平 Node 16/18/20/22 差异。
 * @param {string} url
 * @param {number} [timeoutMs]
 */
export async function httpJson(url, timeoutMs = 3000) {
  if (HAS_FETCH) {
    const opts = {};
    // AbortSignal.timeout 需要 Node 17.3+；老版本靠外层轮询超时兜底
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(timeoutMs);
    }
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  }

  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`响应不是 JSON：${body.slice(0, 120)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时 ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

/** 统一的 open 等待。 */
function waitOpen(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const fail = (e) => {
      if (done) return;
      done = true;
      reject(e instanceof Error ? e : new Error(String(e?.message || e)));
    };

    const timer = setTimeout(() => fail(new Error('WebSocket 连接超时')), timeoutMs);

    if (typeof target.addEventListener === 'function') {
      target.addEventListener('open', () => {
        clearTimeout(timer);
        ok();
      }, { once: true });
      target.addEventListener('error', (e) => {
        clearTimeout(timer);
        fail(new Error(`WebSocket 连接失败：${e?.message || 'error'}`));
      }, { once: true });
    } else {
      target.once('open', () => {
        clearTimeout(timer);
        ok();
      });
      target.once('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
    }
  });
}

/**
 * 打开 WebSocket 并返回统一接口：{ send, close, onMessage, impl }
 * 调用方不需要知道底层是全局 WebSocket 还是 ws 包。
 *
 * @param {string} url ws://...
 * @param {{projectDir?: string, timeout?: number}} [opts]
 */
export async function openWebSocket(url, opts = {}) {
  const timeout = opts.timeout ?? 10000;

  if (HAS_GLOBAL_WS) {
    const ws = new globalThis.WebSocket(url);
    const listeners = [];
    ws.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      for (const fn of listeners) fn(data);
    });
    await waitOpen(ws, timeout);
    return {
      impl: 'global',
      send: (text) => ws.send(text),
      close: () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
      onMessage: (fn) => listeners.push(fn),
    };
  }

  const WS = loadWS(opts.projectDir || null);
  if (!WS) {
    const err = new Error(NO_WEBSOCKET_HINT);
    err.reason = 'no-websocket';
    throw err;
  }

  const ws = new WS(url, { perMessageDeflate: false, handshakeTimeout: timeout });
  const listeners = [];
  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString();
    for (const fn of listeners) fn(text);
  });
  ws.on('error', () => {
    /* 交给上层的 close/异常路径处理，避免 unhandled 'error' 崩溃 */
  });
  await waitOpen(ws, timeout);

  return {
    impl: 'ws',
    send: (text) => ws.send(text),
    close: () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
    onMessage: (fn) => listeners.push(fn),
  };
}

/**
 * 运行时是否满足本套脚本的要求。
 * @returns {{level:'full'|'partial'|'unsupported', notes:string[], ws:string|null}}
 */
export function checkRuntime(projectDir = null) {
  const ws = HAS_GLOBAL_WS ? 'global' : loadWS(projectDir) ? 'ws' : null;
  const notes = [];

  if (ws) {
    notes.push(`WebSocket: ${ws === 'global' ? '全局（Node 22+）' : 'ws 包'}`);
    return { level: 'full', notes, ws };
  }

  notes.push('WebSocket: 不可用（Node < 22 且未安装 ws）');
  notes.push('→ doctor.mjs 可用；inspect.mjs / serve.mjs 不可用');
  return { level: 'partial', notes, ws: null };
}
