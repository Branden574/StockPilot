import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { itemPhotoPath, itemPhotoThumbPath, randomPhotoFileBase } from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

/**
 * The phone's photo uploads must build paths the DATABASE accepts, and must
 * all store a thumbnail.
 *
 * Since 0381 the item-images bucket's write policies parse the path with one
 * anchored regex (public.item_image_path_item_id): lowercase uuids,
 * `{org}/items/{item}/{file}`, the file word characters then `.ext`. Any
 * other name is a 403 at upload time, and on the phone a failed photo upload
 * after New item is only a console warning. The three uploaders (new item,
 * replace photo on the item screen, scan capture) used to build the path
 * inline, each its own way, and none stored a thumbnail (docket B31). They
 * now all call ONE helper, lib/item-photo-upload.ts, which builds the photo's
 * and the thumbnail's paths with the core builders (packages/core
 * item-photo-path.test.ts runs them through the same parser). This file pins
 * the wiring (no uploader uploads on its own again, every row carries the
 * thumbnail) and runs the phone's own outputs through the parser read from
 * the migrations.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '../..');
const MIGRATIONS = path.resolve(MOBILE, '../../supabase/migrations');

const UPLOADERS = ['app/item/new.tsx', 'app/item/[id].tsx', 'app/(drawer)/(tabs)/scan.tsx'];
const HELPER = 'src/lib/item-photo-upload.ts';

function databasePhotoPathPattern(): { re: RegExp; maxLength: number } {
  let found: { re: RegExp; maxLength: number } | null = null;
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const at = sql.search(/create or replace function public\.item_image_path_item_id\(/i);
    if (at < 0) continue;
    const body = sql.slice(at, sql.indexOf('$$;', at));
    const len = body.match(/length\(p_name\)\s*<=\s*(\d+)/);
    const expr = body.match(/p_name\s*~\s*\(([\s\S]*?)\)\s*\n\s*then/);
    if (!len || !expr) throw new Error(`cannot read item_image_path_item_id in ${file}`);
    const literals = [...(expr[1] ?? '').matchAll(/'((?:[^']|'')*)'/g)].map((m) =>
      (m[1] ?? '').replace(/''/g, "'"),
    );
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

const PHONE_SOURCES = (): string[] => [
  ...sourceFiles(path.join(MOBILE, 'app')),
  ...sourceFiles(path.join(MOBILE, 'src')),
];

/** `src` without its comments (block, and line comments not inside a URL), so a
 *  commented-out call is never counted. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every `.from('item_images').insert(...)` argument in `src`'s code (up to the matching parenthesis). */
function itemImageInserts(source: string): string[] {
  const src = withoutComments(source);
  const out: string[] = [];
  const re = /\.from\('item_images'\)\s*\.insert\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
      i += 1;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

describe('phone item photo uploads use the one helper and the path builders the database accepts', () => {
  it.each(UPLOADERS)('%s uploads through uploadItemPhoto, never on its own', (file) => {
    const src = readFileSync(path.join(MOBILE, file), 'utf8');
    expect(src).toMatch(/import \{ uploadItemPhoto \} from '@\/lib\/item-photo-upload';/);
    expect(src).toMatch(/await uploadItemPhoto\(\{ supabase, orgId, itemId, uri(?:: [\w.]+)? \}\)/);
    expect(src).not.toMatch(/\.from\('item-images'\)\s*\.upload\(/);
  });

  it('the helper builds the photo and its thumbnail with the core builders, from one file base', () => {
    const src = readFileSync(path.join(MOBILE, HELPER), 'utf8');
    expect(src).toMatch(/import \{[^}]*\bitemPhotoPath\b[^}]*\} from '@stockpilot\/core';/);
    expect(src).toMatch(/import \{[^}]*\bitemPhotoThumbPath\b[^}]*\} from '@stockpilot\/core';/);
    expect(src).toMatch(/import \{[^}]*\brandomPhotoFileBase\b[^}]*\} from '@stockpilot\/core';/);
    expect(src).toContain('const base = randomPhotoFileBase();');
    expect(src).toContain('const path = itemPhotoPath(orgId, itemId, `${base}.${photo.ext}`);');
    expect(src).toContain(
      'const thumbPath = itemPhotoThumbPath(args.orgId, args.itemId, args.base, format);',
    );
  });

  it('no phone source but the helper uploads to the item-images bucket (a fourth uploader must use it too)', () => {
    const offenders = PHONE_SOURCES()
      .filter((f) =>
        /\.from\((?:'item-images'|ITEM_IMAGES_BUCKET|BUCKET)\)\s*\.upload\(/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => path.relative(MOBILE, f));
    expect(offenders).toEqual([HELPER]);
  });

  it('every item_images row the phone inserts carries the thumbnail path', () => {
    const inserts = PHONE_SOURCES().flatMap((f) =>
      itemImageInserts(readFileSync(f, 'utf8')).map((body) => ({
        file: path.relative(MOBILE, f),
        body,
      })),
    );
    // new item, scan capture, and the replace helper the item screen uses.
    expect(inserts.map((i) => i.file).sort()).toEqual(
      ['app/(drawer)/(tabs)/scan.tsx', 'app/item/new.tsx', 'src/lib/item-photo-replace.ts'].sort(),
    );
    for (const { file, body } of inserts) {
      expect(body, `${file} inserts an item_images row without thumb_path`).toMatch(
        /\bthumb_path: /,
      );
    }
  });

  it('no phone source builds an item-images path inline (a fourth uploader must use the builder too)', () => {
    const offenders = PHONE_SOURCES()
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return (
          /\$\{[^}]+\}\/items\/\$\{[^}]+\}\/\$\{/.test(src) ||
          /\$\{[^}]+\}\/\$\{[^}]+\}\/cover\./.test(src)
        );
      })
      .map((f) => path.relative(MOBILE, f));
    expect(offenders).toEqual([]);
  });

  it("the phone's outputs pass the database parser, for every format it uploads and every thumbnail it makes", () => {
    const db = databasePhotoPathPattern();
    for (let i = 0; i < 500; i += 1) {
      const org = crypto.randomUUID();
      const item = crypto.randomUUID();
      const base = randomPhotoFileBase();
      for (const ext of ['jpg', 'png', 'webp']) {
        const p = itemPhotoPath(org, item, `${base}.${ext}`);
        expect(p.length <= db.maxLength && db.re.test(p)).toBe(true);
      }
      for (const format of ['jpg', 'png'] as const) {
        const t = itemPhotoThumbPath(org, item, base, format);
        expect(t.length <= db.maxLength && db.re.test(t)).toBe(true);
      }
    }
  });
});
