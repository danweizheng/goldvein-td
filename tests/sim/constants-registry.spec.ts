/**
 * ★★ **`constants.json` 键登记门禁**（主策划裁决，欠两轮）
 *
 * 三件事：
 * 1. **未登记即报红**：`constants.json` 里出现任何 `CONSTANTS_KEY_REGISTRY` 没登记的键 → 红。
 *    这是防"新键加了但没人消费"的**唯一**手段（变异门禁只能测"我为它写了变异条目"的键）。
 * 2. **登记表不许陈旧**：登记了但数据里没有的键 → 红。
 * 3. **`consumed:constants` 的每一项都真的被消费**：通用**路径变异探针** —— 把该键变异成
 *    `值+1`（数组则追加一份末元素），断言 `toConstants(...)` 的序列化结果**必须变化**。
 *
 * ## 负对照（铁律 8）
 *
 * - 给 `unregisteredKeys` 喂一棵**含新键**的合成对象 → 必须列出那个键（证明探测器不是恒空）
 * - 给它与登记表完全一致的输入 → 必须为空
 * - **★ 变异探针的负对照**：对一个 `unconsumed:*` 的键做同样的变异 →
 *   `toConstants` **必须不变**（证明"变了"这个信号确实来自消费，而不是探针恒真）
 */
import { describe, expect, it } from 'vitest';
import constantsJson from '../../src/data/constants.json';
import difficultyJson from '../../src/data/difficulty.json';
import mapJson from '../../src/data/map.json';
import unitsJson from '../../src/data/units.json';
import { toConstants, toUnit, type AdapterWarning } from '../../src/balance/data-adapter';
import {
  CONSTANTS_KEY_REGISTRY,
  flattenKeys,
  registrySummary,
  staleRegistryKeys,
  unregisteredKeys,
} from '../../src/balance/constants-registry';
import type { BalanceConstants, DifficultyDef, MapDef, UnitDef } from '../../src/data/types.generated';

const RAW = constantsJson as unknown as BalanceConstants;
const RAW_DIFF = difficultyJson as unknown as DifficultyDef[];
const RAW_MAP = mapJson as unknown as MapDef;
const RAW_UNITS = unitsJson as unknown as UnitDef[];
const noopWarn = (_w: AdapterWarning): void => undefined;

const snap = (v: unknown): string => JSON.stringify(v);

/** 深拷贝 + 把点号路径上的叶子变异（数字 +1；数组追加一份末元素）。 */
function mutateAtPath<T>(raw: T, path: string): T {
  const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const parts = path.split('.');
  let cur: Record<string, unknown> = copy;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i] as string] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1] as string;
  const v = cur[leaf];
  if (typeof v === 'number') cur[leaf] = v + 1;
  else if (Array.isArray(v)) cur[leaf] = [...v, v[v.length - 1]];
  else throw new Error(`变异探针只支持数字与数组，${path} 是 ${typeof v}`);
  return copy as T;
}

function constantsOf(raw: BalanceConstants): unknown {
  return toConstants(raw, RAW_DIFF, RAW_UNITS, RAW_MAP, noopWarn);
}

describe('★ constants.json 键登记门禁', () => {
  it('① 未登记即报红：数据里的每个键都已在登记表中', () => {
    const missing = unregisteredKeys(RAW);
    console.log(
      `[键登记] 数据 ${flattenKeys(RAW).length} 键 ｜ 登记 ${Object.keys(CONSTANTS_KEY_REGISTRY).length} 项 ｜ 处置分布 ${JSON.stringify(registrySummary())}`,
    );
    expect(missing, `这些键没登记（新增键必须先登记，否则它可能永远不被消费）：\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('② 登记表不许陈旧：登记的键都还在数据里', () => {
    const stale = staleRegistryKeys(RAW);
    expect(stale, `登记表里这些键已从数据消失（登记表陈旧）：\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  it('★ 负对照：含新键的合成输入必须被列出（证明探测器不是恒空）', () => {
    const withNew = { ...(RAW as unknown as Record<string, unknown>), brandNewKnob: 123 };
    expect(unregisteredKeys(withNew), '漏报新键 → 探测器是空的').toEqual(['brandNewKnob']);
    // 嵌套的新键也要被列出（用 constants 自己的 map 子对象，不是 map.json）
    const constantsMap = (RAW as unknown as { map: Record<string, unknown> }).map;
    const nested = { ...(RAW as unknown as Record<string, unknown>), map: { ...constantsMap, newMapKnob: 7 } };
    expect(unregisteredKeys(nested)).toEqual(['map.newMapKnob']);
    // 与登记表完全一致的输入应为空
    expect(unregisteredKeys(RAW)).toEqual([]);
  });

  it('③ 每个 consumed:constants 的键都真的被消费（通用路径变异探针）', () => {
    const base = snap(constantsOf(RAW));
    const consumed = Object.entries(CONSTANTS_KEY_REGISTRY)
      .filter(([, e]) => e.disposition === 'consumed:constants')
      .map(([k]) => k);
    expect(consumed.length).toBeGreaterThan(20); // 防止过滤条件写错导致 0 项
    const notConsumed: string[] = [];
    for (const key of consumed) {
      const mutated = snap(constantsOf(mutateAtPath(RAW, key)));
      if (mutated === base) notConsumed.push(key);
    }
    console.log(`[键登记] consumed:constants 共 ${consumed.length} 项，探针确认被消费 ${consumed.length - notConsumed.length} 项`);
    expect(notConsumed, `这些键登记为"被 SimConstants 消费"，但变异后 SimConstants 没变：\n  ${notConsumed.join('\n  ')}`).toEqual([]);
  });

  it('★ 负对照：对 unconsumed 的键做同样的变异 → SimConstants 必须不变', () => {
    const base = snap(constantsOf(RAW));
    const unchecked = [
      'achievementMuls.no_leak',
      'acceptanceTargets.leakRateMax',
      'hero.expFromSteal',
      'map.pathLengthCells',
      'crystalDivisor',
      'waveSettleTime',
    ];
    for (const key of unchecked) {
      expect(CONSTANTS_KEY_REGISTRY[key]?.disposition.startsWith('unconsumed:'), `${key} 应当是 unconsumed`).toBe(true);
      expect(snap(constantsOf(mutateAtPath(RAW, key))), `${key} 竟然影响了 SimConstants → 处置登记写错了`).toBe(base);
    }
  });

  it('consistency-only：map.buildableWidthCells 变异后 buildDepth 不变', () => {
    const base = constantsOf(RAW) as { buildDepth: number };
    const mutated = constantsOf(mutateAtPath(RAW, 'map.buildableWidthCells')) as { buildDepth: number };
    expect(CONSTANTS_KEY_REGISTRY['map.buildableWidthCells']?.disposition).toBe('consistency-only');
    expect(mutated.buildDepth).toBe(base.buildDepth);
  });

  it('consumed:unit：stealWoodRatio 的消费方是 toUnit（不在 SimConstants 里）', () => {
    const thief = RAW_UNITS.find((u) => u.stealBase > 0) as UnitDef;
    const a = toUnit(thief, RAW, noopWarn);
    const b = toUnit(thief, { ...RAW, stealWoodRatio: 77 }, noopWarn);
    expect(a.stealWoodRatio).not.toBe(b.stealWoodRatio);
    expect(b.stealWoodRatio).toBe(77);
  });

  it('★ 跨表一致性：difficultyCrystalMul 与 difficulty.json 的 crystalMul 必须相等', () => {
    // 两处都存了结晶难度系数，适配层只读 difficulty.json 那份。
    // 登记为 unconsumed 是**有意的**，但两表漂移必须被发现 —— 否则又是一个静默错位。
    for (const d of RAW_DIFF) {
      const byConstants = (RAW.difficultyCrystalMul as unknown as Record<string, number>)[d.id];
      expect(byConstants, `${d.id} 的结晶系数两表不一致（constants=${byConstants} vs difficulty=${d.crystalMul}）`).toBe(d.crystalMul);
    }
  });

  it('★ 跨表一致性：map.laneCount 与 difficulty.json 的最大 openLanes 必须相等', () => {
    const maxLanes = Math.max(...RAW_DIFF.map((d) => d.openLanes));
    expect(RAW_MAP.paths.length).toBe(RAW.map.laneCount);
    expect(maxLanes).toBe(RAW.map.laneCount);
  });
});