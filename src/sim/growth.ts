/**
 * 策划案 §5.1 核心成长公式（定点实现）
 *
 * 这些函数**只应是数据播种/校验的参考实现**（`data-arch` 用它校验
 * `waves.json` 的量级，`balance-eng` 用它做对账），运行时波次内容仍由
 * `src/data/waves.json` 驱动（铁律 5：数据驱动）。
 *
 * 附带的价值：它们让「策划案 §5.2 关键波次数值表」变成可执行的断言
 * （见 src/sim/__tests__/growth.spec.ts）。
 */
import { FIXED_SCALE, fmul, fpow, toDisplayInt, truncDiv, type Fixed } from './fixed';
import type { SimConstants } from './content';

/** `HP(n) = baseHp × hpIndex^(n−1)`，定点。n 从 1 开始。 */
export function theoreticalHp(c: SimConstants, n: number): Fixed {
  return fmul(c.baseHp, fpow(c.hpIndex, n - 1));
}

/** `W(n) = baseWallet × walletIndex^(n−1)`，定点。 */
export function theoreticalWallet(c: SimConstants, n: number): Fixed {
  return fmul(c.baseWallet, fpow(c.walletIndex, n - 1));
}

/** `Q(n) = enemyCountBase + floor(enemyCountSlope × n)`，普通整数。 */
export function theoreticalCount(c: SimConstants, n: number): number {
  return toDisplayInt(c.enemyCountBase) + truncDiv(c.enemyCountSlope * n, FIXED_SCALE);
}

/** `G(n) = Q(n) × W(n)`，定点。 */
export function theoreticalWaveWallet(c: SimConstants, n: number): Fixed {
  return theoreticalWallet(c, n) * theoreticalCount(c, n);
}

/** 给定累计窃金额与难度系数，算暗金结晶（策划案 §3.4）。 */
export function crystalsFrom(stolenTotal: Fixed, difficultyCrystalMul: Fixed): number {
  const base = truncDiv(stolenTotal, FIXED_SCALE); // 累计窃金 / 1000
  return truncDiv(base * difficultyCrystalMul, FIXED_SCALE);
}

/** 千分比展示（供报告用）：`750` → `"75.0%"`。 */
export function pctText(pct: Fixed): string {
  const whole = truncDiv(pct, 10);
  const frac = pct - whole * 10;
  return `${whole}.${Math.abs(frac)}%`;
}

export { FIXED_SCALE };
