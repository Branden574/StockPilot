/**
 * RECURRENCE GUARD: one copy of an order's Schedule description (F2-4).
 *
 * An order's Schedule entry carries its needed-by twice: as its start, and in
 * its description ("Auto-created from order SO-000016. Needed by Oct 3, 2026,
 * 2:00 PM."), which the reminder emails print beside the start. The approval
 * (autoScheduleFromOrder) writes the entry, and a needed-by revision
 * (revise_order_needed_by, 0382) moves it. If the two built the text apart, a
 * moved entry would keep a sentence the approval's copy wrote differently, or
 * the old date (plan correction 8). So the sentence is built by core
 * orderScheduleEventDetails alone, and both callers are pinned to it by
 * behaviour (order-requests.approve.test.ts, order-requests.revise-needed-
 * by.test.ts). This file keeps a second copy from appearing anywhere the web,
 * the phone or core keep source (pattern #26).
 *
 * IF THIS FAILS: something builds the sentence itself. Call
 * orderScheduleEventDetails instead.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
