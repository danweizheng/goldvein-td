/**
 * ★★ **窃金覆盖率三乘区扫描**（主策划裁决 2）—— 找出真正的瓶颈
 *
 * ```
 * 覆盖率 = （射程内塔数） × （每塔命中次数） × （每次命中的窃金量）
 *            A·摆位/射程        B·停顿时长已关闭      C·★未曾测过
 * ```
 *
 * | 维度 | 取值 | 谁的问题 |
 * |---|---|---|
 * | **A 经济倾向** | `build-first`（现状，有钱就铺） / `upgrade-first`（先把手上的小偷升到 T3+） | **策略侧，不改数据** |
 * | **B 神偷射程**（内存注入） | 2000 / 2500 | 数据侧 |
 * | **C 摆位** | `uniform` / `clustered` | 策略侧 |
 *
 * **每一格都必须报「覆盖率 + 窃金塔数量 + 平均窃金塔等级」** ——
 * 主策划上一条误判的根源就是「假设了塔数与射程，没看实际值」，
 * 所以这张表必须能分辨是**塔多**还是**塔强**在起作用。
 *
 * `upgrade-first` 的动机：`stealAmountCore = StealBase × LevelMul × (1+0.02×attack)`
 * 在 T1→T3 之间就有 **10.6 倍**差距（4.64 → 49.0 金/次），
 * 远大于摆位的 +8~14pt 与停顿时长的 +5pt。
 *
 * 用法：`pnpm exec tsx src/balance/coverage-scan.ts [--runs N] [--difficulty N2] [--phase A|ABC]`
 */
import { loadRealContent } from './data-adapter';
import { runOne, type RunResult } from './run';
import type { DifficultyId, SimContent } from '../sim/content';

type Policy = 'build-first' | 'upgrade-first';
type Placement = 'uniform' | 'clustered';

/** 神偷系的全部单位 id（射程注入只改这些）。 */
const THIEF_IDS = ['pickpocket', 'cutpurse', 'master_thief', 'grandmaster', 'goldfinger'];

/** 内存注入神偷射程（不改 `src/data`）。 */
function withThiefRange(base: SimContent, range: number): SimContent {
  const units = { ...base.units };
  for (const id of THIEF_IDS) {
    const u = units[id];
    if (u) units[id] = { ...u, range };
  }
  return { ...base, units };
}

interface Cell {
  policy: Policy;
  range: number;
  placement: Placement;
  difficulty: DifficultyId;
  coverage: number;
  thiefCount: number;
  avgTierX100: number;
  maxTier: number;
  winRate: number;
  avgWave: number;
  goldPerThief: number;
}

function measure(
  content: SimContent,
  difficulty: DifficultyId,
  policy: Policy,
  range: number,
  placement: Placement,
  runs: number,
  seeds: readonly number[],
): Cell {
  const rs: RunResult[] = [];
  for (let i = 0; i < runs; i++) {
    rs.push(
      runOne({
        content,
        difficultyId: difficulty,
        strategyId: 'balanced',
        seed: seeds[i % seeds.length] as number,
        maxTicks: 240_000,
        placement,
        economyPolicy: policy,
      }),
    );
  }
  const n = rs.length;
  const stolen = rs.reduce((a, r) => a + r.stolenTotal, 0);
  const wallet = rs.reduce((a, r) => a + r.walletTotal, 0);
  const thiefStolen = rs.reduce((a, r) => a + r.thiefStolenTotal, 0);
  const thiefCountSum = rs.reduce((a, r) => a + r.thiefCount, 0);
  return {
    policy,
    range,
    placement,
    difficulty,
    coverage: wallet > 0 ? Math.trunc((stolen * 1000) / wallet) : 0,
    thiefCount: Math.round((thiefCountSum / n) * 10) / 10,
    avgTierX100: rs.reduce((a, r) => a + r.avgThiefTierX100, 0) / n,
    maxTier: Math.max(...rs.map((r) => r.maxThiefTier)),
    winRate: Math.trunc((rs.filter((r) => r.win).length * 1000) / n),
    avgWave: Math.round(rs.reduce((a, r) => a + r.waveReached, 0) / n),
    goldPerThief: thiefCountSum > 0 ? Math.round(thiefStolen / 1000 / thiefCountSum) : 0,
  };
}

function table(cells: readonly Cell[], title: string): void {
  console.log(`\n${title}`);
  console.log(
    ['经济倾向', '射程', '摆位', '难度', '窃金覆盖', '窃金塔数', '平均等级', '最高', '每塔窃金', '通关率', '均到波']
      .map((h, i) => (i < 4 ? h.padEnd(i === 0 ? 14 : 8) : h.padStart(9)))
      .join(' '),
  );
  for (const c of cells) {
    console.log(
      [
        c.policy.padEnd(14),
        (c.range / 1000).toFixed(1).padEnd(8),
        c.placement.padEnd(8),
        c.difficulty.padEnd(8),
        `${(c.coverage / 10).toFixed(1)}%`.padStart(9),
        String(c.thiefCount).padStart(9),
        `T${(c.avgTierX100 / 100).toFixed(2)}`.padStart(9),
        `T${c.maxTier}`.padStart(9),
        String(c.goldPerThief).padStart(9),
        `${(c.winRate / 10).toFixed(0)}%`.padStart(9),
        String(c.avgWave).padStart(9),
      ].join(' '),
    );
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  let runs = 2;
  let diff: DifficultyId = 'N2';
  let phase = 'A';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') runs = Math.max(1, Number.parseInt(argv[i + 1] ?? '2', 10) || 2);
    if (argv[i] === '--difficulty') diff = (argv[i + 1] ?? 'N2') as DifficultyId;
    if (argv[i] === '--phase') phase = (argv[i + 1] ?? 'A').toUpperCase();
  }
  const base = loadRealContent();
  const seeds = [20261013, 20268932, 20276851];
  console.log(`★窃金覆盖率扫描 ｜ 每格 ${runs} 局 ｜ 难度 ${diff} ｜ phase=${phase}`);
  console.log('（射程用内存注入；策略倾向与摆位走 RunOptions，不改 src/data）');

  // —— phase A：只测经济倾向（射程/摆位固定现状）——
  const aCells: Cell[] = [];
  for (const policy of ['build-first', 'upgrade-first'] as Policy[]) {
    aCells.push(measure(base, diff, policy, 2000, 'uniform', runs, seeds));
  }
  table(aCells, '【阶段 A】经济倾向 A1(建塔优先) vs A2(升级优先) —— 射程 2.0 / 均匀摆位');

  if (phase === 'A') return;

  // —— phase ABC：A2 × 射程 × 摆位 ——
  const abc: Cell[] = [];
  for (const range of [2000, 2500]) {
    const content = withThiefRange(base, range);
    for (const placement of ['uniform', 'clustered'] as Placement[]) {
      abc.push(measure(content, diff, 'upgrade-first', range, placement, runs, seeds));
    }
  }
  table(abc, '【阶段 ABC】A2(升级优先) × 射程 × 摆位');
}

main();
