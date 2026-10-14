/**
 * ★★ **验收阈值的唯一来源**（`constants.json` 的 `acceptanceTargets`）
 *
 * ## 为什么要有这个文件
 *
 * 本轮的「键登记门禁」**第一次运行就抓到**：`data-arch` 已把验收阈值集中到
 * `constants.json` 的 `acceptanceTargets`（并删掉了塔数目标、新增了 4 个 solvability 相关键），
 * 而**我的代码里还留着 5 份私有副本**：
 *
 * | 我代码里的副本 | 数据里的权威值 |
 * |---|---|
 * | `metrics.ts` 的 `COMFORT_BAND = {min:200, max:600, waves:[10,20]}` | `solvabilityComfortMin/Max/Waves` |
 * | `solvability.spec.ts` 的 `<= 800` 余量断言 | 没有对应键（**我自造的数**） |
 * | `gap.ts` 的 `COVERAGE_TARGET = 725` | `stealCoverageMin/Max`（650/800，中值 725） |
 * | `economy-bound.ts` 的 `ASSUMED_STEAL_COVERAGE = 725` | 同上 |
 *
 * **这与适配层那四次事故是同一类**：同一个事实有两个来源，迟早会有一个是错的，
 * 而错的通常不会被发现（适配层曾有两份 id→槽位映射，就是 `target` 漏映射的根源）。
 *
 * ⇒ 本文件是这些阈值的**唯一读取口**。任何消费方都从这里拿，不许再写字面量。
 */
import constantsJson from '../data/constants.json';

interface AcceptanceTargets {
  stealCoverageMin: number;
  stealCoverageMax: number;
  spendRatioMin: number;
  spendRatioMax: number;
  leakRateMax: number;
  waveEndGoldMin: number;
  waveEndGoldMax: number;
  solvabilityMax: number;
  solvabilityComfortMin: number;
  solvabilityComfortMax: number;
  solvabilityComfortWaves: number[];
  techLevelsAtWave20Min: number;
  techLevelsAtWave20Max: number;
  blockExtraStealMin: number;
}

const T = (constantsJson as unknown as { acceptanceTargets: AcceptanceTargets }).acceptanceTargets;

/** ★ `需求DPS/可达上界 ≤ 该值`（千分比，1000 = 1.0×）—— 契约 §14.4 硬门禁的阈值。 */
export const SOLVABILITY_MAX_PERMILLE: number = T.solvabilityMax;

/** ★ 舒适带（千分比区间）+ 采样波次 —— 由 `constants.json` 权威定义。 */
export const COMFORT_BAND = {
  min: T.solvabilityComfortMin,
  max: T.solvabilityComfortMax,
  waves: [...T.solvabilityComfortWaves],
} as const;

/** 窃金覆盖率的目标区间（千分比）。 */
export const STEAL_COVERAGE_RANGE = { min: T.stealCoverageMin, max: T.stealCoverageMax } as const;

/** 覆盖率目标**中值**（缺口驱动用的"目标"）—— 从区间推出，不再硬编码 725。 */
export const COVERAGE_TARGET_PERMILLE: number = Math.trunc((T.stealCoverageMin + T.stealCoverageMax) / 2);

/** 支出/收入、漏怪率等其余验收目标（报告层核对用）。 */
export const OTHER_TARGETS = {
  spendRatioMin: T.spendRatioMin,
  spendRatioMax: T.spendRatioMax,
  leakRateMax: T.leakRateMax,
  waveEndGoldMin: T.waveEndGoldMin,
  waveEndGoldMax: T.waveEndGoldMax,
  techLevelsAtWave20Min: T.techLevelsAtWave20Min,
  techLevelsAtWave20Max: T.techLevelsAtWave20Max,
  blockExtraStealMin: T.blockExtraStealMin,
} as const;