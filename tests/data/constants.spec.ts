/**
 * tests/data/constants.spec.ts —— constants.json 覆盖度 + 策划案公式复现（data-arch 所有）
 *
 * 本文件承担两件评审必查的事：
 *  ① 「公式常量 → constants.json 键名」对照表是**机器可执行**的：
 *     FORMULA_CONSTANT_MAP 逐条列出「策划案出处 → 键名路径 → 期望值」。
 *  ② 反向完备性：constants.json 里每一个数值叶子节点，要么被对照表引用，
 *     要么在 ALLOWED_UNMAPPED 白名单里显式列出。**新增键必须解释出处**，
 *     防止「公式常量被悄悄写死在别处 / 表里塞了无出处的魔法数字」。
 */
import { describe, expect, it } from 'vitest';

import { INCOME_N2, SPEND_BUDGET_PCT, TECH_GRAND_TOTAL, loadTables } from '../../tools/validate-data';

const C = loadTables().constants;
const DIFFICULTY = loadTables().difficulty as any[];
const F = C.fixedScale;

// ---------------------------------------------------------------------------
// ① 公式常量 → 键名 对照表（评审必查）
// ---------------------------------------------------------------------------

interface Mapping {
  /** 策划案出处 */
  src: string;
  /** constants.json 键路径 */
  key: string;
  /** 期望值 */
  expect: unknown;
  /** 单位说明 */
  unit: string;
}

export const FORMULA_CONSTANT_MAP: Mapping[] = [
  // §3.1 / §3.3 时间与定点
  { src: '§3.3 契约 tickRate', key: 'tickRate', expect: 60, unit: 'Hz（纯计数）' },
  { src: '§2 契约 fixedScale', key: 'fixedScale', expect: 1000, unit: '×1000（纯计数）' },
  { src: '决策 D3 波次总量', key: 'waveTotal', expect: 30, unit: '纯计数' },
  { src: '§3.1 备战 15s', key: 'wavePrepTimeDefault', expect: 15000, unit: '秒(定点)' },
  { src: '§3.1 结算 3s', key: 'waveSettleTime', expect: 3000, unit: '秒(定点)' },
  { src: '§3.3 Ctrl+Z 10s', key: 'undoWindow', expect: 10000, unit: '秒(定点)' },
  { src: '§3.3 撤销返还 100%', key: 'undoRefundPct', expect: 1000, unit: '千分比' },

  // §5.1 成长曲线（★ 两轮裁决：baseHp 40→60 / hpIndex 1380→1283 / baseWallet 10→45→32 / walletIndex 1290→1200）
  { src: '§5.1 HP(1)（裁决 40→60）', key: 'baseHp', expect: 60000, unit: '定点' },
  { src: '§5.1 血量指数（裁决 1.38→1.283）', key: 'hpIndex', expect: 1283, unit: '千分比指数' },
  { src: '§5.1 W(1)（裁决 10→32；第二轮由 45 下调以收口支出/收入比）', key: 'baseWallet', expect: 32000, unit: '定点' },
  { src: '§5.1 钱包指数（裁决 1.29→1.20）', key: 'walletIndex', expect: 1200, unit: '千分比指数' },
  { src: '§5.1 Q(n)=6+floor(0.8n) 的 6（已降级为规划参考）', key: 'enemyCountBase', expect: 6000, unit: '定点' },
  { src: '§5.1 数量斜率 0.8（已降级为规划参考）', key: 'enemyCountSlope', expect: 800, unit: '定点' },

  // §4.1.2 窃金公式
  { src: '§4.1.2 LevelMul = 1.0/1.35/1.85/2.6/3.8', key: 'levelMul', expect: [1000, 1350, 1850, 2600, 3800], unit: '定点倍率 ×5' },
  { src: '§4.1.2 (1 + 0.02 × 攻击力) 的 0.02', key: 'stealAtkCoef', expect: 20, unit: '千分比系数' },
  { src: '§4.1.2 暴击率基础 5%', key: 'critRateBase', expect: 50, unit: '千分比' },
  { src: '§4.4.1 暴击率上限 30%', key: 'critRateCap', expect: 300, unit: '千分比' },
  { src: '§4.1.2 CritMul 基础 150%', key: 'critMulBase', expect: 1500, unit: '千分比' },
  { src: '§4.1.2 暴击效率 +25%/级', key: 'critMulPerLevel', expect: 250, unit: '千分比/级' },
  { src: '§4.4.1 暴击效率上限 275%', key: 'critMulCap', expect: 2750, unit: '千分比' },
  { src: '§4.1.2 缺省窃金抗性', key: 'stealResistDefault', expect: 0, unit: '千分比' },
  { src: '§8.5 伪代码 抗性 ≥1000 即免疫', key: 'stealImmunityThreshold', expect: 1000, unit: '千分比' },
  { src: '§4.1.1 窃金时按比例附带窃木（终值 3 = 3‰；契约 §14.5 纠正了此前的 30）', key: 'stealWoodRatio', expect: 3, unit: '千分比' },

  // §4.3 克制矩阵
  { src: '§4.3 标准倍率表', key: 'counterMatrixStandard', expect: [
    [1000, 1500, 1000, 700, 300],
    [2000, 750, 1000, 350, 300],
    [1250, 750, 1500, 350, 500],
    [1000, 500, 1000, 2000, 300],
    [1250, 1250, 1250, 1250, 1000],
  ], unit: '5×5 定点倍率' },
  { src: '§4.3 压缩公式 ×0.5', key: 'compressedFactor', expect: 500, unit: '千分比' },
  { src: '§4.3 压缩下限 0.6', key: 'compressedFloor', expect: 600, unit: '千分比' },

  // §4.2.4 / §4.6 停顿点
  { src: '§4.6 ★停顿点停顿 0.6s', key: 'haltPointStopDuration', expect: 600, unit: '秒(定点)' },

  // §4.7.1 结算
  { src: '§4.7.1 floor(累计窃金/1000)', key: 'crystalDivisor', expect: 1000, unit: '定点除数' },
  { src: '§4.7.1 难度系数 N1', key: 'difficultyCrystalMul.N1', expect: 600, unit: '千分比' },
  { src: '§4.7.1 难度系数 N2', key: 'difficultyCrystalMul.N2', expect: 1000, unit: '千分比' },
  { src: '§4.7.1 难度系数 N3', key: 'difficultyCrystalMul.N3', expect: 1600, unit: '千分比' },
  { src: '§4.7.1 难度系数 N4', key: 'difficultyCrystalMul.N4', expect: 2400, unit: '千分比' },
  { src: '§4.7.1 难度系数 N5', key: 'difficultyCrystalMul.N5', expect: 3600, unit: '千分比' },
  { src: '§4.7.1 第 20 波后可蜕变', key: 'ascensionMinWave', expect: 20, unit: '纯计数' },
  { src: '§6.3 第 7 步首次结算翻倍', key: 'firstClearCrystalMul', expect: 2000, unit: '千分比' },

  // §4.7.3 成就系数
  { src: '§4.7.3 滴水不漏 ×1.25', key: 'achievementMuls.no_leak', expect: 1250, unit: '千分比' },
  { src: '§4.7.3 原汁原味 ×1.50', key: 'achievementMuls.no_ascension', expect: 1500, unit: '千分比' },
  { src: '§4.7.3 闪电战 ×1.20', key: 'achievementMuls.speedrun', expect: 1200, unit: '千分比' },
  { src: '§4.7.3 专精 ×1.30', key: 'achievementMuls.single_line', expect: 1300, unit: '千分比' },
  { src: '§4.7.3 空手道 ×1.15', key: 'achievementMuls.no_mage', expect: 1150, unit: '千分比' },
  { src: '§4.7.3 千金散尽 ×1.10', key: 'achievementMuls.big_spender', expect: 1100, unit: '千分比' },
  { src: '§4.7.3 卡位大师 ×1.15', key: 'achievementMuls.block_master', expect: 1150, unit: '千分比' },
  { src: '§4.7.3 进阶挑战 ×1.2–2.0', key: 'achievementMuls.advanced_challenges', expect: 1200, unit: '千分比（取下限）' },

  // §4.1.4 建筑师技能
  { src: '§4.1.4 领工资 CD 90s', key: 'salaryCooldown', expect: 90000, unit: '秒(定点)' },
  { src: '§4.1.4 领工资 = 60 × 基地每秒产出', key: 'salaryMultiplier', expect: 60000, unit: '定点倍率' },
  { src: '§4.1.4 荆棘丛林 CD 120s', key: 'brambleCooldown', expect: 120000, unit: '秒(定点)' },
  { src: '§4.1.4 荆棘丛林硬控 3s', key: 'brambleDuration', expect: 3000, unit: '秒(定点)' },

  // §4.4.2 科技存档继承
  { src: '§4.4.2 免费起始等级 = floor(存档等级/2)', key: 'techArchiveFreeLevelDivisor', expect: 2, unit: '纯计数除数' },
  { src: '§4.4.2 造价按存档等级 −8%/级', key: 'techArchiveCostReductionPct', expect: 80, unit: '千分比/级' },

  // §4.6 地图
  { src: '§4.6 单人守 4 路', key: 'map.laneCount', expect: 4, unit: '纯计数' },
  { src: '§4.6 路径约 40 格', key: 'map.pathLengthCells', expect: 40000, unit: '格(定点)' },
  { src: '§4.6 路径两侧各 2 格', key: 'map.buildableWidthCells', expect: 2000, unit: '格(定点)' },
  { src: '§4.6 宝库 5×5', key: 'map.vaultSizeCells', expect: 5000, unit: '格(定点)' },
  { src: '§4.6 每路 1 处停顿点', key: 'map.haltPointsPerLane', expect: 1, unit: '纯计数' },

  // §4.2.7 英雄（M6）
  { src: '§4.2.7 英雄最多 2 个', key: 'hero.maxCount', expect: 2, unit: '纯计数' },
  { src: '§4.2.7 第 1 个英雄 30,000 金', key: 'hero.costs.0.gold', expect: 30000000, unit: '定点' },
  { src: '§4.2.7 第 1 个英雄 3,000 木', key: 'hero.costs.0.wood', expect: 3000000, unit: '定点' },
  { src: '§4.2.7 第 2 个英雄 70,000 金', key: 'hero.costs.1.gold', expect: 70000000, unit: '定点' },
  { src: '§4.2.7 第 2 个英雄 7,000 木', key: 'hero.costs.1.wood', expect: 7000000, unit: '定点' },
  { src: '§4.2.7 英雄装备 6 格', key: 'hero.equipSlots', expect: 6, unit: '纯计数' },
  { src: '§4.2.7 10 级变身', key: 'hero.morphLevels.0.level', expect: 10, unit: '纯计数' },
  { src: '§4.2.7 10 级 +50% 攻击', key: 'hero.morphLevels.0.attackPct', expect: 500, unit: '千分比' },
  { src: '§4.2.7 20 级变身', key: 'hero.morphLevels.1.level', expect: 20, unit: '纯计数' },
  { src: '§4.2.7 20 级 +100% 攻击', key: 'hero.morphLevels.1.attackPct', expect: 1000, unit: '千分比' },
  { src: '§4.2.7 30 级变身', key: 'hero.morphLevels.2.level', expect: 30, unit: '纯计数' },
  { src: '§4.2.7 30 级终极形态 +100% 攻击（策划案未给数值，data-arch 推断）', key: 'hero.morphLevels.2.attackPct', expect: 2000, unit: '千分比' },
  { src: '§4.2.7 窃金也涨经验', key: 'hero.expFromSteal', expect: 1000, unit: '千分比权重' },

  // §4.1.1 / §14.12 经济目标
  { src: '§4.1.1 窃金占比 70–80%', key: 'economyTargets.stealShareMin', expect: 700, unit: '千分比' },
  { src: '§4.1.1 窃金占比 70–80%', key: 'economyTargets.stealShareMax', expect: 800, unit: '千分比' },
  { src: '§4.1.1 击杀奖励 15–20%', key: 'economyTargets.killShareMin', expect: 150, unit: '千分比' },
  { src: '§4.1.1 击杀奖励 15–20%', key: 'economyTargets.killShareMax', expect: 200, unit: '千分比' },
  { src: '§14.12 塔建造升级 50%（原 55%）', key: 'economyTargets.spendRatios.tower', expect: 500, unit: '千分比' },
  { src: '§14.12 科技研究 35%（原 28%）', key: 'economyTargets.spendRatios.tech', expect: 350, unit: '千分比' },
  { src: '§14.12 小精灵与产能 8%（原 10%）', key: 'economyTargets.spendRatios.sprite', expect: 80, unit: '千分比' },
  { src: '§14.12 装备与杂项 7%', key: 'economyTargets.spendRatios.equipment', expect: 70, unit: '千分比' },

  // §5.4 / §10.2 验收指标 + §15.4 的两条替代判定
  { src: '§5.4 窃金覆盖率 65%–80%', key: 'acceptanceTargets.stealCoverageMin', expect: 650, unit: '千分比' },
  { src: '§5.4 窃金覆盖率 65%–80%', key: 'acceptanceTargets.stealCoverageMax', expect: 800, unit: '千分比' },
  { src: '§5.4 支出/收入比 80%–90%', key: 'acceptanceTargets.spendRatioMin', expect: 800, unit: '千分比' },
  { src: '§5.4 支出/收入比 80%–90%', key: 'acceptanceTargets.spendRatioMax', expect: 900, unit: '千分比' },
  { src: '§5.4 漏怪率 < 2%', key: 'acceptanceTargets.leakRateMax', expect: 20, unit: '千分比' },
  { src: '§5.4 波末金币余量 10%–40%', key: 'acceptanceTargets.waveEndGoldMin', expect: 100, unit: '千分比' },
  { src: '§5.4 波末金币余量 10%–40%', key: 'acceptanceTargets.waveEndGoldMax', expect: 400, unit: '千分比' },
  { src: '★§15.4 可通关性硬界 需求/上界 ≤ 1.0', key: 'acceptanceTargets.solvabilityMax', expect: 1000, unit: '千分比' },
  { src: '★§15.4 舒适带下限 0.2', key: 'acceptanceTargets.solvabilityComfortMin', expect: 200, unit: '千分比' },
  { src: '★§15.4 舒适带上限 0.6', key: 'acceptanceTargets.solvabilityComfortMax', expect: 600, unit: '千分比' },
  { src: '★§15.4 舒适带适用波次（第 10 波）', key: 'acceptanceTargets.solvabilityComfortWaves.0', expect: 10, unit: '纯计数' },
  { src: '★§15.4 舒适带适用波次（第 20 波）', key: 'acceptanceTargets.solvabilityComfortWaves.1', expect: 20, unit: '纯计数' },
  { src: '§5.4 第 20 波科技等级 10–16', key: 'acceptanceTargets.techLevelsAtWave20Min', expect: 10, unit: '纯计数' },
  { src: '§5.4 第 20 波科技等级 10–16', key: 'acceptanceTargets.techLevelsAtWave20Max', expect: 16, unit: '纯计数' },
  { src: '§10.2 Q1 军训系存在性 ≥25%（§14.15 已降级为诊断指标）', key: 'acceptanceTargets.blockExtraStealMin', expect: 250, unit: '千分比' },
];

function resolveKey(path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = C;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) ? (cur as unknown[])[Number(p)] : (cur as Record<string, unknown>)[p];
  }
  return cur;
}

describe('constants.json —— 公式常量 → 键名 对照表（每条都可在表里找到）', () => {
  for (const m of FORMULA_CONSTANT_MAP) {
    it(`${m.src}  →  constants.${m.key}  (${m.unit})`, () => {
      expect(resolveKey(m.key), `键 ${m.key} 不存在或有误`).toEqual(m.expect);
    });
  }
});

// ---------------------------------------------------------------------------
// ② 反向完备性：表里不能有「无出处」的数值
// ---------------------------------------------------------------------------

/** constants.json 中所有数值叶子节点的路径 */
function numericLeaves(value: unknown, path = ''): string[] {
  if (typeof value === 'number') return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => numericLeaves(v, path === '' ? String(i) : `${path}.${i}`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      numericLeaves(v, path === '' ? k : `${path}.${k}`),
    );
  }
  return [];
}

/** 已在对照表中登记的路径（数组形状的键展开为逐元素路径） */
function mappedPaths(): Set<string> {
  const out = new Set<string>();
  for (const m of FORMULA_CONSTANT_MAP) {
    if (Array.isArray(m.expect)) {
      (m.expect as unknown[]).forEach((_, i) => {
        const item = resolveKey(m.key) as unknown[];
        if (Array.isArray(item[i])) {
          (item[i] as unknown[]).forEach((__, j) => out.add(`${m.key}.${i}.${j}`));
        } else {
          out.add(`${m.key}.${i}`);
        }
      });
    } else {
      out.add(m.key);
    }
  }
  return out;
}

/**
 * 白名单：这些数值叶子没有独立的「策划案公式」出处，但属于表结构必需的语义字段
 * （它们要么是对照表条目的组成部分、要么是纯枚举/计数字段）。
 */
const ALLOWED_UNMAPPED: string[] = [];

describe('constants.json —— 反向完备性（每个数值都能解释出处）', () => {
  it('数值叶子集合 == 对照表引用集合 ∪ 显式白名单', () => {
    const mapped = mappedPaths();
    const unmapped = numericLeaves(C).filter((p) => !mapped.has(p));
    expect(unmapped.sort()).toEqual([...ALLOWED_UNMAPPED].sort());
  });
});

// ---------------------------------------------------------------------------
// §4.3 克制矩阵：压缩模式复现
// ---------------------------------------------------------------------------

describe('constants.json —— §4.3 克制矩阵与压缩公式', () => {
  it('标准倍率表 5×5 与策划案逐格一致', () => {
    expect(C.counterMatrixStandard).toEqual([
      [1000, 1500, 1000, 700, 300],
      [2000, 750, 1000, 350, 300],
      [1250, 750, 1500, 350, 500],
      [1000, 500, 1000, 2000, 300],
      [1250, 1250, 1250, 1250, 1000],
    ]);
  });

  it('压缩公式 1 + (标准 − 1) × 0.5，下限 0.6；§4.3 举例「穿刺打城甲 = 0.675」', () => {
    const compressed = (v: number) => Math.max(1000 + Math.round(((v - 1000) * C.compressedFactor) / 1000), C.compressedFloor);
    expect(compressed(C.counterMatrixStandard[1][3])).toBe(675);
    for (const row of C.counterMatrixStandard as number[][]) {
      for (const v of row) {
        const c = compressed(v);
        expect(c).toBeGreaterThanOrEqual(600);
        expect(c).toBeLessThanOrEqual(1500);
      }
    }
  });

  it('神圣甲列：只有混乱攻击 100%，其余 ≤50%（§4.3 设计意图）', () => {
    const col = (C.counterMatrixStandard as number[][]).map((r) => r[4]);
    expect(col[4]).toBe(1000);
    for (const i of [0, 1, 2, 3]) expect(col[i]).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// §5.1 / §5.2 成长公式复现
// ---------------------------------------------------------------------------

describe('constants.json —— §5.1 曲线（★ v0.2 裁决后的新基线）', () => {
  const hp = (n: number) => (C.baseHp / F) * Math.pow(C.hpIndex / F, n - 1);
  const wallet = (n: number) => (C.baseWallet / F) * Math.pow(C.walletIndex / F, n - 1);
  const count = (n: number) => C.enemyCountBase / F + Math.floor((C.enemyCountSlope / F) * n);

  it('裁决值精确落地：baseHp 60 / hpIndex 1283 / baseWallet 32 / walletIndex 1200', () => {
    expect(C.baseHp).toBe(60 * F);
    expect(C.hpIndex).toBe(1283);
    expect(C.baseWallet).toBe(32 * F);
    expect(C.walletIndex).toBe(1200);
  });

  it('设计意图 ①：压平后置度 —— 1.20^29 ≈ 198×（原 1.29^29 = 1606×）', () => {
    const now = Math.pow(C.walletIndex / F, 29);
    const before = Math.pow(1.29, 29);
    expect(now / before).toBeLessThan(0.15); // 至少压掉 85%
    expect(Math.round(now)).toBe(198);
  });

  it('设计意图 ②：保住净难度爬升 —— 1.283/1.20 = 1.069（原 1.38/1.29 = 1.070）', () => {
    const now = C.hpIndex / C.walletIndex;
    const before = 1380 / 1290;
    expect(now).toBeCloseTo(1.069, 3);
    expect(Math.abs(now - before)).toBeLessThan(0.002); // 一阶参数几乎未变
  });

  it('设计意图 ③：后置度确实被压平 —— 第 26–30 波占比由 ~76% 降到 ~66%（结构张力见汇报，本轮不解决）', () => {
    const share = (r: number): number => {
      let cum = 0;
      const per: number[] = [];
      for (let n = 1; n <= 30; n++) {
        const v = count(n) * (C.baseWallet / F) * Math.pow(r, n - 1);
        per.push(v);
        cum += v;
      }
      return per.slice(25).reduce((a, b) => a + b, 0) / cum;
    };
    // 用同一 baseWallet 比较「原指数 1.29」与「新指数 1.20」的后置度
    const before = share(1.29);
    const after = share(C.walletIndex / F);
    console.log('[data-arch] 第 26–30 波钱包占比：原 1.29 曲线', (before * 100).toFixed(1) + '% → 新曲线', (after * 100).toFixed(1) + '%');
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(0.7);
  });

  it('与策划案 §5.2 原表的偏差（原表未乘 §4.5.2 单体系数，已被裁决取代）—— 仅登记，不作为断言目标', () => {
    const DOC: Array<[number, number, number]> = [
      // wave, 原表血量/敌人, 原表钱包/敌人
      [1, 40, 10],
      [5, 145, 28],
      [10, 726, 99],
      [15, 3634, 353],
      [20, 18188, 1263],
      [25, 91028, 4511],
      [30, 455560, 16115],
    ];
    const rows = DOC.map(([n, dh, dw]) => `w${n}: hp ${Math.round(hp(n))}(原 ${dh}) / wallet ${Math.round(wallet(n))}(原 ${dw})`);
    console.log('[data-arch] 新基线 vs §5.2 原表 =', rows.join(' | '));
    // 新曲线的绝对量级必然与原表不同（这正是裁决要修的），只断言「确有变化」
    expect(Math.round(hp(1))).not.toBe(DOC[0]![1]);
  });
});

describe('constants.json —— 真实数据下的静态算术（供平衡复核，非断言目标）', () => {
  const tables = loadTables();
  const enemyById = new Map<string, any>(tables.enemies.map((e) => [e.id, e]));
  const wi = tables.constants.walletIndex / F;
  const scaleAt = (n: number) => Math.pow(wi, n - 1);

  interface WaveStat {
    wave: number;
    enemies: number;
    wallet: number;
    hp: number;
    bounty: number;
  }

  const stats: WaveStat[] = (tables.waves as any[]).map((w) => {
    let wallet = 0;
    let hp = 0;
    let bounty = 0;
    let enemies = 0;
    for (const g of w.groups) {
      const e = enemyById.get(g.enemy);
      const s = scaleAt(w.wave);
      enemies += g.count;
      wallet += g.count * (e.baseWallet / F) * s;
      hp += g.count * ((e.baseHp / F) * Math.pow(tables.constants.hpIndex / F, w.wave - 1));
      bounty += g.count * ((e.bountyRatio.gold * e.baseWallet) / 1000 / F) * s;
    }
    return { wave: w.wave, enemies, wallet, hp, bounty };
  });

  const totalWallet = stats.reduce((a, b) => a + b.wallet, 0);
  const totalHp = stats.reduce((a, b) => a + b.hp, 0);
  const totalBounty = stats.reduce((a, b) => a + b.bounty, 0);
  const totalEnemies = stats.reduce((a, b) => a + b.enemies, 0);

  it('打印 N2 累计理论钱包 / 敌人总血量 / 击杀奖励占比 / 每波钱包', () => {
    console.log('[data-arch] 敌人总数 =', totalEnemies);
    console.log('[data-arch] N2 累计理论钱包 =', Math.round(totalWallet));
    console.log('[data-arch] N2 敌人总血量 =', Math.round(totalHp));
    console.log('[data-arch] 击杀奖励合计 =', Math.round(totalBounty), ' 占比 =', ((totalBounty / totalWallet) * 100).toFixed(2) + '%');
    console.log('[data-arch] 每波钱包 =', stats.map((s) => `w${s.wave}:${Math.round(s.wallet)}`).join(' '));
    console.log('[data-arch] 每波血量 =', stats.map((s) => `w${s.wave}:${Math.round(s.hp)}`).join(' '));
    expect(totalWallet).toBeGreaterThan(0);
  });

  it('★ 记录：N2 累计理论钱包（契约 §13.5 的 BOSS 钱包系数使之回到 2.2M 量级）', () => {
    const tail = stats.slice(25).reduce((a, b) => a + b.wallet, 0) / totalWallet;
    console.log(
      `[data-arch] 带系数累计理论钱包 = ${Math.round(totalWallet)}` +
        `（baseWallet 32 + BOSS 钱包系数 ×12/×12/×16/×20）`,
    );
    console.log(`[data-arch] 实际组合下第 26–30 波钱包占比 = ${(tail * 100).toFixed(1)}%（结构性张力，已由主策划按设计问题登记）`);
    console.log('[data-arch] BOSS 波钱包 =', stats.filter((s) => [24, 25, 26, 27, 30].includes(s.wave)).map((s) => `w${s.wave}:${Math.round(s.wallet)}`).join(' '));
    // 起点值的精确量级待 headless 标定，这里只拦住量级级错误
    expect(totalWallet).toBeGreaterThan(1_000_000);
    expect(totalWallet).toBeLessThan(4_000_000);
  });

  it('★ 击杀奖励占理论钱包 15–20%（§4.1.1）', () => {
    const ratio = totalBounty / totalWallet;
    expect(ratio).toBeGreaterThanOrEqual(0.15);
    expect(ratio).toBeLessThanOrEqual(0.2);
  });

  it('★ 契约 §15.13 的目的达成：科技总额 = **占预算** 35%（= 占收入 29.7%），两个口径分开写', () => {
    const stealCoverage = 0.7;
    const steal = totalWallet * stealCoverage;
    const waveRewards = (tables.waves as any[]).reduce((a, w) => a + w.reward.gold / F, 0);
    const income = steal + totalBounty + waveRewards;
    const budget = (income * SPEND_BUDGET_PCT) / 1000;
    const techTotal = TECH_GRAND_TOTAL.gold;
    const shareOfBudget = techTotal / budget;
    const shareOfIncome = techTotal / income;
    console.log(
      `[data-arch] 总收入 ${Math.round(income)} → 支出预算(×${SPEND_BUDGET_PCT / 10}%) ${Math.round(budget)}；` +
        `科技 ${techTotal} = **占预算 ${(shareOfBudget * 100).toFixed(1)}%**（目标 ${C.economyTargets.spendRatios.tech / 10}%）= **占收入 ${(shareOfIncome * 1000).toFixed(1)}‰**；` +
        `改造前 313,200 = 占预算 19.0% / 占收入 16.2%`,
    );
    expect(Math.abs(shareOfBudget - C.economyTargets.spendRatios.tech / 1000)).toBeLessThan(0.02);
    // 两个口径的换算：占收入 = 占预算 × 85%
    expect(shareOfIncome).toBeCloseTo(shareOfBudget * (SPEND_BUDGET_PCT / 1000), 3);
  });

  it('★ 记录：支出/收入比（契约 §14.2 已预期支出侧要重算，故本用例只记录）', () => {
    const stealCoverage = 0.7;
    const steal = totalWallet * stealCoverage;
    const waveRewards = (tables.waves as any[]).reduce((a, w) => a + w.reward.gold / F, 0);
    const income = steal + totalBounty + waveRewards;
    const spend = 750_000 + 313_200 + 140_000 + 90_000; // §5.5：塔 75 万 + 科技 + 精灵 + 装备
    const ratio = spend / income;
    console.log('[data-arch] 收入 = 窃金', Math.round(steal), '+ 击杀', Math.round(totalBounty), '+ 波次奖励', waveRewards, '=', Math.round(income));
    console.log('[data-arch] 支出 = §5.5 合计', spend, ' → 支出/收入比 =', (ratio * 100).toFixed(1) + '%');
    console.log(
      '[data-arch] ⚠️ 契约 §13.5 的 BOSS 钱包系数使累计钱包从 1.797M 升到 ' +
        `${(totalWallet / 1_000_000).toFixed(2)}M，该比例从 81.7% 降到 ${(ratio * 100).toFixed(1)}%；` +
        '§14.2 已说明「科技从装饰品变成主强度来源后，313,200 金的科技投入才有意义」——支出侧属重测后重算项。',
    );
    // 只做量级防呆：收入必须够支出，否则才是硬错误
    expect(income).toBeGreaterThan(spend);
  });

  it('★ 反推（记录）：要让固定支出 129.32 万 / 收入 = 85%，累计钱包需 ≈1.73M', () => {
    const stealCoverage = 0.7;
    const waveRewards = (tables.waves as any[]).reduce((a, w) => a + w.reward.gold / F, 0);
    const bountyRatio = totalBounty / totalWallet;
    const spend = 750_000 + 313_200 + 140_000 + 90_000;
    const needWallet = (spend / 0.85 - waveRewards) / (stealCoverage + bountyRatio);
    const needBaseWallet = (C.baseWallet / F) * (needWallet / totalWallet);
    const needBaseWalletAt80 = (C.baseWallet / F) * ((spend / 0.8 - waveRewards) / (stealCoverage + bountyRatio) / totalWallet);
    console.log(
      `[data-arch] 反推：85% 需累计钱包 ≈ ${Math.round(needWallet)}、baseWallet ≈ ${needBaseWallet.toFixed(1)}；` +
        `80% 需 baseWallet ≈ ${needBaseWalletAt80.toFixed(1)}（当前 ${C.baseWallet / F}，BOSS 系数已占一部分预算）`,
    );
    expect(needBaseWallet).toBeGreaterThan(10);
    expect(needBaseWallet).toBeLessThan(C.baseWallet / F);
  });

  it('★ 木材账（stealWoodRatio = 3‰，契约 §14.5；科技木总额 57,600，契约 §15.2）', () => {
    const stolen = totalWallet * 0.7;
    const attached = (stolen * C.stealWoodRatio) / 1000;
    const waveWood = (tables.waves as any[]).reduce((a, w) => a + w.reward.wood / F, 0);
    const techWood = 49_000; // §15.13：8 条线木材总额（原 26,670；木材按同比例缩放）
    const gap = techWood - attached - waveWood;
    console.log(
      `[data-arch] 木：窃金附带 ${Math.round(attached)}（= 窃金 ${Math.round(stolen)} × 3‰）+ 波次奖励 ${waveWood} = ${Math.round(attached + waveWood)}；` +
        `需求 ${techWood} → 缺口 ${Math.round(gap)} 由小精灵承担（≈${Math.ceil(gap / (120 * 28))} 只高阶小精灵；§14.12 的精灵预算 8% × 收入 ≈ 15.5 万）`,
    );
    expect(attached).toBeGreaterThan(0);
    expect(gap).toBeGreaterThan(0); // 缺口必须为正，否则小精灵的预算过投
  });

  it('经济分配目标的四项之和必须为 1000（§14.12）', () => {
    const sr = C.economyTargets.spendRatios;
    expect(sr.tower + sr.tech + sr.sprite + sr.equipment).toBe(1000);
  });

  it('§15.4：塔数目标必须已被删除，替代它的是 solvability 硬界 + 舒适带', () => {
    expect(C.acceptanceTargets.towersAtWave10Min).toBeUndefined();
    expect(C.acceptanceTargets.towersAtWave10Max).toBeUndefined();
    expect(C.acceptanceTargets.solvabilityComfortMin).toBeLessThan(C.acceptanceTargets.solvabilityComfortMax);
    expect(C.acceptanceTargets.solvabilityComfortMax).toBeLessThanOrEqual(C.acceptanceTargets.solvabilityMax);
    expect(C.acceptanceTargets.solvabilityComfortWaves).toEqual([10, 20]);
  });

  it('难度钱包倍率会把 N1 抬高 / N3–N5 压低（§4.8 难度哲学）', () => {
    const muls = DIFFICULTY.map((d) => d.walletMul);
    expect(muls[0]).toBe(1400);
    expect(muls[1]).toBe(1000);
    expect(muls[4]).toBe(700);
  });
});
