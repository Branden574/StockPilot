import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security invariant (docket T24): a pgTAP pin that says a database function
 * writes nothing, or writes only what the pin names, reads the write forms of
 * the security invariant suite.
 *
 * The suite (supabase/tests/security_invariants.test.sql) keeps one pattern
 * for a write statement in a function body, the row of _sec_inv_writer_re:
 * INSERT INTO, MERGE INTO, DELETE FROM, TRUNCATE, and UPDATE [ONLY] of a
 * table in any schema, unqualified or quoted. Its control INV-30b proves the
 * pattern form by form on every database run. A per-migration test cannot
 * read that row (each pgTAP file is its own session), so it carries a copy.
 * This guard keeps the copies equal to the row, and refuses a new pin that
 * carries a narrower list of its own.
 *
 * What is read: every regular expression that follows `!~` or `!~*` in
 * supabase/tests, other than in the suite itself. One that names a write verb
 * (insert, update, delete, merge, truncate) must be one of:
 *   - the suite's whole pattern, or its UPDATE arm, byte for byte;
 *   - the bare word list of all five verbs (stricter: it refuses the word
 *     wherever it appears);
 *   - a row-lock pin (FOR UPDATE and its relatives), which is not about
 *     writes;
 *   - a pattern listed below with its reason.
 * The UPDATE arm is also used through regexp_matches, to count statements;
 * the named files are checked for the form they are expected to carry.
 */

const TESTS_DIR = path.resolve(__dirname, '../../../../supabase/tests');
const SUITE = 'security_invariants.test.sql';

function read(name: string): string {
  return readFileSync(path.join(TESTS_DIR, name), 'utf8');
}

const suiteRow = /insert into _sec_inv_writer_re \(re\) values\n {2}\(\$re\$(.*?)\$re\$\);/.exec(read(SUITE));
const FULL = suiteRow?.[1] ?? '';
const ARM = FULL.slice(FULL.indexOf('\\mupdate\\s+'));
const BARE = '\\m(insert|update|delete|merge|truncate)\\M';

/** Files that carry the suite's whole pattern in a "writes nothing" pin. */
const WHOLE_PATTERN_FILES = [
  '0379_book_order_totals.test.sql',
  '0380_report_rpcs_caller_scope.test.sql',
  '0382_book_order_totals_charter_dates.test.sql',
];

/** Files that pin "these writes and nothing else" with the UPDATE arm. */
const UPDATE_ARM_FILES = ['0378_order_hold_stock.test.sql', '0383_revise_order_needed_by.test.sql'];

/** Files that refuse the five verbs as bare words. */
const BARE_WORD_FILES = ['0351_platform_member_activity.test.sql', '0377_order_readiness_facts.test.sql'];

/**
 * Patterns that name a write verb and are none of the shared forms, each with
 * the reason it may stay. `file` and `pattern` are exact.
 */
const LISTED: ReadonlyArray<{ file: string; pattern: string; why: string }> = [
  {
    file: '0378_order_hold_stock.test.sql',
    pattern: '\\m(delete\\s+from|truncate|merge\\s+into)\\M',
    why: 'the rest of a "these writes and nothing else" pin: the same assertion counts the one INSERT and refuses every UPDATE with the UPDATE arm',
  },
  {
    file: '0383_revise_order_needed_by.test.sql',
    pattern: '\\m(insert\\s+into|delete\\s+from|truncate|merge\\s+into)\\M',
    why: 'the rest of a "these writes and nothing else" pin: the same assertion counts the two UPDATEs with the UPDATE arm',
  },
  {
    file: '0372_exception_recount.test.sql',
    pattern: 'insert\\s+into\\s+public\\.cycle_count',
    why: 'pins one statement (the function starts a count through start_cycle_count, not by its own INSERT); it does not say the function writes nothing',
  },
];

const WRITE_VERB = /(?<![a-z_])(insert|update|delete|merge|truncate)(?![a-z_])/i;
const NOT_MATCH_OPERAND = /!~\*?\s*(?:\$(\w*)\$(.*?)\$\1\$|'((?:[^']|'')*)')/g;

interface Pin {
  file: string;
  line: number;
  pattern: string;
}

function writePins(): Pin[] {
  const pins: Pin[] = [];
  for (const file of readdirSync(TESTS_DIR).sort()) {
    if (!file.endsWith('.sql') || file === SUITE) continue;
    read(file)
      .split('\n')
      .forEach((text, i) => {
        for (const m of text.matchAll(NOT_MATCH_OPERAND)) {
          const pattern = m[2] ?? m[3] ?? '';
          // A class escape (\m, \s, \M) is not part of the word beside it.
          if (WRITE_VERB.test(pattern.replace(/\\[A-Za-z]/g, ' '))) pins.push({ file, line: i + 1, pattern });
        }
      });
  }
  return pins;
}

function isSharedForm(pattern: string): boolean {
  return pattern === FULL || pattern === ARM || pattern.startsWith(BARE);
}

function isRowLockPin(pattern: string): boolean {
  return /^for\b/i.test(pattern);
}

describe('pgTAP write pins read the security invariant suite’s write forms', () => {
  it('finds the suite’s pattern and its UPDATE arm', () => {
    expect(FULL).toMatch(/^\\m\(insert\\s\+into\|merge\\s\+into\|delete\\s\+from\|truncate\)\\M\|\\mupdate\\s\+/);
    expect(ARM).toMatch(/^\\mupdate\\s\+\(only\\s\+\)\?/);
    expect(ARM.endsWith('\\s+set\\M')).toBe(true);
  });

  it('the named files carry the form they are expected to carry', () => {
    const missing: string[] = [];
    for (const f of WHOLE_PATTERN_FILES) {
      if (!read(f).includes(`!~* $w$${FULL}$w$`)) missing.push(`${f}: the whole pattern after !~*`);
    }
    for (const f of UPDATE_ARM_FILES) {
      if (!read(f).includes(`$w$${ARM}$w$`)) missing.push(`${f}: the UPDATE arm`);
    }
    for (const f of BARE_WORD_FILES) {
      if (!read(f).includes(`!~* '${BARE}`)) missing.push(`${f}: the five bare verbs after !~*`);
    }
    expect(missing).toEqual([]);
  });

  it('no pin carries a narrower list of write forms of its own', () => {
    const pins = writePins();
    // The census is not empty: the named files alone hold five such operands.
    expect(pins.length).toBeGreaterThanOrEqual(5);
    const offenders = pins
      .filter(
        (p) =>
          !isSharedForm(p.pattern) &&
          !isRowLockPin(p.pattern) &&
          !LISTED.some((l) => l.file === p.file && l.pattern === p.pattern),
      )
      .map((p) => `${p.file}:${p.line}: ${p.pattern}`);
    expect(
      offenders,
      'use the write forms of _sec_inv_writer_re (security_invariants.test.sql), or list the pattern in LISTED with its reason',
    ).toEqual([]);
  });

  it('every listed pattern is still in its file', () => {
    const pins = writePins();
    const stale = LISTED.filter((l) => !pins.some((p) => p.file === l.file && p.pattern === l.pattern)).map(
      (l) => `${l.file}: ${l.pattern}`,
    );
    expect(stale).toEqual([]);
  });
});
