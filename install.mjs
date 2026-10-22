#!/usr/bin/env node
/**
 * install.mjs —— 把本 skill 装进本机的 AI 技能目录（跨平台，零依赖）
 *
 * 为什么不用 shell 脚本：本 skill 本来就要求 Node 18+（脚本全是 .mjs），
 * 用 Node 写安装器就不必再维护 .sh / .ps1 两份、也不会踩 Windows 路径与编码的坑。
 *
 * 用法：
 *   node install.mjs                 # 自动检测本机已有的技能目录并安装到全部
 *   node install.mjs --list          # 只列出检测结果，不安装
 *   node install.mjs --to ~/.xxx/skills   # 指定技能根目录（会装到 <dir>/electron-app-debug）
 *   node install.mjs --force         # 目标已存在时覆盖
 *   node install.mjs --dry-run       # 只打印将要做什么
 *
 * 退出码：0 成功 / 1 失败 / 2 未找到任何目标目录（需用 --to 指定）
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'electron-app-debug';
const SRC = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

/**
 * 已知的「技能根目录」候选。
 *
 * 只放**确实使用 `skills/<name>/SKILL.md` 约定**的目录：
 * 猜错目录比不装更糟 —— 用户会以为装好了但 AI 读不到。
 * 其它工具请用 `--to` 明确指定。
 */
const CANDIDATES = [
  { id: 'workbuddy', label: 'WorkBuddy', dir: join(homedir(), '.workbuddy', 'skills') },
  { id: 'claude', label: 'Claude Code', dir: join(homedir(), '.claude', 'skills') },
  { id: 'agents', label: '通用 agents 目录', dir: join(homedir(), '.agents', 'skills') },
  { id: 'project', label: '当前项目', dir: join(process.cwd(), '.workbuddy', 'skills') },
];

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'artifacts', 'dist']);
// 这些是"仓库级"文件，装进技能目录只是噪音
const EXCLUDE_FILES = [/\.log$/, /^\.DS_Store$/, /^install\.mjs$/, /^README\.md$/i, /^LICENSE$/i, /^\.gitignore$/];

const dry = has('dry-run');
const force = has('force');
const log = (s) => console.log(s);

function detect() {
  return CANDIDATES.filter((c) => existsSync(c.dir));
}

function copySkill(targetRoot) {
  const dest = join(targetRoot, SKILL_NAME);
  if (existsSync(dest)) {
    if (!force) {
      log(`  ! 已存在，跳过（要覆盖加 --force）：${dest}`);
      return { skipped: true, dest };
    }
    log(`  · 覆盖旧版本：${dest}`);
    if (!dry) rmSync(dest, { recursive: true, force: true });
  }
  if (dry) {
    log(`  → 将复制 ${SRC} → ${dest}`);
    return { ok: true, dest, dryRun: true };
  }
  mkdirSync(dest, { recursive: true });
  cpSync(SRC, dest, {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop();
      if (EXCLUDE_DIRS.has(name)) return false;
      if (EXCLUDE_FILES.some((re) => re.test(name))) return false;
      return true;
    },
  });

  // 装完必须验证：目录在但 SKILL.md 缺失/名字不对，等于没装
  const skillMd = join(dest, 'SKILL.md');
  if (!existsSync(skillMd)) throw new Error(`复制完成但缺少 SKILL.md：${dest}`);
  const head = readFileSync(skillMd, 'utf8').slice(0, 400);
  const m = /^---[\s\S]*?name:\s*([\w-]+)/m.exec(head);
  if (!m || m[1] !== SKILL_NAME) {
    throw new Error(`SKILL.md 的 name 字段不是 "${SKILL_NAME}"（读到 ${m ? m[1] : '无'}），装错包了？`);
  }
  return { ok: true, dest, files: countFiles(dest) };
}

function countFiles(dir, n = 0) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n = countFiles(join(dir, e.name), n);
    else n++;
  }
  return n;
}

// ── 主流程 ─────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0]);
log(`\n${SKILL_NAME} 安装器  ·  Node ${process.versions.node}  ·  源：${SRC}`);
if (Number.isNaN(major) || major < 18) {
  console.error(`\n❌ 需要 Node 18+（当前 ${process.versions.node}）。`);
  process.exit(1);
}

const to = arg('to');
let targets;
if (to) {
  targets = [{ id: 'custom', label: '--to 指定', dir: resolve(to.replace(/^~(?=$|[\\/])/, homedir())) }];
} else {
  targets = detect();
}

if (!targets.length) {
  console.error(`
❌ 没有找到已知的技能目录（这些都不存在）：
${CANDIDATES.map((c) => `   · ${c.dir}`).join('\n')}

请用 --to 指定你的工具的技能根目录，例如：
   node install.mjs --to ~/.workbuddy/skills
   node install.mjs --to "C:/Users/you/.claude/skills"
`);
  process.exit(2);
}

if (has('list')) {
  log('\n检测到的技能目录：');
  for (const t of targets) log(`  [${t.id}] ${t.dir}`);
  log('\n加 --dry-run 可预览，去掉 --list 即开始安装。');
  process.exit(0);
}

let okCount = 0;
for (const t of targets) {
  log(`\n[${t.id}] ${t.dir}`);
  try {
    const r = copySkill(t.dir);
    if (r.ok) {
      okCount++;
      if (r.dryRun) log('  ✓ [dry-run] 未实际写入');
      else log(`  ✓ 已安装${r.files ? `（${r.files} 个文件）` : ''}`);
    }
  } catch (e) {
    log(`  ✗ 失败：${e.message}`);
  }
}

if (!okCount && !dry) {
  console.error('\n没有安装成功任何一份。');
  process.exit(1);
}

log(`
下一步
  1. 重启 AI 客户端（技能在会话启动时加载，不重启看不到）；
  2. 让它跑一次体检确认可用：
       node ~/.workbuddy/skills/${SKILL_NAME}/scripts/doctor.mjs --project <你的 Electron 项目>
  3. 也可以直接在对话里说「用 electron-app-debug 帮我看看这个 Electron 应用为什么白屏」。
`);
