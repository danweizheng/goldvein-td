/**
 * ★★ **`DPS_GOLD_EQ` 扫描**（主策划裁决 2 —— 本轮主线）
 *
 * ## 要回答的那一个问题
 *
 * > **这整条曲线是跷跷板，还是存在一个双达标点？**
 *
 * - **存在双达标点** ⇒ 继续调 AI
 * - **整条都是跷跷板** ⇒ **在当前的投入产出比下，经济与存活不可兼得** ——
 *   那才轮到动数据（第 3 级 / 塔的性价比曲线），而不是继续调 AI
 *
 * ## 为什么扫它
 *
 * `DPS_GOLD_EQ`（默认 400）决定"1 点 DPS 值多少金币"，也就决定 AI 在
 * 「买输出塔」与「买窃金塔」之间怎么选 —— **整个经济/存活分配都挂在它身上**，
 * 而它**从未被标定过**（是 `value.ts` 里一个手写的启发式值）。
 *
 * 佐证它可能是主因：限制输出类型后窃金塔从 **8 座 → 21.7 座**（覆盖 28.2% → 59.6%）。
 * 也就是说**便宜的弓箭手是一个"买得起但回不了本"的金币陷阱**，把本该变成窃金塔的钱吃掉了。
 *
 * ## 额外必报项
 *
 * **每一格的弓箭手数量**（`attackTypeCounts.pierce`）—— 若"弓箭手多"与"覆盖率低"强相关，
 * 就直接印证了"金币陷阱"这个机制。
 *
 * 用法：`pnpm exec tsx src/balance/dps-eq-scan.ts [--difficulty N2] [--runs 3]`
 */
import { loadRealContent } from './data-adapter';
import { runOne, type RunResult } from './run';
import { setDpsGoldEqForExperiment, DEFAULT_DPS_GOLD_EQ, currentDpsGoldEq } from './strategies/value';
import type { DifficultyId } from '../sim/content';

/** 扫 1.5 个数量级（2 倍步长，7 点）。 */
const VALUES = [50, 100, 200, 400, 800, 1600, 3200];

function pct(v: number): string {
  return `${(v / 10).toFixed(1)}%`;
}

interface Row {
  eq: number;
  coverage: number;
  avgWave: number;
  bestWave: number;
  thieves: number;
  avgTier: number;
  archers: number;
  leaks: number;
}

function main(): void {
  const argv = process.argv.slice(2);
  let diff: DifficultyId = 'N2';
  let runs = 3;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--difficulty') diff = (argv[i + 1] ?? 'N2') as DifficultyId;
    if (argv[i] === '--runs') runs = Math.max(1, Number.parseInt(argv[i + 1] ?? '3', 10) || 3);
  }
  const content = loadRealContent();
  const seeds = [20261013, 20268932, 20276851].slice(0, runs);

  console.log(`★DPS_GOLD_EQ 扫描 ｜ 难度 ${diff} ｜ 每值 ${runs} 局 ｜ 默认值 ${DEFAULT_DPS_GOLD_EQ}`);
  console.log('（该参数决定"1 点 DPS 值多少金币" ⇒ 决定买输出塔还是买窃金塔）\n');
  console.log(
    ['DPS_GOLD_EQ', '窃金覆盖', '均到波', '最好', '窃金塔数', '平均等级', '弓箭手数', '漏怪率', '双达标?']
      .map((h, i) => (i === 0 ? h.padEnd(12) : h.padStart(10)))
      .join(' '),
  );

  const rows: Row[] = [];
  try {
    for (const eq of VALUES) {
      setDpsGoldEqForExperiment(eq);
      const rs: RunResult[] = [];
      for (const seed of seeds) {
        rs.push(runOne({ content, difficultyId: diff, strategyId: 'gap', seed, maxTicks: 240_000 }));
      }
      const n = rs.length;
      const stolen = rs.reduce((a, r) => a + r.stolenTotal, 0);
      const wallet = rs.reduce((a, r) => a + r.walletTotal, 0);
      const coverage = wallet > 0 ? Math.trunc((stolen * 1000) / wallet) : 0;
      const avgWave = Math.round(rs.reduce((a, r) => a + r.waveReached, 0) / n);
      const bestWave = Math.max(...rs.map((r) => r.waveReached));
      const thieves = rs.reduce((a, r) => a + r.thiefCount, 0) / n;
      const avgTier = rs.reduce((a, r) => a + r.avgThiefTierX100, 0) / n / 100;
      const archers = rs.reduce((a, r) => a + (r.attackTypeCounts['pierce'] ?? 0), 0) / n;
      const leakRate = Math.trunc((rs.reduce((a, r) => a + r.leaked, 0) * 1000) / Math.max(1, rs.reduce((a, r) => a + r.spawned, 0)));
      const doublePass = bestWave >= 30 && coverage >= 650;
      rows.push({ eq, coverage, avgWave, bestWave, thieves, avgTier, archers, leaks: leakRate });
      console.log(
        [
          String(eq).padEnd(12),
          pct(coverage).padStart(10),
          String(avgWave).padStart(10),
          String(bestWave).padStart(10),
          thieves.toFixed(1).padStart(10),
          `T${avgTier.toFixed(2)}`.padStart(10),
          archers.toFixed(1).padStart(10),
          pct(leakRate).padStart(10),
          (doublePass ? '★ 是' : '否').padStart(10),
        ].join(' '),
      );
    }
  } finally {
    setDpsGoldEqForExperiment(DEFAULT_DPS_GOLD_EQ); // ★ 还原（这个覆盖只在实验进程里有意义）
  }

  // ── 判定：跷跷板 or 双达标点 ──
  console.log('\n【判定】');
  const pass = rows.filter((r) => r.bestWave >= 30 && r.coverage >= 650);
  const maxCov = rows.reduce((a, b) => (b.coverage > a.coverage ? b : a), rows[0] as Row);
  const maxWave = rows.reduce((a, b) => (b.avgWave > a.avgWave ? b : a), rows[0] as Row);
  console.log(`  最高覆盖率：${pct(maxCov.coverage)}（eq=${maxCov.eq}，到第 ${maxCov.avgWave} 波）`);
  console.log(`  最长存活：  第 ${maxWave.avgWave} 波（eq=${maxWave.eq}，覆盖 ${pct(maxWave.coverage)}）`);
  if (pass.length > 0) {
    console.log(`  ⇒ ★ **存在双达标点**：${pass.map((r) => `eq=${r.eq}`).join('、')}（活到 30 波 且 覆盖 ≥ 65%）`);
  } else {
    // 跷跷板判据：覆盖率最高的点与存活最长的点**不是同一个**，且两端互相排斥
    const different = maxCov.eq !== maxWave.eq;
    console.log(
      different
        ? '  ⇒ ⚠️ **跷跷板**：最高覆盖率与最长存活**不在同一个点上**（覆盖最好的那个活得更短）' +
            ' ⇒ 在当前的投入产出比下**经济与存活不可兼得** ⇒ 下一步应动数据，而不是继续调 AI'
        : '  ⇒ ⚠️ 未见双达标点，但两端也不是分离的（最高覆盖率与最长存活同点）→ 需扩大扫描范围再判',
    );
  }
  // 金币陷阱相关性
  const byArch = [...rows].sort((a, b) => a.archers - b.archers);
  console.log('\n【金币陷阱相关性】按弓箭手数量升序：');
  for (const r of byArch) {
    console.log(`  弓箭手 ${r.archers.toFixed(1)} 座 → 覆盖 ${pct(r.coverage)} ｜ 窃金塔 ${r.thieves.toFixed(1)} 座 ｜ 第 ${r.avgWave} 波`);
  }
  const lo = byArch[0] as Row;
  const hi = byArch[byArch.length - 1] as Row;
  console.log(
    `  ⇒ 弓箭手从 ${lo.archers.toFixed(1)} → ${hi.archers.toFixed(1)} 座时，覆盖 ${pct(lo.coverage)} → ${pct(hi.coverage)}，窃金塔 ${lo.thieves.toFixed(1)} → ${hi.thieves.toFixed(1)} 座`,
  );
  console.log(`  （当前生效值已还原为 ${currentDpsGoldEq()}）`);
}

main();