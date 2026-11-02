import { describe, expect, it } from 'vitest';

import {
  PO_BILL_TO_LABEL,
  PO_BILL_TO_UNREADABLE,
  billToCharterDisplay,
  billToCharterName,
  billToCharterReadFrom,
  type BillToCharter,
} from './bill-to-charter';

/**
 * A purchase order's bill-to charter (purchase_orders.charter_id) in words,
 * for its web page, the phone's PO screen and its PDF (B56): the PDF's own
 * name and code line, the shared status mark, and words for a read that
 * failed. Never the charter that owns an item's stock.
 */
const C = '0b000000-0000-4000-8000-0000000000c1';
const D = '0b000000-0000-4000-8000-0000000000d1';

function charter(over: Partial<BillToCharter> = {}): BillToCharter {
  return { id: C, name: 'North Campus', code: 'NC', status: 'active', ...over };
}

describe('the words', () => {
  it('labels the line as the PDF titles its block', () => {
    expect(PO_BILL_TO_LABEL).toBe('Bill to');
    expect(PO_BILL_TO_UNREADABLE).toBe('Could not be loaded');
  });
});

describe('billToCharterName', () => {
  it('prints the PDF line: the name, then the code in brackets', () => {
    // The PDF test's fixture (lib/pdf/po.test.tsx).
    expect(billToCharterName({ name: 'North Region Campus', code: 'NRC' })).toBe(
      'North Region Campus (NRC)',
    );
  });

  it('prints the name alone when there is no code', () => {
    expect(billToCharterName({ name: 'North Campus', code: null })).toBe('North Campus');
    expect(billToCharterName({ name: 'North Campus', code: '' })).toBe('North Campus');
    expect(billToCharterName({ name: 'North Campus', code: '  ' })).toBe('North Campus');
  });

  it('trims the name and the code', () => {
    expect(billToCharterName({ name: ' North Campus ', code: ' NC ' })).toBe('North Campus (NC)');
    expect(billToCharterName({ name: ' North Campus ', code: ' ' })).toBe('North Campus');
  });

  it('names a charter with a blank name as core does elsewhere', () => {
    expect(billToCharterName({ name: '', code: null })).toBe('Unnamed charter');
    expect(billToCharterName({ name: '  ', code: 'NC' })).toBe('Unnamed charter (NC)');
  });
});

describe('billToCharterReadFrom', () => {
  it('is found for the row of the charter asked for, at any status', () => {
    for (const status of ['active', 'inactive', 'archived']) {
      const row = charter({ status });
      expect(billToCharterReadFrom(row, C)).toEqual({ state: 'found', charter: row });
    }
  });

  it('is unreadable for no row, or a row for another charter', () => {
    expect(billToCharterReadFrom(null, C)).toEqual({ state: 'unreadable', charterId: C });
    expect(billToCharterReadFrom(undefined, C)).toEqual({ state: 'unreadable', charterId: C });
    expect(billToCharterReadFrom(charter({ id: D }), C)).toEqual({
      state: 'unreadable',
      charterId: C,
    });
  });
});

describe('billToCharterDisplay', () => {
  it('shows nothing for a purchase order billed to no charter', () => {
    expect(billToCharterDisplay({ state: 'none' })).toBeNull();
  });

  it('shows the name line, with the status mark apart', () => {
    expect(billToCharterDisplay({ state: 'found', charter: charter() })).toEqual({
      text: 'North Campus (NC)',
      note: '',
      unreadable: false,
    });
    expect(
      billToCharterDisplay({ state: 'found', charter: charter({ status: 'archived' }) }),
    ).toEqual({ text: 'North Campus (NC)', note: ' (archived)', unreadable: false });
    expect(
      billToCharterDisplay({
        state: 'found',
        charter: charter({ name: 'South Campus', code: null, status: 'inactive' }),
      }),
    ).toEqual({ text: 'South Campus', note: ' (inactive)', unreadable: false });
  });

  it('says a read that failed, never an empty name', () => {
    expect(billToCharterDisplay({ state: 'unreadable', charterId: C })).toEqual({
      text: 'Could not be loaded',
      note: '',
      unreadable: true,
    });
  });
});
