/**
 * tests/data/enemies.spec.ts —— 11 类敌人 vs 策划案 §4.5.2（data-arch 所有）
 */
import { describe, expect, it } from 'vitest';

import { FIRST_WAVE_BY_ENEMY, loadTables } from '../../tools/validate-data';

const T = loadTables();
const byId = new Map<string, any>(T.enemies.map((e) => [e.id, e]));
const F = T.constants.fixedScale;

/**
 * 策划案 §4.5.2 敌人类型表。
 * speedClass 对应 §4.6「慢速敌人通过需 ~20s，快速 ~10s」（路径 40 格）：
 *   很慢 = 1.2 格/s、慢 = 2.0 格/s、中 = 3.0 格/s、快 = 4.0 格/s
 * walletCoef = 策划案「钱包系数」列；baseWallet = constants.baseWallet × walletCoef
 *   （4 个 BOSS 的「钱包系数」列策划案写「—」→ 取 1.0，即不带系数）
 * hpCoef = 策划案未给具体值，由 data-arch 推断（见汇报），规则：
 *   普通敌人 0.7–2.5，按「高血量 / 极高血量」定性描述排序（基准 thug = 1.0）；
 *   BOSS 取同波基准血的 4–8 倍（转生者因复活一次等效 ×1.5，故本体取 4）。
 *   ⚠ 这套系数会放大 §5.1 的血量曲线；主策划已把基线压平（baseHp 40→60、hpIndex 1380→1283），仍需 headless 标定。
 */
interface PlanEnemy {
  armor: string;
  speed: number;
  flying: boolean;
  stealResist: number;
  dodge: number;
  walletCoef: number;
  hpCoef: number;
  isBoss: boolean;
  firstWave: number;
}

const PLAN: Record<string, PlanEnemy> = {
  thug: { armor: 'light', speed: 2000, flying: false, stealResist: 0, dodge: 0, walletCoef: 1.0, hpCoef: 1.0, isBoss: false, firstWave: 1 },
  bat: { armor: 'light', speed: 4000, flying: true, stealResist: 0, dodge: 0, walletCoef: 1.1, hpCoef: 0.7, isBoss: false, firstWave: 5 },
  heavy_brute: { armor: 'heavy', speed: 2000, flying: false, stealResist: 0, dodge: 0, walletCoef: 1.3, hpCoef: 1.8, isBoss: false, firstWave: 9 },
  armored_car: { armor: 'fortified', speed: 1200, flying: false, stealResist: 0, dodge: 0, walletCoef: 2.0, hpCoef: 2.5, isBoss: false, firstWave: 12 },
  elite_assassin: { armor: 'medium', speed: 4000, flying: false, stealResist: 0, dodge: 150, walletCoef: 2.5, hpCoef: 1.2, isBoss: false, firstWave: 13 },
  merchant_lock: { armor: 'heavy', speed: 3000, flying: false, stealResist: 700, dodge: 0, walletCoef: 2.0, hpCoef: 2.0, isBoss: false, firstWave: 17 },
  temple_guard: { armor: 'divine', speed: 3000, flying: false, stealResist: 0, dodge: 0, walletCoef: 3.0, hpCoef: 2.5, isBoss: false, firstWave: 28 },
  boss_behemoth: { armor: 'fortified', speed: 2000, flying: false, stealResist: 0, dodge: 0, walletCoef: 12, hpCoef: 6, isBoss: true, firstWave: 24 },
  // 策划案原文写「英雄甲」（5 类护甲枚举中不存在）；主策划裁决改为 medium（中甲）：
  // 中甲抵抗穿刺/魔法/攻城、只弱于普通与混乱 → 惩罚 AoE、奖励单体爆发，并逼玩家建军训系（强化 Q1）
  boss_inner_demon: { armor: 'medium', speed: 3000, flying: false, stealResist: 0, dodge: 0, walletCoef: 12, hpCoef: 6, isBoss: true, firstWave: 25 },
  boss_reincarnator: { armor: 'divine', speed: 3000, flying: false, stealResist: 0, dodge: 0, walletCoef: 16, hpCoef: 4, isBoss: true, firstWave: 26 },
  ascendant: { armor: 'divine', speed: 4000, flying: true, stealResist: 1000, dodge: 0, walletCoef: 20, hpCoef: 8, isBoss: true, firstWave: 27 },
};

describe('enemies.json —— 数量与 id', () => {
  it('恰好 11 类敌人', () => {
    expect(T.enemies).toHaveLength(11);
  });

  it('id 集合与策划案 §4.5.2 一致（含 §14.2 示例使用的 7 个 id）', () => {
    expect([...byId.keys()].sort()).toEqual(Object.keys(PLAN).sort());
  });

  it('§14.2 示例里用到的敌人 id 全部存在（thug/bat/armored_car/elite_assassin/merchant_lock/temple_guard/ascendant）', () => {
    for (const id of ['thug', 'bat', 'armored_car', 'elite_assassin', 'merchant_lock', 'temple_guard', 'ascendant']) {
      expect(byId.has(id), id).toBe(true);
    }
  });

  it('4 个 BOSS', () => {
    expect(T.enemies.filter((e) => e.isBoss).map((e) => e.id).sort()).toEqual([
      'ascendant',
      'boss_behemoth',
      'boss_inner_demon',
      'boss_reincarnator',
    ]);
  });
});

describe('enemies.json —— 逐字段对照策划案 §4.5.2', () => {
  for (const [id, p] of Object.entries(PLAN)) {
    it(`${id} 护甲/移速/飞行/抗性/闪避/钱包系数`, () => {
      const e = byId.get(id);
      expect(e, `${id} 不存在`).toBeDefined();
      expect(e.armorType).toBe(p.armor);
      expect(e.speed).toBe(p.speed);
      expect(e.flying).toBe(p.flying);
      expect(e.stealResist).toBe(p.stealResist);
      expect(e.dodge).toBe(p.dodge);
      expect(e.isBoss).toBe(p.isBoss);
      // 钱包系数：baseWallet = constants.baseWallet（第 1 波基准 32）× 系数（定点）
      expect(e.baseWallet).toBe(Math.round(T.constants.baseWallet * p.walletCoef));
      // HP 系数（策划案未给绝对值，只有定性描述）
      expect(e.baseHp).toBe(Math.round(T.constants.baseHp * p.hpCoef));
    });
  }

  it('飞升者 = 飞行 + 窃金免疫 100%（§4.5.2 原文）', () => {
    const a = byId.get('ascendant');
    expect(a.flying).toBe(true);
    expect(a.stealResist).toBe(1000);
    expect(a.hooks).toContain('steal_immune');
  });

  it('铁钱袋商人 = 窃金抗性 70% + 钱包 ×2', () => {
    const m = byId.get('merchant_lock');
    expect(m.stealResist).toBe(700);
    expect(m.baseWallet).toBe(2 * T.constants.baseWallet);
  });

  it('精英刺客 = 闪避 15% + 钱包 ×2.5', () => {
    const a = byId.get('elite_assassin');
    expect(a.dodge).toBe(150);
    expect(a.baseWallet).toBe(Math.round(2.5 * T.constants.baseWallet));
  });

  it('BOSS 机制钩子：荒兽提速光环 / 心魔分裂 / 转生者复活 / 飞升者窃金免疫', () => {
    expect(byId.get('boss_behemoth').hooks).toContain('aura_speed');
    expect(byId.get('boss_inner_demon').hooks).toContain('split');
    expect(byId.get('boss_reincarnator').hooks).toContain('revive');
    expect(byId.get('ascendant').hooks).toContain('steal_immune');
    for (const id of ['boss_behemoth', 'boss_inner_demon', 'boss_reincarnator', 'ascendant']) {
      expect(byId.get(id).hooks, id).toContain('boss_drop');
    }
  });

  it('击杀奖励是**比率字段** `bountyRatio`（千分比，占当波钱包），11 条全部 170‰ / 0‰', () => {
    for (const e of T.enemies) {
      expect(e.bountyRatio, `${e.id} 缺 bountyRatio`).toEqual({ gold: 170, wood: 0 });
      expect(Object.prototype.hasOwnProperty.call(e, 'bounty'), `${e.id} 仍有被契约修订掉的 bounty 字段`).toBe(false);
    }
  });

  it('★ 若 bountyRatio 乘以当波钱包，则全局击杀奖励 = 理论钱包的 15–20%（§4.1.1 目标）', () => {
    const wi = T.constants.walletIndex / T.constants.fixedScale;
    const byId2 = new Map<string, any>(T.enemies.map((e) => [e.id, e]));
    let wallet = 0;
    let bounty = 0;
    for (const w of T.waves as any[]) {
      for (const g of w.groups) {
        const e = byId2.get(g.enemy);
        const scale = Math.pow(wi, w.wave - 1);
        wallet += g.count * (e.baseWallet / T.constants.fixedScale) * scale;
        bounty += g.count * ((e.bountyRatio.gold * e.baseWallet) / 1000 / T.constants.fixedScale) * scale;
      }
    }
    const ratio = bounty / wallet;
    console.log('[data-arch] 击杀奖励 / 理论钱包 =', (ratio * 100).toFixed(2) + '%（§4.1.1 目标 15–20%）');
    expect(ratio).toBeGreaterThanOrEqual(0.15);
    expect(ratio).toBeLessThanOrEqual(0.2);
  });

  it('反例证据：若把 bountyRatio 当绝对值（不乘钱包），全局击杀奖励只有 ~1.4 金级别 → 必然违反 §4.1.1', () => {
    let flat = 0;
    for (const w of T.waves as any[]) {
      for (const g of w.groups) flat += g.count * (byId.get(g.enemy).bountyRatio.gold / T.constants.fixedScale);
    }
    expect(Math.round(flat)).toBeLessThan(6000);
  });

  it('出现波次表（§4.5.2）与 validator 的门禁表一致', () => {
    for (const [id, p] of Object.entries(PLAN)) {
      expect(FIRST_WAVE_BY_ENEMY[id], id).toBe(p.firstWave);
    }
  });
});
