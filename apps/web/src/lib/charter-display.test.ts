import { describe, expect, it } from 'vitest';

import { formatCharterCell, GENERIC_CHARTER_LABEL } from './charter-display';

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
