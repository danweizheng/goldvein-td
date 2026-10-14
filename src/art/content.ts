/**
 * 生成输入的形状化（`src/data/units.json` / `enemies.json` → 美术层输入）。
 *
 * ## 为什么要有这一层
 * 1. **数据驱动（铁律 5）**：`src/art/**` 不 import 具体 JSON，只认结构。
 *    `units.json` 里新增一行 → 自动多一张精灵，**零代码改动**。
 * 2. **零 Node 依赖**：本文件是纯函数，浏览器侧（Vite 打包）与 Node 侧共用同一份逻辑。
 *    （读文件是 `tools/art/**` 的职责。）
 * 3. **唯一的推断点**：敌人数据里**没有**"精英"字段，而方案 §8 的尺寸表要求
 *    「精英 48×48」。推断规则集中在本文件，将来 `data-arch` 补上 `isElite`
 *    字段后只改这里一处（见 `inferElite`）。
 */
import type { SpriteKind } from './types';

/** 塔的最小输入（`units.json` 的超集结构，多余字段会被忽略）。 */
export interface UnitArtInput {
  readonly id: string;
  /** 塔系（`thief` / `archer` / …）。未知值走兜底色板，不抛异常。 */
  readonly line: string;
  /** 品阶 1–5 → 底部齿数。 */
  readonly tier: number;
  /** 展示名（可缺省，只用于接触表标注）。 */
  readonly name?: string;
  /** 阻挡名额（`units.json` 的 `block`），接触表标注用。 */
  readonly block?: number;
  /** 窃金系数（`units.json` 的 `stealBase`），接触表标注用：0 = 不窃金。 */
  readonly stealBase?: number;
}

/** 敌人的最小输入。 */
export interface EnemyArtInput {
  readonly id: string;
  /** 护甲类型（`light` / `medium` / `heavy` / `fortified` / `divine`）。 */
  readonly armorType: string;
  readonly flying: boolean;
  readonly isBoss: boolean;
  /** 窃金抗性千分比：> 0 画挂锁，= 1000 加斜杠。 */
  readonly stealResist: number;
  /** 闪避千分比（仅用于精英推断的兜底规则）。 */
  readonly dodge?: number;
  /** 显式精英标记。**当前 `enemies.json` 没有这个字段**，见 `inferElite`。 */
  readonly isElite?: boolean;
  readonly name?: string;
}

/** 一次生成所需的全部输入。 */
export interface ArtContentInput {
  readonly units: readonly UnitArtInput[];
  readonly enemies: readonly EnemyArtInput[];
}

/** 精英敌的 48×48 尺寸来自方案 §8；判定规则集中在这里。 */
export function inferElite(enemy: EnemyArtInput): boolean {
  if (enemy.isBoss) return false;
  if (enemy.isElite !== undefined) return enemy.isElite;
  // 兜底 1：id 前缀（当前数据里 `elite_assassin`）。
  if (enemy.id.startsWith('elite') || enemy.id.includes('_elite')) return true;
  // 兜底 2：有闪避 = 精英级机制。当前数据里只有 `elite_assassin` 命中。
  return (enemy.dodge ?? 0) > 0;
}

/** 精灵档位（决定帧尺寸）。 */
export type SpriteRank = 'tower' | 'enemy' | 'elite' | 'boss';

/** 敌人的档位。 */
export function enemyRank(enemy: EnemyArtInput): Exclude<SpriteRank, 'tower'> {
  if (enemy.isBoss) return 'boss';
  if (inferElite(enemy)) return 'elite';
  return 'enemy';
}

/** 某个档位属于哪一类精灵。 */
export function kindOfRank(rank: SpriteRank): SpriteKind {
  return rank === 'tower' ? 'tower' : 'enemy';
}

/** 结构化的原始输入（`JSON.parse` 的结果）。 */
export interface RawData {
  readonly units: readonly UnitArtInput[];
  readonly enemies: readonly EnemyArtInput[];
}

/**
 * 把原始 JSON 归一化成生成输入。
 *
 * 目前只做两件事：**按 id 去重（先到先得，抛异常提示）**与**冻结默认值**。
 * 刻意不"修正"任何数据 —— 数据错误应由 `tools/validate-data.ts` 拦，
 * 美术层只负责"有输入就一定有图"。
 */
export function normalizeContent(raw: RawData): ArtContentInput {
  const seenUnits = new Set<string>();
  const units: UnitArtInput[] = [];
  for (const u of raw.units) {
    if (seenUnits.has(u.id)) throw new Error(`units 里 id 重复：${u.id}`);
    seenUnits.add(u.id);
    units.push({
      id: u.id,
      line: u.line,
      tier: u.tier,
      ...(u.name !== undefined ? { name: u.name } : {}),
      ...(u.block !== undefined ? { block: u.block } : {}),
      ...(u.stealBase !== undefined ? { stealBase: u.stealBase } : {}),
    });
  }

  const seenEnemies = new Set<string>();
  const enemies: EnemyArtInput[] = [];
  for (const e of raw.enemies) {
    if (seenEnemies.has(e.id)) throw new Error(`enemies 里 id 重复：${e.id}`);
    seenEnemies.add(e.id);
    enemies.push({
      id: e.id,
      armorType: e.armorType,
      flying: e.flying,
      isBoss: e.isBoss,
      stealResist: e.stealResist,
      ...(e.dodge !== undefined ? { dodge: e.dodge } : {}),
      ...(e.isElite !== undefined ? { isElite: e.isElite } : {}),
      ...(e.name !== undefined ? { name: e.name } : {}),
    });
  }

  // 两个集合共用一个 id 命名空间（图集 key = `${id}:${state}`），必须交叉查重。
  for (const id of seenUnits) {
    if (seenEnemies.has(id)) throw new Error(`塔与敌人 id 撞车：${id}`);
  }
  return { units, enemies };
}

/** 生成输入的只读视图（供接触表按"塔系 → 品阶"排序）。 */
export function unitsByLine(content: ArtContentInput): Map<string, UnitArtInput[]> {
  const map = new Map<string, UnitArtInput[]>();
  for (const u of content.units) {
    const list = map.get(u.line);
    if (list) list.push(u);
    else map.set(u.line, [u]);
  }
  for (const list of map.values()) list.sort((a, b) => a.tier - b.tier || (a.id < b.id ? -1 : 1));
  return map;
}
