/**
 * Node 侧读取生成输入（`tools/art/**` 专用）。
 *
 * `src/art/**` 刻意**不碰文件系统**（那样浏览器侧就废了），
 * 所以"读 JSON"这一步只在工具里做一次。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeContent, type ArtContentInput, type EnemyArtInput, type UnitArtInput } from '../../src/art/content';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（由本文件位置反推，与 cwd 无关）。 */
export const REPO_ROOT = resolve(HERE, '..', '..');

/** `tools/art/out/` —— 工具产物的统一落盘目录。 */
export const OUT_DIR = resolve(HERE, 'out');

/** 读 `src/data/units.json` + `enemies.json` 并归一化。 */
export function loadContent(): ArtContentInput {
  const unitsPath = resolve(REPO_ROOT, 'src', 'data', 'units.json');
  const enemiesPath = resolve(REPO_ROOT, 'src', 'data', 'enemies.json');
  const units = JSON.parse(readFileSync(unitsPath, 'utf8')) as UnitArtInput[];
  const enemies = JSON.parse(readFileSync(enemiesPath, 'utf8')) as EnemyArtInput[];
  return normalizeContent({ units, enemies });
}
