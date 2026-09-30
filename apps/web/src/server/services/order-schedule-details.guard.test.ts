/**
 * RECURRENCE GUARD: one copy of an order's Schedule description (F2-4).
 *
 * An order's Schedule entry carries its needed-by twice: as its start, and in
 * its description ("Auto-created from order SO-000016. Needed by Oct 3, 2026,
 * 2:00 PM."), which the reminder emails print beside the start. The approval
 * (autoScheduleFromOrder) writes the entry, and a needed-by revision
 * (revise_order_needed_by, 0383) moves it. If the two built the text apart, a
 * moved entry would keep a sentence the approval's copy wrote differently, or
 * the old date (plan correction 8). So the sentence is built by core
 * orderScheduleEventDetails alone, and both callers are pinned to it by
 * behaviour (order-requests.approve.test.ts, order-requests.revise-needed-
 * by.test.ts). This file keeps a second copy from appearing anywhere the web,
 * the phone or core keep source (pattern #26).
 *
 * The migration finds that sentence in an event's description, and takes a
 * given description only when it IS that sentence; the server's own move of
 * an event written outside the order's lock (bringing it in step after an
 * insert) applies the same rule through core withOrderScheduleSentence. So
 * core's two patterns must appear in 0383 character for character, and the
 * sentence core writes must be one the migration takes.
 *
 * IF THIS FAILS: something builds the sentence itself (call
 * orderScheduleEventDetails instead), or the migration's patterns and core's
 * drifted apart (change both together).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ORDER_SCHEDULE_SENTENCE_PATTERN,
  ORDER_SCHEDULE_SENTENCE_TAKEN_PATTERN,
  orderScheduleEventDetails,
} from '@stockpilot/core';

const REPO = path.resolve(__dirname, '../../../../..');
const ROOTS = ['apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages/core/src'];
const PHRASE = 'Auto-created from order';

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("an order's Schedule description has one source", () => {
  it(`only core orderScheduleEventDetails spells "${PHRASE}"`, () => {
    const hits = ROOTS.flatMap((root) => sources(path.join(REPO, root)))
      .filter((file) => readFileSync(file, 'utf8').includes(PHRASE))
      .map((file) => path.relative(REPO, file));
    expect(hits).toEqual(['packages/core/src/orders/needed-by-revision.ts']);
  });
});

describe("0383 and core apply one description rule", () => {
  const sql = readFileSync(path.join(REPO, 'supabase/migrations/0383_revise_order_needed_by.sql'), 'utf8');

  it('the migration finds and takes the sentence with core\'s patterns, verbatim', () => {
    expect(sql).toContain(`'${ORDER_SCHEDULE_SENTENCE_TAKEN_PATTERN}'`);
    // Twice: once to find where the sentence sits, once to read it.
    expect(sql.split(`'${ORDER_SCHEDULE_SENTENCE_PATTERN}'`).length - 1).toBe(2);
  });

  it('the sentence core writes is one the migration takes, for any order and zone', () => {
    const taken = new RegExp(ORDER_SCHEDULE_SENTENCE_TAKEN_PATTERN);
    for (const zone of ['America/Los_Angeles', 'Pacific/Chatham', 'Asia/Kathmandu', 'UTC']) {
      for (const orderNumber of [1, 16, 999_999, 12_345_678, null]) {
        const sentence = orderScheduleEventDetails(
          { id: '3f2a9c10-0000-4000-8000-000000000000', orderNumber, neededBy: '2027-02-28T23:30:00Z' },
          zone,
        );
        expect(sentence, `${zone} ${orderNumber}`).toMatch(taken);
      }
    }
  });
});
