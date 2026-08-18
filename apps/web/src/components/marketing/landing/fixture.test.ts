import { describe, expect, it } from 'vitest';

import {
  AVAILABLE,
  AWAITING,
  COUNT,
  crateLabel,
  HERO_KPIS,
  HOLDINGS,
  isStaleAge,
  ON_HAND_AFTER_COUNT,
  ORDERED,
  PLACED,
  PO_LINES,
  RECEIVED,
  RESERVED,
  STAGES,
  STAGING,
  STALE_ROW,
  STALE_THRESHOLD_DAYS,
  VARIANCE,
  formatSigned,
} from './fixture';

/**
 * The landing page's persuasive weight rests on one quantity surviving seven
 * surfaces. If these numbers stop reconciling the page is lying, and the first
 * prospect to read it carefully is the one who finds out. Assert the
 * arithmetic rather than trusting it.
 */
describe('landing fixture — the travelling quantity reconciles', () => {
  it('PO line quantities sum to the advertised totals', () => {
    expect(ORDERED).toBe(240);
    expect(RECEIVED).toBe(238);
    expect(PO_LINES.reduce((n, l) => n + l.ordered, 0)).toBe(ORDERED);
    expect(PO_LINES.reduce((n, l) => n + l.received, 0)).toBe(RECEIVED);
  });

  it('everything received reaches staging', () => {
    const stagedFromPo = STAGING.filter((r) => r.source === 'staged').reduce((n, r) => n + r.qty, 0);
    expect(stagedFromPo).toBe(RECEIVED);
  });

  it('reserved plus available equals what was received', () => {
    expect(RESERVED + AVAILABLE).toBe(RECEIVED);
  });

  it('the count closes the loop back onto on-hand', () => {
    expect(VARIANCE).toBe(COUNT.counted - COUNT.expected);
    expect(VARIANCE).toBe(-3);
    expect(ON_HAND_AFTER_COUNT).toBe(RECEIVED + VARIANCE);
    expect(ON_HAND_AFTER_COUNT).toBe(235);
  });

  it('the counted rack holds exactly the quantity the count expected', () => {
    // The count is scoped to Rack 4. Its expected figure must equal the holding
    // that actually sits there, or the story does not survive a careful reader.
    const onRack4 = HOLDINGS.filter((h) => h.crate.rack === '4').reduce((n, h) => n + h.qty, 0);
    expect(onRack4).toBe(COUNT.expected);
  });

  it('every stage ledger figure is present and non-empty', () => {
    expect(STAGES).toHaveLength(7);
    for (const s of STAGES) {
      expect(s.figure.trim().length).toBeGreaterThan(0);
      expect(s.claim.trim().length).toBeGreaterThan(0);
    }
    expect(STAGES.map((s) => s.code)).toEqual(['01', '02', '03', '04', '05', '06', '07']);
  });

  it('placed and awaiting sum to what was received', () => {
    expect(PLACED + AWAITING).toBe(RECEIVED);
  });

  it('the hero on-hand foot adds up to the total printed above it', () => {
    // REGRESSION GUARD. This foot once read "60 placed · 12 awaiting put-away"
    // against a headline of 238, because the 12 was lifted from the stale
    // Chromebook row — a different sku entirely. Every integer in the foot must
    // be part of the same total, or the very first KPI on the page is a lie.
    const foot = HERO_KPIS.find((k) => k.label === 'On hand')?.foot ?? '';
    const numbers = (foot.match(/\d+/g) ?? []).map(Number);
    expect(numbers.length).toBeGreaterThan(1);
    expect(numbers.reduce((a, b) => a + b, 0)).toBe(RECEIVED);
  });

  it('hero KPIs restate figures the page proves elsewhere', () => {
    expect(HERO_KPIS.find((k) => k.label === 'On hand')?.value).toBe(String(RECEIVED));
    expect(HERO_KPIS.find((k) => k.label === 'Variance')?.value).toBe(formatSigned(VARIANCE));
  });
});

describe('landing fixture — domain rules the marketing page must not misrepresent', () => {
  it('records an over-receipt rather than clamping it (rule 4)', () => {
    const over = PO_LINES.filter((l) => l.received > l.ordered);
    expect(over).toHaveLength(1);
    expect(over[0]?.received).toBe(52);
    expect(over[0]?.ordered).toBe(48);
  });

  it('keeps at least one holding with a NULL rack (rule 3)', () => {
    // Position is optional in the real model. A fixture where every crate has a
    // rack would quietly misrepresent the schema.
    expect(HOLDINGS.some((h) => h.crate.rack === null)).toBe(true);
  });

  it('never renders a crate by name alone (rules 1 and 2)', () => {
    // `gray BIN` exists on five racks in real data, so a name-only label would
    // imply a merge that would be a data bug.
    for (const h of HOLDINGS) {
      const label = crateLabel(h.crate);
      expect(label).toMatch(/\d/); // carries a crate number
      if (h.crate.rack) {
        expect(label).toContain(`Rack ${h.crate.rack}`);
      } else {
        expect(label).toContain('Shelf');
      }
    }
  });

  it('carries exactly one stale staging row, flagged by the real threshold', () => {
    const stale = STAGING.filter((r) => isStaleAge(r.ageDays));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toBe(STALE_ROW);
    expect(STALE_ROW.ageDays).toBeGreaterThan(STALE_THRESHOLD_DAYS);
    // The stale row must be `unplaced`, not `staged` — it is on hand and was
    // never put away, which is the state that actually goes stale.
    expect(STALE_ROW.source).toBe('unplaced');
  });

  it('shows both staging source kinds', () => {
    const kinds = new Set(STAGING.map((r) => r.source));
    expect(kinds).toEqual(new Set(['staged', 'unplaced']));
  });

  it('includes a title long enough to truncate', () => {
    expect(PO_LINES.some((l) => l.truncates)).toBe(true);
  });

  it('uses non-round, irregular quantities', () => {
    // Regularity is what collapses a table into a mockup. At least one line
    // must not be a multiple of ten.
    expect(PO_LINES.some((l) => l.received % 10 !== 0)).toBe(true);
  });
});

describe('landing fixture — no fabricated claims', () => {
  it('contains no emoji anywhere in copy', () => {
    const blob = JSON.stringify(STAGES) + JSON.stringify(HERO_KPIS);
    expect(blob).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('names no real publisher or distributor', () => {
    const blob = JSON.stringify(STAGES).toLowerCase();
    for (const real of ['houghton', 'mifflin', 'pearson', 'scholastic', 'mcgraw', 'cengage', 'wiley']) {
      expect(blob).not.toContain(real);
    }
  });

  it('formats signed variances explicitly', () => {
    expect(formatSigned(-3)).toBe('-3');
    expect(formatSigned(4)).toBe('+4');
  });
});
