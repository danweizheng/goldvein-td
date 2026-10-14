/**
 * ★★ **`SAFETY_WEIGHT` 闩锁扫描**（主策划裁决 1 的第 2 步）
 *
 * ## 待验证的闩锁（上一条汇报里我从代码里读出来的根因）
 *
 * `weightsFor` 在 `mix.output < 路数 × 2` 时把 `dpsW` **钉到** `SAFETY_WEIGHT`(6)。
 * 该条件在**前期长期成立** ⇒ 输出被永久放大 ⇒ **经济与输出那个"近乎平手"的比较一旦倒向输出，
 * 就再也不会回头**（双稳态 + 迟滞）。
 *
 * 这也是 `DPS_GOLD_EQ` 扫描"只有 3 种结果、且从不出现双达标点"的原因：
 * **那个比较只会翻一次，翻完就被这条钉死规则锁住。**
 *
 * ## 本扫描
 *
 * 扫 `SAFETY_WEIGHT ∈ {1, 2, 3, 6, 10}`（1 = 完全不放大，即"拆掉闩锁"），报：
 * **覆盖率 与 存活波数（两个都报）** + 窃金塔数 + 平均等级 + 弓箭手数。
 *
 * `1` 这一行是关键对照：**若拆掉闩锁后窃金塔数与覆盖率显著上升**，
 * 就证明闩锁（而不是 `DPS_GOLD_EQ`）是真正的杠杆。
 *
 * 用法：`pnpm exec tsx src/balance/safety-scan.ts [--difficulty N2] [--runs 3]`
 */
import { loadRealContent } from './data-adapter';
import { runOne, type RunResult } from './run';
import { setSafetyWeightForExperiment, DEFAULT_SAFETY_WEIGHT } from './strategies/value';
import type { DifficultyId } from '../sim/content';

const VALUES = [1, 2, 3, 6, 10];

function pct(v: number): string {
  return `${(v / 10).toFixed(1)}%`;
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

  console.log(`★SAFETY_WEIGHT 闩锁扫描 ｜ 难度 ${diff} ｜ 每值 ${runs} 局 ｜ 默认 ${DEFAULT_SAFETY_WEIGHT}`);
  console.log('（1 = 拆掉闩锁：输出短缺时不再放大 DPS 价值）\n');
  console.log(
    ['SAFETY_WEIGHT', '窃金覆盖', '均到波', '最好', '窃金塔数', '平均等级', '弓箭手数', '漏怪率', '攻击类型分布']
      .map((h, i) => (i === 0 ? h.padEnd(15) : h.padStart(10)))
      .join(' '),
  );
  try {
    for (const sw of VALUES) {
      setSafetyWeightForExperiment(sw);
      const rs: RunResult[] = [];
      for (const seed of seeds) {
        rs.push(runOne({ content, difficultyId: diff, strategyId: 'gap', seed, maxTicks: 240_000 }));
      }
      const n = rs.length;
      const stolen = rs.reduce((a, r) => a + r.stolenTotal, 0);
      const wallet = rs.reduce((a, r) => a + r.walletTotal, 0);
      const coverage = wallet > 0 ? Math.trunc((stolen * 1000) / wallet) : 0;
      const avgWave = Math.round(rs.reduce((a, r) => a + r.waveReached, 0) / n);
      const thieves = rs.reduce((a, r) => a + r.thiefCount, 0) / n;
      const avgTier = rs.reduce((a, r) => a + r.avgThiefTierX100, 0) / n / 100;
      const archers = rs.reduce((a, r) => a + (r.attackTypeCounts['pierce'] ?? 0), 0) / n;
      const leakRate = Math.trunc((rs.reduce((a, r) => a + r.leaked, 0) * 1000) / Math.max(1, rs.reduce((a, r) => a + r.spawned, 0)));
      console.log(
        [
          String(sw).padEnd(15),
          pct(coverage).padStart(10),
          String(avgWave).padStart(10),
          String(Math.max(...rs.map((r) => r.waveReached))).padStart(10),
          thieves.toFixed(1).padStart(10),
          `T${avgTier.toFixed(2)}`.padStart(10),
          archers.toFixed(1).padStart(10),
          pct(leakRate).padStart(10),
          ` ${JSON.stringify(rs[0]?.attackTypeCounts ?? {})}`,
        ].join(' '),
      );
    }
  } finally {
    setSafetyWeightForExperiment(DEFAULT_SAFETY_WEIGHT);
  }
  console.log('\n读法：`1` 那一行是"拆掉闩锁"的对照。若它的窃金塔数/覆盖率显著高于 6，则闩锁是真杠杆。');
  console.log('目标仍是「活到第 30 波 且 覆盖率 ≥ 65%」——两个指标必须同时看。');
}

main();