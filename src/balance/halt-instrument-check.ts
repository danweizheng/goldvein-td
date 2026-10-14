/**
 * ★ **★停顿点机制的两条仪器自检**（铁律 8）—— 跑 `pnpm exec tsx src/balance/halt-instrument-check.ts`
 *
 * ## 自检 1：`haltPointStopDuration` 的内存注入是否真的改变了模拟？
 *
 * 没有这一步，「覆盖率不随停顿时长变化」无法区分：
 *   (a) 停顿机制对覆盖率确实没影响   (b) 我的注入根本没生效（空测量）
 *
 * 做法：两个世界（0.6s vs 3.0s）、**不放任何塔**，统计「有敌人处于硬停顿」的 tick 数。
 * **结果（2026-10-13 实测）**：216 tick vs 539 tick（差 323 ≈ 5.4s）→ 注入生效 ✅
 *
 * ## 自检 2：「单波时长」这个指标对停顿时长敏感吗？
 *
 * 主策划预期"2.5s × 30 只 = 额外 75s/波"。若该指标对停顿时长**不敏感**，
 * 那这条预期就无法用它验证，必须如实标注而不是报一条平线。
 *
 * **结果（实测）**：末 8 波的 waveEnd tick **7 波逐位相同**，最后一波差 **−6 tick（−0.1s，方向还是负的）**。
 * 原因：资源上界阵容在停顿期间就把敌人**打死**了 —— 停顿不推迟波次结束，反而让最后一波略早结束
 * （多打了 4.5 次）。**所以「单波时长」在"能活到第 25 波的强阵容"上测不到停顿代价**；
 * 代价只会在"敌人扛得住、必须继续走完路径"的弱阵容上出现，而弱阵容活不到第 25 波 ⇒ **本轮无法测**。
 */
import { loadRealContent } from './data-adapter';
import { createWorldWithContent, snapshot } from '../sim/world';
import { drainEvents, step } from '../sim/tick';
import type { SimContent } from '../sim/content';

function withHalt(base: SimContent, halt: number): SimContent {
  return { ...base, constants: { ...base.constants, haltPointStopDuration: halt } };
}

interface Probe {
  /** 累计「有敌人处于硬停顿」的 tick 数 */
  haltedTicks: number;
  /** 第 1 只敌人在 t=3000 时的 x（定点） */
  firstEnemyX: number;
  /** 累计敌人行进距离（定点，全部敌人每 tick sum|x|；越大=走得越远） */
  travel: number;
  spawned: number;
}

function probe(content: SimContent): Probe {
  const w = createWorldWithContent({ seed: 20261013, difficultyId: 'N2', relics: {}, techArchive: {} }, content);
  let haltedTicks = 0;
  let travel = 0;
  for (let t = 0; t < 3000 && w.status === 'running'; t++) {
    step(w, []);
    drainEvents(w);
    let halted = 0;
    for (const e of w.enemies) {
      if (e.haltTicksLeft > 0) halted++;
      travel += e.pos.x;
    }
    if (halted > 0) haltedTicks++;
  }
  return {
    haltedTicks,
    firstEnemyX: w.enemies[0] ? w.enemies[0].pos.x : -1,
    travel,
    spawned: w.spawnedTotal,
  };
}

const base = loadRealContent();
const a = probe(withHalt(base, 600));
const b = probe(withHalt(base, 3000));
console.log('【仪器自检 1】haltPointStopDuration 注入是否真的生效？');
console.log(`  0.6s: 停顿 tick 数=${a.haltedTicks} ｜ 第1敌人 x=${a.firstEnemyX} ｜ 累计 x=${a.travel} ｜ 出怪=${a.spawned}`);
console.log(`  3.0s: 停顿 tick 数=${b.haltedTicks} ｜ 第1敌人 x=${b.firstEnemyX} ｜ 累计 x=${b.travel} ｜ 出怪=${b.spawned}`);
console.log(`  差：停顿 tick ${b.haltedTicks - a.haltedTicks} ｜ 累计 x ${b.travel - a.travel}`);
console.log(
  a.haltedTicks === b.haltedTicks && a.travel === b.travel
    ? '  ⇒ ❌ 两次完全相同：**注入是空测量**'
    : '  ⇒ ✅ 注入生效：停顿真的改变了敌人推进',
);

// ── 仪器自检 2：waveEnd 的 tick 间隔对停顿时长敏感吗？──
// 若两个停顿时长下每波 waveEnd tick **逐位相同**，说明「单波时长」这个指标
// 测不到停顿代价（波结束被刷新节奏/击杀速度主导），必须如实标注为"该指标不敏感"。
import { createWorldWithContent as cw, snapshot as sn } from '../sim/world';
import { buildPlacement } from './strategies/placement';
import type { Command } from '../sim/commands';
import type { DifficultyId } from '../sim/content';

function waveEndTicks(content: SimContent): number[] {
  const rich: SimContent = { ...content, constants: { ...content.constants, difficulty: { ...content.constants.difficulty } } };
  for (const id of ['N1', 'N2', 'N3', 'N4', 'N5'] as DifficultyId[]) {
    const row = rich.constants.difficulty[id];
    rich.constants.difficulty[id] = { ...row, startGold: 400_000_000_000, startWood: 400_000_000_000 };
  }
  const w = cw({ seed: 20261013, difficultyId: 'N2', relics: {}, techArchive: {} }, rich);
  const model = buildPlacement(rich, 2, 'clustered');
  const techIds = Object.keys(rich.tech ?? {}).sort();
  const out: number[] = [];
  for (let tick = 0; tick < 240_000 && w.status === 'running'; tick++) {
    const cmds: Command[] = [];
    const snap = sn(w);
    for (const id of techIds) {
      const tv = snap.techs.find((x) => x.id === id);
      if (tv && tv.level < tv.maxLevel && tv.affordable) {
        cmds.push({ type: 'research', techId: id });
        break;
      }
    }
    if (cmds.length === 0 && snap.population < snap.populationCap) {
      const cells = snap.towers.map((t) => t.cell);
      const occupied = new Set(cells.map((c) => c.y * rich.grid.width + c.x));
      const cell = model.pick(occupied, cells, -1);
      if (cell) cmds.push({ type: 'build', unitId: 'pickpocket', cell });
    }
    if (cmds.length === 0) {
      for (const t of snap.towers) {
        const def = rich.units[t.unitId];
        if (!def || !def.upgradeTo) continue;
        cmds.push({ type: 'upgrade', towerId: t.id });
        break;
      }
    }
    step(w, cmds);
    for (const ev of drainEvents(w)) if (ev.type === 'waveEnd') out.push(w.tick);
  }
  return out;
}

const t06 = waveEndTicks(withHalt(base, 600));
const t30 = waveEndTicks(withHalt(base, 3000));
const diffs = t06.map((v, i) => (t30[i] ?? 0) - v);
console.log('\n【仪器自检 2】「单波时长」指标对停顿时长敏感吗？（clustered 摆位，资源上界阵容）');
console.log(`  0.6s 的 waveEnd tick（末 8 波）：${t06.slice(-8).join(', ')}`);
console.log(`  3.0s 的 waveEnd tick（末 8 波）：${t30.slice(-8).join(', ')}`);
console.log(`  逐波差值（3.0s − 0.6s）：${diffs.slice(-8).join(', ')}`);
console.log(
  diffs.every((d) => d === 0)
    ? '  ⇒ ⚠️ 逐位相同：「单波时长」**测不到停顿代价** —— 该指标不敏感，报告时必须标注'
    : `  ⇒ ✅ 敏感：末波累计差 ${diffs[diffs.length - 1]} tick = ${(Math.round(((diffs[diffs.length - 1] ?? 0) / 60) * 10) / 10).toFixed(1)}s`,
);

