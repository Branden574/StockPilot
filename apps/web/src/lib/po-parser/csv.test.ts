import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsvText } from './csv';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/po-cvsii-001824.csv'),
  'utf8',
);

describe('parseCsvText', () => {
  const po = parseCsvText(FIXTURE);

  it('reads header from first 2 rows', () => {
    expect(po.poNumber).toBe('PO-CVSII-001824');
    expect(po.vendorName).toMatch(/Staples Advantage/);
    expect(po.totalAmount).toBeCloseTo(299.53, 2);
  });

  it('reads 4 line rows', () => {
    expect(po.lines.length).toBe(4);
  });

  it('classifies TAX line as tax', () => {
    const tax = po.lines.find((l) => l.description === 'TAX');
    expect(tax?.lineType).toBe('tax');
  });

  it('preserves vendor item number and qty for AA batteries', () => {
    const aa = po.lines.find((l) => l.vendorItemNumber === '867474');
    expect(aa?.qtyOrderedOriginal).toBe(1);
    expect(aa?.uomOriginal).toBe('PK');
  });
});
