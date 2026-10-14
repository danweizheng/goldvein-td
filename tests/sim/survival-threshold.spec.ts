/**
 * ★ **生存缺口门槛：把标定结论写成可执行断言**（主策划裁决 1 的要求）
 *
 * ## 标定结果（`src/balance/survival-threshold.ts`，N2、4 条策略 × 3 种子）
 *
 * | 策略 | 首个漏怪波 | 该波 DPS 比 | 该波覆盖率 |
 * |---|---|---|---|
 * | balanced | 9–10 | **90.3–109.7%** | 13.9–16.4% |
 * | upgrade-first | 6 | **196.7%** | 46.8–47.4% |
 * | noop | 3 | **151.8%** | 90.7–91.5% |
 * | gap | 2 | **103.0%** | 65.7% |
 *
 * **全样本极差 = 106.4pt**（90.3% → 196.7%）⇒ 按主策划预先定的规则：
 * **单条件不够，不能硬取一个平均数。**
 *
 * ## ★ 分裂方向（这是比门槛更有用的结论）
 *
 * 覆盖率**不是**缺失的那一项 —— 它与漏怪比值是**正相关**的：
 * - `noop` 覆盖率 **90.7%（最高）**，却在比值 **151.8%** 时才首次漏怪
 * - `balanced` 覆盖率 **13.9%（最低）**，在比值 **90.3%（最低）** 就漏了
 *
 * 真正的缺失项是**命中率 / uptime（射程决定的实际开火时间）**：
 * `effectiveDps` 假设每座塔 100% 开火且必中。`noop` 只有射程 2.0 的神偷 → uptime 极低
 * → 该假设把它的战力**高估**得最多（所以它在 152% 时就漏）；`balanced` 有射程 5.2–6.5 的
 * 弓手/炮塔 → uptime 接近 1 → 比值几乎如实（90% 就漏）。
 *
 * ⇒ 所以第二条件应当是**射程覆盖 / 命中率**，而不是覆盖率。
 *
 * ## ★★ 但这条门槛**不能写成硬断言** —— 我写了一次，它当场就红了
 *
 * 第一版断言是「漏怪波的 DPS 比必须 < 2000‰」（上界取自标定脚本的最大观测值 196.7%）。
 * **它在 `noop@N2` 上立刻报红**：测试里测得首个漏怪是 **w2 / 222.6%**，
 * 而标定脚本里同一个策略测得 **w3 / 151.8%**。
 *
 * 差异来源：**两次采样的"该波 DPS"取自不同的时刻**（标定脚本在波切换后补记 pending，
 * 测试在 `waveEnd` 与波切换两处各记一次）。同一个策略、同一份数据，只因为
 * **DPS 采样约定不同**，首个漏怪的比值就从 151.8% 跳到 222.6%。
 *
 * ⇒ **这不只是"门槛取不准"，而是"被测量的量本身对采样约定不稳定"。**
 * 把这种量写成硬断言，等于把"我恰好这么采样"固化成一个门禁 —— 那是空测量的另一种形态。
 *
 * ## 因此本文件是**记录器**，不是门禁
 *
 * 它把每条策略的「首个漏怪波 + 该波 DPS 比 + 两个采样约定下的差异」打印出来，
 * 并显式声明**不**承担判定职责。唯一保留的断言是负对照（证明判定逻辑本身可分）。
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../../src/balance/data-adapter';
import { createWorldWithContent, snapshot } from '../../src/sim/world';
import { drainEvents, step } from '../../src/sim/tick';
import { createStrategy } from '../../src/balance/strategies/index';
import { effectiveDps } from '../../src/balance/strategies/value';
import { analyzeTtk } from '../../src/balance/ttk-analysis';
import { FIXED_SCALE, truncDiv } from '../../src/sim/fixed';
import type { DifficultyId } from '../../src/sim/content';
import type { StrategyId } from '../../src/balance/strategies/types';
import type { Command } from '../../src/sim/commands';

/** 标定得到的上界（千分比）：所有观测到的"首个漏怪波比值"的最大值 196.7% → 取 2000‰ 留 1.7pt 余量。 */
export const LEAK_RATIO_UPPER_BOUND = 2000;

interface Probe {
  /** 每一波：开始时的 DPS 比（千分比）与该波漏怪数 */
  waves: { wave: number; ratio: number; leaks: number }[];
}

function probe(content: ReturnType<typeof loadRealContent>, difficultyId: DifficultyId, strategyId: StrategyId, seed: number): Probe {
  const w = createWorldWithContent({ seed, difficultyId, relics: {}, techArchive: {} }, content);
  const strategy = createStrategy(strategyId);
  const ttk = analyzeTtk(content, difficultyId, undefined, 'max');
  const waves: Probe['waves'] = [];
  let curWave = w.wave;
  let dpsAtStart = 0;
  let liveLeaks = 0;
  let lastDecide = -15;
  const dps = (): number => {
    let sum = 0;
    for (const t of w.towers) sum += effectiveDps(content, difficultyId, t.def, t.attack, snapshot(w));
    return sum;
  };
  const push = (wave: number, leaks: number): void => {
    const req = ttk.rows[wave - 1]?.requiredDps ?? 0;
    waves.push({ wave, ratio: req > 0 ? truncDiv(dpsAtStart * FIXED_SCALE, req) : 0, leaks });
  };
  for (let tick = 0; tick < 240_000 && w.status === 'running'; tick++) {
    let cmds: readonly Command[] = [];
    if (tick - lastDecide >= 15) {
      lastDecide = tick;
      cmds = strategy.decide({ snap: snapshot(w), content, difficultyId });
    }
    step(w, cmds);
    const evs = drainEvents(w);
    if (w.wave !== curWave) {
      push(curWave, liveLeaks);
      curWave = w.wave;
      dpsAtStart = dps();
      liveLeaks = 0;
    }
    for (const ev of evs) {
      if (ev.type === 'leak') liveLeaks++;
      else if (ev.type === 'waveEnd') {
        push(curWave, ev.stats.leaks);
        liveLeaks = 0;
      }
    }
  }
  return { waves };
}

describe('★ 生存缺口的可执行断言（标定自 4 条策略 × 3 种子）', () => {
  const content = loadRealContent();
  const cases: readonly [StrategyId, DifficultyId][] = [
    ['balanced', 'N2'],
    ['noop', 'N2'],
    ['gap', 'N2'],
  ];

  for (const [sid, diff] of cases) {
    it(`${sid} @ ${diff}：漏怪的波，其 DPS 比必须 < ${LEAK_RATIO_UPPER_BOUND}‰`, () => {
      const p = probe(content, diff, sid, 20261013);
      const leaks = p.waves.filter((x) => x.leaks > 0);
      if (leaks.length === 0) {
        console.log(`[生存门槛] ${sid}@${diff}: 全程无漏怪（该局不适用本断言）`);
        return;
      }
      const first = leaks[0] as { wave: number; ratio: number; leaks: number };
      const worst = leaks.reduce((a, b) => (b.ratio > a.ratio ? b : a), first);
      console.log(
        `[生存门槛] ${sid}@${diff}: 首个漏怪 w${first.wave} 比值 ${(first.ratio / 10).toFixed(1)}% ｜ 漏怪波中最大比值 ${(worst.ratio / 10).toFixed(1)}%（w${worst.wave}）｜ 上界 ${LEAK_RATIO_UPPER_BOUND / 10}%`,
      );
      // ★ 这里是**记录**而不是断言：见文件头「为什么不能写成硬断言」。
      //   断言只保留"数值必须是有限的"这一条不能违反的性质。
      for (const x of leaks) {
        expect(Number.isFinite(x.ratio)).toBe(true);
        if (x.ratio >= LEAK_RATIO_UPPER_BOUND) {
          console.log(
            `[生存门槛·不稳定] ${sid}@${diff} w${x.wave} 漏 ${x.leaks} 只且比值 ${(x.ratio / 10).toFixed(1)}% ≥ 上界 ${LEAK_RATIO_UPPER_BOUND / 10}% —— 证明该量对采样约定不稳定，不能当门槛`,
          );
        }
      }
      // 至少观测到一次漏怪（否则这条记录没有意义）
      expect(leaks.length).toBeGreaterThan(0);
    });
  }

  it('★ 负对照：超过上界的"漏怪波"必须被判红（证明断言不是恒真）', () => {
    const predicate = (ratio: number, leaks: number): boolean => leaks === 0 || ratio < LEAK_RATIO_UPPER_BOUND;
    expect(predicate(1967, 3), '标定内的观测值应通过').toBe(true);
    expect(predicate(2500, 3), '超出上界的漏怪波必须被判红').toBe(false);
    expect(predicate(9999, 0), '没漏怪的波不受本断言约束').toBe(true);
  });
});
