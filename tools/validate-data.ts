#!/usr/bin/env tsx
/**
 * tools/validate-data.ts —— 8 张配置表的 Schema 校验 + 引用完整性校验
 * 所有者：data-arch（AGENTS.md §2）。消费：CI / 全体 agent。
 *
 * 用法：
 *   pnpm validate-data          （= tsx tools/validate-data.ts）
 *   npx tsx tools/validate-data.ts
 *
 * 设计要点：
 *  1) Schema 校验用 ajv（draft-07）。每张表的 Schema 描述「单个条目」，
 *     校验时包一层 { type: 'array', items: <schema>, minItems, maxItems }，
 *     以便同时把「条目数」钉死（23/11/30/8/9/6/5）。
 *  2) 引用完整性单独实现（Schema 做不到跨表检查）：
 *     waves.groups[].enemy → enemies.id
 *     units.upgradesTo[]   → units.id
 *     units.abilities[].id → Schema 内的技能目录枚举
 *     units.auras[]/ability 目录 → aura 单对象已弃用（裁决），只校验 auras 非空
 *     relics.unlocksUnit   → units.id
 *     tech.requires[]      → tech.id
 *  3) 报错必须能定位到「文件名 + 条目索引 + 条目 id + 字段名」。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import type { ErrorObject } from 'ajv';

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const DATA_DIR = resolve(ROOT, 'src', 'data');
export const SCHEMA_DIR = resolve(DATA_DIR, 'schema');
/** 音频文件真值目录（契约 §11.1：public/assets/audio/<id>.ogg，扁平结构） */
export const PUBLIC_AUDIO_DIR = resolve(ROOT, 'public', 'assets', 'audio');

// ---------------------------------------------------------------------------
// 表清单（接口契约 §3.1）
// ---------------------------------------------------------------------------

export interface TableSpec {
  /** 数据文件名 */
  file: string;
  /** Schema 文件名 */
  schema: string;
  /** 根类型名 */
  name: string;
  /** root 是数组还是单对象 */
  kind: 'array' | 'object';
  /** 契约钉死的条目数（object 为 null） */
  count: number | null;
  /** 一句话说明 */
  what: string;
}

export const TABLES: readonly TableSpec[] = [
  { file: 'units.json', schema: 'units.schema.json', name: 'UnitDef', kind: 'array', count: 29, what: '9 系 / 29 种单位（§4.2 + §4.1.3 小精灵 + §4.2.8 工人 + §4.4.1 科技塔）' },
  { file: 'enemies.json', schema: 'enemies.schema.json', name: 'EnemyDef', kind: 'array', count: 11, what: '11 类敌人（含 4 BOSS）（§4.5.2）' },
  { file: 'waves.json', schema: 'waves.schema.json', name: 'WaveDef', kind: 'array', count: 30, what: '30 波结构（§4.5.1）' },
  { file: 'tech.json', schema: 'tech.schema.json', name: 'TechDef', kind: 'array', count: 8, what: '8 条科技线 × 5 级（§4.4.1）' },
  { file: 'relics.json', schema: 'relics.schema.json', name: 'RelicDef', kind: 'array', count: 9, what: '9 个圣物（§4.7.2）' },
  { file: 'equipment.json', schema: 'equipment.schema.json', name: 'EquipmentDef', kind: 'array', count: 6, what: '6 件装备（M6，§4.2.7）' },
  { file: 'difficulty.json', schema: 'difficulty.schema.json', name: 'DifficultyDef', kind: 'array', count: 5, what: 'N1–N5（§4.8）' },
  { file: 'constants.json', schema: 'constants.schema.json', name: 'BalanceConstants', kind: 'object', count: null, what: '全局平衡常量（§3.3）' },
  { file: 'audio.json', schema: 'audio.schema.json', name: 'AudioDef', kind: 'array', count: 40, what: '音频清单（契约 §11.2，v0.1.1 增补）' },
  { file: 'map.json', schema: 'map.schema.json', name: 'MapDef', kind: 'object', count: null, what: '地图与路径（契约 §14.11 增补的第 10 张表）' },
] as const;

/** 音频类别 → 条目数（对照策划案 §7.3 / 台账类别核对表） */
export const AUDIO_CATEGORY_COUNTS: Readonly<Record<string, number>> = {
  bgm: 4,
  sfx: 34,
  ambience: 2,
};

/** 契约 §14.2：这 4 条科技改乘法后，5 级乘积必须等于文档给出的总倍率 */
export const TECH_MUL_TOTAL: Readonly<Record<string, number>> = {
  attack: 7.59,
  attack_speed: 5.38,
  range: 1.61,
  steal_efficiency: 1.76,
};

/** 契约 §14.2 的验算参数：tier 52.5× × 攻击 7.59× × 攻速 5.38× 必须压住血量 1373× */
export const TIER_STRENGTH_MUL = 52.5;
export const HP_GROWTH_TO_BEAT = 1373;

/** 契约 §13.5：BOSS 波每波总钱包 ≥ 相邻非 BOSS 波的该比例 */
export const BOSS_WAVE_WALLET_FLOOR = 600;

// ---------------------------------------------------------------------------
// 报错结构
// ---------------------------------------------------------------------------

export interface Issue {
  file: string;
  /** 数组条目索引；非数组表为 null */
  index: number | null;
  /** 条目 id / 波次号，便于人眼定位 */
  id: string | null;
  /** 字段路径，如 attackInterval / cost.gold / groups[1].enemy */
  field: string;
  message: string;
}

function renderIssue(it: Issue): string {
  const head = it.index === null ? `src/data/${it.file}` : `src/data/${it.file}  #${it.index}${it.id ? ` (${it.id})` : ''}`;
  return `✖ ${head}\n    .${it.field}  →  ${it.message}`;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function readJson(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(`${path} 不是合法 JSON：${(e as Error).message}`);
  }
}

function splitPath(instancePath: string): { index: number | null; field: string } {
  const parts = instancePath.split('/').filter((p) => p.length > 0);
  let index: number | null = null;
  if (parts.length > 0 && /^\d+$/.test(parts[0]!)) {
    index = Number(parts[0]);
    parts.shift();
  }
  let field = '';
  for (const p of parts) {
    if (/^\d+$/.test(p)) field += `[${p}]`;
    else field += field === '' ? p : `.${p}`;
  }
  return { index, field: field === '' ? '(root)' : field };
}

function entryId(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;
  if (typeof o['id'] === 'string') return o['id'];
  if (typeof o['wave'] === 'number') return `wave ${o['wave']}`;
  if (typeof o['name'] === 'string') return String(o['name']);
  return null;
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

export interface LoadedTables {
  units: any[];
  enemies: any[];
  waves: any[];
  tech: any[];
  relics: any[];
  equipment: any[];
  difficulty: any[];
  constants: any;
  audio: any[];
  map: any;
}

export function loadTables(dataDir: string = DATA_DIR): LoadedTables {
  const opt = (f: string): any => (existsSync(resolve(dataDir, f)) ? readJson(resolve(dataDir, f)) : undefined);
  return {
    units: readJson(resolve(dataDir, 'units.json')) as any[],
    enemies: readJson(resolve(dataDir, 'enemies.json')) as any[],
    waves: readJson(resolve(dataDir, 'waves.json')) as any[],
    tech: readJson(resolve(dataDir, 'tech.json')) as any[],
    relics: readJson(resolve(dataDir, 'relics.json')) as any[],
    equipment: readJson(resolve(dataDir, 'equipment.json')) as any[],
    difficulty: readJson(resolve(dataDir, 'difficulty.json')) as any[],
    constants: readJson(resolve(dataDir, 'constants.json')) as any,
    audio: opt('audio.json') ?? [],
    map: opt('map.json') ?? null,
  };
}

// ---------------------------------------------------------------------------
// 策划案 §4.5.2「出现波次」表 —— 敌人类型最早可出现的波次（引用完整性之外的波次门禁）
// ---------------------------------------------------------------------------

export const FIRST_WAVE_BY_ENEMY: Readonly<Record<string, number>> = {
  thug: 1,
  bat: 5,
  heavy_brute: 9,
  armored_car: 12,
  elite_assassin: 13,
  merchant_lock: 17,
  boss_behemoth: 24,
  boss_inner_demon: 25,
  boss_reincarnator: 26,
  ascendant: 27,
  temple_guard: 28,
};

/** 每条科技线的单线总投入（金/木）。口径见下方 TECH_GRAND_TOTAL 的注释（契约 §15.13）。 */
export const TECH_TOTAL_INVESTMENT: Readonly<Record<string, { gold: number; wood: number }>> = {
  steal_efficiency: { gold: 78000, wood: 7800 },
  attack: { gold: 67500, wood: 6700 },
  attack_speed: { gold: 67500, wood: 6700 },
  range: { gold: 53500, wood: 5300 },
  steal_crit_rate: { gold: 89000, wood: 8900 },
  steal_crit_mul: { gold: 89000, wood: 8900 },
  population: { gold: 45500, wood: 4700 },
  base_level: { gold: 86000, wood: 0 },
};

/**
 * 8 条科技线的总额，来自契约 **§15.13** 的口径：
 *   总收入        = 窃金 + 击杀奖励 + 波次结算 = **1,937,191**
 *   支出预算      = 总收入 × **85%**（§5.4 的 80–90% 带取中）= **1,646,613**
 *   §14.12 四个占比 = **支出预算内的份额**（塔 50 / 科技 35 / 精灵 8 / 杂项 7 = 1000‰）
 *   ⇒ 科技 = 350‰ × 1,646,613 = 576,314 → 取整 **576,000 金**；木材同比例 → **49,000 木**
 *
 * （曾按「收入 × 35% = 677,900」算过一版 677,000 —— 那是把「占预算的 35%」误当成「占收入的 35%」。）
 */
export const TECH_GRAND_TOTAL: Readonly<{ gold: number; wood: number }> = { gold: 576000, wood: 49000 };

/** §15.13 的口径常量（校验器与测试共用，测试用它反推 576,000） */
export const INCOME_N2 = 1937191;
export const SPEND_BUDGET_PCT = 850; // 支出预算 = 总收入 × 85%

/**
 * 科技线 id → 作用槽位（契约 §14.20 新增的必填字段 `TechDef.target`）。
 * 此前效果由 `id` 隐含，引擎只能硬编码一张映射表（违反铁律 5）；现在数据自己声明。
 */
export const TECH_TARGET: Readonly<Record<string, string>> = {
  attack: 'attack',
  attack_speed: 'speed',
  range: 'range',
  steal_efficiency: 'steal',
  steal_crit_rate: 'critRate',
  steal_crit_mul: 'critMul',
  population: 'population',
  base_level: 'baseLevel',
};

/**
 * 每系的单位数量。
 * 前 6 个是 §4.2 的六大战斗塔系（23 种）；
 * 后 3 个是主策划裁决（Blocker 1/2）后并入 units.json 的经济/功能系：
 *   worker（§4.2.8 工人）、sprite（§4.1.3 四档小精灵）、tech（§4.4.1 科技塔）。
 */
export const UNITS_PER_LINE: Readonly<Record<string, number>> = {
  thief: 5,
  archer: 4,
  mage: 5,
  drill: 3,
  beauty: 3,
  cannon: 3,
  worker: 1,
  sprite: 4,
  tech: 1,
};

/** 使用升级树（upgradesTo）的塔系 —— 只有这些系需要「唯一 T1 根 + 全可达」 */
export const LINES_WITH_UPGRADE_TREE: readonly string[] = ['thief', 'archer', 'mage', 'drill', 'beauty', 'cannon'];

// ---------------------------------------------------------------------------
// 主校验
// ---------------------------------------------------------------------------

export interface ValidationReport {
  issues: Issue[];
  /** 成功执行的结构化检查名（用于汇报证据） */
  checks: string[];
  counts: Record<string, number>;
}

export function validateAllData(opts: { dataDir?: string; schemaDir?: string; audioDir?: string } = {}): ValidationReport {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const schemaDir = opts.schemaDir ?? SCHEMA_DIR;
  const issues: Issue[] = [];
  const checks: string[] = [];
  const counts: Record<string, number> = {};

  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, validateFormats: false });

  const push = (file: string, index: number | null, id: string | null, field: string, message: string): void => {
    issues.push({ file, index, id, field, message });
  };

  // ---- 1. Schema 校验 ------------------------------------------------------
  for (const t of TABLES) {
    const schemaPath = resolve(schemaDir, t.schema);
    const dataPath = resolve(dataDir, t.file);
    if (!existsSync(schemaPath)) {
      push(t.file, null, null, '(schema)', `缺 Schema 文件 ${t.schema}`);
      continue;
    }
    if (!existsSync(dataPath)) {
      push(t.file, null, null, '(file)', `缺数据文件 ${t.file}`);
      continue;
    }
    const schema = readJson(schemaPath) as Record<string, unknown>;
    const data = readJson(dataPath);

    // 每张表的 Schema 描述「单个条目」，因此逐条校验；错误里由本函数补上条目索引，
    // 避免用 array-wrapper 造成 $ref: '#/definitions/...' 解析基准错位。
    const validate = ajv.compile(schema);
    let arr: unknown[] = [];
    const entries: Array<{ index: number | null; value: unknown }> =
      t.kind === 'array'
        ? (arr = data as unknown[]).map((value, index) => ({ index, value }))
        : [{ index: null, value: data }];
    counts[t.file] = t.kind === 'array' ? arr.length : 1;

    for (const { index, value } of entries) {
      if (validate(value)) continue;
      for (const err of (validate.errors ?? []) as ErrorObject[]) {
        let { field } = splitPath(err.instancePath);
        const id = index === null ? null : entryId(arr[index]);
        let msg = err.message ?? '校验失败';
        if (err.keyword === 'enum') {
          msg = `取值不在枚举内；允许：${JSON.stringify((err.params as any).allowedValues)}`;
        } else if (err.keyword === 'additionalProperties') {
          msg = `不允许的字段 "${(err.params as any).additionalProperties}"（Schema 为 additionalProperties:false）`;
        } else if (err.keyword === 'required') {
          const missing = String((err.params as any).missingProperty);
          field = field === '(root)' ? missing : `${field}.${missing}`;
          msg = `缺少必填字段（${missing}）`;
        } else if (err.keyword === 'type') {
          msg = `类型必须是 ${(err.params as any).type}`;
        } else if (err.keyword === 'minimum' || err.keyword === 'maximum') {
          msg = `${err.keyword === 'minimum' ? '不得小于' : '不得大于'} ${(err.params as any).limit}`;
        } else if (err.keyword === 'minItems' || err.keyword === 'maxItems') {
          msg = `数组长度必须${err.keyword === 'minItems' ? ' ≥ ' : ' ≤ '}${(err.params as any).limit}`;
        } else if (err.keyword === 'minLength') {
          msg = `字符串长度必须 ≥ ${(err.params as any).limit}`;
        } else if (err.keyword === 'pattern') {
          msg = `不匹配正则 ${(err.params as any).pattern}`;
        }
        push(t.file, index, id, field, msg);
      }
    }
    if (!issues.some((i) => i.file === t.file)) checks.push(`schema:${t.file}`);

    // 条目数（契约 §3.1 钉死）
    if (t.kind === 'array' && t.count !== null && arr.length !== t.count) {
      push(t.file, null, null, 'length', `条目数必须是 ${t.count}（契约 §3.1 ${t.what}），实际 ${arr.length}`);
    }
  }

  const tb = loadTables(dataDir);
  const unitById = new Map<string, any>(tb.units.map((u) => [u.id, u]));
  const enemyById = new Map<string, any>(tb.enemies.map((e) => [e.id, e]));
  const techById = new Map<string, any>(tb.tech.map((x) => [x.id, x]));

  // ---- 2. units 引用完整性 + 结构检查 -------------------------------------
  {
    const seen = new Set<string>();
    tb.units.forEach((u, i) => {
      if (seen.has(u.id)) push('units.json', i, u.id, 'id', `id 重复：${u.id}`);
      seen.add(u.id);
      if (u.line === 'hero') push('units.json', i, u.id, 'line', 'hero 系属 M6（决策 D5），本期 units.json 不得包含');
      if (Array.isArray(u.upgradesTo)) {
        u.upgradesTo.forEach((target: string, k: number) => {
          const t = unitById.get(target);
          if (!t) {
            push('units.json', i, u.id, `upgradesTo[${k}]`, `引用了不存在的 unit id "${target}"`);
          } else if (t.tier !== u.tier + 1) {
            push('units.json', i, u.id, `upgradesTo[${k}]`, `升级目标 "${target}" 的 tier=${t.tier}，应为 ${u.tier + 1}`);
          }
        });
      }
      const abil = Array.isArray(u.abilities) ? u.abilities : [];
      const abilIds = new Set<string>();
      abil.forEach((a: any, k: number) => {
        if (abilIds.has(a.id)) push('units.json', i, u.id, `abilities[${k}].id`, `同一单位内技能 id 重复：${a.id}`);
        abilIds.add(a.id);
      });
      if (Array.isArray(u.auras) && u.aura !== undefined) {
        push('units.json', i, u.id, 'aura', '契约 §14.1 的单对象 aura 已被主策划裁决弃用，只允许 auras[]；禁止两者并存');
      }
      if (u.stealBase > 0 && u.critRate <= 0) {
        push('units.json', i, u.id, 'critRate', `窃金塔（stealBase=${u.stealBase}）的 critRate 必须 > 0`);
      }
      if (u.stealBase === 0 && u.critRate !== 0) {
        push('units.json', i, u.id, 'critRate', `非窃金塔（stealBase=0）的 critRate 必须为 0，实际 ${u.critRate}`);
      }
      if (u.stealBase > 0 && u.critMul !== tb.constants.critMulBase) {
        push('units.json', i, u.id, 'critMul', `窃金塔 critMul 应为 constants.critMulBase=${tb.constants.critMulBase}，实际 ${u.critMul}`);
      }
      if (u.block > 0 && u.slowWhileBlocked <= 0) {
        push('units.json', i, u.id, 'slowWhileBlocked', '阻挡塔必须带「列阵」减速（slowWhileBlocked > 0）');
      }
    });
    // 孤岛检测 + 每系唯一根（只对使用升级树的塔系；worker/sprite/tech 是独立可建造项，无升级链）
    const roots = tb.units.filter((u) => u.tier === 1);
    const targeted = new Set<string>();
    tb.units.forEach((u) => (u.upgradesTo ?? []).forEach((t: string) => targeted.add(t)));
    tb.units
      .filter((u) => LINES_WITH_UPGRADE_TREE.includes(u.line) && u.tier > 1 && !targeted.has(u.id))
      .forEach((u) => {
        const i = tb.units.indexOf(u);
        push('units.json', i, u.id, 'upgradesTo', '该单位没有任何前置单位指向它（不可达）');
      });
    Object.entries(UNITS_PER_LINE).forEach(([line, n]) => {
      const list = tb.units.filter((u) => u.line === line);
      if (list.length !== n) {
        push('units.json', null, line, 'line', `${line} 系应注册 ${n} 种，实际 ${list.length} 种`);
      }
      if (!LINES_WITH_UPGRADE_TREE.includes(line)) return;
      const r = roots.filter((u) => u.line === line);
      if (r.length !== 1) {
        push('units.json', null, line, 'tier', `${line} 系应恰有 1 个 T1 根单位，实际 ${r.length} 个`);
      }
    });
    // 无升级链的系（worker/sprite/tech）不得出现 upgradesTo —— 避免与「多条并列可建造项」的定位矛盾
    tb.units
      .filter((u) => !LINES_WITH_UPGRADE_TREE.includes(u.line) && Array.isArray(u.upgradesTo))
      .forEach((u) => {
        push('units.json', tb.units.indexOf(u), u.id, 'upgradesTo', `${u.line} 系是并列可建造项，不应有 upgradesTo`);
      });
    checks.push(
      'ref:units.upgradesTo→units.id',
      'ref:units.abilities.id(目录枚举)',
      'units.每系数量+唯一根+可达性（仅限 6 大战斗塔系）',
      'units.弃用 aura（只允许 auras[]）',
    );
  }

  // ---- 3. enemies 检查 ----------------------------------------------------
  {
    const seen = new Set<string>();
    tb.enemies.forEach((e, i) => {
      if (seen.has(e.id)) push('enemies.json', i, e.id, 'id', `id 重复：${e.id}`);
      seen.add(e.id);
      const expectBoss = e.id.startsWith('boss_') || e.id === 'ascendant';
      if (e.isBoss !== expectBoss) push('enemies.json', i, e.id, 'isBoss', `isBoss=${e.isBoss} 与命名不符（应 ${expectBoss}）`);
      if (e.stealResist >= tb.constants.stealImmunityThreshold && !(e.hooks ?? []).includes('steal_immune')) {
        push('enemies.json', i, e.id, 'hooks', `stealResist=${e.stealResist} 达到免疫阈值，hooks 必须含 "steal_immune"`);
      }
      if (e.dodge + e.stealResist > 1000) {
        push('enemies.json', i, e.id, 'dodge', `dodge(${e.dodge}) + stealResist(${e.stealResist}) 不得超过 1000（千分比）`);
      }
      if (!(e.id in FIRST_WAVE_BY_ENEMY)) {
        push('enemies.json', i, e.id, 'id', `策划案 §4.5.2 敌人类型表中没有 "${e.id}"，请在 validator 的 FIRST_WAVE_BY_ENEMY 中登记出现波次`);
      }
    });
    const bosses = tb.enemies.filter((e) => e.isBoss);
    if (bosses.length !== 4) push('enemies.json', null, null, 'isBoss', `策划案 §4.5.2 有 4 个 BOSS，实际 ${bosses.length} 个`);
    checks.push('enemies.id唯一', 'enemies.isBoss命名一致', 'enemies.窃金免疫↔hooks', 'enemies.BOSS数量=4');
  }

  // ---- 4. waves 引用完整性 + 波段门禁 -------------------------------------
  {
    const waves = [...tb.waves].sort((a, b) => a.wave - b.wave);
    const seen = new Set<number>();
    let prevGold = -1;
    waves.forEach((w) => {
      const i = tb.waves.indexOf(w);
      if (seen.has(w.wave)) push('waves.json', i, `wave ${w.wave}`, 'wave', `波次号重复：${w.wave}`);
      seen.add(w.wave);
      const armors = new Set<string>();
      w.groups.forEach((g: any, k: number) => {
        const e = enemyById.get(g.enemy);
        if (!e) {
          push('waves.json', i, `wave ${w.wave}`, `groups[${k}].enemy`, `引用了不存在的敌人 id "${g.enemy}"`);
        } else {
          armors.add(e.armorType);
          const first = FIRST_WAVE_BY_ENEMY[g.enemy];
          if (first !== undefined && w.wave < first) {
            push(
              'waves.json',
              i,
              `wave ${w.wave}`,
              `groups[${k}].enemy`,
              `"${g.enemy}" 按策划案 §4.5.2 最早出现在第 ${first} 波，本波是第 ${w.wave} 波`,
            );
          }
        }
        if (Array.isArray(g.path)) {
          g.path.forEach((p: number, m: number) => {
            if (p >= tb.constants.map.laneCount) {
              push(
                'waves.json',
                i,
                `wave ${w.wave}`,
                `groups[${k}].path[${m}]`,
                `路径索引 ${p} 超出 constants.map.laneCount=${tb.constants.map.laneCount}`,
              );
            }
          });
        }
      });
      if (!armors.has(w.hint.recommendArmor)) {
        push(
          'waves.json',
          i,
          `wave ${w.wave}`,
          'hint.recommendArmor',
          `推荐护甲 "${w.hint.recommendArmor}" 不在本波出现的护甲集合 [${[...armors].join(', ')}] 中`,
        );
      }
      if (w.reward.gold < prevGold) {
        push('waves.json', i, `wave ${w.wave}`, 'reward.gold', `本波结算金币 ${w.reward.gold} 低于上一波 ${prevGold}（奖励曲线应单调不减）`);
      }
      prevGold = Math.max(prevGold, w.reward.gold);
    });
    for (let n = 1; n <= tb.constants.waveTotal; n++) {
      if (!seen.has(n)) push('waves.json', null, null, 'wave', `缺少第 ${n} 波（waveTotal=${tb.constants.waveTotal}）`);
    }

    // ★ 主策划裁决（A3/A4/A8）：§5.1 的 Q(n) 降级为「规划参考」，不是逐波硬要求。
    //   取而代之的强制不变量：**非 BOSS 波的敌人总数必须单调不减**（节奏不得倒挂）。
    //   「BOSS 波」= 该波 groups 中含 isBoss 敌人（第 24/25/26/27/30 波），它们不参与该序列。
    const isBossWave = (w: any): boolean => w.groups.some((g: any) => enemyById.get(g.enemy)?.isBoss === true);
    const nonBossTotals: Array<{ wave: number; total: number; index: number }> = [];
    for (const w of waves) {
      if (isBossWave(w)) continue;
      nonBossTotals.push({
        wave: w.wave,
        total: w.groups.reduce((s: number, g: any) => s + g.count, 0),
        index: tb.waves.indexOf(w),
      });
    }
    for (let k = 1; k < nonBossTotals.length; k++) {
      const prev = nonBossTotals[k - 1]!;
      const cur = nonBossTotals[k]!;
      if (cur.total < prev.total) {
        push(
          'waves.json',
          cur.index,
          `wave ${cur.wave}`,
          'groups',
          `非 BOSS 波敌人总数必须单调不减：第 ${prev.wave} 波 ${prev.total} 只 → 第 ${cur.wave} 波 ${cur.total} 只（节奏倒挂）`,
        );
      }
    }
    // 作为参考信息把非 BOSS 波序列登记进 checks，便于人工复核曲线形状
    checks.push(
      `waves.非BOSS波总数单调不减（序列 ${nonBossTotals.map((x) => x.total).join('→')}）`,
      `waves.BOSS 波已排除：${waves.filter(isBossWave).map((w: any) => w.wave).join('/')}（含 BOSS 的波不参与数量序列）`,
    );
    // Q(n) 仅作参考：与 §5.1 规划值的偏差登记为「非错误」，但把偏离 >40% 的波列出来提醒
    const q = (n: number): number => 6 + Math.floor((tb.constants.enemyCountSlope * n) / tb.constants.fixedScale);
    const farOff = nonBossTotals.filter((x) => Math.abs(x.total - q(x.wave)) / q(x.wave) > 0.4).length;
    checks.push(`waves.Q(n) 已降级为规划参考（偏离 Q(n) >40% 的非 BOSS 波数：${farOff}/${nonBossTotals.length}，不算错误）`);
    checks.push('ref:waves.groups[].enemy→enemies.id', 'waves.波次号1..30唯一', 'waves.§4.5.2出现波次门禁', 'waves.path索引<laneCount', 'waves.hint护甲自洽', 'waves.奖励单调不减');

    // ★ 契约 §13.5：BOSS 波不得形成经济断崖（每波总钱包 ≥ 相邻非 BOSS 波的 60%）
    const scale = tb.constants.fixedScale;
    const waveWallet = (w: any): number => {
      let sum = 0;
      for (const g of w.groups) {
        const e = enemyById.get(g.enemy);
        if (!e) continue;
        sum += g.count * (e.baseWallet / scale) * Math.pow(tb.constants.walletIndex / scale, w.wave - 1);
      }
      return sum;
    };
    const bossWaves = waves.filter(isBossWave);
    const nonBossWaves = waves.filter((w: any) => !isBossWave(w));
    const strictGaps: string[] = [];
    for (const bw of bossWaves) {
      const prev = [...nonBossWaves].reverse().find((w: any) => w.wave < bw.wave);
      const next = nonBossWaves.find((w: any) => w.wave > bw.wave);
      const refs = [prev, next].filter(Boolean).map((w: any) => ({ wave: w.wave, wallet: waveWallet(w) }));
      if (refs.length === 0) continue;
      const got = waveWallet(bw);
      const poorer = refs.reduce((a, b) => (b.wallet < a.wallet ? b : a));
      const need = (poorer.wallet * BOSS_WAVE_WALLET_FLOOR) / 1000;
      if (got < need) {
        push(
          'waves.json',
          tb.waves.indexOf(bw),
          `wave ${bw.wave}`,
          'groups',
          `BOSS 波每波总钱包 ${Math.round(got)} 低于相邻非 BOSS 波（第 ${poorer.wave} 波 ${Math.round(poorer.wallet)}）的 ${BOSS_WAVE_WALLET_FLOOR / 10}% = ${Math.round(need)} —— 契约 §13.5 经济断崖门禁`,
        );
      }
      // 严格的「对两侧都成立」读法：仅登记为信息（见汇报「需要裁决」）
      const richest = refs.reduce((a, b) => (b.wallet > a.wallet ? b : a));
      const strictNeed = (richest.wallet * BOSS_WAVE_WALLET_FLOOR) / 1000;
      if (got < strictNeed) {
        strictGaps.push(`w${bw.wave}(${Math.round(got)}<${Math.round(strictNeed)}，需 ×${(strictNeed / got).toFixed(1)})`);
      }
    }
    checks.push(
      `waves.BOSS 波钱包 ≥ 相邻非 BOSS 波 ${BOSS_WAVE_WALLET_FLOOR / 10}%（取较穷一侧；BOSS 波：${bossWaves.map((w: any) => w.wave).join('/')}）`,
      strictGaps.length === 0
        ? 'waves.BOSS 波同时满足「较富一侧」60%（严格读法）'
        : `waves.信息（非门禁）：按「对两侧都成立」的严格读法，以下 BOSS 波未达标 → ${strictGaps.join(' ')}`,
    );
  }

  // ---- 5. tech ------------------------------------------------------------
  {
    const seen = new Set<string>();
    tb.tech.forEach((t, i) => {
      if (seen.has(t.id)) push('tech.json', i, t.id, 'id', `id 重复：${t.id}`);
      seen.add(t.id);
      if (t.costPerLevel.length !== t.maxLevel) {
        push('tech.json', i, t.id, 'costPerLevel', `长度必须 == maxLevel(${t.maxLevel})，实际 ${t.costPerLevel.length}`);
      }
      (t.requires ?? []).forEach((r: string, k: number) => {
        if (!techById.has(r)) push('tech.json', i, t.id, `requires[${k}]`, `引用了不存在的科技 id "${r}"`);
      });
      if (t.archivable !== true) push('tech.json', i, t.id, 'archivable', '策划案 §4.4.1 全部 8 条科技线「是否存档」均为 ✅');
      const total = TECH_TOTAL_INVESTMENT[t.id];
      if (!total) {
        push('tech.json', i, t.id, 'id', '策划案 §4.4.1 科技表中没有这条线');
      } else {
        const g = t.costPerLevel.reduce((s: number, c: any) => s + c.gold, 0) / tb.constants.fixedScale;
        const w = t.costPerLevel.reduce((s: number, c: any) => s + c.wood, 0) / tb.constants.fixedScale;
        if (g !== total.gold || w !== total.wood) {
          push('tech.json', i, t.id, 'costPerLevel', `单线总投入应为 ${total.gold} 金 / ${total.wood} 木，实际 ${g} 金 / ${w} 木`);
        }
      }
      // ★ 契约 §14.2：乘法模式的 5 级乘积必须等于文档给出的总倍率
      const wantMul = TECH_MUL_TOTAL[t.id];
      if (wantMul !== undefined) {
        if (t.effectMode !== 'mul') {
          push('tech.json', i, t.id, 'effectMode', `契约 §14.2 要求这条线为乘法（mul），实际 "${t.effectMode}"`);
        } else {
          const got = Math.pow(t.effectPerLevel / tb.constants.fixedScale, t.maxLevel);
          if (Math.abs(got - wantMul) > 0.01) {
            push(
              'tech.json',
              i,
              t.id,
              'effectPerLevel',
              `${t.effectPerLevel}/1000 的 ${t.maxLevel} 次方 = ${got.toFixed(2)}×，契约 §14.2 要求 ${wantMul}×`,
            );
          }
        }
      }
      // ★ 契约 §14.20：`target` 必须与 id 对应，且不得缺省
      const wantTarget = TECH_TARGET[t.id];
      if (wantTarget === undefined) {
        push('tech.json', i, t.id, 'target', `TECH_TARGET 映射表里没有这条线（新增科技线必须在 tools/validate-data.ts 登记 target）`);
      } else if (t.target !== wantTarget) {
        push('tech.json', i, t.id, 'target', `契约 §14.20：${t.id} 的 target 应为 "${wantTarget}"，实际 "${t.target}"`);
      }
      // 保持加法的两条（有上限）必须带 effectCap，且与 constants 的 cap 一致
      if (t.effectMode === 'add' && t.effectCap !== undefined) {
        const capKey = t.id === 'steal_crit_rate' ? 'critRateCap' : t.id === 'steal_crit_mul' ? 'critMulCap' : null;
        if (capKey && t.effectCap !== tb.constants[capKey]) {
          push('tech.json', i, t.id, 'effectCap', `必须等于 constants.${capKey}=${tb.constants[capKey]}，实际 ${t.effectCap}`);
        }
      }
    });
    // ★ 契约 §15.13：8 条线总额必须精确等于 576,000 金 / 49,000 木
    const grandGold = tb.tech.reduce((s, t) => s + t.costPerLevel.reduce((a: number, c: any) => a + c.gold, 0), 0) / tb.constants.fixedScale;
    const grandWood = tb.tech.reduce((s, t) => s + t.costPerLevel.reduce((a: number, c: any) => a + c.wood, 0), 0) / tb.constants.fixedScale;
    if (grandGold !== TECH_GRAND_TOTAL.gold || grandWood !== TECH_GRAND_TOTAL.wood) {
      push(
        'tech.json',
        null,
        null,
        'costPerLevel',
        `8 条线总额必须精确等于 ${TECH_GRAND_TOTAL.gold} 金 / ${TECH_GRAND_TOTAL.wood} 木（契约 §15.13：350‰ × 支出预算 1,646,613），实际 ${grandGold} 金 / ${grandWood} 木`,
      );
    }
    // §14.2 的总验算：tier × 攻击 × 攻速 必须压住血量成长
    const dpsGrowth =
      TIER_STRENGTH_MUL *
      (tb.tech.find((t) => t.id === 'attack')?.effectPerLevel / tb.constants.fixedScale) ** 5 *
      (tb.tech.find((t) => t.id === 'attack_speed')?.effectPerLevel / tb.constants.fixedScale) ** 5;
    if (dpsGrowth < HP_GROWTH_TO_BEAT) {
      push(
        'tech.json',
        null,
        null,
        'effectPerLevel',
        `契约 §14.2 验算：tier ${TIER_STRENGTH_MUL}× × 攻击 × 攻速 = ${dpsGrowth.toFixed(0)}×，必须 ≥ 血量成长 ${HP_GROWTH_TO_BEAT}×`,
      );
    }
    checks.push(
      'tech.costPerLevel长度==maxLevel',
      'tech.requires→tech.id',
      `tech.8 条线总额 == 契约 §15.13 的 ${TECH_GRAND_TOTAL.gold} 金 / ${TECH_GRAND_TOTAL.wood} 木（350‰ × 支出预算 1,646,613）`,
      `tech.target == §14.20 的 8 个槽位（引擎据此删除硬编码 id→槽位映射表）`,
      'tech.8条线齐全',
      `tech.effectMode（mul 4 条 / add 2 条 + population/base_level 保持 add）`,
      `tech.§14.2 验算：tier×攻击×攻速 = ${dpsGrowth.toFixed(0)}× ≥ 血量 ${HP_GROWTH_TO_BEAT}×（余量 ${(dpsGrowth / HP_GROWTH_TO_BEAT).toFixed(2)}×）`,
    );
  }

  // ---- 6. relics ----------------------------------------------------------
  {
    const seen = new Set<string>();
    tb.relics.forEach((r, i) => {
      if (seen.has(r.id)) push('relics.json', i, r.id, 'id', `id 重复：${r.id}`);
      seen.add(r.id);
      if (r.crystalCostPerLevel.length !== r.maxLevel) {
        push('relics.json', i, r.id, 'crystalCostPerLevel', `长度必须 == maxLevel(${r.maxLevel})，实际 ${r.crystalCostPerLevel.length}`);
      }
      if (r.unlocksUnit) {
        if (!unitById.has(r.unlocksUnit)) {
          push('relics.json', i, r.id, 'unlocksUnit', `引用了不存在的 unit id "${r.unlocksUnit}"`);
        }
        if (r.maxLevel !== 1) push('relics.json', i, r.id, 'maxLevel', '解锁类圣物 maxLevel 必须为 1');
        if (r.effectPerLevel !== 0) push('relics.json', i, r.id, 'effectPerLevel', '解锁类圣物无数值效果，effectPerLevel 必须为 0');
      }
      if (r.effectUnit === 'count' && !Number.isInteger(r.effectPerLevel)) {
        push('relics.json', i, r.id, 'effectPerLevel', 'effectUnit=count 时必须是整数');
      }
    });
    checks.push('ref:relics.unlocksUnit→units.id', 'relics.crystalCostPerLevel长度==maxLevel', 'relics.解锁类圣物约束');
  }

  // ---- 7. equipment ------------------------------------------------------
  {
    const seen = new Set<string>();
    tb.equipment.forEach((e, i) => {
      if (seen.has(e.id)) push('equipment.json', i, e.id, 'id', `id 重复：${e.id}`);
      seen.add(e.id);
      if (e.availableFrom !== 'M6') {
        push('equipment.json', i, e.id, 'availableFrom', '契约 §3.1：equipment.json 属 M6，本期只建表，availableFrom 应为 M6');
      }
    });
    checks.push('equipment.id唯一', 'equipment.本期全部 M6');
  }

  // ---- 8. difficulty ------------------------------------------------------
  {
    const ids = tb.difficulty.map((d) => d.id);
    const expect = ['N1', 'N2', 'N3', 'N4', 'N5'];
    if (ids.join(',') !== expect.join(',')) {
      push('difficulty.json', null, null, 'id', `难度 id 必须按 N1,N2,N3,N4,N5 顺序出现，实际 [${ids.join(', ')}]`);
    }
    tb.difficulty.forEach((d, i) => {
      const cm = tb.constants.difficultyCrystalMul[d.id];
      if (cm !== d.crystalMul) {
        push('difficulty.json', i, d.id, 'crystalMul', `必须与 constants.difficultyCrystalMul.${d.id}=${cm} 一致，实际 ${d.crystalMul}`);
      }
      if (d.openLanes !== 2 && d.openLanes !== 4) {
        push('difficulty.json', i, d.id, 'openLanes', '策划案 §4.6：只有 2 路（N1/N2）与 4 路（N3+）两种');
      }
      if (d.counterMode === 'compressed' && d.divineArmorAllWaves) {
        push('difficulty.json', i, d.id, 'divineArmorAllWaves', '压缩克制与全程神圣甲不应同时启用');
      }
    });
    checks.push('difficulty.id顺序', 'difficulty.crystalMul↔constants', 'difficulty.开放路数∈{2,4}');
  }

  // ---- 9. constants ------------------------------------------------------
  {
    const c = tb.constants;
    if (c.levelMul.length !== 5) push('constants.json', null, null, 'levelMul', `必须恰好 5 个元素，实际 ${c.levelMul.length}`);
    if (c.counterMatrixStandard.length !== 5 || c.counterMatrixStandard.some((r: number[]) => r.length !== 5)) {
      push('constants.json', null, null, 'counterMatrixStandard', '必须是 5×5');
    } else {
      const F = c.compressedFactor;
      const floor = c.compressedFloor;
      let bad = 0;
      for (const row of c.counterMatrixStandard as number[][]) {
        for (const v of row) {
          const comp = 1000 + Math.trunc(((v - 1000) * F) / 1000);
          if (Math.max(comp, floor) > 1500 || Math.max(comp, floor) < floor) bad++;
        }
      }
      if (bad > 0) push('constants.json', null, null, 'compressedFactor', `压缩后仍有 ${bad} 项越界（§4.3 目标区间 0.6–1.5）`);
      const pierceVsFortified = 1000 + Math.trunc(((c.counterMatrixStandard[1][3] - 1000) * F) / 1000);
      if (pierceVsFortified !== 675) {
        push('constants.json', null, null, 'counterMatrixStandard', `§4.3 例：穿刺打城甲压缩后应为 675，实际 ${pierceVsFortified}`);
      }
    }
    const dmKeys = Object.keys(c.difficultyCrystalMul).sort().join(',');
    const dKeys = tb.difficulty.map((d) => d.id).sort().join(',');
    if (dmKeys !== dKeys) push('constants.json', null, null, 'difficultyCrystalMul', `键必须与 difficulty.json 的 id 集合一致（${dKeys}），实际 ${dmKeys}`);
    const sr = c.economyTargets.spendRatios;
    const sum = sr.tower + sr.tech + sr.sprite + sr.equipment;
    if (sum !== 1000) push('constants.json', null, null, 'economyTargets.spendRatios', `四项占比之和必须为 1000，实际 ${sum}`);
    // ★ 契约 §14.12 / §15.4：支出侧目标 + 替代「塔数目标」的两条判定
    if (sr.tech !== 350) {
      push('constants.json', null, null, 'economyTargets.spendRatios.tech', `契约 §14.12：科技支出目标为 350‰（35%），实际 ${sr.tech}`);
    }
    const at = c.acceptanceTargets;
    if (at.solvabilityMax !== 1000) {
      push('constants.json', null, null, 'acceptanceTargets.solvabilityMax', `契约 §15.4：硬界为 1000（需求/上界 ≤ 1.0），实际 ${at.solvabilityMax}`);
    }
    if (!(at.solvabilityComfortMin < at.solvabilityComfortMax && at.solvabilityComfortMax <= at.solvabilityMax)) {
      push(
        'constants.json',
        null,
        null,
        'acceptanceTargets',
        `舒适带必须满足 min < max ≤ solvabilityMax，实际 [${at.solvabilityComfortMin}, ${at.solvabilityComfortMax}] vs ${at.solvabilityMax}`,
      );
    }
    if (!Array.isArray(at.solvabilityComfortWaves) || at.solvabilityComfortWaves.length === 0) {
      push('constants.json', null, null, 'acceptanceTargets.solvabilityComfortWaves', '舒适带必须声明适用波次（§15.4：第 10 与第 20 波）');
    } else if (
      at.solvabilityComfortWaves.join(',') !==
      [...at.solvabilityComfortWaves].sort((a: number, b: number) => a - b).join(',')
    ) {
      push('constants.json', null, null, 'acceptanceTargets.solvabilityComfortWaves', '适用波次必须升序且唯一');
    }
    if (at.towersAtWave10Min !== undefined || at.towersAtWave10Max !== undefined) {
      push(
        'constants.json',
        null,
        null,
        'acceptanceTargets.towersAtWave10Min',
        '契约 §15.4 已删除「第 10 波塔数」目标（塔数是弱代理指标：18 座 T1 与 6 座 T5 完全不同），必须移除',
      );
    }
    if (c.hpIndex <= c.walletIndex) {
      push('constants.json', null, null, 'hpIndex', `§5.3：血量指数必须大于钱包指数（净难度爬升），实际 hp=${c.hpIndex} wallet=${c.walletIndex}`);
    }
    // §5.3 的「净难度爬升」是一阶参数：主策划裁决要求比值维持在设计值 1.07 附近（现 1283/1200 = 1.069）
    const netRise = c.hpIndex / c.walletIndex;
    if (netRise < 1.05 || netRise > 1.09) {
      push(
        'constants.json',
        null,
        null,
        'hpIndex/walletIndex',
        `净难度爬升（血量指数/钱包指数）是 §5.3 的一阶参数，必须维持在 1.05–1.09，实际 ${netRise.toFixed(3)}`,
      );
    }
    // 非 BOSS 波总数不变量所需的基数合法性
    if (c.baseHp <= 0 || c.baseWallet <= 0) {
      push('constants.json', null, null, 'baseHp', '§5.1 基线必须是正数（HP(1) 与 W(1)）');
    }
    if (c.walletIndex >= 1300) {
      push(
        'constants.json',
        null,
        null,
        'walletIndex',
        `钱包指数 ≥1.30 会让 30 波钱包后置度再次恶化（1.30^29 ≈ ${Math.round(Math.pow(1.3, 29))}×，裁决上限为 1.20^29 ≈ 198×）`,
      );
    }
    if (c.tickRate !== 60) push('constants.json', null, null, 'tickRate', '铁律 2：逻辑定步长必须是 60Hz');
    if (c.fixedScale !== 1000) push('constants.json', null, null, 'fixedScale', '铁律 3 / 契约 §2：定点缩放因子必须是 1000');
    if (c.crystalDivisor !== 1000) push('constants.json', null, null, 'crystalDivisor', '§4.7.1 结晶公式除数为 1000');
    checks.push(
      'constants.levelMul长度=5',
      'constants.克制矩阵5×5+压缩下限',
      'constants.difficultyCrystalMul键↔difficulty',
      'constants.经济占比合计=1000',
      `constants.§14.12 支出侧目标：塔 ${sr.tower} / 科技 ${sr.tech} / 精灵 ${sr.sprite} / 装备 ${sr.equipment}（千分比）`,
      `constants.§15.4 可通关性判定：硬界 ${at.solvabilityMax / 1000}（需求/上界 ≤ 1.0，全 30 波 × 5 难度）+ 舒适带 [${at.solvabilityComfortMin / 1000}, ${at.solvabilityComfortMax / 1000}] @ 第 ${at.solvabilityComfortWaves.join('/')} 波`,
      'constants.§15.4 已移除塔数目标（towersAtWave10* 必须不存在）',
      `constants.指数关系+定点因子（净难度爬升 ${netRise.toFixed(3)}）`,
      `constants.钱包指数≤1.20（当前 ${c.walletIndex}，后置度 ${Math.round(Math.pow(c.walletIndex / 1000, 29))}×）`,
    );
  }

  // ---- 10. audio.json：跨文件一致性（契约 §11.2 第 1/2 条）--------------
  {
    const audioDir = opts.audioDir ?? PUBLIC_AUDIO_DIR;
    const rows = tb.audio;
    const seen = new Set<string>();

    rows.forEach((a, i) => {
      if (seen.has(a.id)) push('audio.json', i, a.id, 'id', `id 重复：${a.id}`);
      seen.add(a.id);
      if (a.file !== `assets/audio/${a.id}.ogg`) {
        push('audio.json', i, a.id, 'file', `必须等于 assets/audio/${a.id}.ogg（契约 §11.1 扁平命名），实际 "${a.file}"`);
      }
      if (a.category === 'bgm') {
        if (a.bus !== 'bgm') push('audio.json', i, a.id, 'bus', `bgm 类必须走 bgm 总线，实际 "${a.bus}"`);
        if (a.loop !== true) push('audio.json', i, a.id, 'loop', 'bgm 必须 loop = true');
      } else {
        if (a.bus !== 'sfx') push('audio.json', i, a.id, 'bus', `${a.category} 类走 sfx 总线，实际 "${a.bus}"（如应为 bgm 请提给主策划改契约 §11.3）`);
      }
      if (a.category === 'sfx' && a.loop !== false) {
        push('audio.json', i, a.id, 'loop', 'sfx 必须 loop = false');
      }
      if (a.category === 'ambience') {
        // 契约 §11.2 第 2 条：两个 ambience 是从 123s/119s 原曲截的 30s 片段，接缝未 crossfade
        for (const k of ['fadeInMs', 'fadeOutMs'] as const) {
          if (typeof a[k] !== 'number') {
            push('audio.json', i, a.id, k, 'ambience 必须设置淡化（接缝未做 crossfade，否则循环点会咔哒）');
          } else if (a[k] < 100) {
            push('audio.json', i, a.id, k, `ambience 的淡化必须 ≥ 100ms（契约 §11.2 第 2 条），实际 ${a[k]}`);
          }
        }
      }
    });

    // ★ 跨文件一致性：清单 ↔ 磁盘（不多不少）
    if (!existsSync(audioDir)) {
      push('audio.json', null, null, '(disk)', `找不到音频目录 ${audioDir}（契约 §11.1 要求 40 个 .ogg 落盘）`);
    } else {
      const onDisk = readdirSync(audioDir)
        .filter((f) => f.toLowerCase().endsWith('.ogg'))
        .map((f) => f.replace(/\.ogg$/i, ''))
        .sort();
      const diskSet = new Set(onDisk);
      const missingFiles = [...seen].filter((id) => !diskSet.has(id)).sort();
      const missingRows = onDisk.filter((id) => !seen.has(id));
      for (const id of missingFiles) {
        const i = rows.findIndex((a) => a.id === id);
        push('audio.json', i, id, 'id', `清单里有 "${id}"，但磁盘 ${relative(ROOT, audioDir)}/${id}.ogg 不存在`);
      }
      for (const id of missingRows) {
        push('audio.json', null, id, '(disk)', `磁盘上存在 ${id}.ogg，但 audio.json 清单里没有登记`);
      }
      const nonOgg = readdirSync(audioDir).filter((f) => !f.toLowerCase().endsWith('.ogg'));
      if (nonOgg.length > 0) {
        push('audio.json', null, null, '(disk)', `音频目录含非 .ogg 文件（契约 §11.1 格式统一 Ogg Vorbis）：${nonOgg.join(', ')}`);
      }
      checks.push('ref:audio.id↔public/assets/audio/*.ogg（不多不少）');
    }

    const catCounts = rows.reduce<Record<string, number>>((a, r) => ((a[r.category] = (a[r.category] ?? 0) + 1), a), {});
    for (const [cat, n] of Object.entries(AUDIO_CATEGORY_COUNTS)) {
      if ((catCounts[cat] ?? 0) !== n) {
        push('audio.json', null, null, 'category', `类别 ${cat} 应为 ${n} 条（策划案 §7.3），实际 ${catCounts[cat] ?? 0} 条`);
      }
    }
    checks.push('audio.file==assets/audio/<id>.ogg', 'audio.category/bus/loop 约束', 'audio.ambience 淡化 ≥100ms', 'audio.类别计数 4/34/2');
  }

  // ---- 11. map.json（契约 §14.11 的新增表）--------------------------------
  {
    const m = tb.map;
    const c = tb.constants;
    const F = c.fixedScale;
    if (!m) {
      push('map.json', null, null, '(file)', '缺 map.json（契约 §14.11 要求新增第 10 张表，模拟层不再复用 m0-fixture 几何）');
    } else {
      const { width, height } = m.grid;
      const v = m.vault;
      // 与 constants.map 的交叉一致（map.json 是几何真值，constants 必须与它一致）
      if (m.buildDepth !== c.map.buildableWidthCells / F) {
        push('map.json', null, null, 'buildDepth', `必须等于 constants.map.buildableWidthCells/1000 = ${c.map.buildableWidthCells / F}，实际 ${m.buildDepth}`);
      }
      if (m.haltPointsPerLane !== c.map.haltPointsPerLane) {
        push('map.json', null, null, 'haltPointsPerLane', `必须等于 constants.map.haltPointsPerLane = ${c.map.haltPointsPerLane}，实际 ${m.haltPointsPerLane}`);
      }
      if (v.w !== c.map.vaultSizeCells / F || v.h !== c.map.vaultSizeCells / F) {
        push('map.json', null, null, 'vault', `宝库必须为 ${c.map.vaultSizeCells / F}×${c.map.vaultSizeCells / F}（§4.6），实际 ${v.w}×${v.h}`);
      }
      if (v.x + v.w > width || v.y + v.h > height || v.x < 0 || v.y < 0) {
        push('map.json', null, null, 'vault', `宝库矩形超出网格 ${width}×${height}`);
      }
      const cx = v.x + (v.w - 1) / 2;
      const cy = v.y + (v.h - 1) / 2;
      if (Math.abs(cx - (width - 1) / 2) > 1 || Math.abs(cy - (height - 1) / 2) > 1) {
        push('map.json', null, null, 'vault', `宝库应大致居中（§4.6），当前中心 (${cx},${cy})，网格中心 (${(width - 1) / 2},${(height - 1) / 2})`);
      }
      if (m.paths.length !== c.map.laneCount) {
        push('map.json', null, null, 'paths', `路径条数必须等于 constants.map.laneCount = ${c.map.laneCount}，实际 ${m.paths.length}`);
      }

      const inVaultCell = (x: number, y: number): boolean => x >= v.x && x < v.x + v.w && y >= v.y && y < v.y + v.h;
      const lengths: number[] = [];
      m.paths.forEach((p: any, i: number) => {
        if (p.id !== i) push('map.json', i, `path ${p.id}`, 'id', `路径 id 必须等于它在数组中的下标（sim 按下标索引），下标 ${i}`);
        if (p.haltIndex >= p.waypoints.length) {
          push('map.json', i, `path ${p.id}`, 'haltIndex', `${p.haltIndex} 超出 waypoints 长度 ${p.waypoints.length}`);
        }
        let total = 0;
        for (let k = 0; k < p.waypoints.length; k++) {
          const wp = p.waypoints[k];
          const wx = wp.x / F;
          const wy = wp.y / F;
          if (wx < 0 || wy < 0 || wx >= width || wy >= height) {
            push('map.json', i, `path ${p.id}`, `waypoints[${k}]`, `坐标 (${wx},${wy}) 超出网格 ${width}×${height}`);
          }
          if (wp.x % F !== 0 || wp.y % F !== 0) {
            push('map.json', i, `path ${p.id}`, `waypoints[${k}]`, `必须是整格坐标（格×1000），实际 (${wp.x},${wp.y})`);
          }
          if (k > 0) {
            const prev = p.waypoints[k - 1];
            const dx = Math.abs(wp.x - prev.x);
            const dy = Math.abs(wp.y - prev.y);
            if (dx !== 0 && dy !== 0) {
              push('map.json', i, `path ${p.id}`, `waypoints[${k}]`, '本表是格子地图：相邻 waypoint 必须轴对齐（dx 或 dy 之一为 0）');
            }
            total += dx + dy;
          }
        }
        lengths.push(total);
        if (Math.abs(total - p.pathLengthCells) > F) {
          push('map.json', i, `path ${p.id}`, 'pathLengthCells', `与 waypoints 实测长度 ${total / F} 格相差 ${(total - p.pathLengthCells) / F} 格（容差 1 格）`);
        }
        // §4.6「约 40 格」
        if (total / F < 30 || total / F > 50) {
          push('map.json', i, `path ${p.id}`, 'pathLengthCells', `§4.6 要求路径约 40 格，实测 ${total / F} 格（允许 30–50）`);
        }
        // 末点必须落在宝库内
        const last = p.waypoints[p.waypoints.length - 1];
        if (!inVaultCell(Math.floor(last.x / F), Math.floor(last.y / F))) {
          push('map.json', i, `path ${p.id}`, 'waypoints', `末点 (${last.x / F},${last.y / F}) 不在宝库矩形内（路径必须汇入宝库）`);
        }
        // 停顿点不应落在宝库里
        const halt = p.waypoints[p.haltIndex];
        if (halt && inVaultCell(Math.floor(halt.x / F), Math.floor(halt.y / F))) {
          push('map.json', i, `path ${p.id}`, 'haltIndex', '★停顿点不应落在宝库内（§4.6：停顿点在路径中段）');
        }
      });

      // openLanes 必须与 difficulty.json 的路数一致，且等于 [0..n-1]（sim 按数组顺序取前 n 条）
      const narrowest: number[] = [];
      for (const d of tb.difficulty) {
        const list = m.openLanes[d.id];
        if (!Array.isArray(list)) {
          push('map.json', null, d.id, `openLanes.${d.id}`, '缺失');
          continue;
        }
        if (list.length !== d.openLanes) {
          push('map.json', null, d.id, `openLanes.${d.id}`, `长度必须等于 difficulty.openLanes = ${d.openLanes}，实际 ${list.length}`);
        }
        const want = Array.from({ length: list.length }, (_, k) => k);
        if (list.join(',') !== want.join(',')) {
          push('map.json', null, d.id, `openLanes.${d.id}`, `sim 按 paths[] 顺序取前 n 条，故必须是 [${want.join(',')}]，实际 [${list.join(',')}]`);
        }
        if (narrowest.length === 0 || list.length < narrowest.length) narrowest.splice(0, narrowest.length, ...list);
      }
      // 波次里的 path 索引必须落在「最窄开放集」内：否则 tick.ts 的 `% w.paths.length` 会静默回绕到 0 号路
      const narrowSet = new Set(narrowest);
      for (const w of tb.waves) {
        w.groups.forEach((g: any, k: number) => {
          if (!Array.isArray(g.path)) return;
          g.path.forEach((idx: number, j: number) => {
            if (!narrowSet.has(idx)) {
              push(
                'waves.json',
                tb.waves.indexOf(w),
                `wave ${w.wave}`,
                `groups[${k}].path[${j}]`,
                `路径索引 ${idx} 不在最窄开放集 [${narrowest.join(',')}] 内（N1/N2 只有 ${narrowest.length} 路，sim 会静默回绕到 0 号路）`,
              );
            }
          });
        });
      }

      // §4.6 通过时间：慢速（2.0 格/s）~20s、快速（4.0 格/s）~10s
      const minLen = Math.min(...lengths) / F;
      const maxLen = Math.max(...lengths) / F;
      const sec = (cells: number, speed: number): number => cells / speed;
      const slowLo = sec(minLen, 2.0);
      const slowHi = sec(maxLen, 2.0);
      const fastLo = sec(minLen, 4.0);
      const fastHi = sec(maxLen, 4.0);
      if (slowLo < 15 || slowHi > 25) {
        push('map.json', null, null, 'paths', `§4.6「慢速敌人通过约 20s」（2.0 格/s）实测 ${slowLo.toFixed(1)}–${slowHi.toFixed(1)}s，超出 15–25s`);
      }
      if (fastLo < 7 || fastHi > 13) {
        push('map.json', null, null, 'paths', `§4.6「快速约 10s」（4.0 格/s）实测 ${fastLo.toFixed(1)}–${fastHi.toFixed(1)}s，超出 7–13s`);
      }
      const speeds = tb.enemies.map((e) => e.speed / F);
      const slowest = Math.min(...speeds);
      checks.push(
        `ref:map.openLanes↔difficulty.openLanes（并校验 waves.path ⊆ 最窄开放集 [${narrowest.join(',')}]）`,
        `map.几何↔constants.map（buildDepth/vault/haltPointsPerLane）+ 路径 id==下标 + 轴对齐 + 末点入宝库`,
        `map.路径长度由 waypoints 重算（±1 格；实测 ${lengths.map((l) => l / F).join('/')} 格，§4.6 ≈40）`,
        `map.§4.6 通过时间：慢速(2.0 格/s) ${slowLo.toFixed(1)}–${slowHi.toFixed(1)}s（~20s ✅）、快速(4.0 格/s) ${fastLo.toFixed(1)}–${fastHi.toFixed(1)}s（~10s ✅）、最慢敌人(${slowest} 格/s) ${sec(maxLen, slowest).toFixed(1)}s`,
      );
    }
  }

  return { issues, checks, counts };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  console.log('《窃金者 TD》配置表校验 —— tools/validate-data.ts (data-arch)');
  console.log(`数据目录：${DATA_DIR}`);
  console.log(`音频目录：${PUBLIC_AUDIO_DIR}`);
  console.log('');

  let report: ValidationReport;
  try {
    report = validateAllData();
  } catch (e) {
    console.error(`✖ 校验器自身出错：${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  for (const t of TABLES) {
    const n = report.counts[t.file];
    const ok = t.count === null ? '单对象' : `${n}/${t.count}`;
    const failed = report.issues.some((i) => i.file === t.file);
    console.log(`${failed ? '✖' : '✔'} ${`src/data/${t.file}`.padEnd(26)} ${String(ok).padEnd(8)} ${t.what}`);
  }
  console.log('');
  console.log(`结构化检查项（${report.checks.length}）：`);
  for (const c of report.checks) console.log(`  · ${c}`);
  console.log('');

  if (report.issues.length === 0) {
    console.log(
      `✔ 全部通过：${TABLES.length} 张表 / ${Object.values(report.counts).reduce((a, b) => a + b, 0)} 个条目 / ${report.checks.length} 项结构检查，0 个问题。`,
    );
    return;
  }

  console.error(`✖ 发现 ${report.issues.length} 个问题：`);
  console.error('');
  for (const it of report.issues) console.error(renderIssue(it));
  console.error('');
  process.exitCode = 1;
}

const invoked = process.argv[1] ? /validate-data\.(ts|js|mjs|cjs)$/.test(process.argv[1]) : false;
if (invoked) main();
