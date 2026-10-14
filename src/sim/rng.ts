/**
 * 可播种 RNG —— AGENTS.md 铁律 4 / 接口契约 §4
 *
 * 算法：mulberry32（32 位状态，纯整数运算）。
 *
 * **模拟层只使用 `nextUint32` / `nextInt` / `roll`（全整数路径）**，
 * 概率判定一律走千分比整数比较，不引入浮点。
 * `mulberry32()` 浮点出口是为了对齐契约里的名字与外部调试用途，
 * 模拟层任何状态字段都不会写入它的输出。
 *
 * 状态（`state`）必须进入 WorldState 并参与 hashWorld —— 否则 RNG 位置漂移
 * 就无法被 1x/2x/4x 一致性测试发现。
 */
import type { Fixed } from './fixed';

/** 2^32 */
const UINT32_RANGE = 4294967296;

export interface Rng {
  /** 可变状态（uint32）。进入 WorldState，参与 hashWorld。 */
  state: number;
  /** 原始 32 位无符号输出。纯整数运算，跨引擎完全一致。 */
  nextUint32(): number;
  /** `[0, bound)` 无偏整数（拒绝采样）。bound <= 0 时返回 0。 */
  nextInt(bound: number): number;
  /** `[0, 1000)` 千分比掷骰。 */
  roll(): Fixed;
  /** 当前状态的只读快照（用于克隆 / 序列化）。 */
  getState(): number;
  /** 恢复状态（用于读档 / 回放 / 测试克隆）。 */
  setState(state: number): void;
}

/**
 * mulberry32 的单步核心：状态推进 + 输出。
 * 与公开实现逐位一致（`|0` 保证 32 位有符号回绕，`Math.imul` 保证 32 位乘法）。
 */
function mulberry32Step(state: number): { next: number; out: number } {
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { next: next >>> 0, out: (t ^ (t >>> 14)) >>> 0 };
}

/** 创建可播种 RNG（模拟层唯一入口）。 */
export function createRng(seed: number): Rng {
  const rng: Rng = {
    state: seed >>> 0,
    nextUint32(): number {
      const { next, out } = mulberry32Step(rng.state);
      rng.state = next;
      return out;
    },
    nextInt(bound: number): number {
      if (bound <= 1) return 0;
      // 拒绝采样去掉 % bound 的偏置，保证均匀。
      // 被拒绝的概率 < bound / 2^32，对 bound <= 1e6 几乎不可能触发，
      // 但必须保留 —— 否则不同 bound 的分布不可比。
      const limit = UINT32_RANGE - (UINT32_RANGE % bound);
      let x = rng.nextUint32();
      while (x >= limit) {
        x = rng.nextUint32();
      }
      return x % bound;
    },
    roll(): Fixed {
      return rng.nextInt(1000);
    },
    getState(): number {
      return rng.state;
    },
    setState(state: number): void {
      rng.state = state >>> 0;
    },
  };
  return rng;
}

/**
 * 契约里点名的 `mulberry32(seed)`：返回 `[0, 1)` 的**浮点**生成器。
 *
 * ⚠️ 仅供调试 / 非模拟层 / 与外部实现对照使用。
 * 模拟层请用 `createRng()` —— 它的输出是整数，不会触碰浮点路径。
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    const step = mulberry32Step(state);
    state = step.next;
    return step.out / UINT32_RANGE;
  };
}

/**
 * 千分比概率判定。`pct` 为定点千分比：1000 = 100%。
 * `< 1000` 时按整数比较判定；`>= 1000` 恒真（但仍**不**消耗随机数，
 * 保证「免疫 / 必定暴击」不会推进 RNG 状态，从而不影响其它系统的随机序列）。
 */
export function chance(rng: Rng, pct: Fixed): boolean {
  if (pct >= 1000) return true;
  if (pct <= 0) return false;
  return rng.roll() < pct;
}

/** 克隆 RNG（用于测试/回放时构造等价世界，不污染原状态）。 */
export function cloneRng(rng: Rng): Rng {
  const copy = createRng(0);
  copy.setState(rng.getState());
  return copy;
}
