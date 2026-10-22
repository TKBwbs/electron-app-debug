#!/usr/bin/env node
/**
 * doctor.mjs —— Electron 项目静态体检（不启动应用，秒级）
 *
 * 回答三个问题：
 *   1. 这个项目怎么启动？（入口 / 构建产物 / dev 服务器）
 *   2. 它是 WebGL 还是 WebGPU？（静态线索，运行期由 inspect.mjs 复核）
 *   3. 该用哪些启动参数？哪些坑大概率会踩？
 *
 * 用法：
 *   node doctor.mjs --project <项目目录> [--json]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkRuntime, runtimeInfo } from './lib/compat.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const PROJECT = arg('project', process.cwd());
const AS_JSON = argv.includes('--json');

const notes = [];
const warn = (m) => notes.push({ level: 'warn', message: m });
const info = (m) => notes.push({ level: 'info', message: m });

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function newestMtime(dir, exts) {
  let t = 0;
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        t = Math.max(t, statSync(full).mtimeMs);
      }
    }
  };
  walk(dir);
  return t;
}

/** 递归抓取源码里与渲染后端相关的线索。 */
function scanBackendHints(projectDir) {
  const hints = { webgpu: [], webgl: [], raw: [] };
  const roots = ['src', 'app', 'main', 'renderer', 'electron'].map((d) => join(projectDir, d)).filter(existsSync);
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte|html)$/.test(e.name)) {
        files.push(full);
      }
    }
  };
  roots.forEach(walk);
  // 根目录的入口 html 也算
  for (const f of ['index.html', 'player.html']) if (existsSync(join(projectDir, f))) files.push(join(projectDir, f));

  const WEBGPU_RE = /three\/webgpu|WebGPURenderer|navigator\.gpu|requestAdapter|getContext\(\s*['"]webgpu['"]|GPUDevice|\bwgpu\b/i;
  const WEBGL_RE = /WebGLRenderer|getContext\(\s*['"]webgl2?['"]|THREE\.WebGL|WebGL2RenderingContext/i;

  for (const f of files) {
    let src = '';
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(projectDir, f).replace(/\\/g, '/');
    if (WEBGPU_RE.test(src)) hints.webgpu.push(rel);
    if (WEBGL_RE.test(src)) hints.webgl.push(rel);
  }
  return { hints, fileCount: files.length };
}

// ────────────────────────────────────────────────
const report = { project: PROJECT, ok: true };

const pkg = readJson(join(PROJECT, 'package.json'));
if (!pkg) {
  report.ok = false;
  report.error = `不是 Node 项目：${PROJECT} 下没有 package.json`;
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  else console.log(`\n❌ ${report.error}\n   用 --project 指向 Electron 项目的根目录。`);
  process.exit(1);
}

report.package = { name: pkg.name, version: pkg.version, type: pkg.type || 'commonjs', main: pkg.main };

const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
report.electronVersion = deps.electron || null;
if (!deps.electron) warn('package.json 里没有 electron 依赖，确认这是 Electron 项目');

// ── 版本能力分析 ────────────────────────────────────────────
/**
 * 从 semver 范围里取主版本（`^32.0.0` / `~28.1.0` / `>=25` 都能取到）。
 * 同时优先读 node_modules 里**实际安装**的版本，范围只是声明。
 */
const majorOf = (v) => {
  const m = String(v || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
};

const installedElectron = (() => {
  const p = join(PROJECT, 'node_modules', 'electron', 'package.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8')).version || null;
  } catch {
    return null;
  }
})();

const em = majorOf(installedElectron) ?? majorOf(deps.electron);
report.versions = {
  electronInstalled: installedElectron,
  electronDeclared: deps.electron || null,
  electronMajor: em,
  scriptNode: runtimeInfo(),
};

/**
 * 版本门槛表。每条都对应一个**会改变排查结论**的能力，
 * 而不是「新版本更好」这种废话。
 */
const capabilities = [];
// 允许传 true/false，也允许传 'yes'/'no'/'unknown'（三态里的“未验证”很重要，不能退化成 false）
const cap = (name, ok, note) =>
  capabilities.push({ name, ok: ok === true || ok === 'yes' ? 'yes' : ok === 'unknown' ? 'unknown' : 'no', note });

if (em === null) {
  cap('整体判定', 'unknown', '无法确定 Electron 主版本；请用 --flags 手动指定一组参数，并用 inspect.mjs 看实际后端');
} else {
  cap(
    'WebGPU（navigator.gpu）',
    em >= 25,
    em >= 25
      ? 'Chromium 114+，支持 WebGPU'
      : `Electron ${em} 的 Chromium 早于 113，没有 WebGPU —— 不要按 WebGPU 项目排查，黑屏不是后端问题`,
  );
  cap(
    'Playwright `_electron` E2E',
    em >= 14 ? 'yes' : 'unknown',
    em >= 14
      ? '官方支持列表内（12.2+/13.4+/14+）'
      : em >= 12
        ? '官方只列 12.2+/13.4+/14+，但**实测 12.0.18 + playwright-core 1.64 可正常驱动**（标题/DOM/截图全通过）；先试，报错再退回 CDP 方案'
        : '未实测过该版本；先试一下（`assets/e2e-harness.mjs`），失败就改用 CDP 方案（inspect/serve）',
  );
  cap(
    '`--enable-unsafe-swiftshader`',
    em >= 21,
    em >= 21 ? 'Chromium 105+，认识该开关' : '该开关是 Chromium 105+ 才有；老版本用 --use-angle=swiftshader',
  );
  cap(
    'CDP 调试（inspect / serve）',
    em >= 5,
    em >= 5 ? '--remote-debugging-port + /json/list 各版本行为一致' : 'Electron 5 以下未验证：沙箱开关语义不同，且 /json/list 可能不可用',
  );
}
report.capabilities = capabilities;

// 脚本自身运行时（这条与 Electron 版本无关，取决于跑脚本的那颗 Node）
const rt = checkRuntime(PROJECT);
report.scriptRuntimeCheck = rt;
if (rt.level === 'partial') {
  warn('本机 Node 无法建立 WebSocket：doctor 可用，但 inspect/serve 需要 Node 22+ 或在项目里 npm i -D ws');
}

// 构建/启动工具链
report.toolchain = {
  'vite-plugin-electron': !!deps['vite-plugin-electron'],
  'electron-vite': !!deps['electron-vite'],
  'electron-builder': !!deps['electron-builder'],
  'electron-forge': !!(deps['@electron-forge/cli'] || deps['electron-forge']),
  playwright: !!deps['playwright'] || !!deps['playwright-core'],
  'better-sqlite3': !!deps['better-sqlite3'],
};
report.scripts = {
  dev: pkg.scripts?.dev || null,
  build: pkg.scripts?.build || null,
  start: pkg.scripts?.start || null,
  test: pkg.scripts?.test || null,
};

// 产物与新鲜度
const artifacts = ['dist/index.html', 'dist-electron/main/index.js', 'out/main/index.js', 'build/index.html'].filter((f) =>
  existsSync(join(PROJECT, f)),
);
report.artifacts = artifacts;
report.buildFreshness = null;
if (artifacts.length) {
  const builtAt = Math.min(...artifacts.map((f) => statSync(join(PROJECT, f)).mtimeMs));
  const srcAt = newestMtime(join(PROJECT, 'src'), ['.js', '.ts', '.tsx', '.jsx', '.vue']);
  report.buildFreshness = { builtAt: new Date(builtAt).toISOString(), stale: srcAt > builtAt + 1000 };
  if (report.buildFreshness.stale) warn('src 比构建产物新 —— 直接跑产物会测到旧代码，先 npm run build');
} else {
  warn('没找到构建产物（dist/ 或 out/）。若 main 指向产物，必须先 build 才能启动');
}

// 渲染后端（静态）
const { hints, fileCount } = scanBackendHints(PROJECT);
report.sourceFilesScanned = fileCount;
report.backendHints = {
  webgpu: hints.webgpu.slice(0, 6),
  webgl: hints.webgl.slice(0, 6),
};
const hasGPU = hints.webgpu.length > 0;
const hasGL = hints.webgl.length > 0;
report.suspectedBackend = hasGPU && hasGL ? 'both' : hasGPU ? 'webgpu' : hasGL ? 'webgl' : 'unknown';
if (report.suspectedBackend === 'unknown') {
  info('源码里没找到渲染后端线索 —— 运行 node scripts/inspect.mjs 用运行时探测确定');
}

// 主进程里值得提前知道的行为
function grepMain(re) {
  const candidates = ['src/main', 'main', 'electron', 'src'].map((d) => join(PROJECT, d));
  const hits = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.(js|mjs|cjs|ts)$/.test(e.name)) {
        let src = '';
        try {
          src = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (re.test(src)) hits.push(relative(PROJECT, full).replace(/\\/g, '/'));
      }
    }
  };
  candidates.forEach(walk);
  return [...new Set(hits)].slice(0, 4);
}

report.mainProcess = {
  singleInstanceLock: grepMain(/requestSingleInstanceLock/),
  autoOpenDevTools: grepMain(/openDevTools\s*\(/),
  userDataOverride: grepMain(/setPath\(\s*['"]userData['"]/),
  remoteDebugging: grepMain(/remote-debugging-port/),
};
if (report.mainProcess.singleInstanceLock.length) {
  warn('主进程用了 requestSingleInstanceLock —— 第二个实例会直接退出，测试时务必用独立 --user-data-dir');
}
if (report.mainProcess.autoOpenDevTools.length) {
  info('主进程会自动 openDevTools() —— CDP 的 page 列表里会多一个 devtools:// 目标，附加时要排掉');
}

// 当前 shell 环境
report.environment = {
  ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || null,
  platform: process.platform,
  node: process.version,
};
if (process.env.ELECTRON_RUN_AS_NODE) {
  warn('当前 shell 有 ELECTRON_RUN_AS_NODE=1 —— 直接启动 electron 会退化成裸 Node（报 reading \'exports\'）。本 skill 的脚本已自动清掉，手写命令时必须 unset');
}

// 启动参数建议
const rec = [];
if (report.suspectedBackend === 'webgpu' || report.suspectedBackend === 'both') {
  rec.push({
    flags: ['--disable-gpu-sandbox'],
    why:
      report.suspectedBackend === 'both'
        ? '同时有 WebGL/WebGPU 线索（多为 WebGPURenderer 的 WebGL 回退路径）：按 WebGPU 保守处理 —— 绝不要加 --disable-gpu'
        : 'WebGPU 项目：只关 GPU 沙箱。绝不要加 --disable-gpu，那会让 requestAdapter() 返回 null',
  });
  rec.push({ flags: ['--no-sandbox', '--disable-gpu-sandbox'], why: '若上一档仍 GPU 进程崩溃，再补 --no-sandbox' });
} else if (report.suspectedBackend === 'webgl') {
  rec.push({ flags: ['--disable-gpu-sandbox'], why: 'WebGL 项目：先只关 GPU 沙箱' });
  rec.push({ flags: ['--no-sandbox', '--disable-gpu-sandbox'], why: '仍崩溃时补 --no-sandbox' });
  rec.push({ flags: ['--no-sandbox', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], why: '无 GPU / 远程桌面：强制 SwiftShader 软件渲染' });
} else {
  rec.push({ flags: ['--disable-gpu-sandbox'], why: '未知后端：先用最保守的一档，再用 inspect.mjs 看实际后端' });
}
report.recommendedFlags = rec;

report.notes = notes;

// ────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);
  console.log(`\n项目 ${report.package.name || '(未命名)'} @ ${PROJECT}`);
  line('electron', report.electronVersion || '(未声明)');
  line('electron 已安装', report.versions.electronInstalled || '(未安装/未解析)');
  line('脚本运行时', `Node ${report.versions.scriptNode.node} · WebSocket ${report.versions.scriptNode.hasGlobalWebSocket ? '全局' : report.versions.scriptNode.wsFallback === 'ws' ? 'ws 包' : '不可用'}`);
  line('main', report.package.main || '(未声明)');
  line('type', report.package.type);
  line('dev / build', `${report.scripts.dev || '-'} / ${report.scripts.build || '-'}`);
  line('构建产物', report.artifacts.length ? report.artifacts.join(', ') : '(无)');
  if (report.buildFreshness?.stale) line('产物新鲜度', '⚠ 过期');
  const tc = Object.entries(report.toolchain).filter(([, v]) => v).map(([k]) => k);
  line('工具链', tc.join(', ') || '(裸 electron)');
  line('后端（静态推测）', report.suspectedBackend);
  if (report.backendHints.webgpu.length) line('  ↳ WebGPU 线索', report.backendHints.webgpu.join(', '));
  if (report.backendHints.webgl.length) line('  ↳ WebGL 线索', report.backendHints.webgl.join(', '));

  console.log('\n版本能力：');
  const ICON = { yes: '✅', no: '❌', unknown: '⚠️' };
  for (const c of report.capabilities || []) {
    console.log(`  ${ICON[c.ok] || '·'} ${c.name}`);
    if (c.ok !== 'yes') console.log(`      ${c.note}`);
  }

  console.log('\n建议启动参数：');
  for (const r of report.recommendedFlags) console.log(`  ${r.flags.join(' ')}\n     ${r.why}`);

  if (notes.length) {
    console.log('\n注意：');
    for (const n of notes) console.log(`  ${n.level === 'warn' ? '⚠' : '·'} ${n.message}`);
  }

  console.log('\n下一步：node scripts/inspect.mjs --project "' + PROJECT + '"   # 启动 + 探测后端 + 截图');
}
