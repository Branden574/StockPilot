/**
 * THE GATE AGREEMENT, HELD MECHANICALLY (pattern #26).
 *
 * exception-confirm.test.ts checks core countConfirmGate against
 * GATE_EXPECTATIONS cell by cell. The pgTAP file for 0386 checks the database
 * (exception_confirm_count) against the same table, section M, through its
 * gate_cell and gate_rpc rows. This test holds those rows equal to the
 * fixture: it renders the block the fixture implies and compares it with the
 * block checked in between the markers. So editing the fixture (and the gate
 * with it) fails here until the pgTAP block is updated too, and the updated
 * block then fails pgTAP for as long as the database still answers the old
 * way. Neither side can change alone.
 *
 * After an intended change to the fixture, paste the block this test prints
 * as "expected" into the pgTAP file between the two markers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { CountConfirmState } from './exception-confirm';
import { GATE_EXPECTATIONS, GATE_READERS, GATE_REASON_TO_RPC } from './exception-confirm.fixture';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PGTAP = path.join(ROOT, 'supabase/tests/0386_exception_confirm_count.test.sql');
const BEGIN = '-- BEGIN GATE FIXTURE (generated from exception-confirm.fixture.ts; held by exception-confirm.fixture.test.ts)';
const END = '-- END GATE FIXTURE';

/** The states the database can be put in: `unavailable` is a read the app
 *  could not make, so it exists only in the app. */
const DB_STATES: CountConfirmState[] = [
  'recount_in_progress',
  'count_in_progress',
  'rechecking',
  'count_changed',
  'not_countable',
  'stock_moved',
  'already_confirmed',
  'confirmable',
];

function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function renderBlock(): string {
  const cells = GATE_READERS.flatMap((r) =>
    DB_STATES.map((s) => `  (${q(r.name)}, ${q(s)}, ${q(GATE_EXPECTATIONS[r.name]![s])})`),
  );
  const answers: string[] = [];
  for (const [reason, answer] of Object.entries(GATE_REASON_TO_RPC)) {
    if (reason === 'ok' || answer === 'app_only') continue;
    answers.push(`  (${q(reason)}, ${q(`${answer.sqlstate}:${answer.hint}`)})`);
  }
  // A confirm the database accepts answers ok and how it was recorded.
  for (const as of ['counter', 'manager']) answers.push(`  (${q(as)}, ${q(`ok:${as}`)})`);
  return [
    BEGIN,
    'insert into gate_cell (reader, state, cell) values',
    `${cells.join(',\n')};`,
    'insert into gate_rpc (cell, answer) values',
    `${answers.join(',\n')};`,
    END,
  ].join('\n');
}

function checkedInBlock(sql: string): string | null {
  const start = sql.indexOf(BEGIN);
  const end = sql.indexOf(END);
  if (start < 0 || end < start) return null;
  return sql.slice(start, end + END.length);
}

describe('the 0386 pgTAP gate matrix (section M)', () => {
  it('states every reader x state cell and every answer exactly as the fixture does', () => {
    const block = checkedInBlock(readFileSync(PGTAP, 'utf8'));
    expect(block, 'the pgTAP file has no gate fixture block between the markers').not.toBeNull();
    expect(block).toBe(renderBlock());
  });

  it('covers every reader and every state but the app-only one', () => {
    for (const r of GATE_READERS) {
      expect(Object.keys(GATE_EXPECTATIONS[r.name]!).sort()).toEqual([...DB_STATES, 'unavailable'].sort());
    }
    expect(Object.keys(GATE_EXPECTATIONS).sort()).toEqual(GATE_READERS.map((r) => r.name).sort());
  });

  it('the readers the pgTAP file signs in as are the fixture\'s', () => {
    const sql = readFileSync(PGTAP, 'utf8');
    const readers = sql.match(/insert into gate_reader values\n([\s\S]*?);/);
    expect(readers).not.toBeNull();
    const names = [...readers![1]!.matchAll(/\('([^']+)', :/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(GATE_READERS.map((r) => r.name).sort());
  });
});
