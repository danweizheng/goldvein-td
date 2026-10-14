/**
 * ★ **实验后门不得影响生产路径**（主策划裁决 2）
 *
 * ## 为什么必须有这条断言
 *
 * 为了让"扫描一个从未标定的参数"不必把参数穿透 20 个调用点，我在 `value.ts` 里放了两个
 * **模块级可变状态**：
 *
 * ```ts
 * let dpsGoldEq = DEFAULT_DPS_GOLD_EQ;      export function setDpsGoldEqForExperiment(v)
 * let safetyWeight = DEFAULT_SAFETY_WEIGHT; export function setSafetyWeightForExperiment(v)
 * ```
 *
 * 接受它们的理由（独立进程 / 不穿透调用点 / 有日志）成立，**但它是一条"能被改的默认值"** ——
 * 这正是本项目已经踩过五次的「同一事实两个来源」的另一种形态。
 *
 * ⇒ 所以钉一条断言：**生产路径的结果，必须与"从未调用过 setter"的结果逐位相同。**
 * 否则这个后门会静默地改变跑批结论。
 *
 * ## 断言的三层
 *
 * 1. **初值**：两个 getter 在测试开始时必须等于各自的 `DEFAULT_*`（没有残留状态）
 * 2. **幂等**：把 setter 设成**默认值**后跑一局 → 与不设时**逐位相同**（哈希/波次/窃金塔数）
 * 3. **后门确实有牙**：设成**非默认值**后跑一局 → **必须不同**（否则第 2 条是空话）
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../../src/balance/data-adapter';
import { runOne } from '../../src/balance/run';
import {
  DEFAULT_DPS_GOLD_EQ,
  DEFAULT_SAFETY_WEIGHT,
  cloneSafeDefaults,
  currentDpsGoldEq,
  currentSafetyWeight,
  restoreDefaults,
  setDpsGoldEqForExperiment,
  setSafetyWeightForExperiment,
} from '../../src/balance/strategies/value';

const content = loadRealContent();

function runGap(): { wave: number; hash: string; thieves: number; coverage: number } {
  const r = runOne({ content, difficultyId: 'N2', strategyId: 'gap', seed: 20261013, maxTicks: 240_000 });
  return {
    wave: r.waveReached,
    hash: r.hash,
    thieves: r.thiefCount,
    coverage: Math.trunc((r.stolenTotal * 1000) / Math.max(1, r.walletTotal)),
  };
}

describe('★ 实验后门不得影响生产路径', () => {
  it('① 初值：两个实验参数在测试开始时必须是默认值（无残留）', () => {
    console.log(`[后门] 初值 dpsGoldEq=${currentDpsGoldEq()}（默认 ${DEFAULT_DPS_GOLD_EQ}）安全权重=${currentSafetyWeight()}（默认 ${DEFAULT_SAFETY_WEIGHT}）`);
    expect(currentDpsGoldEq()).toBe(DEFAULT_DPS_GOLD_EQ);
    expect(currentSafetyWeight()).toBe(DEFAULT_SAFETY_WEIGHT);
  });

  it('② 幂等：setter 设成默认值 == 从未调用过（逐位相同）', () => {
    const before = runGap();
    const saved = cloneSafeDefaults();
    try {
      setDpsGoldEqForExperiment(DEFAULT_DPS_GOLD_EQ);
      setSafetyWeightForExperiment(DEFAULT_SAFETY_WEIGHT);
      const after = runGap();
      console.log(`[后门] 未设 ${JSON.stringify(before)} ｜ 设为默认值后 ${JSON.stringify(after)}`);
      expect(after).toEqual(before);
    } finally {
      restoreDefaults(saved);
    }
    expect(currentDpsGoldEq()).toBe(DEFAULT_DPS_GOLD_EQ);
    expect(currentSafetyWeight()).toBe(DEFAULT_SAFETY_WEIGHT);
  });

  it('★ ③ 负对照：设成非默认值后**必须不同**（否则第 ② 条是空话）', () => {
    const before = runGap();
    const saved = cloneSafeDefaults();
    try {
      setDpsGoldEqForExperiment(50); // 明显偏离默认
      const after = runGap();
      console.log(`[后门·负对照] dpsGoldEq 400 → 50：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
      expect(after, '实验参数失效了 → 第 ② 条"幂等"将毫无意义').not.toEqual(before);
    } finally {
      restoreDefaults(saved);
    }
  });

  it('★ ④ 负对照（安全权重）：设成 1 后**必须不同**', () => {
    const before = runGap();
    const saved = cloneSafeDefaults();
    try {
      setSafetyWeightForExperiment(1);
      const after = runGap();
      console.log(`[后门·负对照] 安全权重 6 → 1：覆盖率 ${(before.coverage / 10).toFixed(1)}% → ${(after.coverage / 10).toFixed(1)}%`);
      expect(after).not.toEqual(before);
    } finally {
      restoreDefaults(saved);
    }
  });
});