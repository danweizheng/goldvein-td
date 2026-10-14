/**
 * ★★ **aging 上限扫描**（主策划裁决 2 的硬要求：**不许猜，必须扫**）
 *
 * ```
 * agingMax ∈ {1, 2, 3, 4, 5}
 * ```
 * `agingMax` 的含义：**在漏怪持续的前提下，经济最多可以被连续饿死几波**
 * （也就是反馈闩锁的解锁上限 —— 见 `strategies/gap.ts` 的注释）。
 *
 * ## 报什么（主策划：**覆盖率与存活两个指标都报**）
 *
 * 每个 `agingMax` 都报：窃金覆盖率、均到波、最好到波、窃金塔数、平均/最高等级、漏怪率。
 * **不允许只报变好的那个。**
 *
 * ## 另外报"可解释性抽样"
 *
 * 每个 `agingMax` 抽一条 trace，打印真正的「aging 解锁」那一波，证明它**不是因为配额**而在投经济，
 * 而是因为"经济**确实**低于目标且已被饿够 agingMax 波"。
 *
 * 用法：`pnpm exec tsx src/balance/aging-scan.ts [--difficulty N2] [--runs 3]`
 */
import { loadRealContent } from './data-adapter';
import { runOne, type RunResult } from './run';
import type { DifficultyId } from '../sim/content';
import type { GapTrace } from './strategies/gap';
import { COVERAGE_TARGET_PERMILLE } from './acceptance';

/** 只用于审计：跑一局并取回策略的 trace。 */
function runWithTrace(content: ReturnType<typeof loadRealContent>, difficultyId: DifficultyId, seed: number, agingMax: number): { r: RunResult; trace: GapTrace[] } {
  let trace: GapTrace[] = [];
  const r = runOne({
    content,
    difficultyId,
    strategyId: 'gap',
    seed,
    maxTicks: 240_000,
    agingMax,
    onStrategyReady: (s) => {
      const cand = s as { trace?: () => GapTrace[] };
      if (typeof cand.trace === 'function') trace = cand.trace();
    },
  });
  return { r, trace };
}

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
  const VALUES = [1, 2, 3, 4, 5];

  console.log(`★aging 上限扫描 ｜ 难度 ${diff} ｜ 每值 ${runs} 局 ｜ 覆盖率目标 ${COVERAGE_TARGET_PERMILLE / 10}%`);
  console.log('（agingMax = 漏怪持续时经济最多被连续饿死几波；两个指标都报）\n');
  console.log(
    ['agingMax', '窃金覆盖', '均到波', '最好', '窃金塔数', '平均等级', '最高', '漏怪率', 'aging解锁次数']
      .map((h, i) => (i === 0 ? h.padEnd(10) : h.padStart(10)))
      .join(' '),
  );

  const rows: string[] = [];
  let firstUnlockPrinted = false;
  for (const agingMax of VALUES) {
    const rs: RunResult[] = [];
    let unlockCount = 0;
    let sampleTrace: GapTrace[] = [];
    for (const seed of seeds) {
      const { r, trace } = runWithTrace(content, diff, seed, agingMax);
      rs.push(r);
      unlockCount += trace.filter((t) => t.decision.includes('aging 解锁')).length;
      if (sampleTrace.length === 0) sampleTrace = trace;
    }
    const n = rs.length;
    const stolen = rs.reduce((a, r) => a + r.stolenTotal, 0);
    const wallet = rs.reduce((a, r) => a + r.walletTotal, 0);
    const cov = wallet > 0 ? Math.trunc((stolen * 1000) / wallet) : 0;
    rows.push(
      [
        String(agingMax).padEnd(10),
        pct(cov).padStart(10),
        String(Math.round(rs.reduce((a, r) => a + r.waveReached, 0) / n)).padStart(10),
        String(Math.max(...rs.map((r) => r.waveReached))).padStart(10),
        (rs.reduce((a, r) => a + r.thiefCount, 0) / n).toFixed(1).padStart(10),
        `T${(rs.reduce((a, r) => a + r.avgThiefTierX100, 0) / n / 100).toFixed(2)}`.padStart(10),
        `T${Math.max(...rs.map((r) => r.maxThiefTier))}`.padStart(10),
        pct(Math.trunc((rs.reduce((a, r) => a + r.leaked, 0) * 1000) / Math.max(1, rs.reduce((a, r) => a + r.spawned, 0)))).padStart(10),
        String(unlockCount).padStart(10),
      ].join(' '),
    );
    if (!firstUnlockPrinted) {
      const unlock = sampleTrace.find((t) => t.decision.includes('aging 解锁'));
      if (unlock) {
        firstUnlockPrinted = true;
        console.log(`\n【可解释性抽样】agingMax=${agingMax} 的首次「aging 解锁」波：`);
        console.log(`  波 ${unlock.wave} ｜ 上波漏怪 ${unlock.lastLeaks} 只 ｜ 覆盖率 ${pct(unlock.coverage)} ｜ 距上次经济动作 ${unlock.wavesSinceEconomy} 波`);
        console.log(`  决策：${unlock.decision}`);
        console.log('  ⇒ 读法：漏怪仍在，但经济**确实**低于目标且已被饿够 agingMax 波 → 这一波投经济（不是配额）\n');
      }
    }
  }
  console.log(rows.join('\n'));
  console.log('\n读法：agingMax=1 最激进（每漏一波就插一次经济）；越大越偏向连续补输出。');
  console.log('目标仍是「活到第 30 波 且 覆盖率 ≥ 65%」——两个指标必须同时看。');
}

main();