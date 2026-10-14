/**
 * tests/data/progression.spec.ts —— 科技 / 圣物 / 装备 / 难度 vs 策划案 §4.4 / §4.7.2 / §4.2.7 / §4.8
 */
import { describe, expect, it } from 'vitest';

import { INCOME_N2, SPEND_BUDGET_PCT, TECH_GRAND_TOTAL, TECH_TARGET, TECH_TOTAL_INVESTMENT, loadTables } from '../../tools/validate-data';

const T = loadTables();
const F = T.constants.fixedScale;
const techById = new Map<string, any>(T.tech.map((t) => [t.id, t]));
const relicById = new Map<string, any>(T.relics.map((r) => [r.id, r]));
const diffById = new Map<string, any>(T.difficulty.map((d) => [d.id, d]));

// ---------------------------------------------------------------------------
// §4.4.1 科技
// ---------------------------------------------------------------------------

/**
 * 科技线 → 每级效果与逐级造价首尾值（未定点）。
 * ★ 契约 §14.2 把 4 条线从「线性加法」改成「乘法倍率」：effectMode='mul' 时
 *   effectPerLevel 是**千分比倍率**（1500 = ×1.50/级），5 级 = (effect/1000)^5。
 *   有上限的两条暴击线保持 'add'（增量），并带 effectCap。
 * ★ 契约 §14.20：每条线还必须声明 `target`（作用于什么），引擎据此删除硬编码映射表。
 * ★ 契约 §15.2：造价总额从 313,200 → **677,000 金 / 57,600 木**（×2.16）。
 */
const PLAN_TECH: Record<
  string,
  {
    mode: 'add' | 'mul';
    target: string;
    effect: number;
    unit: 'permille' | 'count';
    cap?: number;
    goldStart: number;
    goldEnd: number;
    woodStart: number;
    woodEnd: number;
  }
> = {
  steal_efficiency: { mode: 'mul', target: 'steal', effect: 1120, unit: 'permille', goldStart: 2200, goldEnd: 41400, woodStart: 220, woodEnd: 4140 },
  attack: { mode: 'mul', target: 'attack', effect: 1500, unit: 'permille', goldStart: 1900, goldEnd: 35900, woodStart: 190, woodEnd: 3540 },
  attack_speed: { mode: 'mul', target: 'speed', effect: 1400, unit: 'permille', goldStart: 1900, goldEnd: 35900, woodStart: 190, woodEnd: 3540 },
  range: { mode: 'mul', target: 'range', effect: 1100, unit: 'permille', goldStart: 1500, goldEnd: 28400, woodStart: 150, woodEnd: 2790 },
  steal_crit_rate: { mode: 'add', target: 'critRate', effect: 50, unit: 'permille', cap: 300, goldStart: 2500, goldEnd: 47500, woodStart: 250, woodEnd: 4750 },
  steal_crit_mul: { mode: 'add', target: 'critMul', effect: 250, unit: 'permille', cap: 2750, goldStart: 2500, goldEnd: 47500, woodStart: 250, woodEnd: 4750 },
  population: { mode: 'add', target: 'population', effect: 2, unit: 'count', goldStart: 1300, goldEnd: 24200, woodStart: 130, woodEnd: 2570 },
  base_level: { mode: 'add', target: 'baseLevel', effect: 80, unit: 'permille', goldStart: 2400, goldEnd: 46000, woodStart: 0, woodEnd: 0 },
};

describe('tech.json —— 8 条科技线 × 5 级（§4.4.1）', () => {
  it('恰好 8 条，id 与策划案一致', () => {
    expect(T.tech).toHaveLength(8);
    expect([...techById.keys()].sort()).toEqual(Object.keys(PLAN_TECH).sort());
  });

  for (const [id, p] of Object.entries(PLAN_TECH)) {
    it(`${id}：maxLevel=5 / effectMode+target+每级效果 / 逐级造价首尾值`, () => {
      const t = techById.get(id);
      expect(t.maxLevel).toBe(5);
      expect(t.effectMode, `${id}.effectMode`).toBe(p.mode);
      expect(t.target, `${id}.target`).toBe(p.target);
      expect(t.effectPerLevel).toBe(p.effect);
      expect(t.effectUnit).toBe(p.unit);
      if (p.cap !== undefined) expect(t.effectCap, `${id}.effectCap`).toBe(p.cap);
      expect(t.archivable).toBe(true);
      expect(t.costPerLevel).toHaveLength(5);
      expect(t.costPerLevel[0]).toEqual({ gold: p.goldStart * F, wood: p.woodStart * F });
      expect(t.costPerLevel[4]).toEqual({ gold: p.goldEnd * F, wood: p.woodEnd * F });
    });
  }

  it('★ 8 条合计精确等于契约 §15.13 的 576,000 金 / 49,000 木（原 313,200 / 26,670，×1.84）', () => {
    let goldTotal = 0;
    let woodTotal = 0;
    for (const t of T.tech) {
      const g = t.costPerLevel.reduce((s: number, c: any) => s + c.gold, 0) / F;
      const w = t.costPerLevel.reduce((s: number, c: any) => s + c.wood, 0) / F;
      expect(g, `${t.id} 金`).toBe(TECH_TOTAL_INVESTMENT[t.id as keyof typeof TECH_TOTAL_INVESTMENT].gold);
      expect(w, `${t.id} 木`).toBe(TECH_TOTAL_INVESTMENT[t.id as keyof typeof TECH_TOTAL_INVESTMENT].wood);
      goldTotal += g;
      woodTotal += w;
    }
    expect(goldTotal).toBe(TECH_GRAND_TOTAL.gold);
    expect(woodTotal).toBe(TECH_GRAND_TOTAL.wood);
    expect(goldTotal).toBe(576000);
    expect(woodTotal).toBe(49000);
  });

  it('★ §15.13 口径可复核：科技 = 350‰ ×（总收入 1,937,191 × 85%）= 576,314 → 576,000', () => {
    const budget = INCOME_N2 * (SPEND_BUDGET_PCT / 1000);
    const techTarget = budget * (T.constants.economyTargets.spendRatios.tech / 1000);
    console.log(
      `[data-arch] §15.13：支出预算 = ${INCOME_N2} × ${SPEND_BUDGET_PCT / 10}% = ${budget.toFixed(0)}；` +
        `科技 = ${T.constants.economyTargets.spendRatios.tech}‰ × 预算 = ${techTarget.toFixed(0)} → 取整 ${TECH_GRAND_TOTAL.gold}` +
        `（= 收入的 ${((TECH_GRAND_TOTAL.gold / INCOME_N2) * 1000).toFixed(1)}‰，不是 350‰ —— 两个口径必须分开写）`,
    );
    expect(Math.abs(TECH_GRAND_TOTAL.gold - techTarget) / techTarget).toBeLessThan(0.01);
    // 两个口径的换算关系：占预算 35% ⇔ 占收入 29.8%
    const shareOfIncome = TECH_GRAND_TOTAL.gold / INCOME_N2;
    expect(shareOfIncome * (INCOME_N2 / budget)).toBeCloseTo(T.constants.economyTargets.spendRatios.tech / 1000, 2);
  });

  it('逐级造价倍率落在 1.8–2.5（§4.4.1 注：2.0–2.3 递增，允许边界外 10%）；★ 契约 §15.13 已改总额', () => {
    for (const t of T.tech) {
      for (let i = 1; i < t.costPerLevel.length; i++) {
        const prev = t.costPerLevel[i - 1].gold;
        const cur = t.costPerLevel[i].gold;
        if (prev === 0) continue;
        const ratio = cur / prev;
        expect(ratio, `${t.id} 第 ${i + 1} 级倍率 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(1.8);
        expect(ratio, `${t.id} 第 ${i + 1} 级倍率 ${ratio.toFixed(2)}`).toBeLessThanOrEqual(2.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ★ 契约 §14.2：科技树从线性改为乘法（经济可通关性的结构性修复）
// ---------------------------------------------------------------------------

describe('★ tech.json —— 契约 §14.2 的乘法化验算', () => {
  const per = (id: string): number => techById.get(id).effectPerLevel / F;
  const total = (id: string): number => Math.pow(per(id), 5);

  it('4 条乘法线的 5 级总倍率与 §14.2 表格逐条一致', () => {
    expect(total('attack')).toBeCloseTo(7.59, 2); // 1.5^5 = 7.59375
    expect(total('attack_speed')).toBeCloseTo(5.38, 2); // 1.4^5 = 5.37824
    expect(total('range')).toBeCloseTo(1.61, 2); // 1.1^5 = 1.61051
    expect(total('steal_efficiency')).toBeCloseTo(1.76, 2); // 1.12^5 = 1.76234
  });

  it('★ §14.2 的核心验算：tier 52.5× × 攻击 × 攻速 ≥ 血量成长 1373×', () => {
    const dps = 52.5 * total('attack') * total('attack_speed');
    console.log(`[data-arch] §14.2 验算：52.5 × ${total('attack').toFixed(2)} × ${total('attack_speed').toFixed(2)} = ${dps.toFixed(0)}× vs 血量 1373× → 余量 ${(dps / 1373).toFixed(2)}×`);
    expect(dps).toBeGreaterThanOrEqual(1373);
    expect(dps / 1373).toBeCloseTo(1.56, 1); // §14.2 写的余量
  });

  it('★ 反例：若保持原线性（+10% / +8%），则只有 110× ≪ 1373× —— 这正是不可通关的根因', () => {
    const linear = 52.5 * (1 + 5 * 0.1) * (1 + 5 * 0.08);
    console.log(`[data-arch] 旧线性方案的 DPS 成长 = ${linear.toFixed(0)}×，对血量 1373× 缺口 ${(1373 / linear).toFixed(1)}×`);
    expect(linear).toBeLessThan(1373 / 10);
  });

  it('有上限的两条暴击线保持 add，且 cap 与 constants 一致', () => {
    expect(techById.get('steal_crit_rate').effectMode).toBe('add');
    expect(techById.get('steal_crit_rate').effectCap).toBe(T.constants.critRateCap);
    expect(techById.get('steal_crit_mul').effectMode).toBe('add');
    expect(techById.get('steal_crit_mul').effectCap).toBe(T.constants.critMulCap);
    // 加法线叠加后的实际值
    expect(T.constants.critRateBase + 5 * techById.get('steal_crit_rate').effectPerLevel).toBe(300); // 5% → 30%
    expect(T.constants.critMulBase + 5 * techById.get('steal_crit_mul').effectPerLevel).toBe(2750); // 150% → 275%
  });

  it('契约 §14.20：8 条线的 `target` 与 TECH_TARGET 映射表逐条一致（引擎据此删除硬编码表）', () => {
    for (const t of T.tech) {
      expect(t.target, `${t.id}.target`).toBe(TECH_TARGET[t.id as keyof typeof TECH_TARGET]);
    }
    // 8 个槽位恰好覆盖 §14.20 的枚举，无重复
    expect(new Set(T.tech.map((t) => t.target)).size).toBe(8);
  });

  it('契约 §14.2 未列入改乘法的两条（人口 / 基地等级）保持 add', () => {
    expect(techById.get('population').effectMode).toBe('add');
    expect(techById.get('population').effectUnit).toBe('count');
    expect(techById.get('base_level').effectMode).toBe('add');
  });
});

// ---------------------------------------------------------------------------
// §4.7.2 圣物
// ---------------------------------------------------------------------------

describe('relics.json —— 9 个圣物（§4.7.2）', () => {
  it('恰好 9 个', () => {
    expect(T.relics).toHaveLength(9);
  });

  it('固定价格表：起始金库 / 起始木料 / 扩建地基', () => {
    expect(relicById.get('start_gold').crystalCostPerLevel).toEqual([100, 200, 400, 800, 1600]);
    expect(relicById.get('start_wood').crystalCostPerLevel).toEqual([80, 160, 320, 640, 1280]);
    expect(relicById.get('foundation').crystalCostPerLevel).toEqual([300, 600, 1200, 2400, 4800]);
  });

  it('起始金库 +500 金/级、起始木料 +200 木/级、扩建地基 +1 塔位/级（定点）', () => {
    expect(relicById.get('start_gold').effectPerLevel).toBe(500 * F);
    expect(relicById.get('start_gold').effectUnit).toBe('fixed');
    expect(relicById.get('start_wood').effectPerLevel).toBe(200 * F);
    expect(relicById.get('start_wood').effectUnit).toBe('fixed');
    expect(relicById.get('foundation').effectPerLevel).toBe(1);
    expect(relicById.get('foundation').effectUnit).toBe('count');
  });

  it('贪婪之手：10 级、+5%/级、价格 = round(150 × 1.35^(n−1))（§4.7.2 公式）', () => {
    const r = relicById.get('greedy_hand');
    expect(r.maxLevel).toBe(10);
    expect(r.effectPerLevel).toBe(50);
    const expect10 = Array.from({ length: 10 }, (_, i) => Math.round(150 * Math.pow(1.35, i)));
    expect(r.crystalCostPerLevel).toEqual(expect10);
  });

  it('学徒契约：5 级、−10s 领工资 CD、价格 = round(200 × 1.5^(n−1))，满级 90s→40s', () => {
    const r = relicById.get('apprentice_contract');
    expect(r.maxLevel).toBe(5);
    expect(r.effectPerLevel).toBe(10 * F);
    const expect5 = Array.from({ length: 5 }, (_, i) => Math.round(200 * Math.pow(1.5, i)));
    expect(r.crystalCostPerLevel).toEqual(expect5);
    expect(T.constants.salaryCooldown - 5 * r.effectPerLevel).toBe(40000);
  });

  it('4 个解锁类圣物：maxLevel=1、effectPerLevel=0、unlocksUnit 指向真实 unit', () => {
    const unlockRelics = T.relics.filter((r) => r.unlocksUnit);
    expect(unlockRelics).toHaveLength(4);
    expect(unlockRelics.map((r) => [r.id, r.unlocksUnit, r.crystalCostPerLevel[0]])).toEqual([
      ['unlock_iron_gate', 'iron_gate', 1500],
      ['unlock_mermaid_mother', 'mermaid_mother', 2500],
      ['unlock_goldfinger', 'goldfinger', 6000],
      ['unlock_archmage_grandpa', 'archmage_grandpa', 8000],
    ]);
  });
});

// ---------------------------------------------------------------------------
// §4.2.7 装备（M6）
// ---------------------------------------------------------------------------

describe('equipment.json —— 6 件装备（§4.2.7）', () => {
  it('恰好 6 件，价格与效果与策划案一致', () => {
    expect(T.equipment).toHaveLength(6);
    const table = T.equipment.map((e) => ({
      id: e.id,
      name: e.name,
      gold: e.cost.gold / F,
      kind: e.effects[0].kind,
      value: e.effects[0].value,
      targetLine: e.effects[0].targetLine ?? null,
    }));
    expect(table).toEqual([
      { id: 'gold_hook', name: '倒挂金钩', gold: 9000, kind: 'stealPct', value: 1000, targetLine: null },
      { id: 'midas_glove', name: '点金手套', gold: 7500, kind: 'critRate', value: 150, targetLine: null },
      { id: 'gale_boots', name: '疾风靴', gold: 5400, kind: 'speedPct', value: 400, targetLine: null },
      { id: 'ring_of_greed', name: '贪婪之戒', gold: 15000, kind: 'bountyPct', value: 500, targetLine: null },
      { id: 'hourglass', name: '时之沙漏', gold: 13500, kind: 'cooldownPct', value: -200, targetLine: null },
      { id: 'pickpocket_tool', name: '探囊取物', gold: 12000, kind: 'rangePct', value: 150, targetLine: 'thief' },
    ]);
  });

  it('本期全部标记 availableFrom = M6（契约 §3.1：只建表不定数值细节）', () => {
    for (const e of T.equipment) expect(e.availableFrom, e.id).toBe('M6');
  });

  it('策划案 §4.2.7 提到的 6 件装备 id 都在表内（含「荆棘护甲」已随 D4 删除）', () => {
    expect(T.equipment.some((e) => e.name.includes('荆棘'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4.8 难度
// ---------------------------------------------------------------------------

describe('difficulty.json —— N1–N5（§4.8）', () => {
  const PLAN: Record<string, { hp: number; wallet: number; mode: string; gold: number; wood: number; lives: number; lanes: number; crystal: number; divineAll: boolean }> = {
    N1: { hp: 600, wallet: 1400, mode: 'compressed', gold: 3000, wood: 2000, lives: 50, lanes: 2, crystal: 600, divineAll: false },
    N2: { hp: 1000, wallet: 1000, mode: 'compressed', gold: 2000, wood: 1500, lives: 30, lanes: 2, crystal: 1000, divineAll: false },
    N3: { hp: 1600, wallet: 900, mode: 'standard', gold: 1500, wood: 1000, lives: 20, lanes: 4, crystal: 1600, divineAll: false },
    N4: { hp: 2400, wallet: 800, mode: 'standard', gold: 1000, wood: 800, lives: 10, lanes: 4, crystal: 2400, divineAll: false },
    N5: { hp: 3600, wallet: 700, mode: 'standard', gold: 800, wood: 500, lives: 5, lanes: 4, crystal: 3600, divineAll: true },
  };

  for (const [id, p] of Object.entries(PLAN)) {
    it(`${id} 血量/钱包倍率、克制模式、起始资源、生命、路数、难度系数`, () => {
      const d = diffById.get(id);
      expect(d).toBeDefined();
      expect(d.hpMul).toBe(p.hp);
      expect(d.walletMul).toBe(p.wallet);
      expect(d.counterMode).toBe(p.mode);
      expect(d.startGold).toBe(p.gold * F);
      expect(d.startWood).toBe(p.wood * F);
      expect(d.lives).toBe(p.lives);
      expect(d.openLanes).toBe(p.lanes);
      expect(d.crystalMul).toBe(p.crystal);
      expect(d.divineArmorAllWaves).toBe(p.divineAll);
    });
  }

  it('难度越高，钱包倍率越低（§4.8 的核心难度哲学）', () => {
    const wallets = ['N1', 'N2', 'N3', 'N4', 'N5'].map((id) => diffById.get(id).walletMul);
    for (let i = 1; i < wallets.length; i++) expect(wallets[i]).toBeLessThan(wallets[i - 1]);
    const hps = ['N1', 'N2', 'N3', 'N4', 'N5'].map((id) => diffById.get(id).hpMul);
    for (let i = 1; i < hps.length; i++) expect(hps[i]).toBeGreaterThan(hps[i - 1]);
  });

  it('N2 起始资源 == 策划案 §3.1 单局循环图（2000 金 / 1500 木）', () => {
    expect(diffById.get('N2').startGold).toBe(2000 * F);
    expect(diffById.get('N2').startWood).toBe(1500 * F);
  });
});
