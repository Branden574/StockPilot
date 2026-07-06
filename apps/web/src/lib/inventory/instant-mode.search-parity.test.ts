import { describe, expect, it } from 'vitest';

import {
  buildInstantSearchTerm,
  normalizeInstantSearchText,
  rowMatchesInstantSearch,
  type InstantModeRow,
} from './instant-mode';

// SEARCH-PARITY SUITE: pins the client matcher to InventoryService.
// list()'s q semantics. The reference below re-implements the server's
// clause literally —
//   term = q.trim().slice(0,120).replace(/[,()%*]/g, ' ')
//   if (term) .or(`name.ilike.%term%,sku.ilike.%term%,
//                  barcode.ilike.%term%,model_number.ilike.%term%`)
// — i.e. a case-insensitive contiguous substring over EXACTLY four
// fields, NULL never matching. If list() ever changes its field list or
// preprocessing, update BOTH the reference here and the client matcher.
//
// Documented divergences (see instant-mode.ts header):
//   • diacritics — client folds them (superset of the server); asserted
//     separately below, EXCLUDED from the strict-parity fixtures.
//   • `_` — LIKE single-char wildcard on the server, literal on the
//     client; excluded from the strict-parity fixtures.

/** The server's q clause, literally. */
function serverQMatches(row: InstantModeRow, q: string): boolean {
  const term = q.trim().slice(0, 120).replace(/[,()%*]/g, ' ');
  if (!term) return true; // no filter applied
  const pat = term.toLowerCase();
  const ilike = (v: string | null | undefined): boolean =>
    v != null && v.toLowerCase().includes(pat);
  return ilike(row.name) || ilike(row.sku) || ilike(row.barcode) || ilike(row.model_number);
}

function clientQMatches(row: InstantModeRow, q: string): boolean {
  return rowMatchesInstantSearch(row, normalizeInstantSearchText(buildInstantSearchTerm(q)));
}

function row(over: Partial<InstantModeRow>): InstantModeRow {
  return {
    id: 'r1',
    sku: 'SKU-0001',
    barcode: null,
    model_number: null,
    name: 'Widget',
    status: 'active',
    quantity_on_hand: 5,
    reorder_point: 0,
    unit_cost: 2,
    category_id: null,
    primary_location_id: null,
    charter_id: null,
    custom_fields: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-02T00:00:00+00:00',
    ...over,
  };
}

// Representative rows: names with case/spacing/punctuation variety,
// partial-able SKUs, digit barcodes, model numbers, NULL columns.
const FIXTURE_ROWS: InstantModeRow[] = [
  row({ id: 'a', name: 'Blue Lanyard (Large)', sku: 'LAN-BLU-L', barcode: '0123456789012', model_number: 'LNY-2000' }),
  row({ id: 'b', name: 'HP Chromebook 11 G9', sku: 'CHR-HP-11', barcode: '196068774301', model_number: '3V2Y2UT#ABA' }),
  row({ id: 'c', name: 'usb-c cable, 2m', sku: 'CAB-USBC-2M', barcode: null, model_number: null }),
  row({ id: 'd', name: 'Safety Vest 100% Hi-Vis', sku: 'VES-HIVIS', barcode: '712345678904', model_number: 'HV*9' }),
  row({ id: 'e', name: 'The Giver', sku: 'BK-GIVER', barcode: '9780544336261', model_number: null }),
  row({ id: 'f', name: '  padded   envelope  ', sku: 'ENV-PAD', barcode: '000111222333', model_number: 'PE-01' }),
];

// Terms covering the brief's fixture classes: case variants, partial
// SKU, barcode digits, model numbers, multi-word (contiguous), the
// stripped punctuation class, whitespace-only, over-length, no-match.
const FIXTURE_TERMS: string[] = [
  '', '   ',
  // case variants
  'blue', 'BLUE', 'BlUe LaNyArD', 'chromebook', 'CHROMEBOOK 11',
  // partial SKU (prefix, infix, suffix, with dash)
  'LAN-', 'lan-blu', 'BLU-L', 'usbc', 'CAB-USBC-2M', 'HR-HP',
  // barcode digits (full + partial)
  '0123456789012', '2345678', '9780544336261', '196068',
  // model numbers (incl. # which neither side strips)
  'LNY-2000', 'lny-2', '3V2Y2UT#ABA', '3v2y2ut#', 'PE-01',
  // multi-word — matches as ONE contiguous substring on both sides
  'blue lanyard', 'lanyard blue', 'hp chromebook 11', 'padded   envelope',
  // punctuation both sides map to spaces: ( ) , % *
  'lanyard (large)', '(large)', '100%', 'HV*9', 'cable, 2m',
  // stripped-to-spaces-only term (server still filters on '%   %')
  '%,)', '((()))',
  // no-match probes (also exercise NULL barcode/model_number columns)
  'zzz-none', '999999999999999',
  // over-length: only the first 120 chars participate on both sides
  `${'x'.repeat(119)}yz`,
];

describe('instant-mode search parity with InventoryService.list() q semantics', () => {
  it('matches the server clause row-for-row over the fixture matrix (field coverage: name / sku / barcode / model_number)', () => {
    for (const term of FIXTURE_TERMS) {
      for (const r of FIXTURE_ROWS) {
        expect(
          clientQMatches(r, term),
          `term=${JSON.stringify(term)} row=${r.id}`,
        ).toBe(serverQMatches(r, term));
      }
    }
  });

  it('covers each field INDEPENDENTLY (a term matching only one column must hit on both sides)', () => {
    const r = row({
      id: 'solo',
      name: 'OnlyNameZZZ',
      sku: 'ONLYSKU111',
      barcode: '424242424242',
      model_number: 'MODL-777',
    });
    for (const term of ['onlynamezzz', 'onlysku111', '424242424242', 'modl-777']) {
      expect(clientQMatches(r, term), term).toBe(true);
      expect(serverQMatches(r, term), term).toBe(true);
    }
    // NULL columns never match on either side.
    const nulls = row({ id: 'nulls', name: 'N', sku: 'S', barcode: null, model_number: null });
    expect(clientQMatches(nulls, 'modl')).toBe(false);
    expect(serverQMatches(nulls, 'modl')).toBe(false);
  });

  it('mirrors the 120-char cap: chars beyond the cap are ignored on both sides', () => {
    const longName = 'a'.repeat(200);
    const r = row({ id: 'long', name: longName });
    const overlongTerm = 'a'.repeat(121);
    // Both sides truncate the TERM to 120 'a's, which the 200-'a' name contains.
    expect(clientQMatches(r, overlongTerm)).toBe(true);
    expect(serverQMatches(r, overlongTerm)).toBe(true);
    // A term whose meaningful tail is beyond 120 chars is truncated away.
    const tailTerm = `${'a'.repeat(120)}ZZZ`;
    expect(clientQMatches(r, tailTerm)).toBe(serverQMatches(r, tailTerm));
  });

  it('DOCUMENTED DIVERGENCE (superset only): the client folds diacritics, the server does not — the client must never MISS a server match', () => {
    const accented = row({ id: 'acc', name: 'Café Crème Sticker', sku: 'STK-CAFE' });
    // Client folds both sides: plain-ASCII search finds the accented row…
    expect(clientQMatches(accented, 'cafe creme')).toBe(true);
    // …where the server's ILIKE would not (the accepted divergence).
    expect(serverQMatches(accented, 'cafe creme')).toBe(false);
    // Superset property over the whole matrix: server-true ⇒ client-true.
    for (const term of ['café', 'CRÈME', 'Café Crème', 'stk-cafe']) {
      if (serverQMatches(accented, term)) {
        expect(clientQMatches(accented, term), term).toBe(true);
      }
    }
  });

  it('multi-word terms are ONE contiguous substring, not word-AND (both sides)', () => {
    const r = row({ id: 'mw', name: 'Blue Lanyard' });
    expect(clientQMatches(r, 'blue lanyard')).toBe(true);
    expect(serverQMatches(r, 'blue lanyard')).toBe(true);
    // Reversed word order does NOT match on either side.
    expect(clientQMatches(r, 'lanyard blue')).toBe(false);
    expect(serverQMatches(r, 'lanyard blue')).toBe(false);
  });
});
