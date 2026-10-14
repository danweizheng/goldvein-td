/**
 * ★ **缺口驱动分配的审计报告**（主策划裁决 2 主线）
 *
 * 主策划的原话：「每波把这两个缺口值与最终决策打出来（至少前 20 波），
 * 否则我们无法判断它是"**在按缺口买**"还是"碰巧买对了"。」
 *
 * 本脚本做三件事：
 * 1. 打印 `gap` 策略**逐波的两个缺口 + 归一化 + 最终决策**（前 20 波）
 * 2. 对照 `gap` / `balanced` / `noop` 的**覆盖率 × 存活 × 最高窃金塔等级**
 *    （最高等级是一等指标 —— 它揭示"主乘区有没有打开"）
 * 3. 判定缺口驱动是否达到主策划的目标：**能活到第 30 波 且 覆盖率 ≥ 65%**
 *
 * 用法：`pnpm exec tsx src/balance/gap-report.ts [--difficulty N2] [--runs 3]`
 */
import { loadRealContent } from './data-adapter';
import { runOne, type RunResult } from './run';
import type { DifficultyId } from '../sim/content';
import type { GapTrace } from './strategies/gap';
import type { StrategyId } from './strategies/types';

function pct(p: number): string {
  return `${(p / 10).toFixed(1)}%`;
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
  const seeds = [20261013, 20268932, 20276851];

  // ── 1. 缺口轨迹（第 1 局）──
  let trace: GapTrace[] = [];
  const first = runOne({
    content,
    difficultyId: diff,
    strategyId: 'gap',
    seed: seeds[0] as number,
    maxTicks: 240_000,
    onStrategyReady: (s) => {
      const cand = s as { trace?: () => GapTrace[] };
      if (typeof cand.trace === 'function') trace = cand.trace();
    },
  });
  console.log(`★缺口驱动审计 ｜ 难度 ${diff} ｜ seed ${seeds[0]}`);
  console.log('\n【逐波缺口与决策】（前 20 波）');
  console.log(
    ['波', '上波漏怪', '上波覆盖', '下波护甲', '决策']
      .map((h, i) => (i === 0 ? h.padEnd(4) : i === 8 ? h.padEnd(10) : h.padStart(10)))
      .join(' '),
  );
  for (const t of trace.slice(0, 20)) {
    console.log(
      [
        String(t.wave).padEnd(4),
        String(t.lastLeaks).padStart(10),
        pct(t.coverage).padStart(10),
        t.nextWaveArmor.padStart(10),
        ` ${t.decision}`,
      ].join(' '),
    );
  }

  // ── 2. 三策略对照（覆盖率 × 存活 × 最高窃金塔等级）──
  console.log('\n【对照】gap / balanced / noop');
  console.log(
    ['策略', '难度', '窃金覆盖', '均到波', '最好到波', '窃金塔数', '平均等级', '最高等级', '通关率', '漏怪率']
      .map((h, i) => (i < 2 ? h.padEnd(10) : h.padStart(9)))
      .join(' '),
  );
  let gapWins = 0;
  for (const sid of ['gap', 'balanced', 'noop'] as StrategyId[]) {
    const rs: RunResult[] = [];
    for (let i = 0; i < runs; i++) {
      rs.push(
        runOne({ content, difficultyId: diff, strategyId: sid, seed: seeds[i % seeds.length] as number, maxTicks: 240_000 }),
      );
    }
    const n = rs.length;
    const stolen = rs.reduce((a, r) => a + r.stolenTotal, 0);
    const wallet = rs.reduce((a, r) => a + r.walletTotal, 0);
    const cov = wallet > 0 ? Math.trunc((stolen * 1000) / wallet) : 0;
    const wins = rs.filter((r) => r.win).length;
    const bestWave = Math.max(...rs.map((r) => r.waveReached));
    if (sid === 'gap') gapWins = wins;
    console.log(
      [
        sid.padEnd(10),
        diff.padEnd(10),
        pct(cov).padStart(9),
        String(Math.round(rs.reduce((a, r) => a + r.waveReached, 0) / n)).padStart(9),
        String(bestWave).padStart(9),
        (rs.reduce((a, r) => a + r.thiefCount, 0) / n).toFixed(1).padStart(9),
        `T${(rs.reduce((a, r) => a + r.avgThiefTierX100, 0) / n / 100).toFixed(2)}`.padStart(9),
        `T${Math.max(...rs.map((r) => r.maxThiefTier))}`.padStart(9),
        `${((wins * 100) / n).toFixed(0)}%`.padStart(9),
        pct(Math.trunc((rs.reduce((a, r) => a + r.leaked, 0) * 1000) / Math.max(1, rs.reduce((a, r) => a + r.spawned, 0)))).padStart(9),
      ].join(' '),
    );
  }

  // ── 3. 目标判定（主策划：能活到第 30 波 且 覆盖率 ≥ 65%）──
  const gapRuns: RunResult[] = [];
  for (let i = 0; i < runs; i++) {
    gapRuns.push(
      runOne({ content, difficultyId: diff, strategyId: 'gap', seed: seeds[i % seeds.length] as number, maxTicks: 240_000 }),
    );
  }
  const gStolen = gapRuns.reduce((a, r) => a + r.stolenTotal, 0);
  const gWallet = gapRuns.reduce((a, r) => a + r.walletTotal, 0);
  const gCov = gWallet > 0 ? Math.trunc((gStolen * 1000) / gWallet) : 0;
  const survived30 = gapRuns.filter((r) => r.waveReached >= 30).length;
  console.log('\n【目标判定】能活到第 30 波 **且** 覆盖率 ≥ 65%（契约 §16：达成则第 3 级永久撤销）');
  console.log(
    `  gap: 活到第 30 波的局数 = ${survived30}/${runs} ｜ 覆盖率 = ${pct(gCov)} ｜ 最好到第 ${Math.max(...gapRuns.map((r) => r.waveReached))} 波 ｜ 最高窃金塔 T${Math.max(...gapRuns.map((r) => r.maxThiefTier))}`,
  );
  console.log(
    survived30 >= runs && gCov >= 650
      ? '  ⇒ ✅ 达成：第 3 级（下调钱包曲线）应永久撤销'
      : '  ⇒ ❌ 未达成（覆盖率或存活仍不足）—— 第 3 级维持"暂停"',
  );
  void first;
  void gapWins;
}

main();
