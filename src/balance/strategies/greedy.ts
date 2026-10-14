/**
 * `greedy` —— 「无脑玩家」：有钱就买**最贵**的那一步。
 *
 * 策划案 §10.2 用它做「太简单」的探针：如果这个策略都能通关，说明难度不足。
 *
 * 实现：把所有可执行的建造/升级/**研究**候选（买得起 + 位置合法 + 人口没满）按金币造价降序排，
 * 取最贵的那个。买不起就**什么都不做**（攒钱），这正是「有钱就升最贵的塔」的字面行为。
 *
 * ⚠️ 建造只限**根单位**（升级树入口）。契约 §14.7 之后 sim 也会拒绝非根单位
 * （直达建 T5 比升级链便宜 32%，是经济漏洞），两边行为一致。
 */
import type { Command } from '../../sim/commands';
import type { Cell } from '../../sim/types';
import { buildPlacement, occupiedKeys, type PlacementModel } from './placement';
import { laneCountOf, rootUnitIds, salaryCommand } from './common';
import type { Strategy, StrategyInput, StrategyOptions } from './types';

interface Candidate {
  kind: 'build' | 'upgrade' | 'research';
  /** build/upgrade = 单位 id；research = 科技线 id */
  unitId: string;
  towerId: number;
  cost: number;
  cell: Cell | null;
}

export function createGreedy(opts: StrategyOptions = {}): Strategy {
  let model: PlacementModel | null = null;
  let roots: Set<string> | null = null;

  return {
    id: 'greedy',
    label: '无脑玩家（买最贵的）',
    description: '有钱就买造价最高的那一步（含升级与科技研究）；买不起就攒钱。难度过低的探针。',
    decide(input: StrategyInput): Command[] {
      const snap = input.snap;
      if (!model) {
        model = buildPlacement(input.content, laneCountOf(input.content, input.difficultyId), opts.placement ?? 'uniform');
        roots = rootUnitIds(input.content);
      }
      const m = model;
      const canBuild = snap.population < snap.populationCap;
      const cells: Cell[] = snap.towers.map((t) => t.cell);
      const occupied = occupiedKeys(snap.towers, input.content.grid.width);
      const counts = new Array<number>(m.laneCount).fill(0);
      for (const c of cells) {
        const l = m.laneOf(c);
        if (l >= 0 && l < m.laneCount) counts[l] = (counts[l] as number) + 1;
      }
      let lane = 0;
      for (let i = 1; i < counts.length; i++) if ((counts[i] as number) < (counts[lane] as number)) lane = i;

      const cands: Candidate[] = [];
      if (canBuild) {
        for (const id of roots as Set<string>) {
          const def = input.content.units[id];
          if (!def || def.costGold > snap.gold || def.costWood > snap.wood) continue;
          const cell = m.pick(occupied, cells, lane);
          if (!cell) continue;
          cands.push({ kind: 'build', unitId: id, towerId: -1, cost: def.costGold, cell });
        }
      }
      for (const t of snap.towers) {
        const cur = input.content.units[t.unitId];
        if (!cur || !cur.upgradeTo) continue;
        const next = input.content.units[cur.upgradeTo];
        if (!next || next.costGold > snap.gold || next.costWood > snap.wood) continue;
        cands.push({ kind: 'upgrade', unitId: next.id, towerId: t.id, cost: next.costGold, cell: null });
      }
      // 契约 §14.2：科技也是「一步」，且它是后期最贵的东西 → 无脑玩家会买它
      for (const tv of snap.techs) {
        if (tv.level >= tv.maxLevel || tv.unimplemented) continue;
        if (!tv.affordable) continue;
        cands.push({ kind: 'research', unitId: tv.id, towerId: -1, cost: tv.nextGold, cell: null });
      }

      const skills = salaryCommand(snap);
      if (cands.length === 0) return skills;
      cands.sort((a, b) => b.cost - a.cost || (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
      const pick = cands[0] as Candidate;
      if (pick.kind === 'research') return [...skills, { type: 'research', techId: pick.unitId }];
      if (pick.kind === 'upgrade') return [...skills, { type: 'upgrade', towerId: pick.towerId }];
      return [...skills, { type: 'build', unitId: pick.unitId, cell: pick.cell as Cell }];
    },
  };
}
