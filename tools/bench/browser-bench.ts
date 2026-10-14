/**
 * 浏览器基准驱动（CDP over WebSocket，零第三方依赖）
 *
 * 流程：
 *   1. 起 `vite` 开发服务器（固定端口，避免撞到别的 agent 的 dev server）；
 *   2. 找 Edge / Chrome，headless 启动 + `--remote-debugging-port`；
 *   3. 用 Node 内置 `WebSocket`（Node ≥ 22）连 CDP，收集 console 输出；
 *   4. 依次打开两个页面：
 *        /tools/bench/render-bench.html  → 250 敌人 + 500 投射物 + 300 飘字的 FPS
 *        /index.html?scene=probe         → 「NEAREST 无糊边」的逐像素判定
 *   5. 顺手截一张图存到 tools/bench/out/ 作为人眼可核对的证据。
 *
 * 找不到浏览器 / 起不来时**不抛异常**：返回 `{ ok: false, reason }`，
 * 由 run.ts 在报告里如实写「无法验证」，而不是让整条 `pnpm bench` 挂掉。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BrowserBenchResult {
  ok: boolean;
  reason?: string;
  browserPath?: string;
  benchJson?: unknown;
  probeJson?: unknown;
  screenshotPath?: string;
  jsHeapUsedBytes?: number;
  consoleLines?: string[];
}

const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
].filter((p) => p !== '');

function findBrowser(): string | null {
  for (const p of BROWSER_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

interface CdpStackFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface CdpStackTrace {
  description?: string;
  callFrames?: CdpStackFrame[];
}

interface CdpExceptionDetails {
  text?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: { className?: string; description?: string; value?: unknown; preview?: unknown };
  stackTrace?: CdpStackTrace;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 300);
  } catch {
    return '[unserializable]';
  }
}

/** 把 CDP 的 stackTrace 变成人类可读的几行（函数名 @ url:line:col）。 */
function formatStackTrace(st: CdpStackTrace | undefined): string {
  if (!st) return '';
  const frames = st.callFrames ?? [];
  if (frames.length === 0) return st.description ? `    stack: ${st.description}` : '';
  return frames
    .slice(0, 6)
    .map((f) => `    at ${f.functionName && f.functionName !== '' ? f.functionName : '<anonymous>'} (${f.url ?? '?'}:${f.lineNumber ?? 0}:${f.columnNumber ?? 0})`)
    .join('\n');
}

/**
 * 把 `Runtime.exceptionThrown` 的 details 格式化成**有信息量**的多行文本。
 *
 * ⚠️ 这里踩过一个坑（主策划实测抓到）：第一版只输出 `d.exception?.description ?? d?.text`，
 * 于是页面上真实的未捕获异常只打出了 **`Uncaught` 两个字** ——
 * 排查 `pnpm dev` 白屏时被彻底挡住。
 * **一个"报错了但不告诉你错什么"的工具等于没有工具。**
 * 现在固定输出：className + message/description + 位置 + 栈（截断保留），
 * 并且在**任何字段都拿不到**时把原始 details 的 JSON 打出来（宁可难看，不可无用）。
 */
function formatException(d: CdpExceptionDetails | undefined): string {
  if (!d) return '[exceptionThrown] 无 details（CDP 未提供）';
  const ex = d.exception;
  const name = ex?.className ?? '';
  const desc = typeof ex?.description === 'string' ? ex.description : '';
  const value = ex?.value !== undefined ? String(ex.value) : '';
  const head = `${d.text ?? 'Uncaught'}${name ? ` [${name}]` : ''}`;
  const where = d.url ? `${d.url}:${d.lineNumber ?? 0}:${d.columnNumber ?? 0}` : '(无位置)';
  const body = desc || value || safeJson(d.exception);
  const stack = formatStackTrace(d.stackTrace);
  const lines = [`[exception] ${head}`, `    message: ${body.slice(0, 800) || '(空)'}`, `    at: ${where}`];
  if (stack) lines.push(stack);
  // 兜底：字段全空时把原始 details 打出来（截断）
  if ((!body || body === '(空)') && !stack) lines.push(`    raw: ${safeJson(d)}`);
  return lines.join('\n');
}

/** 极简 CDP 客户端。 */
class Cdp {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly consoleLines: string[] = [];
  /** 未捕获异常 / 浏览器日志里的 error|warning（**必须单独收集**，见下方注释） */
  readonly exceptionLines: string[] = [];
  onConsole: ((text: string) => void) | null = null;

  async connect(wsUrl: string): Promise<void> {
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP WebSocket 连接失败: ' + String((e as ErrorEvent).message ?? e))));
    });
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id) as { resolve: (v: unknown) => void; reject: (e: Error) => void };
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const params = msg.params as {
          type: string;
          args: { value?: unknown; description?: string; type?: string; preview?: unknown }[];
          stackTrace?: CdpStackTrace;
        };
        const text = params.args
          .map((a) => {
            if (a.value !== undefined) return String(a.value);
            // 对象参数要看 description（带类名/message），必要时附上 preview
            const desc = a.description ?? '';
            const preview = a.preview !== undefined ? ' ' + safeJson(a.preview) : '';
            return desc + preview;
          })
          .join(' ');
        this.consoleLines.push(text);
        if (params.type === 'error') {
          this.exceptionLines.push(`[console.error] ${text.slice(0, 500)}`);
          const st = formatStackTrace(params.stackTrace);
          if (st) this.exceptionLines.push(st);
        }
        this.onConsole?.(text);
      }
      // ★ 未捕获异常**不走** consoleAPICalled —— 只监听 console 会漏掉
      //   "模块求值阶段就抛了"这类最致命的错误（页面白屏但 console 干净）。
      if (msg.method === 'Runtime.exceptionThrown') {
        const params = msg.params as { exceptionDetails?: CdpExceptionDetails };
        this.exceptionLines.push(formatException(params.exceptionDetails));
      }
      if (msg.method === 'Log.entryAdded') {
        const params = msg.params as {
          entry?: { level?: string; text?: string; url?: string; lineNumber?: number; source?: string; stackTrace?: CdpStackTrace };
        };
        const e = params.entry;
        if (e && (e.level === 'error' || e.level === 'warning')) {
          const where = e.url ? ` @ ${e.url}:${e.lineNumber ?? 0}` : '';
          this.exceptionLines.push(`[log:${e.level}:${e.source ?? '?'}] ${String(e.text ?? '')}${where}`.slice(0, 600));
        }
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} 超时`));
        }
      }, 60_000);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function connectToPage(port: number, match: (url: string) => boolean): Promise<Cdp | null> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await res.json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[];
      const page = targets.find((t) => t.type === 'page' && match(t.url)) ?? targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        const cdp = new Cdp();
        await cdp.connect(page.webSocketDebuggerUrl);
        return cdp;
      }
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(300);
  }
  return null;
}

/** 等待 console 里出现以 `prefix` 开头的行（并返回其 JSON 负载）。 */
async function waitForConsole(cdp: Cdp, prefix: string, timeoutMs: number): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const line = cdp.consoleLines.find((l) => l.startsWith(prefix));
    if (line) {
      const json = line.slice(prefix.length).trim();
      try {
        return JSON.parse(json);
      } catch {
        return { raw: json };
      }
    }
    await sleep(200);
  }
  return null;
}

/**
 * 真实页面冒烟：起 vite → headless 浏览器打开 `path` → 收集 console/异常 →
 * 用 `Runtime.evaluate` 问页面几个客观事实 → 截图落盘。
 *
 * 「能打开」这件事必须被**测量**，而不是靠人肉点开看 —— 否则就复现了
 * "编译通过 = 能用"的经典误判（本项目的铁律 8）。
 */
export interface PageSmokeResult {
  ok: boolean;
  reason?: string;
  url?: string;
  consoleLines: string[];
  exceptions: string[];
  probes: Record<string, unknown>;
  screenshotPath?: string;
  /** `play: true` 时的交互结果（建了几座塔、偷到多少、到第几波） */
  playReport?: Record<string, unknown> | null;
  /** 卡位反馈对照：每个数字键下的红色像素数 */
  feedbackProbe?: { key: string; label: string; blockRedPixels: number; goldWorldPixels: number }[];
}

export async function smokePage(opts: {
  nodeExe: string;
  viteEntry: string;
  repoRoot: string;
  /** 页面路径，例如 `/index.html?difficulty=N1` */
  path: string;
  outDir: string;
  port?: number;
  debugPort?: number;
  /** 等多少毫秒后取快照 */
  settleMs?: number;
  verbose?: boolean;
  /**
   * 交互冒烟：在页面上**真的点几下**（建塔）并按 F 加速，
   * 再报告「是否真的产生了窃金事件」。验证的是 input → Command → sim → 反馈 这条链。
   */
  play?: boolean;
  /** 交互后再等多少毫秒收集结果 */
  playMs?: number;
  /**
   * 自检：在页面里**故意 throw** 一个已知错误，用来证明本工具的异常通道
   * 真的能打出 message 与栈（否则它自己就是一条空门禁）。
   */
  injectError?: boolean;
  /**
   * 卡位反馈验证：依次按这些数字键（选塔系）并各测一次像素，
   * 返回每个键位下的 `blockRedPixels`。
   * **同一页面、同一区域、只切换选择** ⇒ 这是标准的作用域隔离对照：
   * 选神偷（无阻挡）应为 0，选军训系应为 > 0。
   */
  feedbackKeys?: string[];
  /**
   * 已有服务器时直接用它（不再自己起 vite）。
   * `pnpm build` 的产物用静态服务器托管最稳 —— 避免 dev server 的
   * 依赖预构建/文件监听在长连接下重启（实测会把音频请求打成 ERR_CONNECTION_REFUSED）。
   */
  baseUrl?: string;
}): Promise<PageSmokeResult> {
  const port = opts.port ?? 5211;
  const debugPort = opts.debugPort ?? 9345;
  const browser = findBrowser();
  if (!browser) return { ok: false, reason: '未找到 Edge/Chrome', consoleLines: [], exceptions: [], probes: {} };

  mkdirSync(opts.outDir, { recursive: true });
  const children: ChildProcess[] = [];
  try {
    let origin = opts.baseUrl ?? '';
    if (!opts.baseUrl) {
      const vite = spawn(
        opts.nodeExe,
        [opts.viteEntry, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
        { cwd: opts.repoRoot, stdio: opts.verbose ? 'inherit' : 'ignore' },
      );
      children.push(vite);
      origin = `http://127.0.0.1:${port}`;
    }
    const url = `${origin}${opts.path}`;
    if (!(await waitForHttp(url, 60_000))) {
      return { ok: false, reason: `服务器未能在 60s 内起来（${url}）`, consoleLines: [], exceptions: [], probes: {} };
    }

    const proc = spawn(
      browser,
      [
        '--headless=new',
        `--remote-debugging-port=${debugPort}`,
        // ★ 浏览器 profile **绝不能放进仓库目录**：
        //   Chrome 会往里写几百个文件，而 vite 的 watcher 监听整个项目根 →
        //   触发 HMR/full reload，把正在加载的资源打成 ERR_CONNECTION_REFUSED，
        //   页面还可能整屏空白（会伪装成"dev server 坏了"）。
        //   这是本项目第 N 次"工具自己污染了被测环境"，故写死到系统临时目录。
        `--user-data-dir=${join(tmpdir(), `dsh-smoke-profile-${process.pid}`)}`,
        '--window-size=1280,720',
        '--no-first-run',
        '--no-default-browser-check',
        '--enable-unsafe-swiftshader',
        '--autoplay-policy=no-user-gesture-required',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: opts.verbose ? 'inherit' : 'ignore' },
    );
    children.push(proc);

    const cdp = await connectToPage(debugPort, (u) => u.includes('127.0.0.1'));
    if (!cdp) return { ok: false, reason: 'CDP 未连上', consoleLines: [], exceptions: [], probes: {} };

    const exceptions: string[] = [];
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable').catch(() => undefined);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url });
    await sleep(opts.settleMs ?? 9000);

    // ── 自检：故意抛一个已知错误（异步抛，走 Runtime.exceptionThrown 通道）──
    if (opts.injectError) {
      await cdp.send('Runtime.evaluate', {
        expression: `setTimeout(() => { throw new Error('SMOKE_SELF_TEST_BOOM at ' + location.pathname); }, 0)`,
        returnByValue: true,
      });
      await sleep(900);
    }

    // ── 交互冒烟：真的用鼠标点几下建塔，再按 F 加速看是否真的偷到钱 ──
    let playReport: Record<string, unknown> | null = null;
    if (opts.play) {
      // ① 让页面算出"可建造格 → 屏幕坐标"（相机 zoom/scroll 都在页面里）
      const pickScript = `(() => {
        const g = window.__DSH_GAME__; const s = g && g.scene ? g.scene.getScene('Game') : null;
        if (!s || !s.driver) return JSON.stringify({ error: 'no scene' });
        const world = s.driver.world; const cam = s.cameras.main;
        const width = world.grid.width;
        const halt = world.paths[0].waypoints[world.paths[0].haltIndex];
        const hx = Math.floor(halt.x / 1000), hy = Math.floor(halt.y / 1000);
        const cands = [];
        for (const key of world.buildableCells) {
          const x = key % width, y = Math.trunc((key - x) / width);
          const d = Math.abs(x - hx) + Math.abs(y - hy);
          if (d <= 2) cands.push({ x, y, d });
        }
        cands.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
        const picked = cands.slice(0, 6).map(c => {
          const wx = c.x * 16 + 8, wy = c.y * 16 + 8;
          return { wx, wy, sx: (wx - cam.worldView.x) * cam.zoom, sy: (wy - cam.worldView.y) * cam.zoom, cell: c.x + ',' + c.y };
        });
        // 前 4 座用神偷（窃金），后 2 座用军训（阻挡）
        return JSON.stringify({ picked, unitIds: ['pickpocket','pickpocket','pickpocket','pickpocket','drill_instructor','drill_instructor'] });
      })()`;
      let picked: { sx: number; sy: number; cell: string }[] = [];
      let unitIds: string[] = [];
      try {
        const res = (await cdp.send('Runtime.evaluate', { expression: pickScript, returnByValue: true })) as {
          result?: { value?: string };
        };
        const parsed = JSON.parse(res.result?.value ?? '{}') as {
          picked?: { sx: number; sy: number; cell: string }[];
          unitIds?: string[];
        };
        picked = parsed.picked ?? [];
        unitIds = parsed.unitIds ?? [];
      } catch {
        picked = [];
      }

      // ② 依次选中建造项（数字键）并把塔点到格子上
      for (let i = 0; i < picked.length; i++) {
        const spot = picked[i] as { sx: number; sy: number; cell: string };
        // 数字键选中该系（1-6 对应面板顺序；这里用前两个键位简化：1=神偷, 4=军训）
        const digit = i < 4 ? 1 : 4;
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: String(digit), code: `Digit${digit}`, windowsVirtualKeyCode: 48 + digit });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: String(digit), code: `Digit${digit}`, windowsVirtualKeyCode: 48 + digit });
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp.send('Input.dispatchMouseEvent', {
            type,
            x: Math.round(spot.sx),
            y: Math.round(spot.sy),
            button: 'left',
            clickCount: 1,
          });
        }
        await sleep(120);
      }
      // ③ 按 F 加速到 4x，让试玩窗口内真的打到几波
      for (let i = 0; i < 2; i++) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 });
        await sleep(150);
      }
      await sleep(opts.playMs ?? 30_000);

      const afterScript = `(() => {
        const g = window.__DSH_GAME__; const s = g && g.scene ? g.scene.getScene('Game') : null;
        if (!s) return JSON.stringify({ error: 'no scene' });
        const world = s.driver.world;
        return JSON.stringify({
          towers: world.towers.length,
          towerIds: world.towers.map(t => t.unitId),
          wave: world.wave,
          gold: world.gold,
          stolenTotal: world.stolenTotal,
          killed: world.killed,
          leaked: world.leaked,
          status: world.status,
          debug: s.debugState,
        });
      })()`;
      try {
        const res = (await cdp.send('Runtime.evaluate', { expression: afterScript, returnByValue: true })) as {
          result?: { value?: string };
        };
        playReport = JSON.parse(res.result?.value ?? '{}') as Record<string, unknown>;
      } catch {
        playReport = { error: 'evaluate 失败' };
      }
    }

    // 客观事实：页面里到底有没有画布、有没有在推进、音频/图集有没有真的就位
    const probeScript = `(() => {
      const g = window.__DSH_GAME__ || null;
      const canvas = document.querySelector('#game canvas');
      const scenes = g && g.scene ? g.scene.scenes.map(s => ({ key: s.scene.key, active: s.scene.isActive() })) : null;
      const gameScene = g && g.scene ? g.scene.getScene('Game') : null;
      let audioKeys = null, soundLocked = null, bgmPlaying = null;
      try { audioKeys = g && g.cache && g.cache.audio ? g.cache.audio.getKeys() : null; } catch (e) { audioKeys = 'err'; }
      try { soundLocked = g && g.sound ? g.sound.locked : null; } catch (e) { soundLocked = 'err'; }
      try { bgmPlaying = g && g.sound ? g.sound.getAll('bgm_wave').some(s => s.isPlaying) : null; } catch (e) { bgmPlaying = 'err'; }
      return JSON.stringify({
        hasCanvas: !!canvas,
        canvasW: canvas ? canvas.width : 0,
        canvasH: canvas ? canvas.height : 0,
        hasGame: !!g,
        artOk: g && g.registry ? g.registry.get('artOk') : null,
        atlasKey: g && g.registry ? g.registry.get('atlasKey') : null,
        artFrames: g && g.registry ? g.registry.get('artFrames') : null,
        audioKeyCount: audioKeys ? audioKeys.length : 0,
        audioKeys: audioKeys,
        soundLocked: soundLocked,
        bgmPlaying: bgmPlaying,
        scenes,
        debug: gameScene && gameScene.debugState ? gameScene.debugState : null,
        bodyText: (document.body.innerText || '').slice(0, 200)
      });
    })()`;
    let probes: Record<string, unknown> = {};
    try {
      const res = (await cdp.send('Runtime.evaluate', { expression: probeScript, returnByValue: true })) as {
        result?: { value?: string };
        exceptionDetails?: { text?: string };
      };
      if (res.exceptionDetails) exceptions.push(res.exceptionDetails.text ?? 'evaluate 异常');
      else if (res.result?.value) probes = JSON.parse(res.result.value) as Record<string, unknown>;
    } catch (err) {
      exceptions.push(`evaluate 失败：${(err as Error).message}`);
    }

    // ── 像素审计：把"画面对不对"变成可测量的数字（而不是"看起来没问题"）──
    // 我（engine-dev）的模型**不能看图**，所以视觉验收必须由人来做；
    // 但"钱包条/HUD 到底有没有画在屏幕上"是可以量的：数金色像素。
    const pixelScript = `(async () => {
      const g = window.__DSH_GAME__;
      if (!g || !g.renderer || !g.renderer.snapshot) return JSON.stringify({ error: 'no renderer snapshot' });
      return await new Promise((resolve) => {
        try {
          g.renderer.snapshot((img) => {
            try {
              const c = document.createElement('canvas');
              c.width = img.width; c.height = img.height;
              const ctx = c.getContext('2d', { willReadFrequently: true });
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(img, 0, 0);
              const d = ctx.getImageData(0, 0, c.width, c.height).data;
              const seen = new Set(); let goldHud = 0; let goldWorld = 0; let nonBg = 0; let bright = 0; let blockRed = 0;
              const bg = [16, 18, 25];
              for (let y = 0; y < c.height; y++) {
                for (let x = 0; x < c.width; x++) {
                  const i = (y * c.width + x) * 4;
                  const r = d[i], gg = d[i+1], b = d[i+2];
                  seen.add((r >> 3) + ',' + (gg >> 3) + ',' + (b >> 3));
                  const isGold = r > 225 && gg > 165 && gg < 235 && b < 100;
                  if (isGold) {
                    // HUD 带：顶部 70px / 底部 60px / 右侧详情面板 200px
                    const inHud = y < 70 || y > c.height - 60 || x > c.width - 200;
                    if (inHud) goldHud++;
                    else goldWorld++;
                  }
                  // 卡位反馈色 BLOCK_RED = #E04438 → 数它就能验证"红色虚线/锁图标真的画了"
                  if (Math.abs(r - 224) <= 6 && Math.abs(gg - 68) <= 6 && Math.abs(b - 56) <= 6) blockRed++;
                  if (Math.abs(r-bg[0]) + Math.abs(gg-bg[1]) + Math.abs(b-bg[2]) > 24) nonBg++;
                  if (r > 180 && gg > 180 && b > 180) bright++;
                }
              }
              resolve(JSON.stringify({
                w: c.width, h: c.height,
                distinctColorBuckets: seen.size,
                // ★ 区域隔离：世界区里的金色 = 钱包条 + ★停顿点高亮（后者是固定底噪）
                goldWorldPixels: goldWorld,
                goldHudPixels: goldHud,
                // 卡位反馈（红色虚线 / 锁图标）的像素数
                blockRedPixels: blockRed,
                nonBackgroundPixels: nonBg,
                brightPixels: bright,
              }));
            } catch (e) { resolve(JSON.stringify({ error: String(e) })); }
          });
        } catch (e) { resolve(JSON.stringify({ error: String(e) })); }
      });
    })()`;
    try {
      const res = (await cdp.send('Runtime.evaluate', {
        expression: pixelScript,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: string } };
      const parsed = JSON.parse(res.result?.value ?? '{}') as Record<string, unknown>;
      probes.pixelAudit = parsed;
    } catch (err) {
      probes.pixelAudit = { error: (err as Error).message };
    }

    // ── 卡位反馈验证：同一页面、同一区域，只切换"选中哪个塔系" ──
    //    这是作用域隔离对照：无阻挡的塔系应为 0 个红像素，军训系应显著 > 0。
    let feedbackProbe: { key: string; label: string; blockRedPixels: number; goldWorldPixels: number }[] = [];
    if (opts.feedbackKeys && opts.feedbackKeys.length > 0) {
      const digitCode = (d: string): number => 48 + Number(d);
      // ★ 先把虚拟鼠标移到地图中央：阻挡范围虚线是**放置预览**的一部分
      //   （策划案 §6.2「放置军训教官 → 显示阻挡范围」），没有 hover 就没有预览。
      //   同一位置只切换"选中哪个塔系" ⇒ 这才是干净的作用域隔离对照。
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 420, button: 'none' });
      await sleep(300);
      for (const key of opts.feedbackKeys) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key,
          code: `Digit${key}`,
          windowsVirtualKeyCode: digitCode(key),
        });
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code: `Digit${key}`,
          windowsVirtualKeyCode: digitCode(key),
        });
        await sleep(600);
        try {
          const res = (await cdp.send('Runtime.evaluate', {
            expression: pixelScript,
            returnByValue: true,
            awaitPromise: true,
          })) as { result?: { value?: string } };
          const parsed = JSON.parse(res.result?.value ?? '{}') as {
            blockRedPixels?: number;
            goldWorldPixels?: number;
          };
          const label = (await cdp.send('Runtime.evaluate', {
            expression: `(() => { const s = window.__DSH_GAME__.scene.getScene('Game'); return s.debugState.selectedUnitId + '|blockRanges=' + s.debugState.blockRangesShown; })()`,
            returnByValue: true,
          })) as { result?: { value?: string } };
          feedbackProbe.push({
            key,
            label: label.result?.value ?? '',
            blockRedPixels: parsed.blockRedPixels ?? -1,
            goldWorldPixels: parsed.goldWorldPixels ?? -1,
          });
        } catch {
          feedbackProbe.push({ key, label: '', blockRedPixels: -1, goldWorldPixels: -1 });
        }
      }
    }

    let screenshotPath: string | undefined;
    try {
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
      screenshotPath = join(opts.outDir, 'playable-screenshot.png');
      writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
    } catch {
      screenshotPath = undefined;
    }

    // 从 console 里挑出错误行（未捕获异常已由 Cdp.exceptionLines 单独收集）
    const consoleLines = cdp.consoleLines.slice(-60);
    for (const l of cdp.exceptionLines) exceptions.push(l);
    for (const l of consoleLines) {
      if (/error|Error|Failed|Uncaught/.test(l)) exceptions.push(l.slice(0, 300));
    }

    cdp.close();
    return {
      ok: Boolean(probes.hasCanvas),
      url,
      consoleLines,
      exceptions,
      probes,
      screenshotPath,
      playReport,
      feedbackProbe,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `冒烟异常：${(err as Error).message}`,
      consoleLines: [],
      exceptions: [],
      probes: {},
    };
  } finally {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function runBrowserBench(opts: {
  nodeExe: string;
  viteEntry: string;
  repoRoot: string;
  port?: number;
  debugPort?: number;
  outDir: string;
  verbose: boolean;
}): Promise<BrowserBenchResult> {
  const port = opts.port ?? 5199;
  const debugPort = opts.debugPort ?? 9333;
  const browser = findBrowser();
  if (!browser) {
    return { ok: false, reason: '未在常见路径找到 Edge / Chrome，无法做浏览器渲染基准' };
  }

  mkdirSync(opts.outDir, { recursive: true });
  const children: ChildProcess[] = [];
  const cleanup = (): void => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        /* ignore */
      }
    }
  };

  try {
    // 1) vite dev server（只服务本仓库 root）
    const vite = spawn(
      opts.nodeExe,
      [opts.viteEntry, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
      { cwd: opts.repoRoot, stdio: opts.verbose ? 'inherit' : 'ignore' },
    );
    children.push(vite);

    const benchUrl = `http://127.0.0.1:${port}/tools/bench/render-bench.html`;
    if (!(await waitForHttp(benchUrl, 60_000))) {
      return { ok: false, reason: `vite dev server 未能在 60s 内起来（${benchUrl}）`, browserPath: browser };
    }

    // 2) 浏览器
    // ★ 同样**不能**把 profile 放进仓库（会触发 vite watcher → full reload → 基准超时）
    const userDataDir = join(tmpdir(), `dsh-bench-profile-${process.pid}`);
    const args = [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,720',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // 不锁 60fps，才能看出还剩多少余量
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
      // headless 下没有真实 GPU 时退回软件光栅（并允许 WebGL）
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      'about:blank',
    ];
    const proc = spawn(browser, args, { stdio: opts.verbose ? 'inherit' : 'ignore' });
    children.push(proc);

    const cdp = await connectToPage(debugPort, (u) => u.includes('127.0.0.1'));
    if (!cdp) {
      return { ok: false, reason: `CDP 未能连上浏览器（debug port ${debugPort}）`, browserPath: browser };
    }
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 3) 渲染基准页
    await cdp.send('Page.navigate', { url: benchUrl });
    const benchJson = await waitForConsole(cdp, 'BENCH_RESULT', 90_000);

    // 4) 像素无糊边校验页
    const probeUrl = `http://127.0.0.1:${port}/index.html?scene=probe`;
    await cdp.send('Page.navigate', { url: probeUrl });
    const probeJson = await waitForConsole(cdp, 'PIXEL_PROBE_RESULT', 60_000);

    // 5) 截图（人眼可核对的证据）
    let screenshotPath: string | undefined;
    try {
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
      screenshotPath = join(opts.outDir, 'pixel-probe-screenshot.png');
      writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
    } catch {
      screenshotPath = undefined;
    }

    // 6) 浏览器 JS 堆（渲染侧内存）
    let jsHeapUsedBytes: number | undefined;
    try {
      const metrics = (await cdp.send('Performance.getMetrics')) as {
        metrics: { name: string; value: number }[];
      };
      jsHeapUsedBytes = metrics.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value;
    } catch {
      jsHeapUsedBytes = undefined;
    }

    cdp.close();
    return {
      ok: benchJson !== null,
      reason: benchJson === null ? '浏览器基准页未在 90s 内输出 BENCH_RESULT' : undefined,
      browserPath: browser,
      benchJson,
      probeJson,
      screenshotPath,
      jsHeapUsedBytes,
      consoleLines: cdp.consoleLines.slice(-40),
    };
  } catch (err) {
    return { ok: false, reason: `浏览器基准异常：${(err as Error).message}`, browserPath: browser };
  } finally {
    cleanup();
  }
}
