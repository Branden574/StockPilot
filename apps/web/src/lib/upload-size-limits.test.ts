import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AVATAR_MAX_BYTES,
  ITEM_IMAGE_MAX_BYTES,
  ORDER_ATTACHMENT_MAX_BYTES,
  ORG_LOGO_MAX_BYTES,
  PO_ATTACHMENT_MAX_BYTES,
  PROCEDURE_POSTER_MAX_BYTES,
  PROCEDURE_VIDEO_MAX_BYTES,
  SUPPORT_SCREENSHOT_MAX_BYTES,
} from './upload-size-limits';

/**
 * Part 6: each upload path's read ceiling is its bucket's own
 * file_size_limit, as the last migration to set it gives it, so the finalize
 * check never reads past what the bucket would have let in. A migration that
 * changes a bucket's limit fails this until the ceiling follows it.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');

/** The limit in bytes the last migration to set one gives `bucket`. */
function migratedLimitBytes(bucket: string): number | null {
  let bytes: number | null = null;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';')) {
      if (!/storage\.buckets/.test(statement) || !statement.includes('file_size_limit')) continue;
      if (!statement.includes(`'${bucket}'`)) continue;
      // Every number or product of numbers of at least a megabyte: the limit.
      const sizes = [...statement.matchAll(/\b\d+(?:\s*\*\s*\d+)*\b/g)]
        .map((m) => m[0].split(/\s*\*\s*/).reduce((n, x) => n * Number(x), 1))
        .filter((n) => n >= 1024 * 1024);
      if (sizes.length !== 1) throw new Error(`${file}: cannot read the limit for ${bucket}`);
      bytes = sizes[0]!;
    }
  }
  return bytes;
}

describe('each upload ceiling is its bucket limit', () => {
  it.each([
    ['item-images', ITEM_IMAGE_MAX_BYTES],
    ['user-avatars', AVATAR_MAX_BYTES],
    ['org-logos', ORG_LOGO_MAX_BYTES],
    ['support-attachments', SUPPORT_SCREENSHOT_MAX_BYTES],
    ['po-attachments', PO_ATTACHMENT_MAX_BYTES],
    ['order-attachments', ORDER_ATTACHMENT_MAX_BYTES],
    ['procedure-videos', PROCEDURE_VIDEO_MAX_BYTES],
  ])('%s', (bucket, ceiling) => {
    expect(migratedLimitBytes(bucket)).toBe(ceiling);
  });

  it('a poster, in the video bucket, is held far below the video', () => {
    expect(PROCEDURE_POSTER_MAX_BYTES).toBeLessThan(PROCEDURE_VIDEO_MAX_BYTES / 100);
    expect(PROCEDURE_POSTER_MAX_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });
});
