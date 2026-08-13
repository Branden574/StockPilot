import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  deriveNewLocationName,
  newLocationFieldsShape,
  planNewLocation,
  refineNewLocation,
} from './new-location';

// ---------------------------------------------------------------------------
// THE RULE: a new destination is a RACK **or** a CRATE, never both.
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
// Refusing is the only outcome that keeps "the confirmation names exactly what
// will be created" true, so that is what this module does.
// ---------------------------------------------------------------------------

describe('planNewLocation — rack XOR crate', () => {
  it('REPRO B: rack fields AND crate fields together are REFUSED, not resolved', () => {
    const plan = planNewLocation({ rackNumber: 'A1', rackRow: 'Row 3', crateNumber: '9' });
    expect(plan.kind).toBe('invalid');
    if (plan.kind !== 'invalid') throw new Error('unreachable');
    expect(plan.problem).toBe('rack_and_crate');
    // Nothing is named, so nothing can be silently created.
    expect(deriveNewLocationName({ rackNumber: 'A1', rackRow: 'Row 3', crateNumber: '9' })).toBe('');
  });

  it('REPRO A: rack number + crate number is the same refusal (no precedence)', () => {
    expect(planNewLocation({ rackNumber: 'A1', crateNumber: '9' }).kind).toBe('invalid');
  });

  it('a crate COLOUR alongside a rack number is refused too — that was "Blue #A1"', () => {
    // The old fallback named a colour-only crate after the RACK number, which
    // is the both-fields guess in its original form.
    const plan = planNewLocation({ rackNumber: 'A1', crateColor: 'blue' });
    expect(plan.kind).toBe('invalid');
    if (plan.kind !== 'invalid') throw new Error('unreachable');
    expect(plan.problem).toBe('rack_and_crate');
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
// The SERVER enforces the same rule, from the same verdict.
// ---------------------------------------------------------------------------

describe('refineNewLocation — one schema rule for every surface', () => {
  const schema = z.object({ ...newLocationFieldsShape }).superRefine(refineNewLocation);

  it('refuses rack + crate with a message that says why', () => {
    const res = schema.safeParse({ rackNumber: 'A1', rackRow: 'Row 3', crateNumber: '9' });
    expect(res.success).toBe(false);
    if (res.success) throw new Error('unreachable');
    expect(res.error.issues[0]!.message).toMatch(/either a rack or a crate/i);
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
