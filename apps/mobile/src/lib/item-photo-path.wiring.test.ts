import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { itemPhotoPath, randomPhotoFileBase } from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

/**
 * The phone's photo uploads must build paths the DATABASE accepts.
 *
 * Since 0381 the item-images bucket's write policies parse the path with one
 * anchored regex (public.item_image_path_item_id): lowercase uuids,
 * `{org}/items/{item}/{file}`, the file word characters then `.ext`. Any
 * other name is a 403 at upload time, and on the phone a failed photo upload
 * after New item is only a console warning. The three uploaders (new item,
 * replace photo on the item screen, scan capture) used to build the path
 * inline, each its own way; they now all call the one core builder, which
 * packages/core item-photo-path.test.ts runs through the same parser. This
 * file pins the wiring (no uploader builds its own path again) and runs the
 * phone's own outputs through the parser read from the migrations.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '../..');
const MIGRATIONS = path.resolve(MOBILE, '../../supabase/migrations');

const UPLOADERS = ['app/item/new.tsx', 'app/item/[id].tsx', 'app/(drawer)/(tabs)/scan.tsx'];

function databasePhotoPathPattern(): { re: RegExp; maxLength: number } {
  let found: { re: RegExp; maxLength: number } | null = null;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const at = sql.search(/create or replace function public\.item_image_path_item_id\(/i);
    if (at < 0) continue;
    const body = sql.slice(at, sql.indexOf('$$;', at));
    const len = body.match(/length\(p_name\)\s*<=\s*(\d+)/);
    const expr = body.match(/p_name\s*~\s*\(([\s\S]*?)\)\s*\n\s*then/);
    if (!len || !expr) throw new Error(`cannot read item_image_path_item_id in ${file}`);
    const literals = [...(expr[1] ?? '').matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] ?? '').replace(/''/g, "'"));
    found = { re: new RegExp(literals.join('')), maxLength: Number(len[1]) };
  }
  if (!found) throw new Error('no migration defines public.item_image_path_item_id');
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('phone item photo uploads use the one path builder the database accepts', () => {
  it.each(UPLOADERS)('%s builds its upload path with itemPhotoPath + randomPhotoFileBase', (file) => {
    const src = readFileSync(path.join(MOBILE, file), 'utf8');
    expect(src).toContain('const path = itemPhotoPath(orgId, itemId, `${randomPhotoFileBase()}.${resized.ext}`);');
    expect(src).toMatch(/import \{[^}]*\bitemPhotoPath\b[^}]*\} from '@stockpilot\/core';/);
    expect(src).toMatch(/import \{[^}]*\brandomPhotoFileBase\b[^}]*\} from '@stockpilot\/core';/);
  });

  it('no phone source builds an item-images path inline (a fourth uploader must use the builder too)', () => {
    const offenders = [...sourceFiles(path.join(MOBILE, 'app')), ...sourceFiles(path.join(MOBILE, 'src'))]
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return /\$\{[^}]+\}\/items\/\$\{[^}]+\}\/\$\{/.test(src) || /\$\{[^}]+\}\/\$\{[^}]+\}\/cover\./.test(src);
      })
      .map((f) => path.relative(MOBILE, f));
    expect(offenders).toEqual([]);
  });

  it("the phone's outputs pass the database parser, for every extension resizeForUpload returns", () => {
    const db = databasePhotoPathPattern();
    for (let i = 0; i < 500; i += 1) {
      for (const ext of ['jpg', 'png', 'webp', 'gif']) {
        const p = itemPhotoPath(crypto.randomUUID(), crypto.randomUUID(), `${randomPhotoFileBase()}.${ext}`);
        expect(p.length <= db.maxLength && db.re.test(p)).toBe(true);
      }
    }
  });
});
