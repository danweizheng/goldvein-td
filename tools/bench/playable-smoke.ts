/**
 * `pnpm exec tsx tools/bench/playable-smoke.ts [选项]`
 *
 * 「能打开就能玩」这条验收标准的**可测量版本**：
 * 起服务器 → headless 浏览器打开真实页面 → 收 console / **未捕获异常** →
 * 问页面客观事实 → 像素审计 → 截图（可选：真的点鼠标建塔）。
 *
 * 为什么要它：编译通过 ≠ 能打开。本项目已多次踩过"门禁看起来绿、其实什么都没测"
 * （AGENTS 铁律 8）。这里测的是**页面里真的有一张在推进的画布**、
 * **art 图集真的挂上了**、**音频真的加载了**、以及**有没有异常**。
 *
 * ## 选项
 *   --dist               托管 `pnpm build` 的 `dist/`（静态服务器）。**不加则走 vite dev server**
 *   --difficulty N1..N5  默认 N1
 *   --scene probe        像素校验页
 *   --settle 9000        导航后等多少毫秒
 *   --play               真的点鼠标建塔 + 按 F 加速，再报窃金/波次
 *   --play-ms 30000      交互后等多久
 *   --self-test-errors   **自检**：在页面里故意 throw，断言异常通道能打出 message 与栈
 *   --port / --verbose
 */
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokePage } from './browser-bench';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ogg': 'audio/ogg',
  '.webmanifest': 'application/manifest+json',
};

/**
 * 极简静态服务器（零依赖）—— 托管 `pnpm build` 的 `dist/`。
 *
 * 为什么另有一条静态路径：`vite` dev server 在长连接下会重启/被杀，
 * 把还在加载的资源打成 `ERR_CONNECTION_REFUSED`（实测）。静态服务器没有这些活动，
 * 且**顺带验证了生产产物**。但人类用的是 `pnpm dev` —— 所以默认路径仍是 dev server。
 */
function startStaticServer(root: string, port: number): Promise<Server> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const raw = (req.url ?? '/').split('?')[0] ?? '/';
      const rel = normalize(decodeURIComponent(raw)).replace(/^([/\\])+/, '');
      const file = join(root, rel === '' ? 'index.html' : rel);
      if (!file.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      readFile(file)
        .then((buf) => {
          res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
          res.end(buf);
        })
        .catch(() => {
          res.writeHead(404).end('not found');
        });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

function argOf(argv: string[], name: string, fallback: string): string {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const difficulty = argOf(argv, '--difficulty', 'N1');
  const scene = argOf(argv, '--scene', '');
  const settleMs = Number(argOf(argv, '--settle', '9000'));
  const useDist = argv.includes('--dist');
  const port = Number(argOf(argv, '--port', '5211'));

  const viteEntry = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const distDir = join(REPO_ROOT, 'dist');
  if (!useDist && !existsSync(viteEntry)) {
    console.error(`找不到 ${viteEntry}`);
    process.exitCode = 1;
    return;
  }
  if (useDist && !existsSync(distDir)) {
    console.error('dist/ 不存在 —— 请先 `pnpm build`');
    process.exitCode = 1;
    return;
  }

  let server: Server | null = null;
  if (useDist) server = await startStaticServer(distDir, port);

  const path = `/index.html?difficulty=${difficulty}${scene ? `&scene=${scene}` : ''}`;
  console.log(
    `════ 可玩路径冒烟 ════\n托管 = ${useDist ? 'dist/（生产产物 + 静态服务器）' : 'vite dev server（★ 人类用的路径）'}\n页面 ${path}（等 ${settleMs}ms 取快照）`,
  );

  try {
    const result = await smokePage({
      nodeExe: process.execPath,
      viteEntry,
      repoRoot: REPO_ROOT,
      path,
      outDir: OUT_DIR,
      port,
      settleMs,
      verbose: argv.includes('--verbose'),
      ...(useDist ? { baseUrl: `http://127.0.0.1:${port}` } : {}),
      ...(argv.includes('--play') ? { play: true, playMs: Number(argOf(argv, '--play-ms', '30000')) } : {}),
      ...(argv.includes('--self-test-errors') ? { injectError: true } : {}),
      ...(argv.includes('--block-feedback') ? { feedbackKeys: ['1', '4'] } : {}),
    });

    console.log(`\nok = ${result.ok}   ${result.reason ?? ''}`);
    console.log('页面客观事实：');
    for (const [k, v] of Object.entries(result.probes)) {
      console.log(`  ${k} = ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    }

    if (result.exceptions.length > 0) {
      console.log('\n⚠ 异常 / 错误行：');
      for (const e of result.exceptions.slice(0, 14)) console.log('  ' + e);
    } else {
      console.log('\n无异常（未捕获异常 / console.error / log:error 都为空）');
    }

    console.log('\nconsole 末尾：');
    for (const l of result.consoleLines.slice(-10)) console.log('  ' + l.slice(0, 200));

    if (result.playReport) {
      console.log('\n交互结果（真的点了鼠标 + 按了 F 加速）：');
      for (const [k, v] of Object.entries(result.playReport)) {
        console.log(`  ${k} = ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      }
    }
    if (result.screenshotPath) console.log(`\n截图：${result.screenshotPath}`);

    // ── 卡位反馈对照（同一页面 / 同一区域 / 只切换选中的塔系）──
    if (result.feedbackProbe && result.feedbackProbe.length > 0) {
      console.log('\n════ 卡位反馈对照（红色像素 = 阻挡虚线 / 锁图标）════');
      for (const f of result.feedbackProbe) {
        console.log(`  按键 [${f.key}] → ${f.label}：blockRedPixels=${f.blockRedPixels}, goldWorldPixels=${f.goldWorldPixels}`);
      }
      const none = result.feedbackProbe.find((f) => !f.label.includes('blockRanges=true'));
      const block = result.feedbackProbe.find((f) => f.label.includes('blockRanges=true'));
      console.log(
        `  判定：无阻挡塔系 = ${none?.blockRedPixels ?? 'n/a'}（期望 0）；军训系 = ${block?.blockRedPixels ?? 'n/a'}（期望 > 0）`,
      );
      if (none && block) {
        if (none.blockRedPixels === 0 && block.blockRedPixels > 0) console.log('  ✓ 对照成立');
        else console.log('  ✗ 对照不成立：红色像素无法区分"有阻挡范围"与"没有"');
      }
    }

    // ── 自检判定（负对照）──
    if (argv.includes('--self-test-errors')) {
      const joined = result.exceptions.join('\n');
      const foundMessage = joined.includes('SMOKE_SELF_TEST_BOOM');
      const foundStack = /at .*\(|at .*:\d+:\d+/.test(joined);
      console.log('\n════ 冒烟工具自检：故意 throw 是否能带出 message 与栈 ════');
      console.log(`  注入标记出现在异常文本里 = ${foundMessage}`);
      console.log(`  含栈帧(at …)             = ${foundStack}`);
      console.log(`  异常条目数               = ${result.exceptions.length}`);
      if (!foundMessage || !foundStack) {
        console.log('  ✗ 自检失败：异常通道是**空测量**（报错了但说不清错什么）');
        process.exitCode = 1;
      } else {
        console.log('  ✓ 自检通过：message 与栈都拿到了');
      }
    }

    if (!result.ok) process.exitCode = 1;
  } finally {
    if (server) await new Promise<void>((r) => server?.close(() => r()));
  }
}

main().catch((err: unknown) => {
  console.error('冒烟失败：', err);
  process.exitCode = 1;
});