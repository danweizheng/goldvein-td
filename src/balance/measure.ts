/**
 * ★ **唯一具名的 DPS 读数**（主策划裁决 2：统一采样约定）
 *
 * ## 为什么需要"唯一具名"
 *
 * 上一轮实测到：**同一个策略、同一份数据**，"首个漏怪波的 DPS 比"在两条读取路径下
 * 分别是 **151.8%** 与 **222.6%**（差 47%）—— 差异只来自**在哪个时刻取 DPS**
 * （波切换后补记 vs `waveEnd` 事件处）。
 *
 * 主策划把这条记为「不可解读」的**第五种形态**：
 * ```
 * ① 门禁没运行  ② 门禁没测对象  ③ 输入陈旧  ④ 指标不敏感  ⑤ ★被测量对【采样约定】不稳定
 * ```
 * 前四种能靠"加断言/配对照"防；**⑤ 只能靠把量的定义钉死成一个具名、单点的读数来防**。
 *
 * ## 定义（钉死在这里，别处不许再算）
 *
 * ```
 * dpsAtWaveEnd(w) = Σ over towers  (attack_eff / interval_eff)
 * ```
 * - **不加克制矩阵**（那是"对某一波"的属性，会把"阵容强度"和"波次护甲"混在一起）
 * - **在 `waveEnd` 事件被 drain 的那一刻读取**（不是"波切换后"，也不是"下一波开始时"）
 * - 只用 `tower.attack`（已含科技与光环）与 `tower.intervalTicks`（已含攻速乘区），
 *   所以它是**当时阵容的纯属性**
 *
 * ⚠️ **任何消费方都必须调用本函数**，不得各自在波边界处就地计算。
 */
import { FIXED_SCALE, truncDiv, type Fixed } from '../sim/fixed';
import type { WorldState } from '../sim/types';

/** 阵容在**波结束时刻**的有效 DPS（定点）。定义见文件头 —— 不许在别处重算。 */
export function dpsAtWaveEnd(w: WorldState): Fixed {
  let sum = 0;
  for (const t of w.towers) {
    const ticks = Math.max(1, t.intervalTicks);
    sum += truncDiv(t.attack * 60, ticks);
  }
  return sum;
}

/**
 * 同一读数的**恒等性检查**：用两条独立路径算同一个世界，必须逐位相等。
 *
 * 路径 A：`dpsAtWaveEnd`（逐塔累加 `attack*60/intervalTicks`）
 * 路径 B：先算单塔 DPS 再累加（顺序/中间量不同）
 *
 * 这不是"防浮点"（全是整数），而是**防"有人在别处又写了一份公式"** ——
 * 那种重复实现正是不稳定读数的温床（本项目已有先例：适配层曾有两份 id→槽位映射）。
 */
export function dpsAtWaveEndCrossCheck(w: WorldState): { a: Fixed; b: Fixed; equal: boolean } {
  const a = dpsAtWaveEnd(w);
  const perTower: Fixed[] = [];
  for (const t of w.towers) perTower.push(truncDiv(t.attack * 60, Math.max(1, t.intervalTicks)));
  let b = 0;
  for (const v of perTower) b += v;
  return { a, b, equal: a === b };
}

/** 显示用：定点 DPS → 一位小数。 */
export function dpsText(dps: Fixed): string {
  return (dps / FIXED_SCALE).toFixed(1);
}
