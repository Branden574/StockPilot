import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePdfText } from './pdf';

const FIXTURE = readFileSync(
  join(__dirname, 'fixtures/po-cvsii-001824.txt'),
  'utf8',
);

describe('parsePdfText (Staples format)', () => {
  const po = parsePdfText(FIXTURE);

  it('extracts the PO number', () => {
    expect(po.poNumber).toBe('PO-CVSII-001824');
  });

  it('extracts the vendor', () => {
    expect(po.vendorName).toMatch(/Staples Advantage/i);
  });

  it('extracts the total amount', () => {
    expect(po.totalAmount).toBeCloseTo(299.53, 2);
  });

  it('extracts a Fresno shipping address', () => {
    expect(po.shippingAddress).toMatch(/Fresno/i);
  });

  it('produces at least 13 line rows', () => {
    expect(po.lines.length).toBeGreaterThanOrEqual(13);
  });

  it('classifies the TAX line as tax (not inventory)', () => {
    const tax = po.lines.find((l) => /^tax$/i.test(l.description ?? ''));
    expect(tax).toBeDefined();
    expect(tax!.lineType).toBe('tax');
    expect(tax!.unitCost).toBeCloseTo(23.11, 2);
  });

  it('captures vendor item number 867474 as Duracell AA batteries', () => {
    const aa = po.lines.find((l) => l.vendorItemNumber === '867474');
    expect(aa).toBeDefined();
    expect(aa!.lineType).toBe('inventory');
    expect(aa!.uomOriginal).toBe('PK');
    expect(aa!.qtyOrderedOriginal).toBe(1);
    expect(aa!.description).toMatch(/Duracell.*AA/i);
  });

  it('captures Logitech mouse with vendor item 2406183 (UOM EA, qty 1)', () => {
    const mouse = po.lines.find((l) => l.vendorItemNumber === '2406183');
    expect(mouse).toBeDefined();
    expect(mouse!.uomOriginal).toBe('EA');
    expect(mouse!.qtyOrderedOriginal).toBe(1);
  });

  it('captures Avery Note Cards qty 2 BX', () => {
    const avery = po.lines.find((l) => l.vendorItemNumber === '466029');
    expect(avery).toBeDefined();
    expect(avery!.qtyOrderedOriginal).toBe(2);
    expect(avery!.uomOriginal).toBe('BX');
  });

  it('every inventory line has a non-null line_total >= 0', () => {
    const inventory = po.lines.filter((l) => l.lineType === 'inventory');
    expect(inventory.length).toBeGreaterThan(0);
    for (const l of inventory) {
      expect(l.lineTotal).not.toBeNull();
      expect(l.lineTotal!).toBeGreaterThanOrEqual(0);
    }
  });
});
