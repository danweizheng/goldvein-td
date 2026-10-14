/**
 * 策略与门禁的单测
 *
 * 核心断言有两类：
 *   1. **契约遵守**：策略只产出契约 §5 的 `Command`，且不直接改世界状态；
 *   2. **策略语义**：`noop` 只造神偷系、`noblock` 绝不建军训系、`greedy` 真的买最贵的。
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../../src/balance/data-adapter';
import { runOne } from '../../src/balance/run';
import { createStrategy, isStrategyId, STRATEGY_IDS } from '../../src/balance/strategies/index';
import { buildBalancedPlan, MAIN_ROWS, EXTRA_ROWS } from '../../src/balance/strategies/balanced';
import { buildNoopPlan } from '../../src/balance/strategies/noop';
import { validatePlan } from '../../src/balance/strategies/plan';
import { createWorldWithContent, snapshot } from '../../src/sim/world';
import { rootUnitIds } from '../../src/balance/strategies/common';
import { step, drainEvents } from '../../src/sim/tick';
import type { Command } from '../../src/sim/commands';
import type { AttackType, DifficultyId } from '../../src/sim/content';

const content = loadRealContent();

const VALID_COMMAND_TYPES = new Set([
  'build',
  'upgrade',
  'sell',
  'undo',
  'relocate',
  'activateSkill',
  'setSpeed',
  'pause',
  'resume',
  'ascend',
  'research', // 契约 §14.2 新增
]);

function drive(strategyId: (typeof STRATEGY_IDS)[number], difficultyId: DifficultyId, ticks: number): Command[] {
  const w = createWorldWithContent(
    { seed: 7, difficultyId, relics: {}, techArchive: {} },
    content,
  );
  const strategy = createStrategy(strategyId);
  const seen: Command[] = [];
  for (let t = 0; t < ticks && w.status === 'running'; t++) {
    let cmds: readonly Command[] = [];
    if (t % 15 === 0) {
      cmds = strategy.decide({ snap: snapshot(w), content, difficultyId });
      for (const c of cmds) seen.push(c);
    }
    step(w, cmds);
    drainEvents(w);
  }
  return seen;
}

describe('策略注册表', () => {
  it('5 种内置策略（策划案 §10.2）+ 1 种 M2 新增（缺口驱动，主策划裁决 2 主线）', () => {
    expect([...STRATEGY_IDS].sort()).toEqual(['balanced', 'gap', 'greedy', 'heuristic', 'noblock', 'noop']);
  });

  it('未知名报错而不是静默返回空策略', () => {
    expect(isStrategyId('nope')).toBe(false);
    expect(() => createStrategy('nope' as never)).toThrow();
  });

  it('每次 createStrategy 都返回新实例（策略持有单局状态）', () => {
    expect(createStrategy('balanced')).not.toBe(createStrategy('balanced'));
  });
});

describe('策略只发契约 §5 的 Command', () => {
  for (const id of STRATEGY_IDS) {
    it(`${id} @ N2 只产出合法指令且不被模拟层拒绝`, () => {
      const cmds = drive(id, 'N2', 4000);
      expect(cmds.length).toBeGreaterThan(0);
      for (const c of cmds) expect(VALID_COMMAND_TYPES.has(c.type)).toBe(true);
    });
  }
});

describe('策略语义', () => {
  it('noop 只建/升神偷系，绝不出其它塔系', () => {
    const plan = buildNoopPlan(2);
    const thief = new Set(['pickpocket', 'cutpurse', 'master_thief', 'grandmaster', 'goldfinger']);
    for (const s of plan) {
      if (s.kind === 'research') continue; // 纯偷流允许研究窃金侧科技（见 noop.ts 的说明）
      expect(thief.has(s.unitId)).toBe(true);
      expect(s.tag).toBe('economy');
    }
    expect(plan.some((s) => s.kind === 'research')).toBe(true);
  });

  it('noblock 的清单里没有任何军训系', () => {
    const blockPlan = buildBalancedPlan({ lanes: 4, allowBlock: true });
    const noBlockPlan = buildBalancedPlan({ lanes: 4, allowBlock: false });
    expect(blockPlan.some((s) => s.unitId === 'drill_instructor')).toBe(true);
    expect(noBlockPlan.some((s) => s.unitId.includes('drill') || s.unitId.includes('iron_gate') || s.unitId.includes('discipline'))).toBe(false);
    expect(noBlockPlan.length).toBeLessThan(blockPlan.length);
  });

  it('noblock 的实际跑批里也确实不造军训系', () => {
    const cmds = drive('noblock', 'N2', 3000);
    const built = cmds.filter((c): c is Extract<Command, { type: 'build' }> => c.type === 'build').map((c) => c.unitId);
    for (const u of built) {
      expect(['drill_instructor', 'iron_gate', 'discipline_dean']).not.toContain(u);
    }
  });

  it('balanced 会建军训系（否则 Q1 对照实验没有意义）', () => {
    const plan = buildBalancedPlan({ lanes: 2, allowBlock: true });
    expect(plan.some((s) => s.unitId === 'drill_instructor')).toBe(true);
  });

  it('greedy 的行为是「买最贵的」：首条指令 = 当前买得起的最贵动作（造价从快照算出，不硬编码）', () => {
    // ⚠️ 不硬编码任何造价：科技/单位的价格由 data-arch 维护，硬编码会在上游调参时反复误报。
    const w = createWorldWithContent({ seed: 7, difficultyId: 'N2', relics: {}, techArchive: {} }, content);
    const snap = snapshot(w);

    // 当前买得起的动作里，造价的**理论最大值**
    const roots = rootUnitIds(content);
    let maxCost = 0;
    for (const id of roots) {
      const def = content.units[id];
      if (def && def.costGold <= snap.gold && def.costWood <= snap.wood) maxCost = Math.max(maxCost, def.costGold);
    }
    for (const t of snap.techs) {
      if (!t.unimplemented && t.level < t.maxLevel && t.affordable) maxCost = Math.max(maxCost, t.nextGold);
    }
    expect(maxCost, '起始局面应当至少有一个买得起的动作').toBeGreaterThan(0);

    const strategy = createStrategy('greedy');
    const first = strategy.decide({ snap, content, difficultyId: 'N2' }).find((c) => c.type !== 'activateSkill');
    expect(first, 'greedy 应当发出至少一条非技能指令').toBeDefined();

    let actual = 0;
    if (first?.type === 'build') actual = content.units[first.unitId]?.costGold ?? 0;
    else if (first?.type === 'research') actual = snap.techs.find((t) => t.id === first.techId)?.nextGold ?? 0;
    else if (first?.type === 'upgrade') {
      const tower = snap.towers.find((t) => t.id === first.towerId);
      const nextId = tower ? content.units[tower.unitId]?.upgradeTo : null;
      actual = nextId ? (content.units[nextId]?.costGold ?? 0) : 0;
    }
    console.log(
      `[greedy] 起始金币 ${(snap.gold / 1000).toFixed(0)} ｜ 首条指令 ${JSON.stringify(first)} ｜ 造价 ${(actual / 1000).toFixed(0)} 金（理论上界 ${(maxCost / 1000).toFixed(0)} 金）`,
    );
    expect(actual).toBe(maxCost);
  });

  it('清单自检：key 唯一、升级的前置存在', () => {
    expect(validatePlan(buildBalancedPlan({ lanes: 4, allowBlock: true }))).toEqual([]);
    expect(validatePlan(buildBalancedPlan({ lanes: 2, allowBlock: false }))).toEqual([]);
    expect(validatePlan(buildNoopPlan(4))).toEqual([]);
    expect(
      validatePlan(
        [...MAIN_ROWS, ...EXTRA_ROWS].map((r, i) => ({
          key: `x${i}`,
          kind: r.kind,
          unitId: r.unitId,
          lane: 0,
          tag: r.tag,
          afterKey: r.after ? 'missing' : undefined,
        })),
      ),
    ).not.toEqual([]);
  });

  it('4 路难度的清单会为每条路都排塔', () => {
    const plan = buildBalancedPlan({ lanes: 4, allowBlock: true });
    for (const lane of [0, 1, 2, 3]) {
      expect(plan.filter((s) => s.lane === lane && s.unitId === 'pickpocket').length).toBeGreaterThan(0);
    }
  });

  /**
   * ★ **`allowedAttackTypes` 的空数组语义**（主策划裁决 4：反直觉语义必须钉住）
   *
   * 「空集合」在直觉上等于「什么都不允许」，而本字段的语义是「**全都允许**」（与 `undefined` 同义）。
   * 本项目已经踩过五次「同一表示两种含义」（`bounty` 绝对值/比率、`aura` 增量/乘区、
   * `attackInterval` 频率/间隔…），所以这条必须写成断言。
   *
   * 同时这也证明**白名单是活的**：传 `['siege']` 必须真的改变结果 ——
   * 否则"空数组=不限"这条断言就是个恒真的空话（两条一起才是完整对照）。
   */
  it('★ allowedAttackTypes：空数组 == 不限（与 undefined 逐位相同），且白名单是活的', () => {
    const content = loadRealContent();
    const run = (types: readonly AttackType[] | undefined): { wave: number; hash: string; thieves: number } => {
      const r = runOne({
        content,
        difficultyId: 'N2',
        strategyId: 'gap',
        seed: 20261013,
        maxTicks: 240_000,
        ...(types === undefined ? {} : { allowedAttackTypes: types }),
      });
      return { wave: r.waveReached, hash: r.hash, thieves: r.thiefCount };
    };
    const unrestricted = run(undefined);
    const empty = run([]);
    const siegeOnly = run(['siege']);
    console.log(
      `[白名单] 不限 wave=${unrestricted.wave} 窃金塔=${unrestricted.thieves} ｜ 空数组 wave=${empty.wave} 窃金塔=${empty.thieves} ｜ 只攻城 wave=${siegeOnly.wave} 窃金塔=${siegeOnly.thieves}`,
    );
    // ① 空数组 == 不限（逐位相同：波次、哈希、窃金塔数）
    expect(empty).toEqual(unrestricted);
    // ② 白名单是活的：只攻城必须与不限**不同**（否则 ① 是空话）
    expect(siegeOnly).not.toEqual(unrestricted);
  });
});
