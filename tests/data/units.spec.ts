/**
 * tests/data/units.spec.ts —— 23 种单位 vs 策划案 §4.2 逐条对照（data-arch 所有）
 *
 * 本文件是「数据 == 策划案」的证据：把 §4.2.1–§4.2.6 六张表的每一列都编码成期望值。
 * 特别注意 attackInterval：策划案写的是**频率**（1.0/s），JSON 存的是**间隔秒**（1000）。
 */
import { describe, expect, it } from 'vitest';

import { loadTables, UNITS_PER_LINE } from '../../tools/validate-data';

const T = loadTables();
const byId = new Map<string, any>(T.units.map((u) => [u.id, u]));
const F = T.constants.fixedScale;

/** 6 大战斗塔系（有升级树 + 6 大系数量核对的对象） */
const LINE_6 = ['thief', 'archer', 'mage', 'drill', 'beauty', 'cannon'];

/** 策划案 §4.2 六张表的原始数值（未定点）。freq = 攻速「次/秒」 */
interface PlanUnit {
  line: string;
  tier: number;
  gold: number;
  attack: number;
  freq: number;
  range: number;
  attackType: string;
  stealBase: number;
}

const PLAN: Record<string, PlanUnit> = {
  // §4.2.1 神偷系
  pickpocket: { line: 'thief', tier: 1, gold: 250, attack: 8, freq: 1.0, range: 2.0, attackType: 'normal', stealBase: 4 },
  cutpurse: { line: 'thief', tier: 2, gold: 800, attack: 20, freq: 1.1, range: 2.0, attackType: 'normal', stealBase: 8 },
  master_thief: { line: 'thief', tier: 3, gold: 2500, attack: 45, freq: 1.2, range: 2.2, attackType: 'pierce', stealBase: 14 },
  grandmaster: { line: 'thief', tier: 4, gold: 8000, attack: 110, freq: 1.3, range: 2.4, attackType: 'pierce', stealBase: 26 },
  goldfinger: { line: 'thief', tier: 5, gold: 25000, attack: 280, freq: 1.5, range: 3.0, attackType: 'chaos', stealBase: 55 },
  // §4.2.2 弓箭系
  archer: { line: 'archer', tier: 1, gold: 200, attack: 14, freq: 0.9, range: 5.5, attackType: 'pierce', stealBase: 0 },
  multi_archer: { line: 'archer', tier: 2, gold: 600, attack: 26, freq: 1.0, range: 6.0, attackType: 'pierce', stealBase: 0 },
  archer_mom: { line: 'archer', tier: 3, gold: 1800, attack: 50, freq: 1.1, range: 6.5, attackType: 'pierce', stealBase: 0 },
  principal_mom: { line: 'archer', tier: 4, gold: 5000, attack: 95, freq: 1.2, range: 7.0, attackType: 'pierce', stealBase: 0 },
  // §4.2.3 法师系
  mage: { line: 'mage', tier: 1, gold: 300, attack: 12, freq: 0.8, range: 4.5, attackType: 'magic', stealBase: 0 },
  shaman: { line: 'mage', tier: 2, gold: 900, attack: 24, freq: 0.9, range: 5.0, attackType: 'magic', stealBase: 0 },
  watcher: { line: 'mage', tier: 3, gold: 2200, attack: 40, freq: 1.0, range: 5.0, attackType: 'magic', stealBase: 0 },
  mage_dad: { line: 'mage', tier: 4, gold: 5500, attack: 75, freq: 1.0, range: 5.5, attackType: 'magic', stealBase: 0 },
  archmage_grandpa: { line: 'mage', tier: 5, gold: 14000, attack: 140, freq: 1.1, range: 6.0, attackType: 'magic', stealBase: 0 },
  // §4.2.4 军训系
  drill_instructor: { line: 'drill', tier: 1, gold: 350, attack: 26, freq: 1.0, range: 1.8, attackType: 'normal', stealBase: 0 },
  iron_gate: { line: 'drill', tier: 2, gold: 1500, attack: 55, freq: 1.1, range: 2.0, attackType: 'normal', stealBase: 0 },
  discipline_dean: { line: 'drill', tier: 2, gold: 1500, attack: 70, freq: 1.0, range: 2.0, attackType: 'magic', stealBase: 0 },
  // §4.2.5 美女系
  ice_beauty: { line: 'beauty', tier: 1, gold: 400, attack: 18, freq: 0.9, range: 4.0, attackType: 'magic', stealBase: 0 },
  mermaid: { line: 'beauty', tier: 2, gold: 1600, attack: 60, freq: 1.0, range: 4.5, attackType: 'magic', stealBase: 0 },
  mermaid_mother: { line: 'beauty', tier: 3, gold: 7000, attack: 130, freq: 1.1, range: 5.0, attackType: 'magic', stealBase: 0 },
  // §4.2.6 炮塔系
  cannon_tower: { line: 'cannon', tier: 1, gold: 450, attack: 55, freq: 0.6, range: 5.0, attackType: 'siege', stealBase: 0 },
  howitzer: { line: 'cannon', tier: 2, gold: 1800, attack: 130, freq: 0.7, range: 6.0, attackType: 'siege', stealBase: 0 },
  hellfire: { line: 'cannon', tier: 3, gold: 8000, attack: 300, freq: 0.8, range: 7.0, attackType: 'siege', stealBase: 0 },

  // ---- 主策划裁决（Blocker 1/2）后并入 units.json 的经济 / 功能系 ----
  // §4.2.8 工人：非攻击单位（attack=0），range = 点金术作用半径
  worker: { line: 'worker', tier: 1, gold: 150, attack: 0, freq: 1.0, range: 2.0, attackType: 'normal', stealBase: 0 },
  // §4.1.3 四档小精灵：非攻击单位（attack=0 / range=0），产能由 wood_gather 的 cooldown + params.woodPerCycle 表达
  sprite_clumsy: { line: 'sprite', tier: 1, gold: 1200, attack: 0, freq: 1.0, range: 0, attackType: 'normal', stealBase: 0 },
  sprite_indulgent: { line: 'sprite', tier: 1, gold: 2200, attack: 0, freq: 1.0, range: 0, attackType: 'normal', stealBase: 0 },
  sprite_common: { line: 'sprite', tier: 1, gold: 4800, attack: 0, freq: 1.0, range: 0, attackType: 'normal', stealBase: 0 },
  sprite_advanced: { line: 'sprite', tier: 1, gold: 9000, attack: 0, freq: 1.0, range: 0, attackType: 'normal', stealBase: 0 },
  // §4.4.1 科技塔：策划案只给「建造后解锁局内科技」，造价/射程为 data-arch 推断
  tech_tower: { line: 'tech', tier: 1, gold: 1000, attack: 0, freq: 1.0, range: 0, attackType: 'normal', stealBase: 0 },
};

describe('units.json —— 数量与塔系结构（§4.2 + 裁决后的 3 个经济系）', () => {
  it('恰好 29 种单位（23 战斗塔 + 工人 + 4 小精灵 + 科技塔）', () => {
    expect(T.units).toHaveLength(29);
    expect(T.units.filter((u) => LINE_6.includes(u.line))).toHaveLength(23);
    expect(T.units.filter((u) => u.line === 'worker')).toHaveLength(1);
    expect(T.units.filter((u) => u.line === 'sprite')).toHaveLength(4);
    expect(T.units.filter((u) => u.line === 'tech')).toHaveLength(1);
  });

  it('6 大战斗塔系数量 = 5/4/5/3/3/3；9 系合计 = 29（§4.2 数量核对 + 裁决）', () => {
    let sum = 0;
    for (const [line, n] of Object.entries(UNITS_PER_LINE)) {
      expect(T.units.filter((u) => u.line === line).length, line).toBe(n);
      sum += n;
    }
    expect(sum).toBe(29);
  });

  it('本期不含 hero 系（决策 D5：英雄压到 M6）', () => {
    expect(T.units.some((u) => u.line === 'hero')).toBe(false);
  });

  it('id 集合与预期表格完全一致（无多、无缺）', () => {
    expect([...byId.keys()].sort()).toEqual(Object.keys(PLAN).sort());
  });
});

describe('units.json —— 逐字段对照策划案 §4.2', () => {
  for (const [id, p] of Object.entries(PLAN)) {
    it(`${id}（${p.line} T${p.tier}）造价/攻击/射程/攻击类型/窃金系数`, () => {
      const u = byId.get(id);
      expect(u, `${id} 不存在`).toBeDefined();
      expect(u.line).toBe(p.line);
      expect(u.tier).toBe(p.tier);
      expect(u.cost.gold).toBe(p.gold * F);
      expect(u.cost.wood).toBe(0);
      expect(u.attack).toBe(p.attack * F);
      expect(u.range).toBe(Math.round(p.range * F));
      expect(u.attackType).toBe(p.attackType);
      expect(u.stealBase).toBe(p.stealBase * F);
      expect(u.sellsFor).toBe(700);
    });
  }
});

describe('★ attackInterval —— 频率 → 间隔秒的倒数转换（评审必查项）', () => {
  it('契约 §3.2 点名的 5 个例句必须精确命中', () => {
    expect(byId.get('pickpocket').attackInterval).toBe(1000); // 1.0/s
    expect(byId.get('cannon_tower').attackInterval).toBe(1667); // 0.6/s
    expect(byId.get('master_thief').attackInterval).toBe(833); // 1.2/s
    expect(byId.get('mage').attackInterval).toBe(1250); // 0.8/s
    expect(byId.get('archer').attackInterval).toBe(1111); // 0.9/s
  });

  it('全部 29 个单位都满足 round(1000 / 频率)（非攻击单位按 1.0/s 占位 = 1000）', () => {
    for (const [id, p] of Object.entries(PLAN)) {
      expect(byId.get(id).attackInterval, `${id} @ ${p.freq}/s`).toBe(Math.round(1000 / p.freq));
    }
    expect(Object.keys(PLAN)).toHaveLength(29);
  });

  it('没有任何单位把频率直接当成间隔写进 JSON（<=500 一律视为漏转换）', () => {
    for (const u of T.units) {
      expect(u.attackInterval, `${u.id} attackInterval=${u.attackInterval} 看起来像频率而非间隔`).toBeGreaterThanOrEqual(600);
    }
  });
});

describe('units.json —— 军训系 / 光环 / 升级图', () => {
  it('三个军训单位都有阻挡名额与「列阵」减速（Q1 联动的前提）', () => {
    expect(byId.get('drill_instructor').block).toBe(3);
    expect(byId.get('iron_gate').block).toBe(6);
    expect(byId.get('discipline_dean').block).toBe(2);
    for (const id of ['drill_instructor', 'iron_gate', 'discipline_dean']) {
      expect(byId.get(id).slowWhileBlocked, id).toBe(400);
    }
  });

  it('非军训单位阻挡为 0', () => {
    for (const u of T.units) {
      if (u.line !== 'drill') expect(u.block, u.id).toBe(0);
    }
  });

  it('法师系光环：萨满 +25% 攻击 / 守望者 +30% 攻速 / 法师老爸 −40% 敌移速', () => {
    expect(byId.get('shaman').auras).toEqual([{ kind: 'attackPct', value: 250, radius: 4000, affects: 'allyTower' }]);
    expect(byId.get('watcher').auras).toEqual([{ kind: 'speedPct', value: 300, radius: 4000, affects: 'allyTower' }]);
    expect(byId.get('mage_dad').auras).toEqual([{ kind: 'slowPct', value: 400, radius: 5000, affects: 'enemy' }]);
  });

  it('★ 裁决：单对象 aura 已弃用 —— 全表 0 处 `aura`，只有 auras[]', () => {
    for (const u of T.units) {
      expect(Object.prototype.hasOwnProperty.call(u, 'aura'), `${u.id} 仍有废弃的 aura 字段`).toBe(false);
    }
    expect(T.units.some((u) => Array.isArray(u.auras))).toBe(true);
  });

  it('法师爷爷三效果（全图 +15% 攻击/+15% 攻速/+10% 射程）全部落在 auras 列表', () => {
    expect(byId.get('archmage_grandpa').auras).toEqual([
      { kind: 'allPct', value: 150, radius: 0, affects: 'allyTower' },
      { kind: 'rangePct', value: 100, radius: 0, affects: 'allyTower' },
    ]);
  });

  it('训导主任「罚站」双效果：敌人 −25% 窃金抗性 + 周围神偷系 +20% 窃金效率', () => {
    const d = byId.get('discipline_dean');
    expect(d.auras).toEqual([
      { kind: 'stealResistDebuff', value: 250, radius: 4000, affects: 'enemy' },
      { kind: 'stealPct', value: 200, radius: 4000, affects: 'allyTower' },
    ]);
  });

  it('升级图与策划案一致（军训系 T1 二选一分支）', () => {
    const edges: Record<string, string[]> = {};
    for (const u of T.units) if (u.upgradesTo) edges[u.id] = u.upgradesTo;
    expect(edges).toEqual({
      pickpocket: ['cutpurse'],
      cutpurse: ['master_thief'],
      master_thief: ['grandmaster'],
      grandmaster: ['goldfinger'],
      archer: ['multi_archer'],
      multi_archer: ['archer_mom'],
      archer_mom: ['principal_mom'],
      mage: ['shaman'],
      shaman: ['watcher'],
      watcher: ['mage_dad'],
      mage_dad: ['archmage_grandpa'],
      drill_instructor: ['iron_gate', 'discipline_dean'],
      ice_beauty: ['mermaid'],
      mermaid: ['mermaid_mother'],
      cannon_tower: ['howitzer'],
      howitzer: ['hellfire'],
    });
  });

  it('窃金塔的暴击基准来自 constants（critRate=50 / critMul=1500），非窃金塔为 0/1000', () => {
    for (const u of T.units) {
      if (u.stealBase > 0) {
        expect(u.critRate, u.id).toBe(T.constants.critRateBase);
        expect(u.critMul, u.id).toBe(T.constants.critMulBase);
      } else {
        expect(u.critRate, u.id).toBe(0);
        expect(u.critMul, u.id).toBe(1000);
      }
    }
  });

  it('技能参数（列阵/锁链/点金术/多重箭）与策划案一致', () => {
    const abil = (id: string, abilityId: string) =>
      byId.get(id).abilities.find((a: any) => a.id === abilityId);
    expect(abil('drill_instructor', 'phalanx').params).toEqual({ slowPct: 400 });
    expect(abil('iron_gate', 'chain_pull')).toEqual({
      id: 'chain_pull',
      cooldown: 15000,
      params: { targets: 1, pullCells: 3000 },
    });
    expect(abil('grandmaster', 'midas_touch')).toEqual({
      id: 'midas_touch',
      cooldown: 20000,
      params: { hpThresholdPct: 150, fullWalletSteal: 1 },
    });
    expect(abil('multi_archer', 'multishot').params).toEqual({ targets: 2 });
    expect(abil('archer_mom', 'multishot').params).toEqual({ targets: 3 });
    expect(abil('principal_mom', 'multishot').params).toEqual({ targets: 4 });
    expect(abil('principal_mom', 'bounce').params).toEqual({ bounces: 1 });
    expect(abil('cannon_tower', 'splash').params).toEqual({ splashRadiusCells: 1200 });
    expect(abil('howitzer', 'splash').params).toEqual({ splashRadiusCells: 1800 });
    expect(abil('hellfire', 'splash_burn').params).toEqual({ splashRadiusCells: 2500, burnSec: 5000 });
    expect(abil('ice_beauty', 'frost_hit').params).toEqual({ slowPct: 250, durationSec: 2000 });
    expect(abil('mermaid', 'group_slow').params).toEqual({ slowPct: 350, splashRadiusCells: 1200 });
  });
});

describe('units.json —— 裁决后新增的 3 个经济/功能系（Blocker 1/2）', () => {
  it('工人（§4.2.8）：点金术 血量 <8% / CD 15s，非攻击单位', () => {
    const w = byId.get('worker');
    expect(w.line).toBe('worker');
    expect(w.cost.gold).toBe(150 * F);
    expect(w.attack).toBe(0);
    const midas = w.abilities.find((a: any) => a.id === 'midas_touch');
    expect(midas).toEqual({ id: 'midas_touch', cooldown: 15000, params: { hpThresholdPct: 80, fullWalletSteal: 1 } });
    expect(w.abilities.map((a: any) => a.id)).toEqual(['midas_touch', 'build_boost', 'wood_gather']);
  });

  it('★ 四档小精灵（§4.1.3）：造价与「间隔 / 产量」逐档精确一致', () => {
    const plan: Record<string, { gold: number; woodPerCycle: number; cycleMs: number }> = {
      sprite_clumsy: { gold: 1200, woodPerCycle: 1000, cycleMs: 5000 },
      sprite_indulgent: { gold: 2200, woodPerCycle: 2000, cycleMs: 5000 },
      sprite_common: { gold: 4800, woodPerCycle: 1000, cycleMs: 1000 },
      sprite_advanced: { gold: 9000, woodPerCycle: 2000, cycleMs: 1000 },
    };
    for (const [id, p] of Object.entries(plan)) {
      const u = byId.get(id);
      expect(u.line, id).toBe('sprite');
      expect(u.cost.gold, id).toBe(p.gold * F);
      const g = u.abilities.find((a: any) => a.id === 'wood_gather');
      expect(g, `${id} 缺 wood_gather`).toBeDefined();
      expect(g.cooldown, `${id} 产木周期`).toBe(p.cycleMs);
      expect(g.params.woodPerCycle, `${id} 每周期产木`).toBe(p.woodPerCycle);
    }
  });

  it('★ 四档小精灵的性价比（木/min/金）单调递增，复现 §4.1.3 的 0.0100 → 0.0133', () => {
    const ratio = (id: string): number => {
      const u = byId.get(id);
      const g = u.abilities.find((a: any) => a.id === 'wood_gather');
      const woodPerMin = (g.params.woodPerCycle / F) * (60000 / g.cooldown);
      return woodPerMin / (u.cost.gold / F);
    };
    const got = ['sprite_clumsy', 'sprite_indulgent', 'sprite_common', 'sprite_advanced'].map(ratio);
    const want = [0.0100, 0.0109, 0.0125, 0.0133];
    got.forEach((v, i) => expect(v, `第 ${i + 1} 档`).toBeCloseTo(want[i]!, 4));
    for (let i = 1; i < got.length; i++) expect(got[i]!, `第 ${i + 1} 档未高于上一档`).toBeGreaterThan(got[i - 1]!);
  });

  it('科技塔（§4.4.1）：解锁局内科技面板；造价与射程为推断值', () => {
    const t = byId.get('tech_tower');
    expect(t.line).toBe('tech');
    expect(t.cost.gold).toBe(1000 * F);
    expect(t.abilities).toEqual([{ id: 'tech_unlock', cooldown: 0, params: { panel: 1 } }]);
  });

  it('3 个经济系都是并列可建造项：无 upgradesTo、无阻挡、无窃金', () => {
    for (const u of T.units.filter((x) => ['worker', 'sprite', 'tech'].includes(x.line))) {
      expect(u.upgradesTo, `${u.id} 不应有 upgradesTo`).toBeUndefined();
      expect(u.block, u.id).toBe(0);
      expect(u.stealBase, u.id).toBe(0);
      expect(u.sellsFor, u.id).toBe(700);
    }
  });
});

describe('铁律 3 —— 全表不得出现浮点数', () => {
  const allTables: Array<[string, unknown]> = [
    ['units.json', T.units],
    ['enemies.json', T.enemies],
    ['waves.json', T.waves],
    ['tech.json', T.tech],
    ['relics.json', T.relics],
    ['equipment.json', T.equipment],
    ['difficulty.json', T.difficulty],
    ['constants.json', T.constants],
  ];

  function findFloats(value: unknown, path: string, out: string[]): void {
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) out.push(`${path} = ${value}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => findFloats(v, `${path}[${i}]`, out));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) findFloats(v, `${path}.${k}`, out);
    }
  }

  for (const [name, table] of allTables) {
    it(`${name} 所有 number 都是整数`, () => {
      const bad: string[] = [];
      findFloats(table, name, bad);
      expect(bad).toEqual([]);
    });
  }
});
