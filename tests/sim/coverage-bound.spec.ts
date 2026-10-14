/**
 * ★ **定义性硬断言：窃金覆盖率不得超过 100%**（主策划裁决 4）
 *
 * ## 为什么这是一条门禁而不是一句废话
 *
 * 我上一轮实测出 `noop@N2 = 1042‰`、`balanced@N4 = 1455‰` 这种**在定义上不可能**的值
 * （窃金 ≤ 钱包），根因是**分子含当前进行中的那一波、分母不含** —— 一个口径错配静默通过了。
 *
 * 主策划的裁决原话：**「一个不能被违反的定义性边界，是最便宜的负对照。」**
 * 任何"分子含进行中、分母不含"这类错配都会立刻撞上它。
 *
 * ## 覆盖
 *
 * 用**会触发那条边界**的策略与难度组合（不是抽样全矩阵）：
 * - `noop`：会早死 + 高窃金 → 旧口径下必然越界（N2 历史值 1042‰）
 * - `balanced`：会早死（N4 历史值 1455‰）
 * - `gap`：本轮新增的缺口驱动策略（也要守住）
 * 难度取 N1/N2/N4/N5（含"钱多怪弱"的早死难度 —— 那正是虚高的温床）。
 *
 * ## 负对照（证明这条断言不是恒真）
 *
 * 构造一个**已知越界**的假结果（`stolenTotal > walletTotal`），断言判定函数**报红**。
 * 若负对照也通过，说明断言是空的。
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../../src/balance/data-adapter';
import { runOne } from '../../src/balance/run';
import { permille } from '../../src/balance/metrics';
import type { DifficultyId } from '../../src/sim/content';
import type { StrategyId } from '../../src/balance/strategies/types';

const content = loadRealContent();

/** 覆盖率判定（千分比）；> 1000 即越界。 */
export function coveragePermille(stolen: number, wallet: number): number {
  return permille(stolen, wallet);
}

describe('★ 定义性硬断言：覆盖率 ≤ 1000‰（窃金 ≤ 钱包）', () => {
  const combos: readonly [StrategyId, DifficultyId][] = [
    ['noop', 'N2'],
    ['noop', 'N1'],
    ['balanced', 'N4'],
    ['balanced', 'N5'],
    ['balanced', 'N2'],
    ['gap', 'N2'],
  ];

  for (const [strategyId, difficultyId] of combos) {
    it(`${strategyId} @ ${difficultyId}：stolenTotal ≤ walletTotal`, () => {
      const r = runOne({ content, difficultyId, strategyId, seed: 20261013, maxTicks: 240_000 });
      const cov = coveragePermille(r.stolenTotal, r.walletTotal);
      console.log(
        `[覆盖率边界] ${strategyId}@${difficultyId}: stolen=${(r.stolenTotal / 1000).toFixed(0)} ≤ wallet=${(r.walletTotal / 1000).toFixed(0)} → ${(cov / 10).toFixed(1)}%`,
      );
      // ★ 定义性边界：分子不可能超过分母
      expect(r.stolenTotal, `${strategyId}@${difficultyId} 窃金超过了钱包总量（口径错配）`).toBeLessThanOrEqual(r.walletTotal);
      expect(cov).toBeLessThanOrEqual(1000);
    });
  }

  it('★ 负对照：已知越界的假结果必须报红（证明断言不是恒真）', () => {
    // 构造两个"假结果"：一个正常、一个越界
    const ok = { stolenTotal: 740_000, walletTotal: 1_000_000 };
    const bad = { stolenTotal: 1_450_000, walletTotal: 1_000_000 }; // 复刻历史上那个 1455‰
    expect(coveragePermille(ok.stolenTotal, ok.walletTotal)).toBeLessThanOrEqual(1000);
    expect(coveragePermille(bad.stolenTotal, bad.walletTotal), '负对照：越界值竟然没报红 → 断言是空的').toBeGreaterThan(1000);
    // 逐条断言也与判定一致
    expect(bad.stolenTotal).toBeGreaterThan(bad.walletTotal);
  });
});
