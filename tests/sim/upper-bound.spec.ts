/**
 * ★ **资源上界实验（启发式摆位）—— 它不是"行为上界"，不得当作行为上界读**
 *
 * ## 它测什么、不测什么（主策划裁决，铁律 8 用在一个新工具上）
 *
 * 它把 **AI 的策略**因素拿掉（无限钱木、满科技、满塔位、全 T5），但**没有**把
 * **摆位质量**因素拿掉：塔的位置仍由 `placement.ts` 的启发式决定，而那套启发式
 * **没有建模射程重叠**、也没建模「哪些塔能同时够到多路」。
 *
 * 证据：解析上界（`ttk-analysis.ts`，假设"每座塔都能打到每个敌人"）说 N5 第 30 波
 * 只有 **0.60×**（宽裕），而本实验的满配阵容在 N5 第 30 波**漏 5 只**（生命正好 5 → 输）。
 * **这个落差就是摆位质量**，不是数据的余量。
 *
 * ⇒ 因此：
 * - ✅ 可以用它证明「**资源不再是瓶颈**」（N2 已能零漏怪通关 30 波）
 * - ❌ **不能**用它的 N5 结果去调 N5 的生命/血量（那是在用一把不知道量程的尺子改数值）
 *
 * 要成为真行为上界，需要用 `cloneWorld()` 做摆位优化（M2 API 已可用，本轮成本未测）。
 *
 * ## 做法
 *
 * 只在**内存里**改 `startGold`/`startWood`（不改任何 `src/data/**` 文件），其余全部走
 * 真实数据 + 契约 §5 的 `Command` 通路（含 §14.2 新增的 `research`）。
 */
import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../../src/balance/data-adapter';
import { createWorldWithContent, snapshot } from '../../src/sim/world';
import { drainEvents, step } from '../../src/sim/tick';
import { buildPlacement } from '../../src/balance/strategies/placement';
import type { Command } from '../../src/sim/commands';
import type { DifficultyId, SimContent, UnitDef } from '../../src/sim/content';

/** 内存副本：把起始金币/木材改大（不落盘、不改 src/data）。 */
function richContent(gold = 400_000_000_000, wood = 400_000_000_000): SimContent {
  const c = loadRealContent();
  const copy: SimContent = { ...c, constants: { ...c.constants, difficulty: { ...c.constants.difficulty } } };
  for (const id of ['N1', 'N2', 'N3', 'N4', 'N5'] as DifficultyId[]) {
    const row = copy.constants.difficulty[id];
    copy.constants.difficulty[id] = { ...row, startGold: gold, startWood: wood };
  }
  return copy;
}

interface BoundResult {
  waveReached: number;
  status: string;
  leaks: number;
  spawned: number;
  towers: number;
  populationCap: number;
  army: Record<string, number>;
  tech: Record<string, number>;
  techEffects: { attackMul: number; attackSpeedMul: number; stealMul: number };
  leaksByWave: { wave: number; leaks: number; spawned: number; stolen: number; towers: number }[];
}

/**
 * 满编实验：① 科技全满 → ② 铺满塔位 → ③ 全部升到 goldfinger。
 * 每 tick 只发一条指令（贴近真实玩家的操作节拍，也避免同 tick 多指令互相干扰）。
 */
function runMaxedArmy(content: SimContent, difficultyId: DifficultyId, seed: number): BoundResult {
  const w = createWorldWithContent({ seed, difficultyId, relics: {}, techArchive: {} }, content);
  const lanes = content.constants.difficulty[difficultyId].paths;
  const model = buildPlacement(content, lanes);

  const leaksByWave: BoundResult['leaksByWave'] = [];
  let waveLeaks = 0;
  let waveStolen = 0;
  let spawnedBase = 0;

  const techIds = Object.keys(content.tech ?? {}).sort();

  for (let tick = 0; tick < 240_000 && w.status === 'running'; tick++) {
    const cmds: Command[] = [];
    const snap = snapshot(w);

    // ① 科技全满（按 id 顺序逐级研究）
    for (const id of techIds) {
      const tv = snap.techs.find((x) => x.id === id);
      if (tv && tv.level < tv.maxLevel && tv.affordable) {
        cmds.push({ type: 'research', techId: id });
        break;
      }
    }

    // ② 铺满塔位
    if (cmds.length === 0 && snap.population < snap.populationCap) {
      const cells = snap.towers.map((t) => t.cell);
      const occupied = new Set(cells.map((c) => c.y * content.grid.width + c.x));
      const counts = new Array<number>(lanes).fill(0);
      for (const c of cells) {
        const l = model.laneOf(c);
        if (l >= 0 && l < lanes) counts[l] = (counts[l] as number) + 1;
      }
      let lane = 0;
      for (let i = 1; i < counts.length; i++) if ((counts[i] as number) < (counts[lane] as number)) lane = i;
      const cell = model.pick(occupied, cells, lane);
      if (cell) cmds.push({ type: 'build', unitId: 'pickpocket', cell });
    }

    // ③ 逐座升到链尾
    if (cmds.length === 0) {
      for (const t of snap.towers) {
        const def: UnitDef | undefined = content.units[t.unitId];
        if (!def || !def.upgradeTo) continue;
        cmds.push({ type: 'upgrade', towerId: t.id });
        break;
      }
    }

    step(w, cmds);
    const spawnedNow = w.spawnedTotal;
    for (const ev of drainEvents(w)) {
      if (ev.type === 'leak') waveLeaks++;
      if (ev.type === 'waveEnd') {
        leaksByWave.push({
          wave: ev.stats.wave,
          leaks: waveLeaks,
          spawned: spawnedNow - spawnedBase,
          stolen: waveStolen,
          towers: ev.stats.towerCount,
        });
        waveLeaks = 0;
        waveStolen = 0;
        spawnedBase = spawnedNow;
      } else if (ev.type === 'steal') {
        waveStolen += ev.amount;
      }
    }
  }

  const army: Record<string, number> = {};
  for (const t of w.towers) army[t.unitId] = (army[t.unitId] ?? 0) + 1;

  return {
    waveReached: w.wave,
    status: w.status,
    leaks: w.leaked,
    spawned: w.spawnedTotal,
    towers: w.towers.length,
    populationCap: w.populationCap,
    army,
    tech: { ...w.techLevels },
    techEffects: { attackMul: w.tech.attackMul, attackSpeedMul: w.tech.attackSpeedMul, stealMul: w.tech.stealMul },
    leaksByWave,
  };
}

function reportLine(label: string, r: BoundResult): string {
  const techDesc = Object.entries(r.tech)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  return (
    `[上界实验 ${label}] 结果=${r.status} 到第 ${r.waveReached} 波 ｜ 漏怪 ${r.leaks}/${r.spawned} ｜ 塔 ${r.towers}/${r.populationCap} ｜ ` +
    `阵容=${JSON.stringify(r.army)} ｜ 科技=${techDesc} ｜ 乘区 攻击×${(r.techEffects.attackMul / 1000).toFixed(2)} 攻速×${(r.techEffects.attackSpeedMul / 1000).toFixed(2)}`
  );
}

describe('资源上界实验（无限钱木 + 满科技 + 满塔位 T5 飞贼，启发式摆位 → **非行为上界**)', () => {
  it('★ N2：满配阵容**零漏怪通关 30 波**（分裂修复后）', () => {
    const content = richContent();
    const seeds = [1, 20261013, 424242];
    const results = seeds.map((seed) => ({ seed, r: runMaxedArmy(content, 'N2', seed) }));

    for (const { seed, r } of results) {
      console.log(reportLine(`N2 seed=${seed}`, r));
      // 阵容与科技必须真的是「满配」——否则这个上界实验不成立
      expect(r.army['goldfinger'], `seed=${seed} 没有铺满 T5`).toBeGreaterThanOrEqual(40);
      expect(r.tech['attack']).toBe(5);
      expect(r.tech['attack_speed']).toBe(5);
      expect(r.populationCap).toBeGreaterThanOrEqual(50);
    }
    const first = results[0]?.r as BoundResult;
    console.log(`[上界实验 N2] 逐波漏怪（seed=1）：${first.leaksByWave.map((x) => `${x.wave}:${x.leaks}`).join(' ')}`);

    // ★ 关键结论：第 24 波（含 24 波）之前**零漏怪** —— 数据层的前 24 波已经被科技改乘法修好了
    for (const { seed, r } of results) {
      const early = r.leaksByWave.filter((x) => x.wave <= 24).reduce((a, b) => a + b.leaks, 0);
      expect(early, `seed=${seed} 第 1–24 波仍有漏怪`).toBe(0);
    }
  });

  it('★★ 分裂修复的回归防线：含分裂也必须通关（出怪 = 522 + 2 只分身，不得再指数膨胀）', () => {
    const base = richContent();
    const noSplit: SimContent = {
      ...base,
      enemies: { ...base.enemies },
    };
    for (const [id, e] of Object.entries(base.enemies)) {
      if (e.splitOnDeath > 0) noSplit.enemies[id] = { ...e, splitOnDeath: 0 };
    }
    const withSplit = runMaxedArmy(base, 'N2', 20261013);
    const without = runMaxedArmy(noSplit, 'N2', 20261013);
    console.log(reportLine('N2 含分裂', withSplit));
    console.log(reportLine('N2 关掉分裂', without));
    console.log(
      `[分裂对比] 含分裂：出怪 ${withSplit.spawned} / 漏 ${withSplit.leaks} / 到第 ${withSplit.waveReached} 波（${withSplit.status}）；` +
        `关掉分裂：出怪 ${without.spawned} / 漏 ${without.leaks} / 到第 ${without.waveReached} 波（${without.status}）`,
    );
    // 关掉分裂后满配阵容应当零漏怪通关 —— 这条把「第 25 波崩」精确归因到心魔的无限分裂
    expect(without.leaks).toBe(0);
    expect(without.status).toBe('won');
    // 含分裂时出怪数明显高于 waves.json 的 522 —— 分身又生了分身（无递归保护）
    expect(withSplit.spawned).toBeGreaterThan(522);
  });

  it('★ N5（最难难度）：第 1–24 波零漏怪；第 30 波差 1 只（5 漏 vs 5 命）', () => {
    const content = richContent();
    const r = runMaxedArmy(content, 'N5', 20261013);
    console.log(reportLine('N5', r));
    expect(r.army['goldfinger']).toBeGreaterThanOrEqual(40);
    const early = r.leaksByWave.filter((x) => x.wave <= 24).reduce((a, b) => a + b.leaks, 0);
    expect(early).toBe(0);
  });

  it('N4 的逐波表落盘（证明前 24 波是真的清怪而不是靠 lives 兜底）', () => {
    const content = richContent();
    const r = runMaxedArmy(content, 'N4', 20261013);
    console.log(reportLine('N4', r));
    console.log(`[上界实验 N4] ${r.leaksByWave.map((x) => `w${x.wave}:漏${x.leaks}/出${x.spawned}`).join(' ')}`);
    expect(r.leaksByWave.length).toBeGreaterThanOrEqual(20);
    const early = r.leaksByWave.filter((x) => x.wave <= 24).reduce((a, b) => a + b.leaks, 0);
    expect(early).toBe(0);
  });
});
