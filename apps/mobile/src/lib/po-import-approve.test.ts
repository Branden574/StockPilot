import { describe, expect, it } from 'vitest';

import {
  actionsForStatus,
  buildLineOverrides,
  createLineIds,
  extractApiErrorMessage,
  isSiteLocation,
  normalizeExpectedAt,
  normalizeLineMatches,
  unmatchedLineIds,
  validateApprove,
  type LineDecision,
} from './po-import-approve';

describe('actionsForStatus', () => {
  it('uploaded/failed offer parse + cancel (the re-parse retry states)', () => {
    expect(actionsForStatus('uploaded')).toEqual(['parse', 'cancel']);
    expect(actionsForStatus('failed')).toEqual(['parse', 'cancel']);
  });

  it('parsed/needs_review offer approve + cancel (the only approvable states)', () => {
    expect(actionsForStatus('parsed')).toEqual(['approve', 'cancel']);
    expect(actionsForStatus('needs_review')).toEqual(['approve', 'cancel']);
  });

  it('parsing/duplicate are cancel-only (non-terminal, not approvable)', () => {
    expect(actionsForStatus('parsing')).toEqual(['cancel']);
    expect(actionsForStatus('duplicate')).toEqual(['cancel']);
  });

  it('terminal states get no actions', () => {
    expect(actionsForStatus('approved')).toEqual([]);
    expect(actionsForStatus('canceled')).toEqual([]);
  });

  it('unknown / missing statuses are defensive no-ops', () => {
    expect(actionsForStatus('who_knows')).toEqual([]);
    expect(actionsForStatus(null)).toEqual([]);
    expect(actionsForStatus(undefined)).toEqual([]);
  });
});

describe('buildLineOverrides', () => {
  it('maps skip → { lineId, skip: true }', () => {
    expect(buildLineOverrides({ 'l-1': { mode: 'skip' } })).toEqual([
      { lineId: 'l-1', skip: true },
    ]);
  });

  it('maps use_existing → { lineId, itemId }', () => {
    expect(
      buildLineOverrides({ 'l-1': { mode: 'use_existing', itemId: 'item-9' } }),
    ).toEqual([{ lineId: 'l-1', itemId: 'item-9' }]);
  });

  it('emits NOTHING for create decisions (create-items resolves them server-side)', () => {
    expect(buildLineOverrides({ 'l-1': { mode: 'create' } })).toEqual([]);
  });

  it('handles a mixed decision set', () => {
    const decisions: Record<string, LineDecision> = {
      'l-1': { mode: 'create' },
      'l-2': { mode: 'use_existing', itemId: 'item-2' },
      'l-3': { mode: 'skip' },
      'l-4': { mode: 'create' },
    };
    expect(buildLineOverrides(decisions)).toEqual([
      { lineId: 'l-2', itemId: 'item-2' },
      { lineId: 'l-3', skip: true },
    ]);
  });

  it('drops use_existing with a blank itemId instead of sending a broken override', () => {
    expect(
      buildLineOverrides({ 'l-1': { mode: 'use_existing', itemId: '  ' } }),
    ).toEqual([]);
  });

  it('empty decisions → empty overrides', () => {
    expect(buildLineOverrides({})).toEqual([]);
  });
});

describe('createLineIds', () => {
  it('returns only the create-mode line ids', () => {
    const decisions: Record<string, LineDecision> = {
      'l-1': { mode: 'create' },
      'l-2': { mode: 'skip' },
      'l-3': { mode: 'use_existing', itemId: 'i' },
      'l-4': { mode: 'create' },
    };
    expect(createLineIds(decisions)).toEqual(['l-1', 'l-4']);
  });

  it('empty decisions → empty batch', () => {
    expect(createLineIds({})).toEqual([]);
  });
});

describe('unmatchedLineIds', () => {
  it('returns inventory lines without an item_id', () => {
    const lines = [
      { id: 'a', line_type: 'inventory', item_id: null },
      { id: 'b', line_type: 'inventory', item_id: 'item-1' },
      { id: 'c', line_type: 'tax', item_id: null },
      { id: 'd', line_type: 'freight', item_id: null },
    ];
    expect(unmatchedLineIds(lines)).toEqual(['a']);
  });

  it('treats a missing line_type as non-inventory (defensive on weird payloads)', () => {
    expect(unmatchedLineIds([{ id: 'a', item_id: null }])).toEqual([]);
    expect(unmatchedLineIds([{ id: 'a', line_type: null, item_id: null }])).toEqual([]);
  });
});

describe('validateApprove', () => {
  const full = { warehouseId: 'w', vendorId: 'v', locationId: 'loc' };

  it('blocks until warehouse, vendor, and location are all chosen (in that order)', () => {
    expect(validateApprove({ warehouseId: null, vendorId: null, locationId: null }, [], {})).toEqual(
      { ok: false, reason: 'Pick a destination warehouse.' },
    );
    expect(validateApprove({ warehouseId: 'w', vendorId: null, locationId: null }, [], {})).toEqual(
      { ok: false, reason: 'Pick a vendor.' },
    );
    expect(validateApprove({ warehouseId: 'w', vendorId: 'v', locationId: null }, [], {})).toEqual({
      ok: false,
      reason: 'Pick a destination location for this warehouse.',
    });
  });

  it('blocks while any unmatched line is undecided (with a count)', () => {
    expect(validateApprove(full, ['l-1'], {})).toEqual({
      ok: false,
      reason: 'Decide how to handle 1 unmatched line.',
    });
    expect(validateApprove(full, ['l-1', 'l-2'], { 'l-1': { mode: 'skip' } })).toEqual({
      ok: false,
      reason: 'Decide how to handle 1 unmatched line.',
    });
    expect(validateApprove(full, ['l-1', 'l-2'], {})).toEqual({
      ok: false,
      reason: 'Decide how to handle 2 unmatched lines.',
    });
  });

  it('blocks a use_existing decision with no item picked', () => {
    expect(
      validateApprove(full, ['l-1'], { 'l-1': { mode: 'use_existing', itemId: '' } }),
    ).toEqual({ ok: false, reason: 'Pick an item for every "use existing" line.' });
  });

  it('passes with all fields set and every unmatched line decided', () => {
    const decisions: Record<string, LineDecision> = {
      'l-1': { mode: 'create' },
      'l-2': { mode: 'use_existing', itemId: 'item-2' },
      'l-3': { mode: 'skip' },
    };
    expect(validateApprove(full, ['l-1', 'l-2', 'l-3'], decisions)).toEqual({ ok: true });
  });

  it('passes with no unmatched lines at all', () => {
    expect(validateApprove(full, [], {})).toEqual({ ok: true });
  });
});

describe('isSiteLocation', () => {
  it('accepts real sites (warehouse/room/vehicle/jobsite/unknown catch-all)', () => {
    expect(isSiteLocation({ type: 'warehouse', kind: null })).toBe(true);
    expect(isSiteLocation({ type: 'room', kind: null })).toBe(true);
    expect(isSiteLocation({ type: 'vehicle', kind: null })).toBe(true);
    expect(isSiteLocation({ type: 'jobsite', kind: null })).toBe(true);
    // Catch-all — future site types (or null metadata) stay pickable,
    // exactly like the web's locationGroup() partition.
    expect(isSiteLocation({ type: null, kind: null })).toBe(true);
    expect(isSiteLocation({ type: 'future_site_type', kind: null })).toBe(true);
  });

  it('rejects system buckets (staging/unplaced)', () => {
    expect(isSiteLocation({ type: null, kind: 'staging' })).toBe(false);
    expect(isSiteLocation({ type: null, kind: 'unplaced' })).toBe(false);
  });

  it('rejects placements (rack/crate/area kinds; shelf/bin types)', () => {
    expect(isSiteLocation({ type: null, kind: 'rack' })).toBe(false);
    expect(isSiteLocation({ type: null, kind: 'crate' })).toBe(false);
    expect(isSiteLocation({ type: null, kind: 'area' })).toBe(false);
    expect(isSiteLocation({ type: 'shelf', kind: null })).toBe(false);
    expect(isSiteLocation({ type: 'bin', kind: null })).toBe(false);
  });
});

describe('normalizeExpectedAt', () => {
  it('empty / whitespace → null (field omitted, not an error)', () => {
    expect(normalizeExpectedAt('')).toEqual({ ok: true, value: null });
    expect(normalizeExpectedAt('   ')).toEqual({ ok: true, value: null });
  });

  it('a valid YYYY-MM-DD → midnight-UTC ISO datetime (what z.string().datetime() wants)', () => {
    expect(normalizeExpectedAt('2026-08-01')).toEqual({
      ok: true,
      value: '2026-08-01T00:00:00.000Z',
    });
  });

  it('rejects non-date text and partial dates', () => {
    expect(normalizeExpectedAt('next tuesday')).toEqual({ ok: false });
    expect(normalizeExpectedAt('2026-08')).toEqual({ ok: false });
    expect(normalizeExpectedAt('08/01/2026')).toEqual({ ok: false });
  });

  it('rejects rollover dates JS Date would silently accept (2026-02-31)', () => {
    expect(normalizeExpectedAt('2026-02-31')).toEqual({ ok: false });
  });
});

describe('normalizeLineMatches', () => {
  const candidate = {
    id: 'item-1',
    name: 'Widget',
    sku: 'SP-1',
    barcode: '123',
    quantityOnHand: 4,
    matchType: 'barcode',
  };

  it('accepts the verbatim Record<lineId, candidates[]> shape', () => {
    const out = normalizeLineMatches({ ok: true, matches: { 'l-1': [candidate] } });
    expect(out['l-1']).toEqual([candidate]);
  });

  it('accepts an array-of-{lineId,candidates} encoding too', () => {
    const out = normalizeLineMatches({
      ok: true,
      matches: [{ lineId: 'l-1', candidates: [candidate] }],
    });
    expect(out['l-1']).toEqual([candidate]);
  });

  it('degrades junk to no-suggestions instead of crashing', () => {
    expect(normalizeLineMatches(null)).toEqual({});
    expect(normalizeLineMatches({})).toEqual({});
    expect(normalizeLineMatches({ matches: 'nope' })).toEqual({});
    expect(normalizeLineMatches({ matches: { 'l-1': 'nope' } })).toEqual({});
    expect(normalizeLineMatches({ matches: { 'l-1': [{ noId: true }] } })).toEqual({});
  });

  it('fills defensive defaults on partial candidates', () => {
    const out = normalizeLineMatches({ matches: { 'l-1': [{ id: 'x' }] } });
    expect(out['l-1']).toEqual([
      { id: 'x', name: 'Unnamed item', sku: '', barcode: null, quantityOnHand: 0, matchType: 'barcode' },
    ]);
  });
});

describe('extractApiErrorMessage', () => {
  it("pulls the server's friendly message out of the api() error text", () => {
    const e = new Error('API 422: {"error":"validation_error","message":"Line 3 has no mapped item."}');
    expect(extractApiErrorMessage(e, 'fallback')).toBe('Line 3 has no mapped item.');
  });

  it('falls back to the error code, then the raw text, then the fallback', () => {
    expect(extractApiErrorMessage(new Error('API 403: {"error":"forbidden"}'), 'f')).toBe(
      'forbidden',
    );
    expect(extractApiErrorMessage(new Error('Request timed out.'), 'f')).toBe('Request timed out.');
    expect(extractApiErrorMessage(new Error(''), 'fallback')).toBe('fallback');
    expect(extractApiErrorMessage(undefined, 'fallback')).toBe('fallback');
  });

  it('survives a non-JSON brace payload', () => {
    expect(extractApiErrorMessage(new Error('API 500: {oops'), 'f')).toBe('API 500: {oops');
  });
});
