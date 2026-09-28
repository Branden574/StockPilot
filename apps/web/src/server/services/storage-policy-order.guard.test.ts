/**
 * MIGRATION GUARD: storage.objects policy DDL comes LAST in its migration
 * (0375 onward).
 *
 * The Supabase CLI applies a migration file as ONE implicit transaction, so
 * every lock a statement takes is held until the whole file commits. CREATE /
 * ALTER / DROP POLICY on storage.objects takes ACCESS EXCLUSIVE on the table
 * every attachment render in every org reads (0312/0315). If anything that
 * waits for another lock comes after it (a foreign key, ADD CONSTRAINT, an
 * index), storage.objects stays locked through each of those waits, up to
 * lock_timeout apiece, and every storage read and write queues behind the push.
 *
 * Review finding 2026-09-27: 0375 created its storage policy near the top and
 * then took locks on organizations, user_profiles, exception_occurrences and
 * exception_occurrence_events, while its header claimed VALIDATE let reads and
 * writes go on. This guard pins the fix for 0375 and every later migration:
 * after the first storage.objects policy statement, a file may only change
 * more storage.objects policies, add or update bucket rows, comment on those
 * policies, and reset lock_timeout.
 *
 * Older migrations are not checked (0315 and its kin contain storage DDL
 * alone, and history is not rewritten).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../supabase/migrations');
const FIRST_CHECKED = 375;

/** SQL with comments removed, so prose never counts as a statement. */
function code(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

const STORAGE_POLICY =
  /\b(?:create|alter|drop)\s+policy\s+(?:if\s+exists\s+)?(?:"[^"]*"|\S+)\s+on\s+storage\.objects\b/i;

/** What may follow the first storage.objects policy statement. */
const ALLOWED_AFTER = [
  STORAGE_POLICY,
  /^comment\s+on\s+policy\s+(?:"[^"]*"|\S+)\s+on\s+storage\.objects\b/i,
  /^insert\s+into\s+storage\.buckets\b/i,
  /^update\s+storage\.buckets\b/i,
  /^reset\s+lock_timeout$/i,
];

/** The statements after the first storage.objects policy statement, or null
 *  when the file has none. */
function statementsAfterStoragePolicy(sql: string): string[] | null {
  const body = code(sql);
  const at = body.search(STORAGE_POLICY);
  if (at < 0) return null;
  const tail = body.slice(at);
  // The first statement is the policy itself.
  return tail
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
    .slice(1);
}

const checked = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= FIRST_CHECKED)
  .sort()
  .map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') }))
  .filter(({ sql }) => statementsAfterStoragePolicy(sql) !== null);

describe('storage.objects policy DDL is the last lock a migration takes', () => {
  it('checks 0375 (the guard is not vacuous)', () => {
    expect(checked.map((m) => m.file)).toContain('0375_exception_evidence.sql');
  });

  it.each(checked.map((m) => [m.file, m.sql] as const))(
    '%s: nothing that takes another lock follows its storage policy',
    (_file, sql) => {
      const after = statementsAfterStoragePolicy(sql) ?? [];
      const offending = after.filter((stmt) => !ALLOWED_AFTER.some((re) => re.test(stmt)));
      expect(offending).toEqual([]);
    },
  );

  it('the rule itself: a constraint after the storage policy is refused, the reset is not', () => {
    const bad = `set lock_timeout = '5s';
      create policy "x" on storage.objects for insert to authenticated with check (true);
      alter table public.t add constraint c check (true) not valid;
      reset lock_timeout;`;
    const good = `set lock_timeout = '5s';
      alter table public.t add constraint c check (true) not valid;
      insert into storage.buckets (id) values ('b') on conflict (id) do nothing;
      create policy "x" on storage.objects for insert to authenticated with check (true);
      reset lock_timeout;`;
    const offending = (sql: string) =>
      (statementsAfterStoragePolicy(sql) ?? []).filter(
        (s) => !ALLOWED_AFTER.some((re) => re.test(s)),
      );
    expect(offending(bad)).toEqual([
      'alter table public.t add constraint c check (true) not valid',
    ]);
    expect(offending(good)).toEqual([]);
  });
});
