/**
 * RECURRENCE GUARD: an audit_logs row is written through server/services/audit.ts.
 *
 * supabase-js returns a refused or failed INSERT as `{ error }` instead of
 * throwing, so `try { await admin.from('audit_logs').insert(row) } catch {}`
 * never sees a lost row. The 443-item lab run (2026-09-23) lost 274, 286 and
 * 253 of 443 rows that way with nothing reported, and four more places wrote
 * their own rows the same way (sign-in, a platform admin's provisioning, invite
 * acceptance, email change). audit(), auditMany() and insertAuditRowReported()
 * read the result, give up after a deadline, and report a loss with counts
 * only (never the row, which quotes item names and before/after values).
 *
 * This file fails when any other file writes to audit_logs. Reads are fine.
 *
 * IF THIS FAILS: write the row with audit() (a request with a ServiceContext),
 * auditMany() (one row per item of a list) or insertAuditRowReported() (a row
 * you must shape yourself). Add a file to ALLOWED only if it reads the
 * INSERT's { error } and reports it, and say so below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

// lib/export-rate-limit.ts was the one other writer until 2026-10-24: its
// bare `void` INSERT held nothing once the 429 was sent. Its trip row now goes
// through insertAuditRowReported, which keeps the INSERT alive past the
// response.
const ALLOWED = new Map<string, string>([['server/services/audit.ts', 'the audit writer itself']]);

/** A write verb on the audit_logs builder, across line breaks and whitespace. */
const AUDIT_WRITE = /from\(\s*['"`]audit_logs['"`]\s*\)\s*\.\s*(insert|upsert|update|delete)\s*\(/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || path === join(SRC, 'test')) continue;
      sourceFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('audit_logs writes', () => {
  it('only the audit writer (and the documented exceptions) write to audit_logs', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => AUDIT_WRITE.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))
      .filter((rel) => !ALLOWED.has(rel));
    expect(offenders).toEqual([]);
  });

  it('catches a direct INSERT split across lines', () => {
    const sample = "await admin\n  .from('audit_logs')\n  .insert({ event: 'x' });";
    expect(AUDIT_WRITE.test(sample)).toBe(true);
    expect(AUDIT_WRITE.test("admin.from('audit_logs').select('id')")).toBe(false);
  });

  it('every allowed file still writes to audit_logs (no stale entries)', () => {
    for (const rel of ALLOWED.keys()) {
      expect(AUDIT_WRITE.test(readFileSync(join(SRC, rel), 'utf8')), rel).toBe(true);
    }
  });
});

/**
 * A later try of an audit write is an upsert that SKIPS a row already there
 * (`insert ... on conflict (id) do nothing`). postgrest-js's upsert MERGES by
 * default (`ignoreDuplicates = false`, Prefer: resolution=merge-duplicates),
 * which would write over a stored audit row with the same id. So every upsert
 * in the writer names `ignoreDuplicates: true` and `onConflict: 'id'`; an
 * omitted option fails.
 */
describe('a later try never overwrites a stored audit row', () => {
  /** The argument text of every `.upsert(` call in a source, to its closing paren. */
  function upsertArguments(source: string): string[] {
    const out: string[] = [];
    const re = /\.\s*upsert\s*\(/g;
    for (const m of source.matchAll(re)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < source.length && depth > 0) {
        if (source[i] === '(') depth += 1;
        else if (source[i] === ')') depth -= 1;
        i += 1;
      }
      out.push(source.slice(start, i - 1));
    }
    return out;
  }
  const SKIPS = (args: string) =>
    /\bignoreDuplicates\s*:\s*true\b/.test(args) && /\bonConflict\s*:\s*['"`]id['"`]/.test(args);

  it('the writer sends a later try as an upsert, and every upsert in it skips a row already there', () => {
    const calls = upsertArguments(readFileSync(join(SRC, 'server/services/audit.ts'), 'utf8'));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const args of calls) expect(SKIPS(args), args).toBe(true);
  });

  it('self-test: an omitted option or ignoreDuplicates false is caught, the skipping form passes', () => {
    const [omitted] = upsertArguments("admin.from('audit_logs').upsert(rows).abortSignal(s)");
    const [noOption] = upsertArguments(
      "admin.from('audit_logs').upsert(rows, { onConflict: 'id' })",
    );
    const [merge] = upsertArguments(
      "admin.from('audit_logs').upsert(rows, { onConflict: 'id', ignoreDuplicates: false })",
    );
    const [skips] = upsertArguments(
      "admin\n  .from('audit_logs')\n  .upsert(withTime(rows), {\n    onConflict: 'id',\n    ignoreDuplicates: true,\n  })",
    );
    expect(SKIPS(omitted!)).toBe(false);
    expect(SKIPS(noOption!)).toBe(false);
    expect(SKIPS(merge!)).toBe(false);
    expect(SKIPS(skips!)).toBe(true);
  });
});
