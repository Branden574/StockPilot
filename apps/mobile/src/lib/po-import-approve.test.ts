import { describe, expect, it } from 'vitest';

// Test-only cross-app import — see the "agrees with the web classifier" guard
// below for why the phone's copy is pinned against the web's ONE definition.
import {
  PLACEMENT_KINDS as WEB_PLACEMENT_KINDS,
  PLACEMENT_TYPES as WEB_PLACEMENT_TYPES,
  SYSTEM_KINDS as WEB_SYSTEM_KINDS,
  isSiteLocation as webIsSiteLocation,
} from '../../../web/src/lib/locations/groups';

import {
  actionsForStatus,
  buildApproveCharterFields,
  buildLineOverrides,
  createLineIds,
  extractApiErrorMessage,
  isSiteLocation,
  normalizeExpectedAt,
  normalizeLineMatches,
  ownershipCharterForCreate,
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

/**
 * Cross-app agreement guard (recurring bug pattern #26: "a fix applied to ONE
 * copy of a duplicated function is not a fix").
 *
 * `isSiteLocation` in po-import-approve.ts is a hand-copy of the web's
 * apps/web/src/lib/locations/groups.ts, and the phone's PO receiving-destination
 * picker (app/po-import/[id].tsx) is the ONLY consumer — it reads every
 * `locations` row straight from Supabase and filters client-side, because there
 * is no /api/v1 locations endpoint with a sitesOnly filter. So if someone adds a
 * new placement kind (say 'zone') to the web's PLACEMENT_KINDS, the web pickers
 * stop offering zones while the phone keeps treating them as sites and staff
 * receive a PO into a zone the web then hides.
 *
 * Until the classifier lives in @stockpilot/core (see the note in
 * po-import-approve.ts), these tests drive BOTH implementations off the WEB's
 * exported constants, so a kind/type added on the web side turns red here
 * instead of silently diverging. The import is test-only and reaches across
 * apps deliberately; groups.ts is dependency-free by contract (its own header
 * says so) precisely so anything can consume it.
 */
describe('isSiteLocation agrees with the web classifier', () => {
  it('rejects every kind/type the WEB classifies as system or placement', () => {
    for (const kind of [...WEB_SYSTEM_KINDS, ...WEB_PLACEMENT_KINDS]) {
      expect(isSiteLocation({ type: null, kind })).toBe(false);
      expect(isSiteLocation({ type: 'other', kind })).toBe(false);
    }
    for (const type of WEB_PLACEMENT_TYPES) {
      expect(isSiteLocation({ type, kind: null })).toBe(false);
    }
  });

  it('returns the same verdict as the web for every fixture row', () => {
    const rows: Array<{ type: string | null; kind: string | null }> = [
      // Real prod shapes: DC4 = {warehouse,null}; a room; a rack; a bin;
      // Staging/Unplaced; plus the null/unknown catch-alls.
      { type: 'warehouse', kind: null },
      { type: 'room', kind: null },
      { type: 'vehicle', kind: null },
      { type: 'jobsite', kind: null },
      { type: null, kind: null },
      { type: 'future_site_type', kind: null },
      { type: 'shelf', kind: 'rack' },
      // Every kind and type the web currently knows about, in both slots, so a
      // new entry on either web list is exercised here automatically.
      ...[...WEB_SYSTEM_KINDS, ...WEB_PLACEMENT_KINDS].flatMap((kind) => [
        { type: null, kind },
        { type: 'other', kind },
        { type: 'warehouse', kind },
      ]),
      ...WEB_PLACEMENT_TYPES.flatMap((type) => [
        { type, kind: null },
        { type, kind: 'rack' },
      ]),
    ];
    for (const row of rows) {
      expect({ row, site: isSiteLocation(row) }).toEqual({
        row,
        site: webIsSiteLocation(row),
      });
    }
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

// ── Bill-to is billing metadata, never placement ───────────────────────────

describe('buildApproveCharterFields / ownershipCharterForCreate', () => {
  const A = 'chr-operational-A';
  const B = 'chr-billto-B';

  it('sends the two charters as two independent keys', () => {
    const body = buildApproveCharterFields({ billToCharterId: B, itemCharterId: A });
    expect(body.charterId).toBe(B);
    expect(body.itemCharterId).toBe(A);
    // Neither is ever the other. On mobile these used to be ONE state variable.
    expect(body.charterId).not.toBe(body.itemCharterId);
  });

  it('OMITS itemCharterId when no ownership intent was stated', () => {
    // The reported defect on mobile: picking only a bill-to charter must not
    // rewrite any item's ownership. Absent — not null — is what tells the
    // server "change nothing".
    const body = buildApproveCharterFields({ billToCharterId: B, itemCharterId: undefined });
    expect(body.charterId).toBe(B);
    expect('itemCharterId' in body).toBe(false);
  });

  it('keeps an explicit Generic ownership choice as a real null', () => {
    const body = buildApproveCharterFields({ billToCharterId: B, itemCharterId: null });
    expect('itemCharterId' in body).toBe(true);
    expect(body.itemCharterId).toBeNull();
  });

  it('never lets the bill-to charter own newly created items', () => {
    // "Keep as-is" for a brand-new item means no charter — NOT the bill-to one.
    expect(ownershipCharterForCreate({ billToCharterId: B, itemCharterId: undefined })).toBeNull();
    expect(ownershipCharterForCreate({ billToCharterId: B, itemCharterId: null })).toBeNull();
    expect(ownershipCharterForCreate({ billToCharterId: B, itemCharterId: A })).toBe(A);
  });

  it('does not treat a bill-to charter as a substitute for the required location', () => {
    // B3: placement stays blocked on the operational field. A billing-only
    // document (the AI schema extracts no warehouse/location/charter at all)
    // must make the user choose.
    const v = validateApprove(
      { warehouseId: 'wh-1', vendorId: 'v-1', locationId: null },
      [],
      {},
    );
    expect(v).toEqual({ ok: false, reason: 'Pick a destination location for this warehouse.' });
  });
});
