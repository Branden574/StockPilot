import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { describePartialResult, previewPartialFulfilment, type PartialAction } from './partial-fulfilment';
import { assessOrderReadiness, parseOrderReadinessFacts, type OrderReadinessResult } from './readiness';

/**
 * THE MESSAGE HALF OF scripts/db-concurrency/f2-3_partial_stale.sh (F2-3).
 *
 * The script runs the real functions on the LOCAL stack in two sessions: it
 * reads order_readiness_facts for the preview, lets another session hold
 * stock, runs the frozen approve_partial / resume_fulfillment, reads the facts
 * again, and counts the holds in SQL. It then writes the cases to a JSON file
 * and runs this file with PARTIAL_STALE_CASES pointing at it. Here core turns
 * the two real answers into the preview and the message, exactly as the web
 * page and the phone do, and checks the message against what SQL counted.
 *
 * Skipped in the ordinary suite (no stack, no cases). The script fails if this
 * file is skipped or runs fewer cases than it wrote.
 */

interface StaleCase {
  name: string;
  action: PartialAction;
  /** order_readiness_facts before the other session held stock. */
  preview: unknown;
  /** order_readiness_facts after the commit. */
  reread: unknown;
  /** What the preview must say it holds (the facts before). */
  previewHolds: number;
  /** What SQL counted as held for the order after the commit. */
  dbHeld: number;
  /** The exact message. */
  text: string;
}

const CASES_FILE = process.env.PARTIAL_STALE_CASES;

function resultOf(raw: unknown): OrderReadinessResult {
  const facts = parseOrderReadinessFacts(raw);
  return { state: 'ok', assessment: assessOrderReadiness(facts, { now: facts.observedAt }) };
}

describe.skipIf(!CASES_FILE)('two-session partial stale (f2-3_partial_stale.sh): the message from the real re-read', () => {
  const cases: StaleCase[] = CASES_FILE ? JSON.parse(readFileSync(CASES_FILE, 'utf8')) : [];

  it('has the cases the script wrote', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
  });

  for (const c of cases) {
    it(c.name, () => {
      const preview = previewPartialFulfilment(resultOf(c.preview), c.action);
      if (preview.state !== 'ok') throw new Error(`no preview: ${preview.reason}`);
      expect(preview.willHold).toBe(c.previewHolds);

      const result = describePartialResult({ action: c.action, preview, reread: resultOf(c.reread) });
      // From the re-read: exactly what SQL counted.
      expect(result.held).toBe(c.dbHeld);
      expect(result.text).toBe(c.text);
      // The echo mutation would be caught here: where stock moved, the preview's
      // number is not what was held.
      if (c.previewHolds !== c.dbHeld) {
        expect(result.text).not.toContain(`Holding ${c.previewHolds} of`);
        expect(result.difference).toBe(c.previewHolds - c.dbHeld);
      } else {
        expect(result.difference).toBe(0);
      }
    });
  }
});
