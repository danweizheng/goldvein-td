/**
 * `pnpm bench` —— 性能基准入口（owner: engine-dev）
 *
 * 场景（策划案 §1.5 硬性指标）：**250 敌人 + 500 投射物同时活动**
 *
 * 输出三块：
 *   ① 渲染路径：平均 FPS / 最低 FPS（500ms 窗口）/ 帧时长分布 / 掉帧率
 *   ② 逻辑路径：单 tick 耗时（avg / p50 / p95 / p99 / max）+ 每秒 tick 数 + 帧预算占用
 *   ③ 内存峰值：Node 侧 heapUsed/RSS 峰值 + 浏览器侧 JSHeapUsedSize
 *
 * 用法：
 *   pnpm bench                  # 逻辑 + 浏览器（找不到浏览器则如实报告「无法验证」）
 *   pnpm bench -- --no-browser  # 只跑逻辑路径
 *   pnpm bench -- --ticks 36000 # 指定逻辑基准 tick 数
 *
 * 设计原则：**不缩水场景、不粉饰数字**。如果达不到 60fps，
 * 就打印真实数字并指出瓶颈所在。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorldWithContent } from '../../src/sim/world';
import { step } from '../../src/sim/tick';
import { drainEvents } from '../../src/sim/tick';
import { hashWorld } from '../../src/sim/world';
import {
  createDesignContent,
  createStressContent,
  stressPlan,
  towerPlan,
} from './fixture';
import { runBrowserBench } from './browser-bench';
import type { RunConfig, WorldState } from '../../src/sim/types';
import type { Command } from '../../src/sim/commands';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const OUT_DIR = join(HERE, 'out');

const FRAME_BUDGET_MS = 1000 / 60; // 16.67ms

interface LogicPhaseResult {
  label: string;
  ticks: number;
  seconds: number;
  totalMs: number;
  ticksPerSecond: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  budgetUsedPct: number;
  withinBudget: boolean;
  peakEnemies: number;
  peakProjectiles: number;
  finalEnemies: number;
  finalProjectiles: number;
  activeTexts: number;
  eventsPerTick: number;
  eventMix: Record<string, number>;
  peakHeapUsedMb: number;
  peakRssMb: number;
  peakExternalMb: number;
  finalHeapUsedMb: number;
  hash: string;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

interface LogicOptions {
  label: string;
  ticks: number;
  build: (w: WorldState) => Command[];
  content: ReturnType<typeof createDesignContent>;
  seed?: number;
  drainEachTick?: boolean;
  /** 测量前跳过的 tick 数（让压力场景的人流进入稳态） */
  skipTicks?: number;
}

function benchLogic(opts: LogicOptions): LogicPhaseResult {
  const cfg: RunConfig = { seed: opts.seed ?? 20260214, difficultyId: 'N2', relics: {}, techArchive: {} };
  const w = createWorldWithContent(cfg, opts.content);

  // 建塔（一次性，不计入测量）
  step(w, opts.build(w));

  // 预热（JIT / 内联缓存）+ 让压力场景的人流达到稳态
  const skip = opts.skipTicks ?? 900;
  for (let i = 0; i < skip; i++) {
    step(w, []);
    drainEvents(w);
  }

  const samples = new Float64Array(opts.ticks);
  let peakHeap = 0;
  let peakRss = 0;
  let peakExternal = 0;
  let events = 0;
  const eventMix: Record<string, number> = {};

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < opts.ticks; i++) {
    const a = process.hrtime.bigint();
    step(w, []);
    const b = process.hrtime.bigint();
    samples[i] = Number(b - a) / 1e6;
    if (opts.drainEachTick !== false) {
      const evs = drainEvents(w);
      events += evs.length;
      for (const ev of evs) eventMix[ev.type] = (eventMix[ev.type] ?? 0) + 1;
    }
    if (i % 120 === 0) {
      const m = process.memoryUsage();
      if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
      if (m.rss > peakRss) peakRss = m.rss;
      if (m.external > peakExternal) peakExternal = m.external;
    }
  }
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const finalMem = process.memoryUsage();

  const sorted = Array.from(samples).sort((x, y) => x - y);
  const mean = totalMs / opts.ticks;

  return {
    label: opts.label,
    ticks: opts.ticks,
    seconds: opts.ticks / 60,
    totalMs: Math.round(totalMs),
    ticksPerSecond: Math.round((opts.ticks / totalMs) * 1000),
    avgMs: round3(mean),
    p50Ms: round3(percentile(sorted, 0.5)),
    p95Ms: round3(percentile(sorted, 0.95)),
    p99Ms: round3(percentile(sorted, 0.99)),
    maxMs: round3(sorted[sorted.length - 1] ?? 0),
    budgetUsedPct: round3((mean / FRAME_BUDGET_MS) * 100),
    withinBudget: mean < FRAME_BUDGET_MS,
    peakEnemies: w.peakAliveEnemies,
    peakProjectiles: w.peakActiveProjectiles,
    finalEnemies: w.enemies.length,
    finalProjectiles: w.projectiles.filter((p) => p.active).length,
    activeTexts: 0,
    eventsPerTick: round3(events / opts.ticks),
    eventMix,
    peakHeapUsedMb: mb(peakHeap),
    peakRssMb: mb(peakRss),
    peakExternalMb: mb(peakExternal),
    finalHeapUsedMb: mb(finalMem.heapUsed),
    hash: hashWorld(w),
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** --browser-only 时占位，避免逻辑基准阻塞浏览器测量。 */
function emptyResult(label: string): LogicPhaseResult {
  return {
    label,
    ticks: 0,
    seconds: 0,
    totalMs: 0,
    ticksPerSecond: 0,
    avgMs: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    maxMs: 0,
    budgetUsedPct: 0,
    withinBudget: true,
    peakEnemies: 0,
    peakProjectiles: 0,
    finalEnemies: 0,
    finalProjectiles: 0,
    activeTexts: 0,
    eventsPerTick: 0,
    eventMix: {},
    peakHeapUsedMb: 0,
    peakRssMb: 0,
    peakExternalMb: 0,
    finalHeapUsedMb: 0,
    hash: '-',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

function printLogicResult(r: LogicPhaseResult): void {
  console.log('');
  console.log(`── 逻辑路径：${r.label}`);
  console.log(`   tick 数                 ${r.ticks}  (= ${r.seconds.toFixed(1)}s 游戏时间)`);
  console.log(`   总耗时                  ${r.totalMs} ms   (${r.ticksPerSecond} tick/s)`);
  console.log(
    `   单 tick 耗时            avg ${r.avgMs} ms | p50 ${r.p50Ms} | p95 ${r.p95Ms} | p99 ${r.p99Ms} | max ${r.maxMs}`,
  );
  console.log(
    `   帧预算占用              ${r.budgetUsedPct}% of 16.67ms   →  60Hz 逻辑${r.withinBudget ? '可达成' : '不达成'}`,
  );
  console.log(`   峰值同屏                ${r.peakEnemies} 敌人 | ${r.peakProjectiles} 投射物`);
  console.log(`   tick 末同屏             ${r.finalEnemies} 敌人 | ${r.finalProjectiles} 投射物`);
  console.log(`   事件密度                ${r.eventsPerTick} 条/tick  ${JSON.stringify(r.eventMix)}`);
  console.log(
    `   内存峰值                heapUsed ${r.peakHeapUsedMb} MB | RSS ${r.peakRssMb} MB | external ${r.peakExternalMb} MB（结束 ${r.finalHeapUsedMb} MB）`,
  );
  console.log(`   状态哈希                ${r.hash}`);
}

function printBrowserResult(r: Awaited<ReturnType<typeof runBrowserBench>>): void {
  console.log('');
  console.log('── 渲染路径（浏览器实测）');
  if (!r.ok) {
    console.log(`   ⚠️  无法验证：${r.reason ?? '未知原因'}`);
    if (r.browserPath) console.log(`   浏览器：${r.browserPath}`);
    if (r.consoleLines && r.consoleLines.length > 0) {
      console.log('   页面 console 末尾（用于定位页面内异常）：');
      for (const l of r.consoleLines.slice(-15)) console.log('     ' + l.slice(0, 300));
    }
    console.log('   手工验证方式：pnpm dev 后打开 http://127.0.0.1:5173/tools/bench/render-bench.html');
    console.log('                 控制台会打印 BENCH_RESULT {...}；?scene=probe 打印 PIXEL_PROBE_RESULT {...}');
    return;
  }
  const bench = r.benchJson as {
    renderer: string;
    pixelArt: boolean;
    antialias: boolean;
    roundPixels: boolean;
    viewport: { w: number; h: number };
    cameraZoom: number;
    glVendor: string | null;
    glRenderer: string | null;
    poolSizes: Record<string, number>;
    poolPeak: Record<string, number>;
    phases: {
      name: string;
      seconds: number;
      frames: number;
      avgFps: number;
      minWindowFps: number;
      p50FrameMs: number;
      p95FrameMs: number;
      p99FrameMs: number;
      maxFrameMs: number;
      jankRate: number;
      simAvgMs: number;
      simP95Ms: number;
      simMaxMs: number;
      peakEnemies: number;
      peakProjectiles: number;
      peakTexts: number;
      textsSpawned: number;
    }[];
  };
  console.log(`   渲染器                  ${bench.renderer}  (pixelArt=${bench.pixelArt} antialias=${bench.antialias} roundPixels=${bench.roundPixels})`);
  console.log(`   GL                      ${bench.glVendor ?? '?'} / ${bench.glRenderer ?? '?'}`);
  console.log(`   视口 / 相机缩放         ${bench.viewport.w}x${bench.viewport.h} @ ${bench.cameraZoom}x（整数倍）`);
  console.log(`   池容量                  ${JSON.stringify(bench.poolSizes)}`);
  console.log(`   池峰值使用              ${JSON.stringify(bench.poolPeak)}`);
  const diag = (bench as { diagnostics?: Record<string, number> }).diagnostics;
  if (diag) {
    console.log(`   诊断                    ${JSON.stringify(diag)}`);
  }
  for (const p of bench.phases) {
    console.log(`   ── 阶段 ${p.name}（${p.seconds.toFixed(2)}s / ${p.frames} 帧）`);
    console.log(`      平均 FPS            ${p.avgFps.toFixed(1)}`);
    console.log(`      最低 FPS(500ms)     ${p.minWindowFps.toFixed(1)}`);
    console.log(
      `      帧时长              p50 ${p.p50FrameMs.toFixed(2)} | p95 ${p.p95FrameMs.toFixed(2)} | p99 ${p.p99FrameMs.toFixed(2)} | max ${p.maxFrameMs.toFixed(2)} ms`,
    );
    console.log(`      掉帧率(>16.67ms)    ${(p.jankRate * 100).toFixed(2)}%`);
    console.log(`      模拟耗时/帧         avg ${p.simAvgMs.toFixed(2)} | p95 ${p.simP95Ms.toFixed(2)} | max ${p.simMaxMs.toFixed(2)} ms`);
    console.log(
      `      同屏峰值            ${p.peakEnemies} 敌人 | ${p.peakProjectiles} 投射物 | ${p.peakTexts} 飘字（累计生成 ${p.textsSpawned} 条飘字）`,
    );
  }
  if (r.jsHeapUsedBytes !== undefined) {
    console.log(`   浏览器 JS 堆            ${mb(r.jsHeapUsedBytes)} MB`);
  }
  if (r.consoleLines && bench.phases.length === 0) {
    console.log('   console 末尾：');
    for (const l of r.consoleLines.slice(-10)) console.log('     ' + l.slice(0, 200));
  }
}

function printProbeResult(probe: unknown): void {
  console.log('');
  console.log('── 像素无糊边校验（逐像素）');
  if (!probe) {
    console.log('   ⚠️  无法验证：像素校验页未返回 PIXEL_PROBE_RESULT');
    return;
  }
  const p = probe as {
    renderer?: string;
    results?: {
      label: string;
      zoom: number;
      integerZoom: boolean;
      filter: string;
      exactDistinctColors: string[];
      mixedPixels: number;
      spriteBBox: unknown;
      edgeRunLengths: number[];
      bodyRunLengths: number[];
      allRunsMatchZoom: boolean;
      verdict: string;
    }[];
  };
  if (!Array.isArray(p.results)) {
    // 解析失败或页面报错：把原始内容打出来，方便定位（不要静默吞掉）
    console.log('   ⚠️  返回值形状异常，原始内容：');
    console.log('   ' + JSON.stringify(probe).slice(0, 600));
    return;
  }
  for (const r of p.results) {
    console.log(
      `   ${r.label}: zoom=${r.zoom} filter=${r.filter} 精确颜色数=${r.exactDistinctColors.length} [${r.exactDistinctColors.join(' ')}] 混色像素=${r.mixedPixels} 描边段长=[${r.edgeRunLengths.join(',')}] 主体段长=[${r.bodyRunLengths.join(',')}] → ${r.verdict}`,
    );
  }
  const shipped = p.results.find((r) => r.integerZoom && r.filter === 'NEAREST');
  const linear = p.results.find((r) => r.filter === 'LINEAR');
  const frac = p.results.find((r) => !r.integerZoom);
  if (shipped) {
    console.log(
      `   出货配置判定：整数倍缩放+NEAREST → 混色像素=${shipped.mixedPixels}（要求 0）、描边段长=[${shipped.edgeRunLengths.join(',')}]（要求都等于 ${shipped.zoom}）`,
    );
  }
  if (linear) {
    console.log(
      `   对照组(LINEAR)：混色像素=${linear.mixedPixels}（>0 才说明"混色检测"有效，不是空测试）`,
    );
  }
  if (frac) {
    console.log(
      `   非整数缩放(NEAREST)：混色像素=${frac.mixedPixels}、描边段长=[${frac.edgeRunLengths.join(',')}] → 像素大小不均匀（shimmer），这是"必须整数倍缩放"的直接证据`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const noBrowser = argv.includes('--no-browser');
  const browserOnly = argv.includes('--browser-only');
  const ticksArg = argv.indexOf('--ticks');
  const ticks = ticksArg >= 0 ? Number(argv[ticksArg + 1] ?? 36000) : 36000;
  const jsonArg = argv.indexOf('--json');

  console.log('════════════════════════════════════════════════════════════════');
  console.log('《窃金者 TD》M0 性能基准   (pnpm bench)');
  console.log(`node ${process.version} / ${process.platform} ${process.arch}`);
  console.log(`场景目标：250 敌人 + 500 投射物同时活动（策划案 §1.5）`);
  console.log(`逻辑基准 tick 数：${ticks}（= ${(ticks / 60).toFixed(0)}s 游戏时间）`);
  console.log('════════════════════════════════════════════════════════════════');

  // ① 压力场景（250 敌人 + 500 投射物）
  const stressContent = createStressContent({ enemyTarget: 250, towers: 35, attackIntervalTicks: 3 });
  const stress = browserOnly
    ? emptyResult('压力场景（已跳过）')
    : benchLogic({
        label: '压力场景：250 敌人 + 500 投射物（35 压力塔，攻速/血量/生命为合成值）',
        ticks,
        content: stressContent,
        build: () => stressPlan(stressContent, 35),
        skipTicks: 1000, // 16.7s：人流进入稳态
      });
  printLogicResult(stress);

  // ② 忠于策划案数值的场景（对照）
  const designContent = createDesignContent({ prepSeconds: 4, startGold: 200_000_000 });
  const plan = towerPlan(designContent, 35, ['thief_t3', 'thief_t4', 'trainer_t1', 'thief_t2']);
  const design = browserOnly
    ? emptyResult('策划案数值场景（已跳过）')
    : benchLogic({
        label: '策划案数值场景：35 塔（神偷/军训系）、设计攻速、30 波',
        ticks,
        content: designContent,
        build: () => plan,
      });
  printLogicResult(design);

  // ③ 浏览器渲染路径
  let browser: Awaited<ReturnType<typeof runBrowserBench>> = {
    ok: false,
    reason: '未执行（--no-browser）',
  };
  if (!noBrowser) {
    const nodeExe = process.execPath;
    const viteEntry = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!existsSync(viteEntry)) {
      browser = { ok: false, reason: `找不到 ${viteEntry}` };
    } else {
      browser = await runBrowserBench({
        nodeExe,
        viteEntry,
        repoRoot: REPO_ROOT,
        outDir: OUT_DIR,
        verbose: argv.includes('--verbose'),
      });
    }
  }
  printBrowserResult(browser);
  printProbeResult(browser.probeJson);

  // ④ 结论速览
  console.log('');
  console.log('── 结论速览');
  console.log(
    `   逻辑：压力场景 avg ${stress.avgMs} ms/tick（预算 ${stress.budgetUsedPct}%）| 设计场景 avg ${design.avgMs} ms/tick（预算 ${design.budgetUsedPct}%）`,
  );
  const simPhase = (browser.benchJson as { phases?: { name: string; avgFps: number; minWindowFps: number }[] } | undefined)?.phases?.find((p) => p.name === 'sim+render');
  if (simPhase) {
    console.log(`   渲染：sim+render avg ${simPhase.avgFps.toFixed(1)} FPS | min(500ms) ${simPhase.minWindowFps.toFixed(1)} FPS`);
  } else {
    console.log(`   渲染：未取得浏览器实测数据`);
  }
  console.log(`   压力场景实测同屏峰值：${stress.peakEnemies} 敌人 / ${stress.peakProjectiles} 投射物`);

  // ⑤ 落盘
  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    ticks,
    logic: { stress, design },
    browser,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = jsonArg >= 0 && argv[jsonArg + 1] ? (argv[jsonArg + 1] as string) : join(OUT_DIR, `bench-${stamp}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log(`报告已写入：${outPath}`);
}

main().catch((err: unknown) => {
  console.error('bench 失败：', err);
  process.exitCode = 1;
});
