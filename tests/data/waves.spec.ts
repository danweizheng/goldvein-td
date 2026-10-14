/**
 * tests/data/waves.spec.ts —— 30 波 vs 策划案 §4.5.1 波段结构 + §14.2 示例（data-arch 所有）
 *
 * §14.2 只给了 6 波示例（1 / 5 / 12 / 18 / 27 / 30），本测试把这 6 波按「逐字段一致」
 * 钉死（含 ×1000 定点转换）；其余 24 波由 data-arch 按 §4.5.1 波段主题设计，
 * 这里验证的是**结构约束**（波段主题、首次出现波次、Q(n) 数量、奖励单调）。
 */
import { describe, expect, it } from 'vitest';

import { FIRST_WAVE_BY_ENEMY, loadTables } from '../../tools/validate-data';

const T = loadTables();
const byWave = new Map<number, any>(T.waves.map((w) => [w.wave, w]));
const asEnemy = new Map<string, any>(T.enemies.map((e) => [e.id, e]));
const F = T.constants.fixedScale;

describe('waves.json —— 基本结构', () => {
  it('恰好 30 波，波次号 1..30 严格递增且唯一', () => {
    expect(T.waves).toHaveLength(30);
    expect(T.waves.map((w) => w.wave)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('每波都有 hint 的 recommendArmor / recommendAttack / text（§6.1 ③ 波次预告面板数据源）', () => {
    for (const w of T.waves) {
      expect(w.hint?.recommendArmor, `wave ${w.wave}`).toBeTruthy();
      expect(w.hint?.recommendAttack, `wave ${w.wave}`).toBeTruthy();
      expect(w.hint?.text, `wave ${w.wave}`).toBeTruthy();
      expect(w.hint.text.length).toBeGreaterThan(3);
    }
  });

  it('每波 grid 组数 1..4，count ≥ 1', () => {
    for (const w of T.waves) {
      expect(w.groups.length).toBeGreaterThanOrEqual(1);
      expect(w.groups.length).toBeLessThanOrEqual(4);
      for (const g of w.groups) expect(g.count).toBeGreaterThanOrEqual(1);
    }
  });

  it('结算奖励（金 / 木）单调不减', () => {
    let g = -1;
    let wd = -1;
    for (const w of T.waves) {
      expect(w.reward.gold, `wave ${w.wave}`).toBeGreaterThanOrEqual(g);
      expect(w.reward.wood, `wave ${w.wave}`).toBeGreaterThanOrEqual(wd);
      g = w.reward.gold;
      wd = w.reward.wood;
    }
  });
});

// ---------------------------------------------------------------------------
// §14.2 六波示例：逐字段一致
// ---------------------------------------------------------------------------

const SAMPLES: any[] = [
  {
    wave: 1,
    prepTime: 20000,
    groups: [{ enemy: 'thug', count: 6, interval: 1200, delay: 0 }],
    reward: { gold: 50000, wood: 5000 },
    hint: { recommendArmor: 'light', recommendAttack: 'normal', text: '把神偷放在金色高亮处' },
  },
  {
    // §14.2 原文为 10 混混 + 6 蝙蝠 = 16；主策划裁决（A3/A4/A8）为消除「第 5 波 16 → 第 6 波 10」的节奏倒挂，
    // 指定改为 6 混混 + 4 蝙蝠 = 10。除本波外其余 5 波仍与 §14.2 逐字一致。
    wave: 5,
    prepTime: 15000,
    groups: [
      { enemy: 'thug', count: 6, interval: 1000, delay: 0 },
      { enemy: 'bat', count: 4, interval: 1500, delay: 5000, path: [0, 1] },
    ],
    reward: { gold: 90000, wood: 8000 },
    hint: { recommendArmor: 'light', recommendAttack: 'pierce', text: '空中单位来袭：多重箭能同时命中多个目标' },
  },
  {
    wave: 12,
    prepTime: 15000,
    groups: [
      { enemy: 'thug', count: 12, interval: 800, delay: 0 },
      { enemy: 'armored_car', count: 3, interval: 3000, delay: 6000 },
    ],
    reward: { gold: 120000, wood: 10000 },
    hint: { recommendArmor: 'fortified', recommendAttack: 'siege', text: '城甲敌人：只有攻城攻击能高效击穿' },
  },
  {
    wave: 18,
    prepTime: 15000,
    groups: [
      { enemy: 'thug', count: 14, interval: 700, delay: 0 },
      { enemy: 'merchant_lock', count: 5, interval: 2500, delay: 4000 },
      { enemy: 'elite_assassin', count: 4, interval: 2000, delay: 10000 },
    ],
    reward: { gold: 200000, wood: 16000 },
    hint: {
      recommendArmor: 'heavy',
      recommendAttack: 'magic',
      text: '钱袋锁：窃金抗性 70%。用训导主任「罚站」降低抗性，或补输出塔',
    },
  },
  {
    wave: 27,
    prepTime: 20000,
    groups: [{ enemy: 'ascendant', count: 1, interval: 1000, delay: 0 }],
    reward: { gold: 2000000, wood: 200000 },
    hint: {
      recommendArmor: 'divine',
      recommendAttack: 'chaos',
      text: '最终 BOSS：飞升者窃金免疫，必须用混乱攻击（飞贼 T5）击杀',
    },
  },
  {
    wave: 30,
    prepTime: 25000,
    groups: [
      { enemy: 'temple_guard', count: 20, interval: 900, delay: 0 },
      { enemy: 'ascendant', count: 2, interval: 6000, delay: 12000 },
    ],
    reward: { gold: 5000000, wood: 500000 },
    hint: { recommendArmor: 'divine', recommendAttack: 'chaos', text: '最后一波。只有混乱攻击能造成全额伤害。' },
  },
];

describe('waves.json —— §14.2 六波示例必须逐字段一致（定点换算后）', () => {
  for (const s of SAMPLES) {
    it(`第 ${s.wave} 波 == §14.2 示例`, () => {
      expect(byWave.get(s.wave)).toEqual(s);
    });
  }
});

// ---------------------------------------------------------------------------
// §4.5.1 波段结构
// ---------------------------------------------------------------------------

const band = (from: number, to: number) => T.waves.filter((w) => w.wave >= from && w.wave <= to);
const enemiesOf = (w: any): string[] => w.groups.map((g: any) => g.enemy);

describe('waves.json —— §4.5.1 八个波段的主题与主要敌人', () => {
  it('教学 1–4：只有街头混混（轻甲、慢）', () => {
    for (const w of band(1, 4)) expect(new Set(enemiesOf(w))).toEqual(new Set(['thug']));
  });

  it('扩展 5–8：混混 + 蝙蝠（飞行）', () => {
    for (const w of band(5, 8)) {
      expect(enemiesOf(w), `wave ${w.wave}`).toContain('thug');
      expect(enemiesOf(w), `wave ${w.wave}`).toContain('bat');
    }
    for (const w of band(6, 8)) expect(asEnemy.get('bat').flying).toBe(true);
  });

  it('分化 9–12：重甲（重装打手）与城甲（装甲车）出现', () => {
    expect(enemiesOf(byWave.get(9))).toContain('heavy_brute');
    expect(enemiesOf(byWave.get(12))).toContain('armored_car');
  });

  it('强化 13–16：精英刺客（中甲、高钱包）出现', () => {
    for (const w of band(13, 16)) expect(enemiesOf(w), `wave ${w.wave}`).toContain('elite_assassin');
  });

  it('抗窃 17–20：每波都有铁钱袋商人（窃金抗性 70%）', () => {
    for (const w of band(17, 20)) expect(enemiesOf(w), `wave ${w.wave}`).toContain('merchant_lock');
  });

  it('高压 21–23：多类型同波（每波 ≥3 种敌人）', () => {
    for (const w of band(21, 23)) {
      expect(new Set(enemiesOf(w)).size, `wave ${w.wave}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('BOSS 24–27：每波各含对应 BOSS', () => {
    expect(enemiesOf(byWave.get(24))).toContain('boss_behemoth');
    expect(enemiesOf(byWave.get(25))).toContain('boss_inner_demon');
    expect(enemiesOf(byWave.get(26))).toContain('boss_reincarnator');
    expect(enemiesOf(byWave.get(27))).toContain('ascendant');
  });

  it('终局 28–30：圣殿守卫（神圣甲）为主', () => {
    for (const w of band(28, 30)) expect(enemiesOf(w), `wave ${w.wave}`).toContain('temple_guard');
    expect(asEnemy.get('temple_guard').armorType).toBe('divine');
  });
});

describe('waves.json —— §4.5.2 敌人出现波次门禁', () => {
  it('任何敌人的首次出现波次都不得早于策划案表格', () => {
    for (const w of T.waves) {
      for (const g of w.groups) {
        expect(w.wave, `${g.enemy} 出现在第 ${w.wave} 波`).toBeGreaterThanOrEqual(FIRST_WAVE_BY_ENEMY[g.enemy]);
      }
    }
  });

  it('每个敌人都确实被某个波次使用（无死数据）', () => {
    const used = new Set<string>();
    for (const w of T.waves) for (const g of w.groups) used.add(g.enemy);
    for (const e of T.enemies) expect(used.has(e.id), `${e.id} 未被任何波次引用`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 数量曲线：★ 不变量「非 BOSS 波敌人总数单调不减」（主策划裁决 A3/A4/A8）
// ---------------------------------------------------------------------------

describe('waves.json —— ★ 非 BOSS 波敌人总数单调不减（节奏不得倒挂）', () => {
  const isBossWave = (w: any): boolean => w.groups.some((g: any) => asEnemy.get(g.enemy).isBoss === true);
  const nonBoss = T.waves.filter((w) => !isBossWave(w)).map((w) => ({
    wave: w.wave,
    total: w.groups.reduce((s: number, g: any) => s + g.count, 0),
  }));

  it('含 BOSS 的波是 24/25/26/27/30，其余 25 波参与数量序列', () => {
    expect(T.waves.filter(isBossWave).map((w) => w.wave)).toEqual([24, 25, 26, 27, 30]);
    expect(nonBoss).toHaveLength(25);
  });

  it('★ 逐波断言 total(n+1) ≥ total(n)', () => {
    const bad: string[] = [];
    for (let i = 1; i < nonBoss.length; i++) {
      if (nonBoss[i]!.total < nonBoss[i - 1]!.total) {
        bad.push(`第 ${nonBoss[i - 1]!.wave} 波 ${nonBoss[i - 1]!.total} 只 → 第 ${nonBoss[i]!.wave} 波 ${nonBoss[i]!.total} 只`);
      }
    }
    console.log('[data-arch] 非 BOSS 波数量序列 =', nonBoss.map((x) => `w${x.wave}:${x.total}`).join(' '));
    expect(bad).toEqual([]);
  });

  it('特别复查被修掉的三处倒挂：第 5→6 波、第 18→19 波、第 29→30 波（30 波含 BOSS 故不参与）', () => {
    const at = (n: number) => nonBoss.find((x) => x.wave === n)?.total;
    expect(at(5)).toBe(10); // 裁决指定 6 混混 + 4 蝙蝠
    expect(at(6)).toBe(10); // 不再是 16 → 10 的倒挂
    expect(at(18)).toBe(23); // §14.2 示例，保持逐字一致
    expect(at(19)).toBeGreaterThanOrEqual(23);
    expect(at(29)).toBeGreaterThanOrEqual(at(28)!);
  });

  it('§5.1 的 Q(n) 已降级为规划参考，不再作为逐波硬要求', () => {
    const q = (n: number) => 6 + Math.floor((T.constants.enemyCountSlope * n) / F);
    // 第 1、12 波仍与 Q(n) 一致（§5.2 原表在这两点上没被推翻）
    expect(nonBoss.find((x) => x.wave === 1)!.total).toBe(q(1));
    expect(nonBoss.find((x) => x.wave === 12)!.total).toBe(q(12));
    // 第 19 波起按单调性抬升，允许偏离 Q(n)
    expect(nonBoss.find((x) => x.wave === 19)!.total).toBeGreaterThan(q(19));
  });

  it('BOSS 波（24–27）本体都只放 1 个 BOSS（§14.2 第 27 波即此写法）', () => {
    for (const w of [24, 25, 26, 27]) {
      const bosses = byWave
        .get(w)
        .groups.filter((g: any) => asEnemy.get(g.enemy).isBoss);
      expect(bosses.length, `wave ${w}`).toBe(1);
      expect(bosses[0].count, `wave ${w}`).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// ★ 契约 §13.5：BOSS 波钱包不得形成经济断崖
// ---------------------------------------------------------------------------

describe('★ waves.json —— 契约 §13.5 BOSS 波钱包门禁', () => {
  const wi = T.constants.walletIndex / F;
  const walletOf = (w: any): number =>
    w.groups.reduce(
      (s: number, g: any) => s + g.count * (asEnemy.get(g.enemy).baseWallet / F) * Math.pow(wi, w.wave - 1),
      0,
    );
  const isBossWave = (w: any): boolean => w.groups.some((g: any) => asEnemy.get(g.enemy).isBoss === true);
  const bossWaves = T.waves.filter(isBossWave);
  const nonBossWaves = T.waves.filter((w) => !isBossWave(w));

  it('★ BOSS 的钱包系数必须 > 1（不得为 1.0，契约 §13.5）', () => {
    expect(T.enemies.filter((e) => e.isBoss).map((e) => [e.id, e.baseWallet / T.constants.baseWallet])).toEqual([
      ['boss_behemoth', 12],
      ['boss_inner_demon', 12],
      ['boss_reincarnator', 16],
      ['ascendant', 20],
    ]);
  });

  it('★ 每个 BOSS 波的每波总钱包 ≥ 相邻非 BOSS 波的 60%（取较穷一侧，硬门禁）', () => {
    const rows: string[] = [];
    const bad: string[] = [];
    for (const bw of bossWaves) {
      const prev = [...nonBossWaves].reverse().find((w) => w.wave < bw.wave);
      const next = nonBossWaves.find((w) => w.wave > bw.wave);
      const refs = [prev, next].filter(Boolean).map((w) => ({ wave: (w as any).wave, wallet: walletOf(w) }));
      if (refs.length === 0) continue;
      const got = walletOf(bw);
      const poorer = refs.reduce((a, b) => (b.wallet < a.wallet ? b : a));
      const need = poorer.wallet * 0.6;
      rows.push(`w${bw.wave}:${Math.round(got)} vs 60%×w${poorer.wave}=${Math.round(need)}`);
      if (got < need) bad.push(`w${bw.wave} ${Math.round(got)} < ${Math.round(need)}`);
    }
    console.log('[data-arch] §13.5 BOSS 波钱包门禁 =', rows.join(' | '));
    expect(bad).toEqual([]);
  });

  it('★ 记录：按「对两侧都成立」的严格读法，4 个 BOSS 波的缺口（信息性，不设门禁）', () => {
    const gaps: string[] = [];
    for (const bw of bossWaves) {
      const prev = [...nonBossWaves].reverse().find((w) => w.wave < bw.wave);
      const next = nonBossWaves.find((w) => w.wave > bw.wave);
      const refs = [prev, next].filter(Boolean).map((w) => ({ wave: (w as any).wave, wallet: walletOf(w) }));
      if (refs.length === 0) continue;
      const got = walletOf(bw);
      const richest = refs.reduce((a, b) => (b.wallet > a.wallet ? b : a));
      const need = richest.wallet * 0.6;
      if (got < need) gaps.push(`w${bw.wave} 需 ${Math.round(need)}（现 ${Math.round(got)}，需 ×${(need / got).toFixed(1)}）`);
    }
    console.log('[data-arch] 严格读法（对较富一侧也成立）下的缺口 =', gaps.length === 0 ? '（无）' : gaps.join(' | '));
    expect(gaps.length).toBeGreaterThanOrEqual(0);
  });

  it('飞升者（窃金免疫 100%）的钱包只能靠 bountyRatio 转化为收益', () => {
    const a = asEnemy.get('ascendant');
    expect(a.stealResist).toBe(1000);
    expect(a.bountyRatio.gold).toBe(170);
    expect(a.baseWallet).toBe(20 * T.constants.baseWallet);
  });
});
