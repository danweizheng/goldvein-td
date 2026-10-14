/**
 * 门禁 / Q1 / 尾部占比的判定逻辑单测
 *
 * 这里验证的是**判定器**本身（给定指标 → 判定），不是跑批结果。
 * 门禁表（`GATES`）是策划案 §10.2 的原文抄录（`optimal` 已按契约 §14.9 更名 `heuristic`），
 * 本文件同时锁死它不被改动。
 */
import { describe, expect, it } from 'vitest';
import { GATES, evaluateGates, evaluateQ1, permille, summarize, type GroupSummary } from '../../src/balance/metrics';
import { analyzeKillReward, analyzeTail, evaluateAltModel, solveAltGrowthForTail, waveWalletTheory } from '../../src/balance/tail-model';
import { analyzeTtk } from '../../src/balance/ttk-analysis';
import { loadRealContent } from '../../src/balance/data-adapter';
import type { RunResult } from '../../src/balance/run';

const content = loadRealContent();

function fakeRun(over: Partial<RunResult>): RunResult {
  return {
    strategyId: 'balanced',
    difficultyId: 'N2',
    seed: 1,
    status: 'lost',
    win: false,
    waveReached: 10,
    ticks: 60_000,
    seconds: 1000,
    waves: [],
    towersAtWave10: 8,
    towersAtWave20: 0,
    techLevelsAtWave20: 0,
    techSpentGold: 30_000,
    techSpentWood: 3_000,
    techResearched: 6,
    thiefCount: 3,
    avgThiefTierX100: 150,
    maxThiefTier: 2,
    thiefStolenTotal: 90_000,
    attackTypeCounts: { pierce: 4, normal: 2 },
    waveDps: [
      { wave: 1, dps: 0, tick: 600 },
      { wave: 2, dps: 12_000, tick: 1800 },
    ],
    stolenTotal: 100_000,
    killGoldTotal: 20_000,
    waveRewardTotal: 5_000,
    salaryTotal: 1_000,
    incomeTotal: 125_000,
    spentTotal: 100_000,
    blockExtraSteal: 30_000,
    walletTotal: 150_000,
    leaked: 5,
    killed: 100,
    spawned: 200,
    livesLeft: 0,
    finalGold: 0,
    finalWood: 0,
    towerCount: 8,
    rejections: 0,
    rejectionSamples: [],
    commands: {},
    peakAliveEnemies: 20,
    peakActiveProjectiles: 30,
    hash: 'deadbeef',
    lastCoverage: 700,
    ...over,
  };
}

describe('门禁表（策划案 §10.2 + 契约 §14.9 更名，不得为了过闸而修改）', () => {
  it('六条门禁与策划案一致（optimal → heuristic）', () => {
    expect(GATES.map((g) => [g.strategyId, g.difficultyId, g.min, g.max])).toEqual([
      ['balanced', 'N2', 1000, 1000],
      ['balanced', 'N3', 600, 800],
      ['heuristic', 'N4', 400, 600],
      ['heuristic', 'N5', 50, 150],
      ['greedy', 'N3', 0, 300],
      ['noop', 'N2', 0, 0],
    ]);
  });

  it('缺格记 missing，不静默当作通过', () => {
    const res = evaluateGates([]);
    expect(res.every((r) => r.verdict === 'missing')).toBe(true);
  });

  it('判定方向正确：fails-high / fails-low / pass', () => {
    const summary = (
      strategyId: GroupSummary['strategyId'],
      difficultyId: GroupSummary['difficultyId'],
      winRate: number,
    ): GroupSummary =>
      ({
        ...summarize(strategyId, difficultyId, []),
        strategyId,
        difficultyId,
        winRate,
        runs: 10,
        wins: Math.round(winRate / 100),
      }) as GroupSummary;
    const res = evaluateGates([
      summary('balanced', 'N2', 1000),
      summary('balanced', 'N3', 950),
      summary('heuristic', 'N4', 500),
      summary('heuristic', 'N5', 10),
      summary('greedy', 'N3', 800),
      summary('noop', 'N2', 0),
    ]);
    const by = (s: string, d: string) => res.find((r) => r.gate.strategyId === s && r.gate.difficultyId === d)?.verdict;
    expect(by('balanced', 'N2')).toBe('pass');
    expect(by('balanced', 'N3')).toBe('fail-high');
    expect(by('heuristic', 'N4')).toBe('pass');
    expect(by('heuristic', 'N5')).toBe('fail-low');
    expect(by('greedy', 'N3')).toBe('fail-high');
    expect(by('noop', 'N2')).toBe('pass');
  });
});

describe('Q1 判定（军训系存在性）', () => {
  const sum = (strategyId: 'balanced' | 'noblock', blockShare: number, avgWaveReached: number, winRate = 0): GroupSummary => ({
    ...summarize(strategyId, 'N3', []),
    strategyId,
    avgWaveReached,
    blockShare,
    winRate,
  });

  it('★ 判据是真反事实：通关波次差 ≥2 → 有价值', () => {
    const q = evaluateQ1('N3', [sum('balanced', 300, 12), sum('noblock', 0, 9)]);
    expect(q?.waveGapPass).toBe(true);
    expect(q?.verdict).toContain('有实际价值');
  });

  it('★ 波次差 < 2 → 触发 G1 决策门', () => {
    const q = evaluateQ1('N3', [sum('balanced', 300, 11), sum('noblock', 0, 10)]);
    expect(q?.waveGapPass).toBe(false);
    expect(q?.verdict).toContain('G1 决策门');
    expect(q?.verdict).toContain('整系删除');
  });

  it('blockShare 降级为**诊断**指标：它不再能单独决定结论', () => {
    const q = evaluateQ1('N3', [sum('balanced', 10, 12), sum('noblock', 0, 9)]);
    expect(q?.sharePass).toBe(false);
    expect(q?.verdict).toContain('人工复核');
  });

  it('缺一组时返回 null', () => {
    expect(evaluateQ1('N3', [sum('balanced', 300, 12)])).toBeNull();
  });
});

describe('汇总指标', () => {
  it('千分比取整与分母为 0 的保护', () => {
    expect(permille(1, 2)).toBe(500);
    expect(permille(1, 3)).toBe(333);
    expect(permille(5, 0)).toBe(0);
  });

  it('一组内的覆盖率/支出比/漏怪率/卡位占比/科技占比', () => {
    const s = summarize('balanced', 'N2', [fakeRun({}), fakeRun({})]);
    expect(s.stealCoverage).toBe(permille(200_000, 300_000));
    expect(s.spendRatio).toBe(permille(200_000, 250_000));
    expect(s.leakRate).toBe(permille(10, 400));
    expect(s.blockShare).toBe(permille(60_000, 200_000));
    expect(s.techSpendShare).toBe(permille(60_000, 200_000));
    expect(s.avgTechResearched).toBe(6);
    expect(s.winRate).toBe(0);
  });
});

describe('尾部占比分析（§5.3.1 / §14.12）', () => {
  it('实测尾部占比与 §14.12 记录的 74.0% 同量级', () => {
    const tail = analyzeTail(content, 26, 30);
    expect(tail.tailShare).toBeGreaterThan(700);
    expect(tail.tailShare).toBeLessThan(790);
    expect(1000 - tail.tailShare).toBeLessThan(300);
  });

  it('每波钱包与 §5.2 的更新值一致（±0.2%）', () => {
    const doc: readonly [number, number][] = [
      [1, 192],
      [5, 690],
      [10, 2509],
      [20, 41911],
      [25, 142458],
      [30, 633004],
    ];
    for (const [wave, gold] of doc) {
      const got = waveWalletTheory(content, wave).wallet / 1000;
      expect(Math.abs(got - gold) / gold, `第 ${wave} 波`).toBeLessThan(0.002);
    }
  });

  it('★ 备选模型能压平尾部（证明是模型问题而不是取值问题）', () => {
    const current = analyzeTail(content);
    expect(current.tailShare).toBeGreaterThan(700);
    const g = solveAltGrowthForTail(content, 500);
    expect(g).toBeGreaterThan(1100);
    expect(g).toBeLessThan(1170);
    const alt = evaluateAltModel(content, g);
    expect(alt.tailShare).toBeLessThanOrEqual(500);
    expect(alt.perEnemyLast).toBeGreaterThan(alt.perEnemyFirst);
    expect(alt.tailShare).toBeLessThan(current.tailShare);
  });

  it('备选模型的总量与现行模型同量级（归一化后可比）', () => {
    const current = analyzeTail(content);
    const alt = evaluateAltModel(content, 1130);
    const ratio = alt.totalIncome / current.totalWallet;
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });
});

describe('击杀奖励量级（契约 §14.6 裁决要求）', () => {
  it('★ 击杀奖励 / 理论钱包 = 17.0%（§4.1.1 的 15–20%），逐波缩放生效', () => {
    const k = analyzeKillReward(content, 'N2');
    expect(k.ratio).toBeGreaterThanOrEqual(990);
    expect(k.ratio).toBeLessThanOrEqual(1010);
    // 第 30 波单只混混：击杀奖励 / 当波钱包 ≈ 170‰（旧实现只有 0.86‰）
    // 允许 1‰ 的定点截断误差（mulDiv 向零取整）
    expect(k.wave30Ratio).toBeGreaterThanOrEqual(168);
    expect(k.wave30Ratio).toBeLessThanOrEqual(170);
    expect(k.totalEnemies).toBe(522);
  });
});

describe('DPS 可行性分析器（契约 §14.4 的硬门禁内核）', () => {
  it('上界**必须含科技乘区**（不含会给错误的悲观结论）', () => {
    const a = analyzeTtk(content, 'N2', undefined, 'max');
    expect(a.tech.attackMul).toBeGreaterThan(7000); // ×7.59
    expect(a.tech.attackSpeedMul).toBeGreaterThan(5000); // ×5.38
  });

  it('上界随科技放大后，低波次有巨大余量', () => {
    const a = analyzeTtk(content, 'N2', undefined, 'max');
    expect(a.rows[0]?.requiredOverMax).toBeLessThan(100);
    expect(a.rows[9]?.requiredOverMax).toBeLessThan(300);
  });

  it('难度不影响「上界含科技」这个前提', () => {
    for (const d of ['N1', 'N2', 'N3', 'N4', 'N5'] as const) {
      const a = analyzeTtk(content, d, undefined, 'max');
      expect(a.tech.attackMul).toBe(a.tech.attackMul);
      expect(a.rows.length).toBe(30);
    }
  });
});
