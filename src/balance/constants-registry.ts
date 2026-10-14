/**
 * ★★ **`constants.json` 键 → 消费方 / 有意不消费** 的显式清单（主策划裁决，欠两轮）
 *
 * ## 为什么需要这张表
 *
 * 适配层的变异覆盖门禁（`tests/sim/mapping-coverage.spec.ts`）只能检查**我为它写了变异条目的键**。
 * 我上一轮自己把这条边界说清楚了：
 *
 * > `constants.json` 里"有意不消费"的键只写在测试的字段表里，**没有显式清单**。
 * > 若将来有人往表里加一个本该进模拟层的键，**本门禁不会提醒他**（没人给它写变异条目）。
 *
 * **而适配层已经四次成为瓶颈**（漏整张 `tech` 表 → 漏 `target` → `map.json` 未迁 → 按下标取难度）。
 * 这张表就是防第四次的第六个位置：**新增键未登记 → 报红**。
 *
 * ## 三种处置（没有第四种）
 *
 * | 处置 | 含义 | 由谁验证 |
 * |---|---|---|
 * | `consumed:constants` | 映射进 `SimConstants` | 通用变异探针（本文件 + 门禁） |
 * | `consumed:unit` | 被 `toUnit` 消费（不在 `SimConstants` 里） | 定点断言（见门禁） |
 * | `consistency-only` | 不进 `SimContent`，仅用于**一致性告警** | 断言"变异它 → 目标字段不变" |
 * | `unconsumed:<归属>` | **有意不消费**，归属方写在 reason 里 | 不测（登记即合法） |
 *
 * ⚠️ 规则：**任何新键必须先在这里登记**。未登记 → `unregisteredKeys()` 非空 → 门禁报红。
 */
import type { BalanceConstants } from '../data/types.generated';

/** 处置类型。`unconsumed:` 后面跟归属方（UI / 存档 / 局外 / 策划目标 / M6…）。 */
export type KeyDisposition =
  | 'consumed:constants'
  | 'consumed:unit'
  /** 被**平衡层**消费（不进 SimContent；如验收阈值，由 src/balance/acceptance.ts 读） */
  | 'consumed:balance'
  | 'consistency-only'
  | `unconsumed:${string}`;

export interface KeyEntry {
  disposition: KeyDisposition;
  reason: string;
}

/**
 * 键 → 处置。**点号路径**，数组整体作为一项（如 `levelMul`、`counterMatrixStandard`）。
 * 顺序按 `constants.json` 的书写顺序排列，便于逐行核对。
 */
export const CONSTANTS_KEY_REGISTRY: Readonly<Record<string, KeyEntry>> = {
  tickRate: { disposition: 'consumed:constants', reason: 'SimConstants.tickRate' },
  fixedScale: {
    disposition: 'unconsumed:契约常量',
    reason: '契约 §2 的 FIXED_SCALE 是编译期常量（src/sim/fixed.ts），不从数据读；此键仅作数据自述',
  },
  waveTotal: { disposition: 'consumed:constants', reason: 'SimConstants.totalWaves' },
  wavePrepTimeDefault: {
    disposition: 'unconsumed:引擎兜底',
    reason: '仅当 waves.json 缺 prepTime 时用；本适配层始终取 waves.json 的值 → 实际未被消费',
  },
  waveSettleTime: { disposition: 'unconsumed:未实现', reason: '结算阶段时长；sim 的 waveSystem 没有结算阶段' },
  undoWindow: { disposition: 'unconsumed:engine-dev', reason: '撤销窗口写死在 tick.ts 的 UNDO_WINDOW_TICKS' },
  undoRefundPct: { disposition: 'unconsumed:engine-dev', reason: '撤销返还比例由 cmdUndo 内部处理，未走 SimConstants' },

  baseHp: { disposition: 'consumed:constants', reason: 'SimConstants.baseHp' },
  hpIndex: { disposition: 'consumed:constants', reason: 'SimConstants.hpIndex' },
  baseWallet: { disposition: 'consumed:constants', reason: 'SimConstants.baseWallet' },
  walletIndex: { disposition: 'consumed:constants', reason: 'SimConstants.walletIndex' },
  enemyCountBase: { disposition: 'consumed:constants', reason: 'SimConstants.enemyCountBase' },
  enemyCountSlope: { disposition: 'consumed:constants', reason: 'SimConstants.enemyCountSlope' },

  levelMul: { disposition: 'consumed:constants', reason: 'SimConstants.levelMul（窃金等级系数）' },
  stealAtkCoef: { disposition: 'consumed:constants', reason: 'SimConstants.stealAtkCoef' },
  critRateBase: { disposition: 'consumed:constants', reason: 'SimConstants.critRateBase' },
  critRateCap: { disposition: 'consumed:constants', reason: 'SimConstants.critRateCap' },
  critMulBase: { disposition: 'consumed:constants', reason: 'SimConstants.critMulBase' },
  critMulPerLevel: { disposition: 'consumed:constants', reason: 'SimConstants.critMulPerLevel' },
  critMulCap: { disposition: 'consumed:constants', reason: 'SimConstants.critMulCap' },
  stealResistDefault: {
    disposition: 'unconsumed:引擎默认',
    reason: '缺省窃金抗性 0；enemies.json 每只敌人都显式写了 stealResist → 该缺省值未被消费',
  },
  stealImmunityThreshold: {
    disposition: 'unconsumed:engine-dev',
    reason: '免疫阈值写在 stealPerHit 的抗性比较里（>=1000），未走 SimConstants',
  },
  stealWoodRatio: { disposition: 'consumed:unit', reason: '→ 每个窃金单位的 UnitDef.stealWoodRatio（不在 SimConstants 里）' },
  counterMatrixStandard: { disposition: 'consumed:constants', reason: 'SimConstants.counterMatrixStandard（5×5）' },
  compressedFactor: { disposition: 'consumed:constants', reason: 'SimConstants.compressedFactor' },
  compressedFloor: { disposition: 'consumed:constants', reason: 'SimConstants.compressedFloor' },
  haltPointStopDuration: { disposition: 'consumed:constants', reason: 'SimConstants.haltPointStopDuration' },

  crystalDivisor: {
    disposition: 'unconsumed:局外结算',
    reason: '暗金结晶除数（§4.7.1）；结晶是局外结算，不进模拟层',
  },
  'difficultyCrystalMul.N1': { disposition: 'unconsumed:与difficulty.json重复', reason: '结晶难度系数；difficulty.json 的 crystalMul 才是适配层读的那份' },
  'difficultyCrystalMul.N2': { disposition: 'unconsumed:与difficulty.json重复', reason: '同上' },
  'difficultyCrystalMul.N3': { disposition: 'unconsumed:与difficulty.json重复', reason: '同上' },
  'difficultyCrystalMul.N4': { disposition: 'unconsumed:与difficulty.json重复', reason: '同上' },
  'difficultyCrystalMul.N5': { disposition: 'unconsumed:与difficulty.json重复', reason: '同上' },
  ascensionMinWave: { disposition: 'unconsumed:局外/被动蜕变', reason: '蜕变门槛（第 20 波）；AI 的 ascend 未使用' },
  'achievementMuls.no_leak': { disposition: 'unconsumed:局外结算', reason: '成就系数，局外结晶结算用' },
  'achievementMuls.no_ascension': { disposition: 'unconsumed:局外结算', reason: '同上' },
  'achievementMuls.speedrun': { disposition: 'unconsumed:局外结算', reason: '同上' },
  'achievementMuls.single_line': { disposition: 'unconsumed:局外结算', reason: '同上' },
  'achievementMuls.no_mage': { disposition: 'unconsumed:局外结算', reason: '同上' },
  'achievementMuls.big_spender': { disposition: 'unconsumed:局外结算', reason: '同上' },
  'achievementMuls.block_master': { disposition: 'unconsumed:局外结算', reason: '同上（卡位大师：军训系额外窃取 ≥10 万）' },
  'achievementMuls.advanced_challenges': { disposition: 'unconsumed:局外结算', reason: '同上' },
  firstClearCrystalMul: { disposition: 'unconsumed:局外结算', reason: '首通加成，局外' },

  salaryCooldown: { disposition: 'consumed:constants', reason: 'SimConstants.salaryCooldown' },
  salaryMultiplier: { disposition: 'consumed:constants', reason: 'SimConstants.salaryMultiplier' },
  brambleCooldown: { disposition: 'consumed:constants', reason: 'SimConstants.brambleCooldown' },
  brambleDuration: { disposition: 'consumed:constants', reason: 'SimConstants.brambleDuration' },

  techArchiveFreeLevelDivisor: { disposition: 'consumed:constants', reason: 'SimConstants.techArchiveFreeLevelDivisor' },
  techArchiveCostReductionPct: { disposition: 'consumed:constants', reason: 'SimConstants.techArchiveCostReductionPct' },

  'map.laneCount': {
    disposition: 'unconsumed:与difficulty.json重复',
    reason: '路数由 difficulty.json 的 openLanes 决定（并按难度不同）；laneCount=4 是数据自述',
  },
  'map.pathLengthCells': { disposition: 'unconsumed:自述值', reason: '路径长度由 map.json 的 waypoints 实际算出，此键不参与计算' },
  'map.buildableWidthCells': {
    disposition: 'consistency-only',
    reason: '可建造区深度以 map.json 的 buildDepth 为准（sim 直接用它）；本键仅用于不一致时告警',
  },
  'map.vaultSizeCells': { disposition: 'unconsumed:自述值', reason: '宝库尺寸由 map.json 的 vault 决定' },
  'map.haltPointsPerLane': { disposition: 'unconsumed:自述值', reason: '★停顿点位置由 map.json 的 paths[].haltIndex 决定' },

  'hero.maxCount': { disposition: 'unconsumed:M6', reason: '英雄系压到 M6（决策 D5），本期不进模拟层' },
  'hero.costs': { disposition: 'unconsumed:M6', reason: '同上' },
  'hero.equipSlots': { disposition: 'unconsumed:M6', reason: '装备系统 M6' },
  'hero.morphLevels': { disposition: 'unconsumed:M6', reason: '同上' },
  'hero.expFromSteal': { disposition: 'unconsumed:M6', reason: '同上' },

  'economyTargets.stealShareMin': { disposition: 'unconsumed:策划目标', reason: '§4.1.1 的收入占比目标；由报告层人工核对，不是模拟输入' },
  'economyTargets.stealShareMax': { disposition: 'unconsumed:策划目标', reason: '同上' },
  'economyTargets.killShareMin': { disposition: 'unconsumed:策划目标', reason: '同上' },
  'economyTargets.killShareMax': { disposition: 'unconsumed:策划目标', reason: '同上' },
  'economyTargets.spendRatios.tower': { disposition: 'unconsumed:策划目标', reason: '§14.12 支出侧目标；报告层核对' },
  'economyTargets.spendRatios.tech': { disposition: 'unconsumed:策划目标', reason: '同上' },
  'economyTargets.spendRatios.sprite': { disposition: 'unconsumed:策划目标', reason: '同上' },
  'economyTargets.spendRatios.equipment': { disposition: 'unconsumed:策划目标', reason: '同上' },

  'acceptanceTargets.stealCoverageMin': { disposition: 'consumed:balance', reason: '§5.4 覆盖率区间下界 → acceptance.ts 的 STEAL_COVERAGE_RANGE.min（缺口驱动的目标由它推中值）' },
  'acceptanceTargets.stealCoverageMax': { disposition: 'consumed:balance', reason: '同上（上界）' },
  'acceptanceTargets.spendRatioMin': { disposition: 'unconsumed:验收目标', reason: '同上' },
  'acceptanceTargets.spendRatioMax': { disposition: 'unconsumed:验收目标', reason: '同上' },
  'acceptanceTargets.leakRateMax': { disposition: 'unconsumed:验收目标', reason: '同上' },
  'acceptanceTargets.waveEndGoldMin': { disposition: 'unconsumed:验收目标', reason: '同上' },
  'acceptanceTargets.waveEndGoldMax': { disposition: 'unconsumed:验收目标', reason: '同上' },
  'acceptanceTargets.solvabilityMax': { disposition: 'consumed:balance', reason: '契约 §14.4 硬门禁阈值 → src/balance/acceptance.ts 的 SOLVABILITY_MAX_PERMILLE' },
  'acceptanceTargets.solvabilityComfortMin': { disposition: 'consumed:balance', reason: '舒适带下界 → acceptance.ts 的 COMFORT_BAND.min' },
  'acceptanceTargets.solvabilityComfortMax': { disposition: 'consumed:balance', reason: '舒适带上界 → acceptance.ts 的 COMFORT_BAND.max' },
  'acceptanceTargets.solvabilityComfortWaves': { disposition: 'consumed:balance', reason: '舒适带采样波次 → acceptance.ts 的 COMFORT_BAND.waves' },
  'acceptanceTargets.techLevelsAtWave20Min': { disposition: 'unconsumed:验收目标', reason: '第 20 波科技级数区间；报告层核对' },
  'acceptanceTargets.techLevelsAtWave20Max': { disposition: 'unconsumed:验收目标', reason: '同上' },
  'acceptanceTargets.blockExtraStealMin': { disposition: 'unconsumed:验收目标', reason: 'Q1 的 25% 目标；已按 §14.8 降级为诊断' },
};

/** 把嵌套对象摊平成点号路径（数组整体作为一项，不下钻）。 */
export function flattenKeys(obj: unknown, prefix = ''): string[] {
  const out: string[] = [];
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...flattenKeys(v, path));
    else out.push(path);
  }
  return out;
}

/**
 * 列出**未登记**的键。
 *
 * 这是本模块的核心价值所在：**新增键未登记即报红**。
 * 纯函数，因此可以用合成输入做负对照（见门禁）。
 */
export function unregisteredKeys(
  raw: unknown,
  registry: Readonly<Record<string, KeyEntry>> = CONSTANTS_KEY_REGISTRY,
): string[] {
  return flattenKeys(raw).filter((k) => registry[k] === undefined);
}

/** 列出**已登记但数据里不存在**的键（防登记表陈旧）。 */
export function staleRegistryKeys(
  raw: unknown,
  registry: Readonly<Record<string, KeyEntry>> = CONSTANTS_KEY_REGISTRY,
): string[] {
  const actual = new Set(flattenKeys(raw));
  return Object.keys(registry).filter((k) => !actual.has(k));
}

/** 按处置分类统计（报告用）。 */
export function registrySummary(registry: Readonly<Record<string, KeyEntry>> = CONSTANTS_KEY_REGISTRY): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of Object.values(registry)) {
    const key = e.disposition.startsWith('unconsumed:') ? 'unconsumed' : e.disposition;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export type { BalanceConstants };