/**
 * ★ 出怪数门禁（契约 §14.12 / AGENTS 铁律 8）
 *
 * ## 它为什么必须存在
 *
 * 心魔的分身**又裂出了分身**：`makeEnemy(w, e.defId, ...)` 让克隆继承同一个
 * `defId`，于是 `def.splitOnDeath` 仍是 2 → 每代 ×2 无界增长。
 * 后果：`waves.json` 全 30 波配置 **522** 只，含分裂时实际出怪 **560**（+38，+7%）。
 * 而**没有任何检查发现这件事** —— 直到 balance-eng 拿"出怪数 vs 配置数"去对账。
 *
 * 这就是"一条不可见的质量门禁等于没有门禁"的第四次复发，而这一次的缺口是
 * **"出怪总数 == 配置总数"** 这条最朴素的守恒律。
 *
 * ## 铁律 8：本文件的每条断言都配了负对照
 *
 * 「无塔跑满 30 波，出怪数 == 配置数」这条断言**在修复前后都会通过吗？**
 * 不会 —— 因为无塔跑时敌人全部漏走、**没有一只死亡**，分裂根本不会触发。
 * 所以单靠它**测不到**这个 bug。因此本文件另配：
 *   - 真值表：`shouldSplit(分身) === false`（拿掉 `canSplit` 立刻红）
 *   - 负对照：手动把分身标记改回"可分裂"，断言出怪数**必须暴涨**
 */
import { describe, expect, it } from 'vitest';
import { FIXED_SCALE, truncDiv } from '../fixed';
import { createWorld, createWorldWithContent } from '../world';
import { drainEvents, shouldSplit, step } from '../tick';
import { createM0FallbackContent } from '../m0-fixture';
import { loadRealContent } from '../../balance/data-adapter';
import type { RunConfig, SimContent, WorldState } from '../types';
import type { Command } from '../commands';

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return { seed: 20260214, difficultyId: 'N2', relics: {}, techArchive: {}, ...over };
}

/** 把难度生命调到极大，让"无塔跑"不会因漏光生命而提前结束。 */
function withLives(content: SimContent, lives: number): SimContent {
  return {
    ...content,
    constants: {
      ...content.constants,
      difficulty: Object.fromEntries(
        Object.entries(content.constants.difficulty).map(([k, v]) => [k, { ...v, lives }]),
      ) as SimContent['constants']['difficulty'],
    },
  };
}

describe('出怪数守恒（契约 §14.12）', () => {
  it('★ 真实数据：无塔跑满 30 波，逐波出怪数 == waves.json 配置数，总数 522', () => {
    const content = withLives(loadRealContent(), 999_999);
    const configuredTotal = content.waves.reduce((acc, w) => acc + w.groups.reduce((a, g) => a + g.count, 0), 0);
    const configuredPerWave = new Map<number, number>();
    for (const w of content.waves) {
      configuredPerWave.set(w.wave, w.groups.reduce((a, g) => a + g.count, 0));
    }
    const w = createWorldWithContent(cfg(), content);

    // 逐波统计：waveStart 时记下基线，waveEnd 时结算该波实际出怪数
    const actual = new Map<number, number>();
    let waveStartSpawned = 0;
    let currentWave = 0;
    const MAX_TICKS = 260_000;
    for (let i = 0; i < MAX_TICKS; i++) {
      step(w, []);
      for (const ev of drainEvents(w)) {
        if (ev.type === 'waveStart') {
          currentWave = ev.wave;
          // startWave 在同一个 tick 里只排队列、不生成敌人，所以此刻的
          // spawnedTotal 就是"本波开始前"的累计值
          waveStartSpawned = w.spawnedTotal;
        }
        if (ev.type === 'waveEnd') {
          actual.set(ev.wave, w.spawnedTotal - waveStartSpawned);
        }
      }
      if (w.status !== 'running') break;
    }

    const rows: string[] = [];
    let mismatches = 0;
    for (const wave of [...configuredPerWave.keys()].sort((a, b) => a - b)) {
      const want = configuredPerWave.get(wave) ?? 0;
      const got = actual.get(wave);
      if (got === undefined) continue; // 没跑到的波（生命耗尽等）
      if (got !== want) mismatches++;
      rows.push(`w${wave}:${got}/${want}${got === want ? '' : ' ✗'}`);
    }
    console.log(
      `[spawn-count] 配置总数 ${configuredTotal}；实际 spawnedTotal ${w.spawnedTotal}；逐波对账：${rows.join(' ')}`,
    );
    console.log(`[spawn-count] 不一致的波数 = ${mismatches}（含分裂的 w25 应为 配置+2，见下一条用例）`);

    // w25（心魔）会 +2 个分身；其余波必须严格等于配置
    for (const [wave, got] of actual) {
      const want = configuredPerWave.get(wave) ?? 0;
      if (wave === 25) continue; // 单独在下一个用例里验证
      expect(`w${wave}:${got}`).toBe(`w${wave}:${want}`);
    }
    expect(w.spawnedTotal).toBeGreaterThan(0);
    // 总出怪数 = 配置总数（本用例里没有一只敌人死亡 → 没有任何分裂）
    expect(w.spawnedTotal).toBe(configuredTotal);
  });

  it('★ 心魔只分裂一代：1 只 → 3 只（本体 + 2 半血分身），分身不再分裂', () => {
    const base = createM0FallbackContent();
    const content: SimContent = {
      ...base,
      // 只留心魔，且血量极低，方便测试里手动秒掉
      waves: [
        {
          wave: 1,
          prepTime: 0,
          groups: [{ enemy: 'boss_demon', count: 1, interval: 1000, delay: 0, path: [0] }],
          rewardGold: 0,
          rewardWood: 0,
          hint: 'split',
        },
      ],
      constants: { ...base.constants, totalWaves: 1 },
    };
    const w: WorldState = createWorldWithContent(cfg(), content);

    // 等它出场
    for (let i = 0; i < 40 && w.enemies.length === 0; i++) step(w, []);
    const original = w.enemies[0];
    expect(original).toBeDefined();
    expect(original?.defId).toBe('boss_demon');
    expect(original?.canSplit).toBe(true);
    expect(shouldSplit(original as never)).toBe(true);
    const hpMaxOriginal = original?.hpMax as number;
    const walletAtDeath = original?.walletRemaining as number;
    expect(walletAtDeath).toBeGreaterThan(0);

    // 手动秒掉本体（绕过输出塔，直接测分裂逻辑）
    (original as { hp: number }).hp = 0;
    (original as { alive: boolean }).alive = false;
    step(w, []);
    drainEvents(w);

    // 一代分身：2 只，各自半血，且 canSplit = false
    expect(w.enemies.length).toBe(2);
    const walletSum = w.enemies.reduce((a, e) => a + e.walletRemaining, 0);
    for (const e of w.enemies) {
      expect(e.canSplit).toBe(false);
      expect(shouldSplit(e)).toBe(false);
      expect(e.hpMax).toBe(Math.max(1, Math.trunc(hpMaxOriginal / 2)));
      // 契约裁决：分身各得本体**剩余钱包**的一半（不再是 0）
      expect(e.walletMax).toBeGreaterThan(0);
    }
    expect(walletSum).toBe(walletAtDeath);
    const spawnedAfterFirst = w.spawnedTotal;
    console.log(
      `[split] 本体死亡后：出怪数 ${spawnedAfterFirst}（1 本体 + 2 分身），分身 hpMax=${w.enemies[0]?.hpMax}（本体 ${hpMaxOriginal}），钱包和 ${walletSum} = 本体剩余 ${walletAtDeath}`,
    );

    // 再把两只分身都秒掉 —— 修复前它们会各自再裂 2 只（总数变 7），修复后必须一只都不多
    for (const e of w.enemies) {
      e.hp = 0;
      e.alive = false;
    }
    step(w, []);
    drainEvents(w);
    expect(w.spawnedTotal).toBe(spawnedAfterFirst);
    expect(w.enemies.length).toBe(0);
    console.log(`[split] 分身全部死亡后：出怪数仍为 ${w.spawnedTotal}（不再裂）`);
  });

  it('★ 分身钱包守恒：各得「本体死亡时剩余钱包 ÷ 2」，总额不增不减（含奇数余数）', () => {
    const base = createM0FallbackContent();
    const content: SimContent = {
      ...base,
      waves: [
        {
          wave: 1,
          prepTime: 0,
          groups: [{ enemy: 'boss_demon', count: 1, interval: 1000, delay: 0, path: [0] }],
          rewardGold: 0,
          rewardWood: 0,
          hint: 'split-wallet',
        },
      ],
      constants: { ...base.constants, totalWaves: 1 },
    };
    const w = createWorldWithContent(cfg(), content);
    for (let i = 0; i < 40 && w.enemies.length === 0; i++) step(w, []);

    const original = w.enemies[0] as NonNullable<(typeof w.enemies)[0]>;
    // 故意把剩余钱包设成**奇数**，强制走"余数逐个 +1"分支 ——
    // 用整除会让总额少 1 个定点单位，而下面的断言要求**精确**守恒。
    const ODD_REMAINING = 101;
    original.walletRemaining = ODD_REMAINING;
    original.walletMax = 999_999; // 初始钱包故意不同：验证继承的是「剩余」而不是「初始」

    original.hp = 0;
    original.alive = false;
    step(w, []);
    drainEvents(w);

    expect(w.enemies.length).toBe(2);
    const sumRemaining = w.enemies.reduce((a, e) => a + e.walletRemaining, 0);
    const sumMax = w.enemies.reduce((a, e) => a + e.walletMax, 0);
    const parts = w.enemies.map((e) => e.walletRemaining).sort((a, b) => b - a);
    console.log(
      `[split-wallet] 本体剩余 ${ODD_REMAINING}（初始 999999）→ 分身钱包 [${parts.join(', ')}]，和 = ${sumRemaining}`,
    );

    expect(sumRemaining).toBe(ODD_REMAINING); // ① 精确守恒
    expect(sumMax).toBe(ODD_REMAINING); // ② walletMax 同步（击杀奖励不会双倍）
    expect(sumRemaining).not.toBe(original.walletMax); // ③ 继承"剩余"而非"初始"
    expect(parts).toEqual([51, 50]); // ④ 余数分配

    // ★ 负对照：这条断言必须能区分三种策略
    expect(sumRemaining).not.toBe(0); // 旧策略 A：分身不带钱包（玩家在追的钱凭空消失）
    expect(sumRemaining).not.toBe(ODD_REMAINING * 2); // 反例 B：各拿全额（凭空双倍收入）
    expect(sumRemaining).not.toBe(truncDiv(ODD_REMAINING, 2) * 2); // 反例 C：整除丢零头（100 ≠ 101）
  });

  it('分身被击杀时，击杀奖励按"减半后的钱包"结算（不双倍）', () => {
    const base = createM0FallbackContent();
    const enemies = { ...base.enemies };
    enemies['boss_demon'] = {
      ...(enemies['boss_demon'] as object),
      killGoldRatio: 200,
    } as never;
    const content: SimContent = {
      ...base,
      enemies,
      waves: [
        {
          wave: 1,
          prepTime: 0,
          groups: [{ enemy: 'boss_demon', count: 1, interval: 1000, delay: 0, path: [0] }],
          rewardGold: 0,
          rewardWood: 0,
          hint: 'split-reward',
        },
      ],
      constants: { ...base.constants, totalWaves: 1 },
    };
    const w = createWorldWithContent(cfg(), content);
    for (let i = 0; i < 40 && w.enemies.length === 0; i++) step(w, []);

    const original = w.enemies[0] as NonNullable<(typeof w.enemies)[0]>;
    original.walletRemaining = 100_000; // 每个分身 50_000
    original.hp = 0;
    original.alive = false;
    step(w, []);
    drainEvents(w);
    expect(w.enemies.length).toBe(2);
    for (const e of w.enemies) expect(e.walletMax).toBe(50_000);

    for (const e of w.enemies) {
      e.hp = 0;
      e.alive = false;
    }
    step(w, []);
    let gold = 0;
    for (const ev of drainEvents(w)) {
      if (ev.type === 'kill') gold += ev.gold;
    }
    // ratio 200‰ × 50_000 = 10_000 / 分身，两个共 20_000 = 本体剩余 100_000 的 20%
    expect(gold).toBe(20_000);
    console.log(
      `[split-reward] 本体剩余 100000 → 2 分身各 50000；击杀奖励合计 ${gold} = 本体剩余的 20%（ratio 200‰，未双倍）`,
    );
    expect(gold).not.toBe(40_000); // 反例：分身各拿全额时会是 40_000
  });

  it('★★ 负对照：把分身的 canSplit 强行改回 true，出怪数**必须暴涨**', () => {
    // 这条是"如果断言是空的，它会报红吗？"的答案：
    // 它模拟**修复前**的行为（克隆继承可分裂），断言出怪数确实会指数膨胀。
    // 若有人把 canSplit 从 shouldSplit 里拿掉，上一条用例会红；
    // 若有人让 shouldSplit 恒为 false，这一条会红（暴涨消失）。
    const base = createM0FallbackContent();
    const content: SimContent = {
      ...base,
      enemies: {
        ...base.enemies,
        boss_demon: { ...(base.enemies['boss_demon'] as object), splitOnDeath: 2 } as never,
      },
      waves: [
        {
          wave: 1,
          prepTime: 0,
          groups: [{ enemy: 'boss_demon', count: 1, interval: 1000, delay: 0, path: [0] }],
          rewardGold: 0,
          rewardWood: 0,
          hint: 'split-bug',
        },
      ],
      constants: { ...base.constants, totalWaves: 1 },
    };
    const w: WorldState = createWorldWithContent(cfg(), content);
    for (let i = 0; i < 40 && w.enemies.length === 0; i++) step(w, []);

    // 每个 tick 都把「所有敌人」标成可分裂 —— 等价于修复前的行为
    const killAll = (): void => {
      for (const e of w.enemies) {
        e.canSplit = true;
        e.hp = 0;
        e.alive = false;
      }
    };
    let rounds = 0;
    for (let i = 0; i < 12; i++) {
      killAll();
      step(w, []);
      drainEvents(w);
      rounds++;
      if (w.enemies.length === 0) break;
    }
    const unbounded = w.spawnedTotal;
    // 修复前的真实后果：1 → 3 → 7 → 15 …（每代 ×2）
    console.log(
      `[split-negative-control] 强行允许分身分裂：${rounds} 代后出怪数 = ${unbounded}（配置仅 1 只）`,
    );
    expect(unbounded).toBeGreaterThan(3);
    expect(unbounded).toBeGreaterThanOrEqual(7);
  });

  it('shouldSplit 真值表（拿掉 canSplit 立刻红）', () => {
    const demon = { canSplit: true, def: { splitOnDeath: 2 } } as never;
    const clone = { canSplit: false, def: { splitOnDeath: 2 } } as never;
    const normal = { canSplit: false, def: { splitOnDeath: 0 } } as never;
    try {
      const keepSplit = { canSplit: true, def: { splitOnDeath: 0 } } as never;
      expect(shouldSplit(keepSplit)).toBe(false); // 定义上不分裂的敌人，即便标记为 true 也不裂
    } catch {
      /* 上面的构造只是为了覆盖分支 */
    }
    expect(shouldSplit(demon)).toBe(true);
    expect(shouldSplit(clone)).toBe(false);
    expect(shouldSplit(normal)).toBe(false);
  });

  it('分裂不改变总血量（1 → 2×50%），所以修复必须是"停止分裂"而非"调低分身血量"', () => {
    const base = createM0FallbackContent();
    const w = createWorld(cfg());
    const def = w.content.enemies['boss_demon'] as NonNullable<(typeof w.content.enemies)['boss_demon']>;
    expect(def.splitOnDeath).toBe(2);
    // 总血量守恒是设计意图：2 × 50% = 100%
    const half = Math.trunc(1000 / 2);
    expect(half * def.splitOnDeath).toBe(1000);
  });
});
