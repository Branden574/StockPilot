import { describe, expect, it } from 'vitest';
import { matchByVendorNumber, type MappingRow } from './vendor-item-mappings-match';

const rows: MappingRow[] = [
  {
    id: 'm1',
    vendor_id: 'v1',
    item_id: 'i-aa',
    vendor_item_number: '867474',
    vendor_product_number: '867474',
    auxiliary_number: '867474',
  },
  {
    id: 'm2',
    vendor_id: 'v1',
    item_id: 'i-mouse',
    vendor_item_number: '2406183',
    vendor_product_number: null,
    auxiliary_number: null,
  },
];

describe('matchByVendorNumber', () => {
  it('returns mapped item_id on exact vendor_item_number', () => {
    expect(
      matchByVendorNumber(rows, {
        vendorItemNumber: '867474',
        vendorProductNumber: null,
        auxiliaryNumber: null,
      }),
    ).toEqual({ itemId: 'i-aa', source: 'vendor_item_number' });
  });

  it('falls back to vendor_product_number', () => {
    expect(
      matchByVendorNumber(rows, {
        vendorItemNumber: null,
        vendorProductNumber: '867474',
        auxiliaryNumber: null,
      }),
    ).toEqual({ itemId: 'i-aa', source: 'vendor_product_number' });
  });

  it('returns null when no fields match', () => {
    expect(
      matchByVendorNumber(rows, {
        vendorItemNumber: '999',
        vendorProductNumber: '999',
        auxiliaryNumber: '999',
      }),
    ).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(
      matchByVendorNumber(
        [{ ...rows[0]!, vendor_item_number: 'abc-1' }],
        { vendorItemNumber: 'ABC-1', vendorProductNumber: null, auxiliaryNumber: null },
      ),
    ).toEqual({ itemId: 'i-aa', source: 'vendor_item_number' });
  });
});
