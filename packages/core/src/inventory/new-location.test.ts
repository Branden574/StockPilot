import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  deriveNewLocationName,
  newLocationFieldsShape,
  planNewLocation,
  refineNewLocation,
} from './new-location';

// ---------------------------------------------------------------------------
// THE RULE: a crate SITS ON a rack. Rack fields + crate fields = a POSITIONED
// CRATE, named in full.
//
// Two live defects came out of guessing at the combination, on surfaces with no
// confirmation:
//
//   REPRO A (mobile)  rack "A1" + crate "9" minted a brand-new "Crate #9" and
//                     moved stock into it, after asking "Create new rack A1?".
//   REPRO B (web)     rack "A1" + row "Row 3" + crate "9" produced name
//                     "Crate #9", kind 'crate', and DROPPED the row — where
//                     before the branch the same input made rack "A1-Row 3".
//
// THE FIRST FIX READ THOSE AS "this input is invalid, forbid it" and made rack
// and crate mutually exclusive. That was the wrong reading: the input is
// MEANINGFUL — crate 9 located at rack A1 — and the WRITER was mishandling it.
// The tests that pinned the exclusivity were rewritten into the four below,
// which pin the corrected model: both halves survive, the name says so, and
// neither is silently dropped.
// ---------------------------------------------------------------------------

describe('planNewLocation — a crate sits on a rack', () => {
  it('REPRO B: rack fields AND crate fields together are ONE positioned crate', () => {
    const fields = { rackNumber: 'A1', rackRow: 'Row 3', crateNumber: '9' };
    const plan = planNewLocation(fields);
    expect(plan).toMatchObject({
      kind: 'crate',
      noun: 'crate',
      // Nothing is dropped and nothing is guessed: the name states both facts.
      name: 'Crate #9 on rack A1-Row 3',
      crateNumber: '9',
      crateColor: null,
      rackNumber: 'A1',
      rackRow: 'Row 3',
    });
    // The confirmation renders this exact string, so it names what gets created.
    expect(deriveNewLocationName(fields)).toBe('Crate #9 on rack A1-Row 3');
  });

  it('REPRO A: rack number + crate number keeps BOTH — no precedence, no drop', () => {
    const plan = planNewLocation({ rackNumber: 'A1', crateNumber: '9' });
    expect(plan).toMatchObject({
      kind: 'crate',
      name: 'Crate #9 on rack A1',
      rackNumber: 'A1',
      rackRow: null,
      crateNumber: '9',
    });
  });

  it('a crate COLOUR alongside a rack number still needs its own NUMBER', () => {
    // "Blue #A1" — borrowing the RACK number as the crate's identity — is still
    // refused. A position is not an identity; the crate needs its own number.
    const plan = planNewLocation({ rackNumber: 'A1', crateColor: 'blue' });
    expect(plan.kind).toBe('invalid');
    if (plan.kind !== 'invalid') throw new Error('unreachable');
    expect(plan.problem).toBe('crate_needs_number');
  });

  it('a rack ROW with no number is refused (a row does not name a rack)', () => {
    const plan = planNewLocation({ rackRow: 'Row 3' });
    expect(plan.kind).toBe('invalid');
    if (plan.kind !== 'invalid') throw new Error('unreachable');
    expect(plan.problem).toBe('rack_needs_number');
  });

  it('a crate COLOUR with no number is refused — a colour does not name a crate', () => {
    const plan = planNewLocation({ crateColor: 'blue' });
    expect(plan.kind).toBe('invalid');
    if (plan.kind !== 'invalid') throw new Error('unreachable');
    expect(plan.problem).toBe('crate_needs_number');
  });

  it('empty input is refused rather than named ""', () => {
    expect(planNewLocation({}).kind).toBe('invalid');
    expect(planNewLocation({ rackNumber: '   ', crateNumber: '  ' }).kind).toBe('invalid');
  });
});

describe('planNewLocation — the RACK branch', () => {
  it('names and decomposes, so the label and the columns cannot disagree', () => {
    const plan = planNewLocation({ rackNumber: '22', rackRow: 'B' });
    expect(plan).toMatchObject({
      kind: 'rack',
      noun: 'rack',
      name: '22-B',
      rackNumber: '22',
      rackRow: 'B',
      crateColor: null,
      crateNumber: null,
    });
  });

  it('splits a WHOLE label typed into the number box (incident 2026-07-23)', () => {
    const plan = planNewLocation({ rackNumber: '22-B' });
    expect(plan).toMatchObject({ kind: 'rack', name: '22-B', rackNumber: '22', rackRow: 'B' });
  });

  it('keeps a dashed rack NAME that has its own row', () => {
    expect(planNewLocation({ rackNumber: 'E2E-RACK', rackRow: '1' })).toMatchObject({
      name: 'E2E-RACK-1',
      rackNumber: 'E2E-RACK',
      rackRow: '1',
    });
  });

  it('a number with no row is a bare rack', () => {
    expect(planNewLocation({ rackNumber: 'A1' })).toMatchObject({ name: 'A1', rackRow: null });
  });
});

describe('planNewLocation — the CRATE branch', () => {
  it('a NUMBER alone is a crate — the colour is optional', () => {
    expect(planNewLocation({ crateNumber: '42' })).toMatchObject({
      kind: 'crate',
      noun: 'crate',
      name: 'Crate #42',
      crateColor: null,
      crateNumber: '42',
      rackNumber: null,
      rackRow: null,
    });
  });

  it('a known colour names it with the registry label', () => {
    expect(deriveNewLocationName({ crateColor: 'blue', crateNumber: '42' })).toBe('Blue #42');
    expect(deriveNewLocationName({ crateColor: 'Blue', crateNumber: '42' })).toBe('Blue #42');
  });

  it('an UNKNOWN colour is kept verbatim — the name must stay reconstructible', () => {
    expect(deriveNewLocationName({ crateColor: 'taupe', crateNumber: '42' })).toBe('taupe #42');
  });

  it('a crate NUMBER is free text — production holds 0, "Bin", "Blue Shelf"', () => {
    // Never range-validate; these are real book_crate_number values.
    for (const n of ['0', '16', 'Bin', 'BIN', 'Blue Shelf']) {
      const plan = planNewLocation({ crateColor: 'blue', crateNumber: n });
      expect(plan.kind).toBe('crate');
      expect(plan.kind === 'crate' && plan.crateNumber).toBe(n);
    }
  });
});

// ---------------------------------------------------------------------------
// CRATE IDENTITY — (colour, number, rack number, rack row), never colour+number.
//
// Production, L4L North Region, books carrying BOTH summaries:
//   gray "BIN"  → 43-B, 43-C, 42-B, 42-C, 41-C   (FIVE distinct bins)
//   yellow 5    → 40-B, 40-C                      blue 0 → 39-B, 38-B, 37-C
//   blue "Blue Shelf" → NO RACK AT ALL (5 books)
//
// `findOrCreateRackOrCrate` dedupes on `lower(name)` and migration 0270's
// partial unique index keys on it too, so if the name were position-blind those
// five bins would COLLAPSE INTO ONE `locations` row and one bin's books would
// be stamped with another bin's location. The name is therefore the identity,
// and these tests are what stop it regressing.
// ---------------------------------------------------------------------------

describe('planNewLocation — crate identity includes the rack position', () => {
  const GRAY_BIN_POSITIONS = [
    ['43', 'B'],
    ['43', 'C'],
    ['42', 'B'],
    ['42', 'C'],
    ['41', 'C'],
  ] as const;

  it('the five real "gray BIN" bins get five DISTINCT dedupe keys', () => {
    const names = GRAY_BIN_POSITIONS.map(([n, r]) =>
      deriveNewLocationName({ crateColor: 'gray', crateNumber: 'BIN', rackNumber: n, rackRow: r }),
    );
    expect(names).toEqual([
      'Gray #BIN on rack 43-B',
      'Gray #BIN on rack 43-C',
      'Gray #BIN on rack 42-B',
      'Gray #BIN on rack 42-C',
      'Gray #BIN on rack 41-C',
    ]);
    // The dedupe key is lower(name) — five rows, not one.
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(5);
  });

  it('"yellow 5" on 40-B and on 40-C are two crates, not one', () => {
    const a = deriveNewLocationName({
      crateColor: 'yellow',
      crateNumber: '5',
      rackNumber: '40',
      rackRow: 'B',
    });
    const b = deriveNewLocationName({
      crateColor: 'yellow',
      crateNumber: '5',
      rackNumber: '40',
      rackRow: 'C',
    });
    expect(a).toBe('Yellow #5 on rack 40-B');
    expect(b).toBe('Yellow #5 on rack 40-C');
    expect(a.toLowerCase()).not.toBe(b.toLowerCase());
  });

  it('BACKWARD COMPATIBLE: a position-less crate keeps its EXACT old name', () => {
    // Every crate row in production today was created without a position, so
    // put-away must still match and REUSE it. If any of these strings move, the
    // existing rows stop being found and duplicates are minted (mig 0270).
    expect(deriveNewLocationName({ crateColor: 'blue', crateNumber: 'Shelf' })).toBe('Blue #Shelf');
    expect(deriveNewLocationName({ crateColor: 'gray', crateNumber: 'BIN' })).toBe('Gray #BIN');
    expect(deriveNewLocationName({ crateNumber: '42' })).toBe('Crate #42');
    expect(deriveNewLocationName({ crateColor: 'taupe', crateNumber: '42' })).toBe('taupe #42');
  });

  it('a position-less crate stays DISTINCT from the positioned one', () => {
    // "Blue Shelf" holds 5 books with rack NULL. That is a legitimate permanent
    // shape — it must never be backfilled onto, or merged with, a positioned row.
    expect(deriveNewLocationName({ crateColor: 'blue', crateNumber: '13' })).toBe('Blue #13');
    expect(
      deriveNewLocationName({ crateColor: 'blue', crateNumber: '13', rackNumber: '38', rackRow: 'B' }),
    ).toBe('Blue #13 on rack 38-B');
  });

  it('a whole label typed into the crate form’s rack box is DECOMPOSED', () => {
    // The 2026-07-23 shape applies to a crate's position too: ("38-B", null)
    // stored composite would go invisible to the ("38","B") rack filter.
    const plan = planNewLocation({ crateNumber: '13', rackNumber: '38-B' });
    expect(plan).toMatchObject({
      kind: 'crate',
      name: 'Crate #13 on rack 38-B',
      rackNumber: '38',
      rackRow: 'B',
    });
  });

  it('a colour-only crate NUMBER of 0 still positions (0 is a real crate number)', () => {
    expect(
      deriveNewLocationName({ crateColor: 'blue', crateNumber: '0', rackNumber: '39', rackRow: 'B' }),
    ).toBe('Blue #0 on rack 39-B');
  });

  it('a NUMBER with no colour positions too (production: rack 39-B, number 1)', () => {
    expect(deriveNewLocationName({ crateNumber: '1', rackNumber: '39', rackRow: 'B' })).toBe(
      'Crate #1 on rack 39-B',
    );
  });
});

// ---------------------------------------------------------------------------
// The SERVER enforces the same rule, from the same verdict.
// ---------------------------------------------------------------------------

describe('refineNewLocation — one schema rule for every surface', () => {
  const schema = z.object({ ...newLocationFieldsShape }).superRefine(refineNewLocation);

  it('ACCEPTS rack + crate — it is a crate on a rack, not a conflict', () => {
    // This assertion used to be its exact opposite ("refuses rack + crate with
    // a message that says why"). It pinned the misread, and a schema that
    // refuses the combination makes a positioned crate unreachable from every
    // surface at once.
    expect(schema.safeParse({ rackNumber: 'A1', rackRow: 'Row 3', crateNumber: '9' }).success).toBe(
      true,
    );
  });

  it('refuses a rack ROW with no rack number, pointing at the rack field', () => {
    // On the crate branch too: a row alone is not a position, and dropping it
    // silently is the original bug wearing a different hat.
    const res = schema.safeParse({ rackRow: 'B', crateNumber: '9' });
    expect(res.success).toBe(false);
    if (res.success) throw new Error('unreachable');
    expect(res.error.issues[0]!.path).toEqual(['rackNumber']);
  });

  it('refuses a crate with no number, pointing at the crate field', () => {
    const res = schema.safeParse({ crateColor: 'blue' });
    expect(res.success).toBe(false);
    if (res.success) throw new Error('unreachable');
    expect(res.error.issues[0]!.path).toEqual(['crateNumber']);
  });

  it('accepts a number-only crate — the case every surface used to make unreachable', () => {
    expect(schema.safeParse({ crateNumber: '9' }).success).toBe(true);
  });

  it('accepts a plain rack', () => {
    expect(schema.safeParse({ rackNumber: 'A1', rackRow: 'Row 3' }).success).toBe(true);
  });
});
