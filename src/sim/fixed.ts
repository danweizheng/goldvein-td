/**
 * 定点数 —— 接口契约 §2（全局约定）
 *
 * | 项 | 约定 |
 * |---|---|
 * | 缩放因子 | FIXED_SCALE = 1000 |
 * | 类型别名 | Fixed = number，**始终是整数**，真实值 = Fixed / 1000 |
 * | 适用范围 | 模拟层一切数值（位置、速度、伤害、窃金额、金币、木材、千分比加成） |
 * | 例外 | 纯计数用普通整数：tick / id / 波次 / 阻挡名额 / 数组下标 |
 *
 * 设计约束（AGENTS.md 铁律 3）：
 *   模拟层内任何 `/` 运算的结果都不得直接进入状态，必须先取整。
 *   本文件是**唯一**允许出现除法的地方，且所有返回值都是精确整数。
 *
 * 本实现刻意不使用 `Math.trunc(a / b)`：`Math.trunc` 依赖浮点除法的舍入，
 * 对大整数存在理论上的边界风险。`(a - a % b) / b` 是整数恒等式，结果精确。
 */

/** 定点缩放因子：1000。普通整数常量（非 Fixed）。 */
export const FIXED_SCALE = 1000;

/** 定点数：**始终是整数**，真实值 = 这个整数 / FIXED_SCALE。 */
export type Fixed = number;

/**
 * 精确整数除法，结果**向零取整**（与 C 的 `/` 一致）。
 * `a - a % b` 一定是 `b` 的整数倍，因此最后的 `/` 是精确除法，无舍入。
 */
export function truncDiv(a: number, b: number): number {
  if (b === 0) {
    throw new Error('truncDiv: 除以零（模拟层数值 bug，不做静默兜底）');
  }
  return (a - (a % b)) / b;
}

/**
 * 通用三参数乘除 `(a * b) / c`，用于避免中间结果溢出。
 * 返回值向零取整。
 */
export function mulDiv(a: number, b: number, c: number): number {
  return truncDiv(a * b, c);
}

/** 定点乘：返回 `(a * b) / FIXED_SCALE`，结果向零取整。 */
export function fmul(a: Fixed, b: Fixed): Fixed {
  return truncDiv(a * b, FIXED_SCALE);
}

/** 定点除：返回 `(a * FIXED_SCALE) / b`，结果向零取整。 */
export function fdiv(a: Fixed, b: Fixed): Fixed {
  return truncDiv(a * FIXED_SCALE, b);
}

/** 千分比应用：`(base * pct) / 1000`。`pct = 1000` 表示 ×1.0。 */
export function applyPct(base: Fixed, pct: Fixed): Fixed {
  return truncDiv(base * pct, FIXED_SCALE);
}

/** 向上取整除法（仅用于「至少 1 tick」这类计数场景，结果仍是整数）。 */
export function ceilDiv(a: number, b: number): number {
  if (b === 0) throw new Error('ceilDiv: 除以零');
  return truncDiv(a, b) + (a % b === 0 ? 0 : a < 0 === b < 0 ? 1 : -1);
}

/**
 * 定点幂：`basePct^exp`（`basePct` 是千分比定点，例如 1380 = 1.380）。
 *
 * 用于策划案 §5.1 的 `1.38^(n−1)` / `1.29^(n−1)` 成长曲线。
 * 内部用 ×1000 的额外精度域累乘（等效 ×1e6 表示法），把 29 次连续截断
 * 的累积误差从「千分之几十」压到「千分之几」；最大中间值约 1.7e13，
 * 远低于 2^53，无溢出风险。
 */
export function fpow(basePct: Fixed, exp: number, extraPrecision = 1000): Fixed {
  if (exp <= 0) return FIXED_SCALE;
  let acc = FIXED_SCALE * extraPrecision;
  for (let i = 0; i < exp; i++) {
    acc = truncDiv(acc * basePct, FIXED_SCALE);
  }
  return truncDiv(acc, extraPrecision);
}

/** 整数常量 → 定点。`fromInt(8) === 8000`。 */
export function fromInt(n: number): Fixed {
  return n * FIXED_SCALE;
}

/** 定点 → 显示用整数（**向下取整**，契约 §2：UI 层显示金币用 `Math.floor(gold/1000)`）。 */
export function toDisplayInt(v: Fixed): number {
  return Math.floor(v / FIXED_SCALE);
}

/** 定点钳制。 */
export function fclamp(v: Fixed, lo: Fixed, hi: Fixed): Fixed {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 定点取小。 */
export function fmin(a: Fixed, b: Fixed): Fixed {
  return a < b ? a : b;
}

/** 定点取大。 */
export function fmax(a: Fixed, b: Fixed): Fixed {
  return a > b ? a : b;
}

/**
 * 调试用：断言一个值确实是定点整数。
 * 只在测试/dev 校验路径调用，**不在热路径**。
 */
export function isFixedInteger(v: number): boolean {
  return Number.isInteger(v);
}
