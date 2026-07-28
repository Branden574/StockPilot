import { describe, expect, it } from 'vitest';

import {
  applyItemCsvHeaderDecisions,
  itemCsvAmbiguousHeaders,
  itemCsvHeaderDecisionsOutstanding,
  itemCsvTemplateHeader,
  meaningToItemCsvColumn,
  resolveItemCsvHeaders,
  reviewItemCsvRows,
} from './items-csv-import';

/**
 * LIVE-VERIFIED FAIL (Demo Co, 2026-07-28, report lines 10 + 11).
 *
 * The review table printed the file's own first eight headers, an extra column
 * headed `Number` was echoed once and then silently dropped, and Import was
 * enabled immediately. The requirements forbid all three: "show candidate
 * mappings + confidence, require confirmation, block import until required
 * mappings resolved", and a review row must say WHAT will happen, not nothing.
 */
describe('resolveItemCsvHeaders — detected columns map to known fields', () => {
  it('maps an exact template column to itself', () => {
    const m = resolveItemCsvHeaders(['name', 'sku', 'quantity_on_hand'], {
      sportsEnabled: false,
    });
    expect(m.map((x) => [x.header, x.status, x.field])).toEqual([
      ['name', 'mapped', 'name'],
      ['sku', 'mapped', 'sku'],
      ['quantity_on_hand', 'mapped', 'quantity_on_hand'],
    ]);
  });

  it('maps a spreadsheet-shaped header through an alias, case and spacing aside', () => {
    const m = resolveItemCsvHeaders(['Item Name', '  QTY  ', 'UPC', 'Unit_Cost'], {
      sportsEnabled: false,
    });
    expect(m.map((x) => x.field)).toEqual(['name', 'quantity_on_hand', 'barcode', 'unit_cost']);
    expect(m.every((x) => x.status === 'mapped')).toBe(true);
  });

  it('maps the sports aliases only when the module is on', () => {
    expect(resolveItemCsvHeaders(['Jersey #'], { sportsEnabled: true })[0]!.field).toBe(
      'jersey_number',
    );
    expect(resolveItemCsvHeaders(['Uniform No.'], { sportsEnabled: true })[0]!.field).toBe(
      'jersey_number',
    );
    // Two headers claiming the SAME field is not two mappings: the first wins
    // and the second is reported, so a value can never be applied twice.
    const both = resolveItemCsvHeaders(['Jersey #', 'Uniform No.'], { sportsEnabled: true });
    expect(both.map((x) => x.status)).toEqual(['mapped', 'duplicate']);

    const off = resolveItemCsvHeaders(['Jersey #', 'Uniform No.'], { sportsEnabled: false });
    expect(off.every((x) => x.status === 'unmapped')).toBe(true);
    expect(off.every((x) => x.field === null)).toBe(true);
  });

  it('REGRESSION (line 10b): "Number" is ambiguous, never silently guessed', () => {
    const [m] = resolveItemCsvHeaders(['Number'], { sportsEnabled: true });
    expect(m!.status).toBe('ambiguous');
    expect(m!.field).toBeNull();
    // Exactly the meanings the spec names for a bare number column, plus the
    // explicit opt-out. Reuses Task 14's vocabulary — no parallel label set.
    expect(m!.candidates).toEqual([
      'jersey_number',
      'quantity',
      'serial',
      'style_number',
      'ignore',
    ]);
  });

  it('drops the sports meaning from the candidates of a non-sports org', () => {
    const [m] = resolveItemCsvHeaders(['No.'], { sportsEnabled: false });
    expect(m!.status).toBe('ambiguous');
    expect(m!.candidates).toEqual(['quantity', 'serial', 'style_number', 'ignore']);
  });

  it('never offers the PO-only line_number meaning on an items CSV', () => {
    const [m] = resolveItemCsvHeaders(['#'], { sportsEnabled: true });
    expect(m!.candidates).not.toContain('line_number');
    expect(m!.candidates).not.toContain('confirm');
  });

  it('reports an unknown column as unmapped rather than inventing a field', () => {
    const [m] = resolveItemCsvHeaders(['Warehouse Manager Initials'], { sportsEnabled: true });
    expect(m!.status).toBe('unmapped');
    expect(m!.field).toBeNull();
    expect(m!.candidates).toEqual([]);
  });

  it('an alias never displaces a real column that is already in the file', () => {
    // Both 'Qty' and 'quantity_on_hand' present: the canonical column wins and
    // the alias is reported as a duplicate rather than mapped twice.
    const m = resolveItemCsvHeaders(['quantity_on_hand', 'Qty'], { sportsEnabled: false });
    expect(m[0]!.field).toBe('quantity_on_hand');
    expect(m[1]!.status).toBe('duplicate');
    expect(m[1]!.field).toBeNull();
  });
});

describe('itemCsvHeaderDecisionsOutstanding — import blocks until mappings resolve', () => {
  const mappings = resolveItemCsvHeaders(['name', 'Number'], { sportsEnabled: true });

  it('lists the ambiguous header while it is unanswered', () => {
    expect(itemCsvHeaderDecisionsOutstanding(mappings, {})).toEqual(['Number']);
  });

  it('clears once the header is answered', () => {
    expect(itemCsvHeaderDecisionsOutstanding(mappings, { Number: 'jersey_number' })).toEqual([]);
    expect(itemCsvHeaderDecisionsOutstanding(mappings, { Number: 'ignore' })).toEqual([]);
  });

  it('does not accept an answer that is not one of that header’s candidates', () => {
    // 'line_number' is never offered on an items CSV, so it cannot resolve one.
    expect(itemCsvHeaderDecisionsOutstanding(mappings, { Number: 'line_number' })).toEqual([
      'Number',
    ]);
  });

  it('finds nothing to answer when no header is ambiguous', () => {
    const clean = resolveItemCsvHeaders(['name', 'sku'], { sportsEnabled: false });
    expect(itemCsvAmbiguousHeaders(clean)).toEqual([]);
    expect(itemCsvHeaderDecisionsOutstanding(clean, {})).toEqual([]);
  });
});

describe('applyItemCsvHeaderDecisions — the confirmed meaning is what lands', () => {
  const mappings = resolveItemCsvHeaders(['Item Name', 'Number'], { sportsEnabled: true });

  it('routes the ambiguous column to the field the human named', () => {
    const out = applyItemCsvHeaderDecisions({ 'Item Name': 'Falcons Jersey', Number: '07' }, mappings, {
      Number: 'jersey_number',
    });
    expect(out.name).toBe('Falcons Jersey');
    expect(out.jersey_number).toBe('07');
  });

  it('sends the same column to quantity when that is what it meant', () => {
    const out = applyItemCsvHeaderDecisions({ Number: '12' }, mappings, { Number: 'quantity' });
    expect(out.quantity_on_hand).toBe('12');
    expect(out.jersey_number).toBeUndefined();
  });

  it('"ignore" drops the value instead of applying it anywhere', () => {
    const out = applyItemCsvHeaderDecisions({ Number: '07' }, mappings, { Number: 'ignore' });
    expect(out.jersey_number).toBeUndefined();
    expect(out.quantity_on_hand).toBeUndefined();
    expect(out.serial).toBeUndefined();
  });

  it('an unanswered ambiguous column applies nowhere — never a silent guess', () => {
    const out = applyItemCsvHeaderDecisions({ Number: '07' }, mappings, {});
    expect(out.jersey_number).toBeUndefined();
    expect(out.quantity_on_hand).toBeUndefined();
  });

  it('preserves the source value under its own header (nothing is destroyed)', () => {
    const out = applyItemCsvHeaderDecisions({ Number: '07' }, mappings, { Number: 'ignore' });
    expect(out.Number).toBe('07');
  });

  it('an alias never overwrites a canonical column that already carries a value', () => {
    const m = resolveItemCsvHeaders(['quantity_on_hand', 'Qty'], { sportsEnabled: false });
    const out = applyItemCsvHeaderDecisions({ quantity_on_hand: '5', Qty: '99' }, m, {});
    expect(out.quantity_on_hand).toBe('5');
  });

  it('maps every meaning to a real template column, or to nothing at all', () => {
    expect(meaningToItemCsvColumn('jersey_number')).toBe('jersey_number');
    expect(meaningToItemCsvColumn('quantity')).toBe('quantity_on_hand');
    expect(meaningToItemCsvColumn('serial')).toBe('serial');
    expect(meaningToItemCsvColumn('style_number')).toBe('style_number');
    expect(meaningToItemCsvColumn('line_number')).toBeNull();
    expect(meaningToItemCsvColumn('ignore')).toBeNull();
    expect(meaningToItemCsvColumn('confirm')).toBeNull();
  });
});

/**
 * LIVE-VERIFIED FAIL (line 10a): the review table had "no Group column, no
 * Variant column, and no per-row Result column". Requirements: per-row Result
 * from the Task 14 LineResult vocabulary, "Not just Valid/Invalid".
 */
describe('reviewItemCsvRows — a row says what will happen', () => {
  const sportsMappings = resolveItemCsvHeaders(
    ['name', 'sku', 'brand', 'model', 'size', 'size_system', 'jersey_number', 'quantity_on_hand'],
    { sportsEnabled: true },
  );

  it('numbers the source row as the spreadsheet does (header is line 1)', () => {
    const rows = reviewItemCsvRows([{ name: 'A' }, { name: 'B' }], sportsMappings, {
      sportsEnabled: true,
    });
    expect(rows.map((r) => r.sourceRow)).toEqual([2, 3]);
  });

  it('a complete plain row is ready', () => {
    const [r] = reviewItemCsvRows([{ name: 'Wireless Mouse', quantity_on_hand: '5' }], sportsMappings, {
      sportsEnabled: false,
    });
    expect(r!.result).toBe('ready');
    expect(r!.group).toBeNull();
    expect(r!.variant).toBeNull();
  });

  it('a nameless row is missing a required attribute, not merely invalid', () => {
    const [r] = reviewItemCsvRows([{ sku: 'X' }], sportsMappings, { sportsEnabled: false });
    expect(r!.result).toBe('missing_required_attribute');
    expect(r!.message).toMatch(/name/i);
  });

  it('a sports row carrying variant attributes reads as a new variant', () => {
    const [r] = reviewItemCsvRows(
      [{ name: 'Pegasus 41', brand: 'Nike', model: 'Pegasus 41', size: '10', size_system: 'US_MENS' }],
      sportsMappings,
      { sportsEnabled: true },
    );
    expect(r!.result).toBe('add_new_variant');
    expect(r!.group).toBe('Nike Pegasus 41');
    expect(r!.variant).toBe('Size 10');
  });

  it('names the group from the team when that is the identity on offer', () => {
    const [r] = reviewItemCsvRows(
      [{ name: 'Home Jersey', team: 'Falcons', season: '2026', jersey_number: '07', size: 'M' }],
      sportsMappings,
      { sportsEnabled: true },
    );
    expect(r!.group).toBe('Falcons 2026');
    expect(r!.variant).toBe('#07 · Size M');
  });

  it('shows no group or variant to an org without the sports module', () => {
    const [r] = reviewItemCsvRows(
      [{ name: 'Pegasus 41', brand: 'Nike', size: '10' }],
      sportsMappings,
      { sportsEnabled: false },
    );
    expect(r!.group).toBeNull();
    expect(r!.variant).toBeNull();
    expect(r!.result).toBe('ready');
  });

  it('a malformed jersey number is flagged in review, not imported wrong', () => {
    const [r] = reviewItemCsvRows([{ name: 'J', jersey_number: '12A' }], sportsMappings, {
      sportsEnabled: true,
    });
    expect(r!.result).toBe('missing_required_attribute');
    expect(r!.message).toMatch(/jersey/i);
  });

  it('a SKU repeated inside one file is a possible duplicate, on both rows', () => {
    const rows = reviewItemCsvRows(
      [
        { name: 'A', sku: 'SP-1' },
        { name: 'B', sku: 'sp-1' },
      ],
      sportsMappings,
      { sportsEnabled: false },
    );
    expect(rows.map((r) => r.result)).toEqual(['possible_duplicate', 'possible_duplicate']);
  });

  it('an unresolved ambiguous header blocks EVERY row, whatever else is right', () => {
    const m = resolveItemCsvHeaders(['name', 'Number'], { sportsEnabled: true });
    const rows = reviewItemCsvRows([{ name: 'A', Number: '7' }], m, {
      sportsEnabled: true,
      headerDecisions: {},
    });
    expect(rows[0]!.result).toBe('mapping_review_required');
  });

  it('…and stops blocking once the header is answered', () => {
    const m = resolveItemCsvHeaders(['name', 'Number'], { sportsEnabled: true });
    const rows = reviewItemCsvRows([{ name: 'A', Number: '7' }], m, {
      sportsEnabled: true,
      headerDecisions: { Number: 'jersey_number' },
    });
    expect(rows[0]!.result).toBe('add_new_variant');
    expect(rows[0]!.variant).toBe('#7');
  });
});

describe('itemCsvTemplateHeader — the template is the mapping vocabulary', () => {
  it('offers no sports column when the module is off', () => {
    const h = itemCsvTemplateHeader(false);
    expect(h).not.toContain('jersey_number');
    expect(h.slice(-2)).toEqual(['warehouse_name', 'location_name']);
  });

  it('splices the sports block in front of the location lookups when it is on', () => {
    const h = itemCsvTemplateHeader(true);
    expect(h).toContain('jersey_number');
    expect(h.slice(-2)).toEqual(['warehouse_name', 'location_name']);
    // Every template column resolves to itself, or the review table would show
    // the app's own template as unmapped.
    const m = resolveItemCsvHeaders(h, { sportsEnabled: true });
    expect(m.filter((x) => x.status !== 'mapped')).toEqual([]);
  });
});
