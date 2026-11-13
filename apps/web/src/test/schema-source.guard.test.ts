import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * C18: the database schema has one source, the migrations in
 * supabase/migrations, and the setup documents say so.
 *
 * supabase/setup used to hold a single-file copy of the schema that stopped at
 * migration 0030, and DEPLOY.md and the setup README told a reader to build a
 * database from it. A database built that way has none of the changes made
 * since, including later changes to access rules. The copy is gone.
 *
 * WHAT HOLDS IT NOW:
 * - supabase/setup holds no SQL, and under supabase/ SQL lives only in
 *   migrations/, tests/ and repairs/ and in seed.sql. A new bundle fails here.
 * - DEPLOY.md's Database section and supabase/setup/README.md name
 *   supabase/migrations and `supabase db push`, and neither sends a reader to
 *   the SQL Editor with a file.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const SUPABASE = join(REPO_ROOT, 'supabase');

/** Where SQL may live under supabase/: these folders, and seed.sql. */
const SQL_FOLDERS: ReadonlySet<string> = new Set(['migrations', 'tests', 'repairs']);
const SQL_FILES: ReadonlySet<string> = new Set(['seed.sql']);

/** Every .sql file under `dir`, skipping dot-folders (the CLI's own state). */
function sqlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.')) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sqlFiles(full);
    return name.toLowerCase().endsWith('.sql') ? [full] : [];
  });
}

/** A Markdown section from its `## ` heading up to the next one. */
function section(markdown: string, heading: RegExp): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('the schema comes only from supabase/migrations', () => {
  it('supabase/setup holds no SQL', () => {
    const setup = join(SUPABASE, 'setup');
    const found = existsSync(setup) ? sqlFiles(setup) : [];
    expect(found.map((f) => relative(REPO_ROOT, f))).toEqual([]);
  });

  it('under supabase/, SQL lives only in migrations, tests, repairs and seed.sql', () => {
    const elsewhere = sqlFiles(SUPABASE)
      .map((f) => relative(SUPABASE, f).split('\\').join('/'))
      .filter((rel) => !SQL_FILES.has(rel) && !SQL_FOLDERS.has(rel.split('/')[0]!));
    expect(elsewhere).toEqual([]);
    // The check reads the real tree.
    expect(sqlFiles(join(SUPABASE, 'migrations')).length).toBeGreaterThan(400);
  });

  it("DEPLOY.md's Database section builds a database from the migrations", () => {
    const database = section(
      readFileSync(join(REPO_ROOT, 'DEPLOY.md'), 'utf8'),
      /^## \d+\. Database\s*$/,
    );
    expect(database).toContain('supabase/migrations');
    expect(database).toContain('supabase db push');
    expect(database).toContain('supabase db reset');
    // It names no SQL file to run, and no migration range that would go stale.
    expect(database).not.toMatch(/\.sql\b/);
    expect(database).not.toMatch(/SQL Editor/i);
    expect(database).not.toMatch(/\b0\d{3}\b/);
  });

  it('the setup README builds a database from the migrations', () => {
    const readme = readFileSync(join(SUPABASE, 'setup/README.md'), 'utf8');
    expect(readme).toContain('supabase/migrations');
    expect(readme).toContain('supabase db push');
    expect(readme).toContain('supabase start');
    expect(readme).not.toMatch(/SQL Editor/i);
    expect(readme).not.toMatch(/copy the entire file|paste it in/i);
    // Sign-up is invite-only: the README sends no one to a sign-up page.
    expect(readme).not.toMatch(/\/signup/);
  });
});
