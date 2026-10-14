/**
 * ★ **经济感知上界**（契约 §16.3 裁决：两个上界、两个用途，**不得混用**）
 *
 * | 上界 | 用途 | 特征 |
 * |---|---|---|
 * | 「最大军队上界」（`maxDps`，见 `ttk-analysis.ts`） | **硬界** `需求/上界 ≤ 1.0` —— 存在性证明 | 故意宽松（满级科技 + 满塔位 + 全覆盖），所以第 10 波只有 0.00× 是**正常**的 |
 * | **「经济感知上界」（本文件）** | **舒适带** `∈ [0.2, 0.6]` —— 到该波"合理经济"能支撑的阵容 | 用**到该波的累计到手收入**当预算，买得起的最强阵容 |
 *
 * ## 为什么必须有两个
 *
 * 上一轮把舒适带套在"最大军队上界"上，10 个采样点全部 0.00–0.02× —— 那不是数据有问题，
 * 是**尺子用错了**：拿"无限资源"的上界去量"玩家在第 10 波该有多少压力"，必然永远"太轻松"。
 * 主策划否决了"把区间挪到读数好看的地方"（那是改验收区间），改为**新增这把正确的尺子**。
 *
 * ## 预算怎么算（全整数，N2 基准）
 *
 * ```
 * 到手收入(n) = 起始金币 + 累计理论钱包(1..n) × 窃金覆盖率 + 累计击杀奖励 + 累计波次奖励
 * 窃金覆盖率取 §5.4 的目标中值 725‰（不是实测值 —— 这是"合理经济"而不是"任何 AI 的经济"）
 * 经济感知上界(n) = 用这笔预算能买到的最大 DPS（每金币 DPS 最高的塔，含该波护甲克制）
 * ```
 *
 * 已知的宽松处（都让上界偏高 → 舒适带判定偏"太轻松"，方向是保守的）：
 * ① 假设预算**全部**变成 DPS（现实中要分摊到经济/辅助/科技）
 * ② 假设能立刻买到最高档的塔（忽略建造节奏与升级链时间）
 * ③ 不扣科技支出
 */
import { FIXED_SCALE, fmul, fpow, mulDiv, truncDiv, type Fixed } from '../sim/fixed';
import { COVERAGE_TARGET_PERMILLE } from './acceptance';
import { armorIndex, attackIndex, type ArmorType, type DifficultyId, type SimContent, type UnitDef } from '../sim/content';

/** 窃金覆盖率假设（§5.4 目标 [650, 800] 的中值）。 */
// ★ 覆盖率假设来自 constants.json 的 stealCoverageMin/Max 中值（曾经硬编码 725）。
// ★ 覆盖率假设来自 constants.json 的 stealCoverageMin/Max 中值（曾经硬编码 725）。
export const ASSUMED_STEAL_COVERAGE: number = COVERAGE_TARGET_PERMILLE;

export interface EconomyBoundRow {
  wave: number;
  /** 到本波为止的累计到手收入（定点） */
  income: Fixed;
  /** 本波敌人总血量（定点） */
  totalHp: Fixed;
  /** 本波时长（秒） */
  durationSec: number;
  /** 需求 DPS（定点） */
  requiredDps: Fixed;
  /** 经济感知上界：预算能买到的最强阵容的 DPS（定点） */
  maxDps: Fixed;
  /** 需求 / 经济感知上界（千分比） */
  requiredOverMax: number;
  /** 该预算买到的塔数与型号 */
  towers: number;
  bestUnit: string;
}

export interface EconomyBoundAnalysis {
  difficultyId: DifficultyId;
  rows: EconomyBoundRow[];
  assumedCoverage: number;
}

function durationOf(content: SimContent, wave: number): number {
  const def = content.waves.find((w) => w.wave === wave);
  if (!def) return 20;
  let last = 0;
  for (const g of def.groups) last = Math.max(last, g.delay + g.interval * Math.max(0, g.count - 1));
  return Math.max(1, Math.round(last / FIXED_SCALE)) + 18;
}

/** 到第 n 波的累计理论钱包（定点，含难度钱包系数）。 */
function cumulativeWallet(content: SimContent, n: number, diff: DifficultyId): Fixed {
  const walletIndex = content.constants.walletIndex;
  const diffMul = content.constants.difficulty[diff]?.walletMul ?? FIXED_SCALE;
  let sum = 0;
  for (let w = 1; w <= n; w++) {
    const def = content.waves.find((x) => x.wave === w);
    if (!def) continue;
    const growth = fmul(fpow(walletIndex, w - 1), diffMul);
    for (const g of def.groups) {
      const e = content.enemies[g.enemy];
      if (!e) continue;
      sum += g.count * fmul(e.baseWallet, growth);
    }
  }
  return sum;
}

/** 到第 n 波的累计敌人总血量（定点，含难度血量系数）。 */
function cumulativeHp(content: SimContent, n: number, diff: DifficultyId): Fixed {
  const hpIndex = content.constants.hpIndex;
  const diffMul = content.constants.difficulty[diff]?.hpMul ?? FIXED_SCALE;
  let sum = 0;
  for (let w = 1; w <= n; w++) {
    const def = content.waves.find((x) => x.wave === w);
    if (!def) continue;
    const growth = fmul(fpow(hpIndex, w - 1), diffMul);
    for (const g of def.groups) {
      const e = content.enemies[g.enemy];
      if (!e) continue;
      sum += g.count * fmul(e.baseHp, growth);
    }
  }
  return sum;
}

/** 到第 n 波的累计波次结算奖励（定点）。 */
function cumulativeReward(content: SimContent, n: number): Fixed {
  let sum = 0;
  for (let w = 1; w <= n; w++) {
    const def = content.waves.find((x) => x.wave === w);
    if (def) sum += def.rewardGold;
  }
  return sum;
}

/** 单塔对本波护甲的实际 DPS（含满级科技 —— 预算买的是"最终强度"）。 */
function unitDpsWithTech(content: SimContent, u: UnitDef, armor: ArmorType, attackMul: Fixed, speedMul: Fixed): Fixed {
  const baseTicks = Math.max(1, truncDiv(u.attackInterval * content.constants.tickRate, FIXED_SCALE));
  const ticks = Math.max(1, mulDiv(baseTicks, FIXED_SCALE, speedMul));
  const attack = fmul(u.attack, attackMul);
  const row = content.constants.counterMatrixStandard[attackIndex(u.attackType)];
  const col = armorIndex(armor, content.constants.armorAlias);
  const mul = (row ? row[col] : undefined) ?? FIXED_SCALE;
  return fmul(truncDiv(attack * content.constants.tickRate, ticks), mul);
}

/**
 * 「每金币 DPS 最高」的塔 —— 用**累计升级链成本**（设计不变量：必须逐级升上去）。
 * 返回该塔的 id 与它的链总成本。
 */
function bestDpsPerGold(
  content: SimContent,
  wave: number,
  attackMul: Fixed,
  speedMul: Fixed,
): { id: string; chainCost: Fixed; dps: Fixed } {
  const def = content.waves.find((w) => w.wave === wave);
  const armors: ArmorType[] = [];
  const counts: number[] = [];
  if (def) {
    for (const g of def.groups) {
      const e = content.enemies[g.enemy];
      if (!e) continue;
      armors.push(e.armorType);
      counts.push(g.count);
    }
  }
  let best = { id: '—', chainCost: 1, dps: 0, perGold: 0 };
  for (const u of Object.values(content.units)) {
    if (u.attack <= 0) continue;
    // 累计升级链成本：从没有升级目标的根单位一路走到它
    let chainCost = u.costGold;
    for (const cand of Object.values(content.units)) {
      if (cand.upgradeTo === u.id) chainCost += cand.costGold;
    }
    let dps = 0;
    let total = 0;
    for (let i = 0; i < armors.length; i++) {
      dps += unitDpsWithTech(content, u, armors[i] as ArmorType, attackMul, speedMul) * (counts[i] as number);
      total += counts[i] as number;
    }
    dps = total > 0 ? truncDiv(dps, total) : 0;
    if (chainCost <= 0) continue;
    const perGold = truncDiv(dps * FIXED_SCALE, chainCost);
    if (perGold > best.perGold) best = { id: u.id, chainCost, dps, perGold };
  }
  return { id: best.id, chainCost: best.chainCost, dps: best.dps };
}

/**
 * 经济感知上界分析。`attackMul` / `speedMul` 传**当前可达**的科技乘区
 * （舒适带要的是"到该波合理能有的强度"，不是"满级科技"）。
 */
export function analyzeEconomyBound(
  content: SimContent,
  diff: DifficultyId,
  attackMul: Fixed,
  speedMul: Fixed,
  assumedCoverage: number = ASSUMED_STEAL_COVERAGE,
): EconomyBoundAnalysis {
  const startGold = content.constants.difficulty[diff]?.startGold ?? 0;
  const rows: EconomyBoundRow[] = [];
  for (let n = 1; n <= content.constants.totalWaves; n++) {
    const wallet = cumulativeWallet(content, n, diff);
    const hp = cumulativeHp(content, n, diff);
    const reward = cumulativeReward(content, n);
    const kill = mulDiv(wallet, 170, FIXED_SCALE); // §4.1.1 的 17%
    const income = startGold + mulDiv(wallet, assumedCoverage, FIXED_SCALE) + kill + reward;

    const pick = bestDpsPerGold(content, n, attackMul, speedMul);
    const towers = pick.chainCost > 0 ? Math.min(content.constants.populationCap, truncDiv(income, pick.chainCost)) : 0;
    const maxDps = pick.dps * towers;

    // 本波需求：本波（不是累计）血量 / 本波时长
    const waveHp = n === 1 ? hp : hp - cumulativeHp(content, n - 1, diff);
    const durationSec = durationOf(content, n);
    const requiredDps = truncDiv(waveHp, durationSec);

    rows.push({
      wave: n,
      income,
      totalHp: waveHp,
      durationSec,
      requiredDps,
      maxDps,
      requiredOverMax: maxDps > 0 ? truncDiv(requiredDps * FIXED_SCALE, maxDps) : Number.MAX_SAFE_INTEGER,
      towers,
      bestUnit: pick.id,
    });
  }
  return { difficultyId: diff, rows, assumedCoverage };
}
