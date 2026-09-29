import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  bookCoverPath,
  itemPhotoPath,
  itemPhotoThumbPath,
  randomPhotoFileBase,
} from './item-photo-path';

/**
 * Every writer's photo path must be one the DATABASE accepts.
 *
 * Since 0381 the item-images bucket's write policies, and item_images'
 * row policies, parse a path with public.item_image_path_item_id: one
 * anchored regex over lowercase uuids, at most 400 characters. A name it
 * does not accept is a 403 at upload time, and nothing else in the app
 * would notice (a new filename format, the original file name kept, an
 * uppercased id). So this test reads the regex out of the newest migration
 * that defines the function and runs every builder's output through it:
 * the web's presigned master and thumbnail, the phone's uploads (base36 and
 * the older hex names), and the books import's cover.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../../supabase/migrations');

function databasePhotoPathPattern(): { re: RegExp; maxLength: number; file: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found: { re: RegExp; maxLength: number; file: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const at = sql.search(/create or replace function public\.item_image_path_item_id\(/i);
    if (at < 0) continue;
    const body = sql.slice(at, sql.indexOf('$$;', at));
    const len = body.match(/length\(p_name\)\s*<=\s*(\d+)/);
    const expr = body.match(/p_name\s*~\s*\(([\s\S]*?)\)\s*\n\s*then/);
    if (!len || !expr) throw new Error(`cannot read item_image_path_item_id in ${file}`);
    const literals = [...(expr[1] ?? '').matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] ?? '').replace(/''/g, "'"));
    found = { re: new RegExp(literals.join('')), maxLength: Number(len[1]), file };
  }
  if (!found) throw new Error('no migration defines public.item_image_path_item_id');
  return found;
}

const DB = databasePhotoPathPattern();
const ORG = '0a000000-0000-0000-0000-000000000001';
const ITEM = crypto.randomUUID();

function accepted(path: string): boolean {
  return path.length <= DB.maxLength && DB.re.test(path);
}

describe('item photo paths match the database parser (0381 item_image_path_item_id)', () => {
  it('reads the parser from the newest migration that defines it', () => {
    expect(DB.file >= '0381').toBe(true);
    expect(DB.re.source.startsWith('^')).toBe(true);
    expect(DB.re.source.endsWith('$')).toBe(true);
  });

  it('accepts the web presigned master and thumbnail (uuid names)', () => {
    for (let i = 0; i < 200; i += 1) {
      const uuid = crypto.randomUUID();
      for (const ext of ['jpg', 'png', 'webp', 'gif', 'heic']) {
        expect(accepted(itemPhotoPath(ORG, ITEM, `${uuid}.${ext}`))).toBe(true);
      }
      expect(accepted(itemPhotoThumbPath(ORG, ITEM, uuid))).toBe(true);
    }
  });

  it('accepts the phone upload names (random base36, and the older 12-hex names)', () => {
    for (let i = 0; i < 2000; i += 1) {
      const base = randomPhotoFileBase();
      expect(base).toMatch(/^[a-z0-9]{1,12}$/);
      expect(accepted(itemPhotoPath(ORG, ITEM, `${base}.jpg`))).toBe(true);
    }
    expect(accepted(itemPhotoPath(ORG, ITEM, 'a1b2c3d4e5f6.png'))).toBe(true);
  });

  it('accepts the books import cover, both of its extensions', () => {
    for (const ext of ['jpg', 'png', 'webp'] as const) {
      expect(accepted(bookCoverPath(ORG, ITEM, ext))).toBe(true);
    }
  });

  it('names the org first and the item second, in both shapes', () => {
    expect(itemPhotoPath(ORG, ITEM, 'x.jpg')).toBe(`${ORG}/items/${ITEM}/x.jpg`);
    expect(itemPhotoThumbPath(ORG, ITEM, 'u')).toBe(`${ORG}/items/${ITEM}/u-thumb.webp`);
    expect(bookCoverPath(ORG, ITEM, 'png')).toBe(`${ORG}/${ITEM}/cover.png`);
  });

  it('never yields an empty file base (an empty name is refused by the database)', () => {
    const real = Math.random;
    try {
      Math.random = () => 0;
      expect(randomPhotoFileBase().length).toBeGreaterThan(0);
      expect(accepted(itemPhotoPath(ORG, ITEM, `${randomPhotoFileBase()}.jpg`))).toBe(true);
    } finally {
      Math.random = real;
    }
  });

  it('pins what the database refuses, so a new format fails here and not at upload time', () => {
    expect(accepted(`${ORG.toUpperCase()}/items/${ITEM}/x.jpg`)).toBe(false);
    expect(accepted(itemPhotoPath(ORG, ITEM, 'photo (1).jpg'))).toBe(false);
    expect(accepted(itemPhotoPath(ORG, ITEM, 'noext'))).toBe(false);
    expect(accepted(`${ORG}/items/${ITEM}/sub/x.jpg`)).toBe(false);
    expect(accepted(`${ORG}/misc/${ITEM}/x.jpg`)).toBe(false);
  });
});
