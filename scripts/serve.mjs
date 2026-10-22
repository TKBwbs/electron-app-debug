#!/usr/bin/env node
/**
 * serve.mjs —— 把应用跑起来并常驻开放 CDP，供智能体实时操作
 *
 * 与 inspect.mjs 的区别：
 *   · inspect：一次体检 + 截图，跑完就退，适合「看一眼现在什么样」；
 *   · serve  ：应用常驻、调试端口开放，适合「点一下试试 / 改完立刻复验」。
 *
 * 端口固定（默认 9492）是刻意的：MCP 配置里写死这个地址，之后不用每次改。
 * 不要用 9222 —— 那是外部 Chrome 的默认调试端口，撞上后极难排查。
 *
 * 用法：
 *   node serve.mjs --project <目录>
 *   node serve.mjs --project <目录> --port 9492 --flags "--disable-gpu-sandbox"
 *   node serve.mjs --project <目录> --no-mcp        # 只起应用，不打印 MCP 配置
 */

import { launchAdaptive, connectPage, attachByPort, FAILURE_HINT } from './lib/cdp.mjs';
import { checkRuntime, NO_WEBSOCKET_HINT } from './lib/compat.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const PROJECT = arg('project', process.cwd());
const PORT = Number(arg('port', 9492));
const ATTACH = arg('attach', null);
const TARGET_HINT = arg('target', null);
const SHOW_MCP = !argv.includes('--no-mcp');
const EXPLICIT = arg('flags', null);

// 不指定 --flags 时走自适应阶梯：无 GPU 环境下 --disable-gpu-sandbox 往往还不够，
// 需要补 --no-sandbox，否则 renderer 会被崩溃的 GPU 进程一起带走。
const LADDER = EXPLICIT
  ? [EXPLICIT.split(/\s+/).filter(Boolean)]
  : [[], ['--disable-gpu-sandbox'], ['--no-sandbox', '--disable-gpu-sandbox']];

const rt = checkRuntime(PROJECT);
if (!rt.ws) {
  console.error(`\n❌ ${NO_WEBSOCKET_HINT}`);
  process.exit(2);
}

/**
 * 两种模式共用同一套输出与 MCP 配置，区别只在「谁把应用跑起来」：
 *   · 默认：本脚本启动（可加自适应参数）
 *   · --attach <port>：只连已在运行的应用，不启动、不重启、不结束它
 */
let launched = null;
let attempts = [];
let title = '';
let pageUrl = '';
let cdpPort = PORT;
let attachInfo = '';

if (ATTACH) {
  cdpPort = Number(ATTACH);
  try {
    const r = await attachByPort(ATTACH, { hint: TARGET_HINT, projectDir: PROJECT });
    title = await r.client.evaluate('document.title').catch(() => '');
    pageUrl = r.target.url || '';
    r.client.close();
    attachInfo = `已附加（未重启）：${title || '(无标题)'}`;
  } catch (e) {
    console.error(`\n❌ 附加失败：${e.reason || 'unknown'}`);
    console.error(
      e.reason === 'no-target'
        ? '  该实例启动时没带 --remote-debugging-port，或端口不对。已运行的实例无法事后开启调试端口。'
        : `  ${e.message}`,
    );
    process.exit(1);
  }
} else {
  try {
    ({ launched, attempts } = await launchAdaptive({ projectDir: PROJECT, ladder: LADDER, port: PORT, timeout: 30000 }));
  } catch (e) {
    console.error(`\n❌ 启动失败：${e.reason || 'unknown'}\n   ${FAILURE_HINT[e.reason] || ''}`);
    console.error((e.logs || '').slice(-1500));
    process.exit(1);
  }

  // 连一次以确认端口真能用（也能顺手报出页面标题，便于确认连对了窗口）
  const client = await connectPage(launched.page, { projectDir: PROJECT });
  title = await client.evaluate('document.title').catch(() => '');
  pageUrl = launched.page.url;
  client.close();
  attachInfo = `应用已启动：${PROJECT}`;
}

console.log(`
════════════════════════════════════════════════════════
 ${attachInfo}
 页面：${title || '(无标题)'}  ${pageUrl}
 CDP ：http://127.0.0.1:${cdpPort}${launched ? `   (${launched.exeSource})` : '   (外部实例)'}
 ${launched ? `参数：${launched.flags.join(' ') || '(无)'}${attempts.length > 1 ? '（已降级）' : ''}` : '退出本脚本不会关闭应用'}
`);

if (SHOW_MCP) {
  console.log(` 挂进 Cursor / WorkBuddy 的 mcpServers：

{
  "mcpServers": {
    "electron-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:${cdpPort}"]
    }
  }
}

 无 MCP 时的零依赖替代（Node 18+）：

  node -e "fetch('http://127.0.0.1:${cdpPort}/json/list').then(r=>r.json()).then(l=>l.filter(t=>t.type==='page'&&!/^devtools/.test(t.url)).forEach(t=>console.log(t.title,t.webSocketDebuggerUrl)))"
════════════════════════════════════════════════════════
 Ctrl+C 结束。
`);
} else {
  console.log('\n Ctrl+C 结束。\n');
}

// 附加模式没有子进程要收，Ctrl+C 只断开自己；启动模式才结束应用
const bye = async () => {
  if (launched) await launched.stop();
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
if (launched) launched.proc.on('exit', () => process.exit(0));
