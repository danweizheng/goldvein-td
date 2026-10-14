/**
 * 汇总与门禁判定（策划案 §10.2 + §5.4 + §6.1 Q1 判定）
 *
 * 所有指标都从 `RunResult` / `WaveStats` 算出来（契约 §6.1：`WaveStats` 是平衡验证的
 * 唯一数据源）。定点千分比一律按整数比较，避免浮点。
 */
import type { DifficultyId } from '../sim/content';
import { COMFORT_BAND } from './acceptance';
import type { RunResult } from './run';
import type { StrategyId } from './strategies/types';

/** 一组（策略 × 难度）的汇总。 */
export interface GroupSummary {
  strategyId: StrategyId;
  difficultyId: DifficultyId;
  runs: number;
  wins: number;
  losses: number;
  timeouts: number;
  /** 千分比（1000 = 100%） */
  winRate: number;
  avgWaveReached: number;
  avgSeconds: number;
  /** 累计窃金 / 累计理论钱包（千分比） */
  stealCoverage: number;
  /** 支出 / 收入（千分比） */
  spendRatio: number;
  /** 漏怪 / 出怪（千分比） */
  leakRate: number;
  /** (blockExtraSteal / stolenTotal)（千分比） */
  blockShare: number;
  /** 平均每局累计窃金（定点） */
  avgStolen: number;
  avgIncome: number;
  avgSpent: number;
  avgKillGold: number;
  avgWaveReward: number;
  avgSalary: number;
  avgTowersAtWave10: number;
  avgTowersAtWave20: number;
  avgTowerCount: number;
  /** 平均每局已研究的科技总级数（§5.4：第 20 波应 10–16 级） */
  avgTechLevelsAtWave20: number;
  avgTechResearched: number;
  /** 科技支出 / 总支出（千分比）——契约 §14.12 目标 350‰ */
  techSpendShare: number;
  avgTechSpent: number;
  /** 指令被拒总数（全组） */
  rejections: number;
  /** 每局平均实际游戏时长（分钟） */
  avgMinutes: number;
  /** 分布：逐局 waveReached */
  wavesReached: number[];
}

function sum(nums: readonly number[]): number {
  let s = 0;
  for (const n of nums) s += n;
  return s;
}

/** 千分比（整数除法，向下取整）。 */
export function permille(num: number, den: number): number {
  if (den <= 0) return 0;
  return Math.trunc((num * 1000) / den);
}

export function summarize(
  strategyId: StrategyId,
  difficultyId: DifficultyId,
  runs: readonly RunResult[],
): GroupSummary {
  const n = runs.length;
  const wins = runs.filter((r) => r.win).length;
  const timeouts = runs.filter((r) => r.status === 'timeout').length;
  const stolen = sum(runs.map((r) => r.stolenTotal));
  const wallet = sum(runs.map((r) => r.walletTotal));
  const spent = sum(runs.map((r) => r.spentTotal));
  const income = sum(runs.map((r) => r.incomeTotal));
  const leaked = sum(runs.map((r) => r.leaked));
  const spawned = sum(runs.map((r) => r.spawned));
  const blockExtra = sum(runs.map((r) => r.blockExtraSteal));
  const ticks = sum(runs.map((r) => r.ticks));

  return {
    strategyId,
    difficultyId,
    runs: n,
    wins,
    losses: n - wins - timeouts,
    timeouts,
    winRate: permille(wins, n),
    avgWaveReached: n > 0 ? Math.round(sum(runs.map((r) => r.waveReached)) / n) : 0,
    avgSeconds: n > 0 ? Math.round(ticks / n / 60) : 0,
    stealCoverage: permille(stolen, wallet),
    spendRatio: permille(spent, income),
    leakRate: permille(leaked, spawned),
    blockShare: permille(blockExtra, stolen),
    avgStolen: n > 0 ? Math.round(stolen / n) : 0,
    avgIncome: n > 0 ? Math.round(income / n) : 0,
    avgSpent: n > 0 ? Math.round(spent / n) : 0,
    avgKillGold: n > 0 ? Math.round(sum(runs.map((r) => r.killGoldTotal)) / n) : 0,
    avgWaveReward: n > 0 ? Math.round(sum(runs.map((r) => r.waveRewardTotal)) / n) : 0,
    avgSalary: n > 0 ? Math.round(sum(runs.map((r) => r.salaryTotal)) / n) : 0,
    avgTowersAtWave10: n > 0 ? sum(runs.map((r) => r.towersAtWave10)) / n : 0,
    avgTowersAtWave20: n > 0 ? sum(runs.map((r) => r.towersAtWave20)) / n : 0,
    avgTowerCount: n > 0 ? sum(runs.map((r) => r.towerCount)) / n : 0,
    avgTechLevelsAtWave20: n > 0 ? sum(runs.map((r) => r.techLevelsAtWave20)) / n : 0,
    avgTechResearched: n > 0 ? sum(runs.map((r) => r.techResearched)) / n : 0,
    techSpendShare: permille(sum(runs.map((r) => r.techSpentGold)), spent),
    avgTechSpent: n > 0 ? Math.round(sum(runs.map((r) => r.techSpentGold)) / n) : 0,
    rejections: sum(runs.map((r) => r.rejections)),
    avgMinutes: n > 0 ? Math.round(ticks / n / 60 / 60) : 0,
    wavesReached: runs.map((r) => r.waveReached),
  };
}

/** 逐波平均（用于看曲线）。 */
export interface WaveAggregate {
  wave: number;
  runs: number;
  goldEarned: number;
  goldSpent: number;
  stolenTotal: number;
  walletTotal: number;
  stealCoverage: number;
  blockExtraSteal: number;
  leaks: number;
  towerCount: number;
  techLevels: number;
}

export function aggregateWaves(runs: readonly RunResult[], totalWaves: number): WaveAggregate[] {
  const out: WaveAggregate[] = [];
  for (let wave = 1; wave <= totalWaves; wave++) {
    const recs = runs.map((r) => r.waves.find((x) => x.wave === wave)).filter((x) => x !== undefined);
    if (recs.length === 0) continue;
    const num = recs.length;
    const stolen = sum(recs.map((r) => r.stolenTotal));
    const wallet = sum(recs.map((r) => r.walletTotal));
    out.push({
      wave,
      runs: num,
      goldEarned: Math.round(sum(recs.map((r) => r.goldEarned)) / num),
      goldSpent: Math.round(sum(recs.map((r) => r.goldSpent)) / num),
      stolenTotal: Math.round(stolen / num),
      walletTotal: Math.round(wallet / num),
      stealCoverage: permille(stolen, wallet),
      blockExtraSteal: Math.round(sum(recs.map((r) => r.blockExtraSteal)) / num),
      leaks: Math.round(sum(recs.map((r) => r.leaks)) / num),
      towerCount: Math.round(sum(recs.map((r) => r.towerCount)) / num),
      techLevels: Math.round(sum(recs.map((r) => r.techLevels)) / num),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 门禁（策划案 §10.2「验收门槛（自动判定）」原文抄录）
// ─────────────────────────────────────────────────────────────────────────────

export interface Gate {
  strategyId: StrategyId;
  difficultyId: DifficultyId;
  min: number;
  max: number;
  /** 说明 */
  note: string;
}

/** 门禁表 —— **不得为了让结果落进区间而修改本表**（策划案 §10.2）。 */
export const GATES: readonly Gate[] = [
  { strategyId: 'balanced', difficultyId: 'N2', min: 1000, max: 1000, note: '普通玩家必须稳通' },
  { strategyId: 'balanced', difficultyId: 'N3', min: 600, max: 800, note: '主力难度区间' },
  {
    strategyId: 'heuristic',
    difficultyId: 'N4',
    min: 400,
    max: 600,
    note: '启发式上限（契约 §14.9：应读作**下界**，它不是真搜索）',
  },
  {
    strategyId: 'heuristic',
    difficultyId: 'N5',
    min: 50,
    max: 150,
    note: '挑战难度（同上，下界读法）',
  },
  { strategyId: 'greedy', difficultyId: 'N3', min: 0, max: 300, note: '无脑玩家不得超过 30%（超过说明太简单）' },
  { strategyId: 'noop', difficultyId: 'N2', min: 0, max: 0, note: '纯偷流必须失败' },
];

export type GateVerdict = 'pass' | 'fail-high' | 'fail-low' | 'missing';

export interface GateResult {
  gate: Gate;
  actual: number | null;
  verdict: GateVerdict;
  deviation: number;
}

export function evaluateGates(summaries: readonly GroupSummary[]): GateResult[] {
  return GATES.map((gate) => {
    const s = summaries.find((x) => x.strategyId === gate.strategyId && x.difficultyId === gate.difficultyId);
    if (!s) return { gate, actual: null, verdict: 'missing' as GateVerdict, deviation: 0 };
    const actual = s.winRate;
    let verdict: GateVerdict = 'pass';
    if (actual > gate.max) verdict = 'fail-high';
    else if (actual < gate.min) verdict = 'fail-low';
    return { gate, actual, verdict, deviation: actual > gate.max ? actual - gate.max : actual < gate.min ? actual - gate.min : 0 };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ★ 舒适带（主策划裁决：替代被删除的 §5.4「第 10 波 6–9 座塔」）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 为什么删掉塔数目标：**塔数是个弱代理指标** —— 18 座 T1 与 6 座 T5 是完全不同的局面，
 * 塔数区分不了。替代它的是两条有真实判据的指标：
 *
 * 1. `solvability`：`需求DPS/可达上界 ≤ 1.0`（**硬界**，见 `tests/sim/solvability.spec.ts`）
 * 2. **舒适带**（本条）：第 10 波与第 20 波的 `需求/上界` 应落在 **[0.2, 0.6]**
 *    —— 既不轻松（< 0.2 = 这一波毫无压力）也不绝望（> 0.6 = 逼近上界）
 *
 * ⚠️ **口径警告（必须与数字一起读）**：本判定的"上界"用的是**满级科技 + 人口上限**的理想上界。
 * 早期波次的实际阵容远弱于此，所以 `需求/上界` 在前期天然极低（0.01–0.05×）→
 * **早期波按此口径必然判「太轻松」**。这不是数据缺陷，是"理想上界"在早期的必然结果。
 * 若要把舒适带当**数据门禁**，需改用"按波次可达的预算上界"（尚未定义）；
 * 若当**玩家体验**指标，则应改用 AI 实测（策略相关）。两者我都不擅自选 —— 见汇报。
 */
// ★ 阈值的**唯一来源**是 `constants.json` 的 `acceptanceTargets`（`src/balance/acceptance.ts`）。
//   这里曾经硬编码 `{min:200, max:600, waves:[10,20]}` —— 与数据里的
//   `solvabilityComfortMin/Max/Waves` 是一份**重复副本**；键登记门禁第一次运行就抓到了它。
export { COMFORT_BAND } from './acceptance';

export type ComfortVerdict = 'pass' | 'too-easy' | 'too-hard' | 'missing';

export interface ComfortResult {
  difficultyId: DifficultyId;
  wave: number;
  /** 需求 / 可达上界（千分比） */
  ratio: number | null;
  verdict: ComfortVerdict;
  /** 与最近边界的距离（千分比） */
  deviation: number;
}

export function evaluateComfortBand(
  rowsByDifficulty: readonly {
    difficultyId: DifficultyId;
    rows: readonly { wave: number; requiredOverMax: number }[];
  }[],
  band = COMFORT_BAND,
): ComfortResult[] {
  const out: ComfortResult[] = [];
  for (const d of rowsByDifficulty) {
    for (const wave of band.waves) {
      const row = d.rows.find((r) => r.wave === wave);
      if (!row) {
        out.push({ difficultyId: d.difficultyId, wave, ratio: null, verdict: 'missing', deviation: 0 });
        continue;
      }
      const ratio = row.requiredOverMax;
      let verdict: ComfortVerdict = 'pass';
      let deviation = 0;
      if (ratio < band.min) {
        verdict = 'too-easy';
        deviation = band.min - ratio;
      } else if (ratio > band.max) {
        verdict = 'too-hard';
        deviation = ratio - band.max;
      }
      out.push({ difficultyId: d.difficultyId, wave, ratio, verdict, deviation });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Q1：军训系存在性（策划案 §4.2.4 / §10.2）
// ─────────────────────────────────────────────────────────────────────────────

export interface Q1Result {
  difficultyId: DifficultyId;
  balanced: GroupSummary | null;
  noblock: GroupSummary | null;
  /** block_extra_steal / total_steal（千分比，目标 ≥ 250） */
  blockShare: number;
  /** 两组平均通关波次差 */
  waveGap: number;
  /** 两组通关率差（千分比） */
  winRateGap: number;
  sharePass: boolean;
  waveGapPass: boolean;
  /** 判定结论（按 G1 决策门规则） */
  verdict: string;
}

export function evaluateQ1(
  difficultyId: DifficultyId,
  summaries: readonly GroupSummary[],
): Q1Result | null {
  const balanced = summaries.find((s) => s.strategyId === 'balanced' && s.difficultyId === difficultyId) ?? null;
  const noblock = summaries.find((s) => s.strategyId === 'noblock' && s.difficultyId === difficultyId) ?? null;
  if (!balanced || !noblock) return null;

  const blockShare = balanced.blockShare;
  const waveGap = Math.abs(balanced.avgWaveReached - noblock.avgWaveReached);
  const winRateGap = balanced.winRate - noblock.winRate;
  const sharePass = blockShare >= 250;
  const waveGapPass = waveGap >= 2;

  let verdict: string;
  if (sharePass && waveGapPass) verdict = '军训系有实际价值（窃金占比与通关波次两个口径同时成立）';
  else if (!waveGapPass) verdict = '★ 触发 G1 决策门：两组通关波次差 < 2 波 → 建议军训系整系删除';
  else verdict = '窃金占比未达 25%，但通关波次差 ≥ 2 波 → 价值存在但不是「窃金」带来的，需人工复核';
  return { difficultyId, balanced, noblock, blockShare, waveGap, winRateGap, sharePass, waveGapPass, verdict };
}

/** 用运行时长判断「通关时间」（§5.4：N1 22–28 min / N5 35–50 min）。 */
export function minutes(ticks: number, tickRate = 60): number {
  return Math.round((ticks / tickRate / 60) * 10) / 10;
}
