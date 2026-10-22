#!/usr/bin/env node
/**
 * act.mjs —— 对**正在运行**的 Electron 应用做单次动作（点一下、填一下、看一眼）
 *
 * 定位：`serve.mjs` / `inspect.mjs` 负责「把应用跑起来并看清它」，
 * act.mjs 负责「动手试一下」。每次调用独立连接、执行、退出，不留后台进程 ——
 * 适合「点两下看看」「改完立刻验一下」这类临时操作，不需要写 JS 脚本。
 *
 * 用法（端口默认 9492，与 serve.mjs 默认值一致）：
 *   node act.mjs dom                                   # 列出可见按钮/输入框 + 建议选择器
 *   node act.mjs click 'text=新建项目'
 *   node act.mjs click '#btn-play' --then '!!document.querySelector(".game-active")'
 *   node act.mjs fill '#search-projects' 'Demo'
 *   node act.mjs press '#search-projects' Enter
 *   node act.mjs eval 'document.title'
 *   node act.mjs wait '!!document.querySelector(".editor-layout")' --timeout 20000
 *   node act.mjs shot --out after-click.png
 *   node act.mjs reload                                # 重载页面（改完代码复验 / 截图卡住时恢复）
 *
 * 通用选项：
 *   --attach <port>    调试端口（默认 9492）
 *   --target <子串>    多窗口时按标题/URL 选窗口
 *   --then <expr>      动作完成后等待该表达式为真（失败即判失败）
 *   --timeout <ms>     --then / wait 的超时，默认 15000
 *   --json             机器可读输出
 *
 * 退出码：0 成功 / 1 动作未生效 / 2 运行时缺 WebSocket / 3 附加失败
 */

import { attachByPort, waitFor, reload as reloadPage, FAILURE_HINT } from './lib/cdp.mjs';
import { checkRuntime, NO_WEBSOCKET_HINT } from './lib/compat.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

/** 位置参数：第一个是动作，之后是它的参数（可能含空格与中文，不要按 -- 前缀误判） */
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    // 只跳过已知带值选项的「值」
    const NEEDS_VALUE = ['attach', 'target', 'then', 'timeout', 'out', 'mode', 'project'];
    if (NEEDS_VALUE.includes(argv[i].slice(2)) && i + 1 < argv.length) i++;
    continue;
  }
  positional.push(argv[i]);
}

const PORT = arg('attach', '9492');
const TARGET = arg('target', null);
const THEN = arg('then', null);
const TIMEOUT = Number(arg('timeout', 15000));
const AS_JSON = has('json');
const PROJECT = arg('project', process.cwd());

const action = positional[0];
const a1 = positional[1];
const a2 = positional[2];

function out(result, humanLine) {
  if (AS_JSON) console.log(JSON.stringify(result, null, 2));
  else if (humanLine) console.log(humanLine);
}

function help() {
  console.log(`
act.mjs —— 对正在运行的 Electron 应用做单次动作

  node act.mjs <动作> [参数] [选项]

动作：
  dom                                 列出可见可交互元素 + 建议选择器
  click <选择器> [--mode auto|mouse|dom]
  fill  <选择器> <文本>
  press <选择器> [键名=Enter]
  eval  <表达式>
  wait  <表达式>                       轮询直到为真
  shot  [--out 文件路径]
  reload                              重载页面（并等 load 完成）

选项：
  --attach <端口>   默认 9492
  --target <子串>   多窗口选窗口
  --then <表达式>   动作后等待该条件成立
  --timeout <ms>    默认 15000
  --json

选择器：CSS，或 text=文案 / :has-text("文案") 两种文本写法。
`);
}

async function main() {
  if (!action || has('help') || action === 'help') return help();

  const rt = checkRuntime(PROJECT);
  if (!rt.ws) {
    console.error(`\n❌ ${NO_WEBSOCKET_HINT}`);
    process.exit(2);
  }

  let client;
  try {
    ({ client } = await attachByPort(PORT, { hint: TARGET, projectDir: PROJECT }));
  } catch (e) {
    console.error(`\n❌ 附加失败：${e.reason || 'unknown'}`);
    console.error(`   ${FAILURE_HINT[e.reason] || e.message}`);
    if (e.reason === 'no-target') console.error('   先用 `node scripts/serve.mjs --project <目录>` 起一个带端口的实例。');
    process.exit(3);
  }

  let result;
  let line = '';
  let ok = true;

  switch (action) {
    case 'dom': {
      const list = await client.inventory();
      result = { ok: true, count: list.length, elements: list };
      line = `可见可交互元素 ${list.length} 个：`;
      for (const el of list.slice(0, 40)) {
        const label = `${el.tag}${el.type ? '[' + el.type + ']' : ''}`.padEnd(16);
        line += `\n  ${label} ${el.disabled ? '(disabled) ' : ''}${el.text || '(无文案)'}   →  ${el.selector || 'text=' + el.text}`;
      }
      break;
    }

    case 'click': {
      if (!a1) return help();
      const mode = arg('mode', 'auto');
      result = await client.click(a1, { mode });
      ok = !!result.clicked;
      line = result.clicked
        ? `点击成功（${result.method}）：${result.tag} "${result.text}"${result.method === 'dom' ? '  ⚠ 用了 DOM 点击：该元素用户可能点不到（被遮挡/不可见）' : ''}`
        : `点击失败：${result.reason || 'unknown'}${result.tag ? ` (${result.tag} "${result.text}")` : ''}`;
      break;
    }

    case 'fill': {
      if (!a1) return help();
      result = await client.fill(a1, a2 ?? '');
      ok = !!result.matched;
      line = result.matched
        ? `填写成功：回读 "${result.readback}"（原值 "${result.before ?? ''}"）`
        : `填写未生效：回读 "${result.readback ?? ''}"，期望 "${a2 ?? ''}"（受控组件没认这次赋值？）`;
      break;
    }

    case 'press': {
      if (!a1) return help();
      const key = a2 || 'Enter';
      result = await client.press(a1, key);
      ok = !!result.ok;
      line = result.ok ? `已按键 ${result.key}（作用于 ${a1}）` : `按键失败：${result.reason || 'unknown'}`;
      break;
    }

    case 'eval': {
      if (!a1) return help();
      try {
        const value = await client.evaluate(a1);
        result = { ok: true, value };
        line = typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value);
      } catch (e) {
        result = { ok: false, error: e.message };
        ok = false;
        line = `求值失败：${e.message}`;
      }
      break;
    }

    case 'wait': {
      if (!a1) return help();
      const hit = await waitFor(client, a1, { timeout: TIMEOUT });
      result = { ok: hit, waited: TIMEOUT };
      ok = hit;
      line = hit ? `条件已满足（≤${TIMEOUT}ms）` : `等待超时（${TIMEOUT}ms）：${a1}`;
      break;
    }

    case 'reload': {
      const okLoad = await reloadPage(client, { timeout: TIMEOUT });
      result = { ok: okLoad, reloaded: okLoad };
      ok = okLoad;
      line = okLoad ? '已重载并完成 load' : `已发出 reload，但 ${TIMEOUT}ms 内没等到 load 完成`;
      break;
    }

    case 'shot': {
      const outArg = arg('out', null);
      const file = outArg
        ? (isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg))
        : join(PROJECT, 'artifacts', `act-${Date.now()}.png`);
      const buf = Buffer.from(await client.screenshot(), 'base64');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buf);
      result = { ok: true, screenshot: file, bytes: buf.length };
      line = `截图: ${file} (${(buf.length / 1024).toFixed(0)} KB)`;
      break;
    }

    default:
      return help();
  }

  // --then：动作之后等条件成立，把「点完是否真的生效」变成可判定结果
  if (THEN) {
    const hit = await waitFor(client, THEN, { timeout: TIMEOUT }).catch(() => false);
    result.then = { expr: THEN, ok: hit, timeout: TIMEOUT };
    if (!hit) ok = false;
    line += hit ? `\n后续条件已满足：${THEN}` : `\n后续条件未满足（${TIMEOUT}ms）：${THEN}`;
  }

  client.close();
  result.ok = ok;
  out(result, line);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
