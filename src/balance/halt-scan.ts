/**
 * ★★ **★停顿点停留时长 扫描**（契约 §16 派下的任务，主策划裁决）
 *
 * ## 要回答的问题
 *
 * 策划案 §4.6 把 ★停顿点 写成「**本项目对原作最重要的致敬**」—— 原作高手攻略的原话是
 * 「怪来的时候会在一个地方稍微有一下停顿，而这个位置恰好可以打到那里」，
 * 即**把窃金塔集中堆在停顿点上**。但 `haltPointStopDuration = 600`（0.6s）让这个机制
 * 形同不存在：`0.6s × 1.5 次/秒` **连一次额外命中都换不来**。
 *
 * 实测窃金覆盖率只有 **16%**，而 §5.2/§5.5 的整个经济校准建立在 **65–80%** 上
 * —— 收入差 4–5 倍。这个脚本就是在内存里扫停顿时长 × 两种摆位，看机制能否被激活。
 *
 * ## 三件测量（每个格子）
 *
 * | 指标 | 载体 | 为什么 |
 * |---|---|---|
 * | 窃金覆盖率 | `balanced` AI（N2/N3） | 主目标（§5.4 要 65–80%） |
 * | 单波时长（第 25–30 波） | **资源上界阵容**（无限钱、满科技、能活到 30 波） | 停顿变长的代价（2.5s × 30 只 = +75s/波） |
 * | 通关率 / 均到波 | `balanced` AI | 最终判据 |
 *
 * ⚠️ **不改任何 `src/data/**` 文件**：停顿时长用**内存克隆**注入。
 *
 * 用法：`pnpm exec tsx src/balance/halt-scan.ts [--runs N] [--difficulty N2,N3]`
 */
import { loadRealContent } from './data-adapter';
import { runOne, type RunResult } from './run';
import type { DifficultyId, SimContent } from '../sim/content';
import { createWorldWithContent, snapshot } from '../sim/world';
import { drainEvents, step } from '../sim/tick';
import { buildPlacement } from './strategies/placement';
import type { Command } from '../sim/commands';
import { truncDiv } from '../sim/fixed';

const HALT_VALUES = [600, 1000, 1500, 2000, 2500, 3000] as const;
const PLACEMENTS = ['uniform', 'clustered'] as const;
type Placement = (typeof PLACEMENTS)[number];

/** 内存注入停顿时长（不落盘、不改 `src/data`）。 */
function withHalt(base: SimContent, halt: number): SimContent {
  return { ...base, constants: { ...base.constants, haltPointStopDuration: halt } };
}

interface ScanCell {
  halt: number;
  placement: Placement;
  difficulty: DifficultyId;
  coverage: number;
  winRate: number;
  avgWave: number;
  wavesReached: number[];
  /** 第 25–30 波的平均单波时长（秒）；AI 活不到就没有 */
  lateWaveSeconds: number | null;
}

function scan(
  content: SimContent,
  difficulty: DifficultyId,
  placement: Placement,
  runs: number,
  seeds: readonly number[],
): ScanCell {
  const results: RunResult[] = [];
  for (let i = 0; i < runs; i++) {
    results.push(
      runOne({
        content,
        difficultyId: difficulty,
        strategyId: 'balanced',
        seed: seeds[i % seeds.length] as number,
        maxTicks: 240_000,
        placement,
      }),
    );
  }
  const n = results.length;
  const stolen = results.reduce((a, r) => a + r.stolenTotal, 0);
  const wallet = results.reduce((a, r) => a + r.walletTotal, 0);
  const wins = results.filter((r) => r.win).length;
  const avgWave = Math.round(results.reduce((a, r) => a + r.waveReached, 0) / n);
  return {
    halt: 0,
    placement,
    difficulty,
    coverage: wallet > 0 ? Math.trunc((stolen * 1000) / wallet) : 0,
    winRate: Math.trunc((wins * 1000) / n),
    avgWave,
    wavesReached: results.map((r) => r.waveReached),
    lateWaveSeconds: null,
  };
}

/**
 * 资源上界阵容（无限钱木 + 满科技 + 满塔位 T5 飞贼）——**它才活得到第 30 波**，
 * 所以「单波时长」只能用它测。
 */
function lateWaveDurations(content: SimContent, placement: Placement): { avg: number; per: number[] } | null {
  const rich: SimContent = { ...content, constants: { ...content.constants, difficulty: { ...content.constants.difficulty } } };
  for (const id of ['N1', 'N2', 'N3', 'N4', 'N5'] as DifficultyId[]) {
    const row = rich.constants.difficulty[id];
    rich.constants.difficulty[id] = { ...row, startGold: 400_000_000_000, startWood: 400_000_000_000 };
  }
  const w = createWorldWithContent({ seed: 20261013, difficultyId: 'N2', relics: {}, techArchive: {} }, rich);
  const lanes = rich.constants.difficulty['N2'].paths;
  const model = buildPlacement(rich, lanes, placement);
  const techIds = Object.keys(rich.tech ?? {}).sort();
  const marks: { wave: number; tick: number }[] = [];

  for (let tick = 0; tick < 240_000 && w.status === 'running'; tick++) {
    const cmds: Command[] = [];
    const snap = snapshot(w);
    for (const id of techIds) {
      const tv = snap.techs.find((x) => x.id === id);
      if (tv && tv.level < tv.maxLevel && tv.affordable) {
        cmds.push({ type: 'research', techId: id });
        break;
      }
    }
    if (cmds.length === 0 && snap.population < snap.populationCap) {
      const cells = snap.towers.map((t) => t.cell);
      const occupied = new Set(cells.map((c) => c.y * rich.grid.width + c.x));
      const counts = new Array<number>(lanes).fill(0);
      for (const c of cells) {
        const l = model.laneOf(c);
        if (l >= 0 && l < lanes) counts[l] = (counts[l] as number) + 1;
      }
      let lane = 0;
      for (let i = 1; i < counts.length; i++) if ((counts[i] as number) < (counts[lane] as number)) lane = i;
      const cell = model.pick(occupied, cells, lane);
      if (cell) cmds.push({ type: 'build', unitId: 'pickpocket', cell });
    }
    if (cmds.length === 0) {
      for (const t of snap.towers) {
        const def = rich.units[t.unitId];
        if (!def || !def.upgradeTo) continue;
        cmds.push({ type: 'upgrade', towerId: t.id });
        break;
      }
    }
    step(w, cmds);
    for (const ev of drainEvents(w)) {
      if (ev.type === 'waveEnd') marks.push({ wave: ev.stats.wave, tick: w.tick });
    }
  }
  const late: number[] = [];
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i] as { wave: number; tick: number };
    if (cur.wave < 25 || cur.wave > 30) continue;
    const prev = marks[i - 1];
    const dur = prev ? truncDiv((cur.tick - prev.tick) * 1000, 60) / 1000 : 0;
    late.push(Math.round(dur));
  }
  if (late.length === 0) return null;
  return { avg: Math.round(late.reduce((a, b) => a + b, 0) / late.length), per: late };
}

function main(): void {
  const argv = process.argv.slice(2);
  let runs = 2;
  let diffs: DifficultyId[] = ['N2', 'N3'];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') runs = Math.max(1, Number.parseInt(argv[i + 1] ?? '2', 10) || 2);
    if (argv[i] === '--difficulty') diffs = (argv[i + 1] ?? 'N2,N3').split(',').map((s) => s.trim() as DifficultyId);
  }
  const base = loadRealContent();
  const seeds = [20261013, 20268932, 20276851];
  console.log(`★停顿点停留时长扫描 ｜ 每格 ${runs} 局 ｜ 难度 ${diffs.join('/')} ｜ 摆位 uniform vs clustered`);
  console.log('（内存注入 haltPointStopDuration；不改 src/data）\n');

  const rows: string[] = [];
  rows.push(
    ['时长s', '摆位', '难度', '窃金覆盖', '通关率', '均到波', '逐局到波', '第25-30波均时长s'].map((h, i) => (i < 3 ? h.padEnd(10) : h.padStart(i === 3 ? 9 : 8))).join(' '),
  );
  const lateCache = new Map<string, number | null>();
  for (const halt of HALT_VALUES) {
    const content = withHalt(base, halt);
    for (const placement of PLACEMENTS) {
      const key = `${halt}|${placement}`;
      if (!lateCache.has(key)) {
        const late = lateWaveDurations(content, placement);
        lateCache.set(key, late ? late.avg : null);
        if (late) {
          console.log(`  [时长采样 ${(halt / 1000).toFixed(1)}s/${placement}] 第 25–30 波每波秒数 = ${late.per.join(', ')} → 均值 ${late.avg}s`);
        }
      }
      for (const d of diffs) {
        const cell = scan(content, d, placement, runs, seeds);
        rows.push(
          [
            (halt / 1000).toFixed(1).padEnd(10),
            placement.padEnd(10),
            d.padEnd(10),
            `${(cell.coverage / 10).toFixed(1)}%`.padStart(9),
            `${(cell.winRate / 10).toFixed(0)}%`.padStart(8),
            String(cell.avgWave).padStart(8),
            `[${cell.wavesReached.join(' ')}]`.padStart(8),
            (lateCache.get(key) === null ? '—' : String(lateCache.get(key))).padStart(8),
          ].join(' '),
        );
      }
    }
  }
  console.log('');
  console.log(rows.join('\n'));
  console.log('\n读法：覆盖率目标 65–80%（§5.4）；「集中堆」若显著优于「均匀铺」，说明★停顿点机制被激活。');
  console.log('注：第 25–30 波时长用资源上界阵容测（AI 活不到那里），它是停顿变长的**代价**指标。');
}

main();
