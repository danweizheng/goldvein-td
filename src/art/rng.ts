/**
 * 占位美术的**确定性**随机源（AGENTS.md 铁律 4 / 4.7）。
 *
 * 美术模块**不复用** `src/sim/rng.ts`：那条路径属于 `engine-dev`，
 * 跨 owner 的 import 会在对方重构时静默崩掉。这里自带一份 mulberry32
 * （公开算法，10 行），保证 `src/art/**` 完全自包含。
 *
 * 约束：**不得使用 `Math.random()`**。同一 `id` 必须永远得到同一张图，
 * 因此所有"随机"都必须由 id 的哈希播种。
 */

/** FNV-1a 32 位字符串哈希。同一字符串永远得到同一结果（跨引擎一致）。 */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 2^32 */
const UINT32_RANGE = 4294967296;

/** 确定性随机源（全整数路径，无浮点）。 */
export interface ArtRng {
  /** 原始 32 位无符号输出。 */
  nextUint32(): number;
  /** `[0, bound)` 无偏整数（拒绝采样）。bound <= 1 时返回 0。 */
  nextInt(bound: number): number;
  /** `[lo, hi]` 闭区间整数。 */
  nextRange(lo: number, hi: number): number;
}

/**
 * mulberry32：状态推进 + 输出，逐位与公开实现一致。
 * `|0` 保证 32 位有符号回绕，`Math.imul` 保证 32 位乘法。
 */
function mulberry32Step(state: number): { next: number; out: number } {
  const next = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { next: next >>> 0, out: (t ^ (t >>> 14)) >>> 0 };
}

/** 由数值种子创建 RNG。 */
export function createArtRng(seed: number): ArtRng {
  let state = seed >>> 0;
  const rng: ArtRng = {
    nextUint32(): number {
      const step = mulberry32Step(state);
      state = step.next;
      return step.out;
    },
    nextInt(bound: number): number {
      if (bound <= 1) return 0;
      const limit = UINT32_RANGE - (UINT32_RANGE % bound);
      let x = rng.nextUint32();
      while (x >= limit) x = rng.nextUint32();
      return x % bound;
    },
    nextRange(lo: number, hi: number): number {
      if (hi <= lo) return lo;
      return lo + rng.nextInt(hi - lo + 1);
    },
  };
  return rng;
}

/**
 * 由实体 id 派生 RNG。
 *
 * `salt` 用于在同一 id 内部开多条互不干扰的随机流
 * （例如"身体抖动"与"眼位抖动"分别取流，改动其中一个不会挪动另一个）。
 */
export function rngForId(id: string, salt = ''): ArtRng {
  return createArtRng(fnv1a32(`${id}\u0000${salt}`));
}
