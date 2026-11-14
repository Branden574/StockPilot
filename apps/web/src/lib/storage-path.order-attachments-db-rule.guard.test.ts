/**
 * GUARD: the database's file-name rule for an order attachment row is the
 * web's OBJECT_FILENAME_SEGMENT.
 *
 * OrderAttachmentsService.add asks orderAttachmentPathShape, whose file part
 * is OBJECT_FILENAME_SEGMENT. Since 0451 (docket S3c) the
 * "order_request_attachments manager insert" policy asks the same file-name
 * rule as a POSIX pattern on split_part(storage_path, '/', 3). The two must
 * stay one rule: this test fails when either changes without the other. The
 * policy is read from the LAST migration that sets it, so a later migration
 * that restates the policy has to carry the rule too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { OBJECT_FILENAME_SEGMENT, orderAttachmentPathShape } from './storage-path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');

const SETS_INSERT_POLICY =
  /\b(?:create|alter)\s+policy\s+"order_request_attachments manager insert"\s+on\s+public\.order_request_attachments\b/i;

/** SQL with comments removed, so prose never counts. */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/** The statement that sets the insert policy, from its start to its `;`. */
function insertPolicyStatement(sql: string): string | null {
  const body = code(sql);
  const m = SETS_INSERT_POLICY.exec(body);
  if (!m) return null;
  const end = body.indexOf(';', m.index);
  return body.slice(m.index, end === -1 ? undefined : end);
}

/** OBJECT_FILENAME_SEGMENT as the POSIX pattern the policy carries. Postgres
 *  regular expressions take `(?:` too, but the policy is written with a plain
 *  group; everything else is the same text. */
const DB_PATTERN = `'^${OBJECT_FILENAME_SEGMENT.replace(/\(\?:/g, '(')}$'`;

describe('order attachment file-name rule: web and database', () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const setters = files
    .map((f) => ({
      f,
      stmt: insertPolicyStatement(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')),
    }))
    .filter((x): x is { f: string; stmt: string } => x.stmt !== null);

  it('the web asks OBJECT_FILENAME_SEGMENT for the file part of an order attachment path', () => {
    const shape = orderAttachmentPathShape('org', 'order');
    expect(shape.source.endsWith(`/${OBJECT_FILENAME_SEGMENT}$`)).toBe(true);
  });

  it('the last migration that sets the insert policy carries the same rule on the file part', () => {
    expect(setters.length).toBeGreaterThan(0);
    const last = setters[setters.length - 1]!;
    expect(last.stmt).toContain(`split_part(storage_path, '/', 3) ~ ${DB_PATTERN}`);
    // The whole path is {organization}/{order}/{file part}: nothing after it.
    expect(last.stmt).toMatch(
      /storage_path\s*=\s*organization_id::text\s*\|\|\s*'\/'\s*\|\|\s*order_request_id::text\s*\|\|\s*'\/'\s*\|\|\s*split_part\(storage_path,\s*'\/',\s*3\)/,
    );
  });

  it('the policy pattern and the web pattern agree on sample names', () => {
    const web = new RegExp(`^${OBJECT_FILENAME_SEGMENT}$`);
    const db = new RegExp(DB_PATTERN.slice(1, -1));
    const samples = [
      '0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4.webp',
      'k3j9x0q2m7ab.jpg',
      'a.poster.jpg',
      'a1b2c3d4e5f6',
      'a1.jpg?x',
      'a1.jpg#x',
      'a1.jpg ',
      'a1.jpg;x',
      'a1.jpg&x',
      `${'a'.repeat(120)}.jpg`,
      `${'a'.repeat(121)}.jpg`,
      '.jpg',
      'a..jpg',
    ];
    for (const s of samples) expect(db.test(s)).toBe(web.test(s));
  });
});
