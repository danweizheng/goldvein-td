#!/usr/bin/env tsx
/**
 * tools/gen-types.ts —— 由 src/data/schema/*.schema.json 生成 src/data/types.generated.ts
 * 所有者：data-arch（AGENTS.md §2）。
 *
 * 契约要求（接口契约 §3.4）：
 *  - 生成物由本脚本产出，**任何人不得手改** types.generated.ts
 *  - 生成类型必须是策划案 14.1 手写类型的**超集**（字段名一致，不得少字段）
 *
 * 用法：
 *   pnpm gen-types
 *   npx tsx tools/gen-types.ts
 *
 * 说明：每张表的 Schema 描述「单个条目」，因此生成的是条目接口（UnitDef 等），
 * 表级别名（UnitDef[] 等）与 ConfigTables 汇总接口由本脚本在文件尾部确定性追加。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from 'json-schema-to-typescript';

import { SCHEMA_DIR, TABLES, type TableSpec } from './validate-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const OUT_FILE = resolve(ROOT, 'src', 'data', 'types.generated.ts');

/** 表 → 生成出来的「表数组」别名（单对象表直接用根类型名） */
function tableAlias(t: TableSpec): string {
  return t.kind === 'array' ? `${t.name.replace(/Def$/, '')}Table` : t.name;
}

const BANNER = `/**
 * ⚠️ 本文件由 \`pnpm gen-types\`（tools/gen-types.ts）自动生成，请勿手改。
 * 源：src/data/schema/*.schema.json
 *
 * 生成类型是策划案 14.1 手写类型的超集（接口契约 §3.4）：
 *  - 字段名与 14.1 完全一致，未删除任何字段
 *  - 追加的可选扩展字段（auras / effectUnit / equipSlot / availableFrom）已在各自 JSDoc 标注
 *
 * 定点约定（接口契约 §2）：除纯计数外，一切数值均为 ×1000 的整数。
 *  - \`attackInterval\` 是「间隔秒」，不是「次/秒」
 *  - \`block\` / \`tier\` / \`wave\` / \`count\` / \`maxLevel\` / \`openLanes\` / \`lives\` 等为纯计数
 *  - 数组长度约束（levelMul 恰好 5 个、counterMatrixStandard 5×5、costPerLevel 长度 == maxLevel）
 *    由 \`pnpm validate-data\` 的 ajv 门禁强制；类型层不展开为元组，以贴合契约 §3.3/§14.1 的 \`T[]\` 写法
 */

/** 定点数：始终是整数，真实值 = Fixed / 1000 */
export type Fixed = number;
`;

/** 文件尾部的确定性追加内容（表别名 + 汇总接口） */
function footer(): string {
  const lines: string[] = [];
  lines.push('/** 表级别名：整张 JSON 表的根类型 */');
  for (const t of TABLES) {
    if (t.kind !== 'array') continue; // 单对象表直接用根类型名，不产生同义别名
    lines.push(`export type ${tableAlias(t)} = ${t.name}[];`);
  }
  lines.push('');
  lines.push('/** 8 张配置表在内存中的统一形状（data loader 消费） */');
  lines.push('export interface ConfigTables {');
  for (const t of TABLES) {
    const key = t.file.replace(/\.json$/, '');
    lines.push(`  ${key}: ${tableAlias(t)};`);
  }
  lines.push('}');
  lines.push('');
  lines.push('/** 配置表文件名 → 根类型名（供 loader 做运行期断言） */');
  lines.push('export const TABLE_ROOT_TYPES = {');
  for (const t of TABLES) {
    lines.push(`  '${t.file}': '${t.name}',`);
  }
  lines.push('} as const;');
  lines.push('');
  return lines.join('\n');
}

export interface GenerateResult {
  source: string;
  compiled: string[];
  /** 跨表同名 definition 的合并提示（结构相同 → 合并；结构不同 → 抛错） */
  notes: string[];
}

/** 去掉 description 后比较结构（跨表同名 definition 只允许描述不同） */
function stripDescriptions(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripDescriptions);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'description' || k === 'title') continue;
      out[k] = stripDescriptions(val);
    }
    return out;
  }
  return v;
}

/**
 * 把 8 份「单条目 Schema」合并成一份 JSON Schema 文档后一次性编译。
 *
 * 为什么合并：每张表的 Schema 都自带 `definitions`（Cost / Bounty / ArmorType …），
 * 分别编译会产出一份带重复 `export type ArmorType` 的 .ts（TS2300 重复标识符）。
 * 合并后 `#/definitions/X` 全部指向同一份定义，输出里每种辅助类型只出现一次。
 * 同名但结构不同的 definition 会**直接报错**（不许静默覆盖）。
 */
export function buildMergedSchema(schemaDir: string = SCHEMA_DIR): { document: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const document: Record<string, unknown> = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'ConfigTableEntry',
    type: 'object',
    definitions: {} as Record<string, unknown>,
    anyOf: [] as unknown[],
  };
  const defs = document['definitions'] as Record<string, unknown>;
  const anyOf = document['anyOf'] as unknown[];

  for (const t of TABLES) {
    const schemaPath = resolve(schemaDir, t.schema);
    if (!existsSync(schemaPath)) throw new Error(`缺 Schema 文件：${schemaPath}`);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;

    for (const [name, def] of Object.entries((schema['definitions'] as Record<string, unknown>) ?? {})) {
      const existing = defs[name];
      if (existing !== undefined) {
        if (JSON.stringify(stripDescriptions(existing)) !== JSON.stringify(stripDescriptions(def))) {
          throw new Error(
            `跨表同名 definition "${name}" 结构不一致（${t.schema}）。` +
              ` 请在其中一张 Schema 里改名，否则生成的类型会互相覆盖。`,
          );
        }
        notes.push(`definition "${name}" 在多张 Schema 中重复，已合并为一份`);
        continue;
      }
      defs[name] = def;
    }

    const item: Record<string, unknown> = { ...schema };
    delete item['$schema'];
    delete item['definitions'];
    defs[t.name] = item;
    anyOf.push({ $ref: `#/definitions/${t.name}` });
  }

  return { document, notes: [...new Set(notes)] };
}

/** 纯函数：不写盘，便于单测直接比对 */
export async function buildTypesSource(schemaDir: string = SCHEMA_DIR): Promise<GenerateResult> {
  const { document, notes } = buildMergedSchema(schemaDir);
  const compiled = TABLES.map((t) => t.name);

  const body = await compile(document as never, 'ConfigTableEntry', {
    bannerComment: '',
    additionalProperties: false,
    declareExternallyReferenced: true,
    ignoreMinAndMaxItems: true,
    style: { singleQuote: true, semi: true, tabWidth: 2 },
  });

  const source = [BANNER, body.trimEnd(), footer()].join('\n\n') + '\n';
  return { source, compiled, notes };
}

async function main(): Promise<void> {
  console.log('《窃金者 TD》类型生成 —— tools/gen-types.ts (data-arch)');
  const { source, compiled, notes } = await buildTypesSource();
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, source, 'utf8');
  console.log(`✔ 已生成 ${OUT_FILE}`);
  console.log(`  合并编译 ${compiled.length} 份 Schema：${compiled.join(', ')}`);
  console.log(`  表级别名：${TABLES.map(tableAlias).join(', ')}`);
  for (const n of notes) console.log(`  · ${n}`);
  console.log(`  字节数：${Buffer.byteLength(source, 'utf8')}`);
}

const invoked = process.argv[1] ? /gen-types\.(ts|js|mjs|cjs)$/.test(process.argv[1]) : false;
if (invoked) {
  main().catch((e: unknown) => {
    console.error(`✖ 生成失败：${(e as Error).message}`);
    process.exitCode = 1;
  });
}
