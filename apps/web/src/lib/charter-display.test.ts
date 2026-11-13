import { describe, expect, it } from 'vitest';

import {
  charterCellFor,
  charterCellLookup,
  formatCharterCell,
  GENERIC_CHARTER_LABEL,
} from './charter-display';

/**
 * charter_id IS NULL means "generic stock — any charter the warehouse services
 * can use". The inventory list has rendered that as the word "Generic" since it
 * shipped (inventory-table.tsx:2154-2176). Every export printed a blank, which
 * the PDF then rendered as an em dash — the owner's screenshot item 9. One
 * definition, shared, so the two surfaces cannot drift again.
 */
describe('formatCharterCell', () => {
  const names = new Map([['ch-1', 'Visalia']]);

  it('resolves a real charter to its name', () => {
    expect(formatCharterCell('ch-1', names)).toBe('Visalia');
  });

  it('says Generic for a null charter — never a blank, never an em dash', () => {
    expect(formatCharterCell(null, names)).toBe('Generic');
    expect(formatCharterCell(undefined, names)).toBe('Generic');
    expect(GENERIC_CHARTER_LABEL).toBe('Generic');
  });

  it('stays fail-closed blank when the id is set but the lookup could not load', () => {
    // buildInventoryExportRows wraps every lookup in safe(), which returns []
    // on a throw. A charter id with no entry means the lookup degraded — that
    // is NOT generic stock, and calling it "Generic" would be a lie.
    expect(formatCharterCell('ch-missing', names)).toBe('');
    expect(formatCharterCell('ch-1', new Map())).toBe('');
  });
});

// B97: Items, Books and Rentals > Items called a record tagged to an archived
// charter "Generic" (the lists knew active charters only, and the cell read
// "a charter it does not know" as "no charter").
describe('charterCellFor / charterCellLookup', () => {
  const lookup = charterCellLookup(
    [{ id: 'a', name: 'North Campus', code: 'NC' }],
    [
      { id: 'b', name: 'Old Campus', code: 'OC', status: 'archived' },
      { id: 'c', name: 'Summer Site', code: null, status: 'inactive' },
      // Listed both ways: the active entry wins.
      { id: 'a', name: 'North Campus', code: 'NC', status: 'archived' },
    ],
  );

  it('no charter is Generic', () => {
    expect(charterCellFor(null, lookup)).toEqual({ kind: 'generic' });
    expect(charterCellFor(undefined, undefined)).toEqual({ kind: 'generic' });
  });

  it('an active charter: its code, its name as the title', () => {
    expect(charterCellFor('a', lookup)).toEqual({
      kind: 'charter',
      text: 'NC',
      title: 'North Campus',
    });
  });

  it('an archived or inactive charter: marked so, by code or else name', () => {
    expect(charterCellFor('b', lookup)).toEqual({
      kind: 'charter',
      text: 'OC (archived)',
      title: 'Old Campus (archived)',
    });
    expect(charterCellFor('c', lookup)).toEqual({
      kind: 'charter',
      text: 'Summer Site (inactive)',
      title: 'Summer Site (inactive)',
    });
  });

  it('a charter the lookup does not know is unknown, never Generic', () => {
    expect(charterCellFor('zzz', lookup)).toEqual({ kind: 'unknown' });
    expect(charterCellFor('zzz', undefined)).toEqual({ kind: 'unknown' });
  });
});
