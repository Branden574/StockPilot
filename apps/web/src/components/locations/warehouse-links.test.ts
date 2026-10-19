import { describe, expect, it } from 'vitest';

import { newOrderFromWarehouseHref, warehouseMailtoUrl, warehouseTelUrl } from './warehouse-links';

/**
 * The warehouse page used to build `tel:${contact_phone}` from the stored
 * text, so '555-1234 or 555-9999' dialled 55512345559999 and '*67 555 0100'
 * sent a service code to the dialler (P5.8 verify sweep, handed to P4.A4).
 * One plain number links; anything else stays plain text.
 */
describe('warehouseTelUrl', () => {
  it('a plain phone number becomes a tel: link of its digits and leading +', () => {
    expect(warehouseTelUrl('(555) 010-0100')).toBe('tel:5550100100');
    expect(warehouseTelUrl('+1 (555) 010-0100')).toBe('tel:+15550100100');
    expect(warehouseTelUrl('555.010.0100')).toBe('tel:5550100100');
    expect(warehouseTelUrl('  555-010-0100  ')).toBe('tel:5550100100');
    expect(warehouseTelUrl('555-0100')).toBe('tel:5550100');
    expect(warehouseTelUrl('1-800-555-0100')).toBe('tel:18005550100');
    expect(warehouseTelUrl('+44 20 7946 0958')).toBe('tel:+442079460958');
    expect(warehouseTelUrl('+44 (0)20 7946 0958')).toBe('tel:+442079460958');
    expect(warehouseTelUrl('+7 495 123-45-67')).toBe('tel:+74951234567');
    expect(warehouseTelUrl('555 010 0100')).toBe('tel:5550100100');
  });

  it('text that is not one plain phone number is not a link', () => {
    for (const phone of [
      '555-0100 ext 12',
      '555-0100 ext. 12',
      '555-0100 x12',
      '555-0100#12',
      '*67 555 0100',
      '555-1234 or 555-9999',
      '555-1234 555-9999',
      '555-0100;phone-context=example.com',
      '1-800-FLOWERS',
      '*#06#',
      '555,,1234',
      '555-0100?x=1',
      '555-0100 123',
      '+1 555-0100',
      '+1234567890123456',
      '011 44 20 7946 0958',
      '５５５-０１００',
      '',
      '   ',
      'front desk',
      '+',
    ]) {
      expect(warehouseTelUrl(phone), JSON.stringify(phone)).toBeNull();
    }
    expect(warehouseTelUrl(null)).toBeNull();
    expect(warehouseTelUrl(undefined)).toBeNull();
  });
});

describe('warehouseMailtoUrl', () => {
  it('one plain address becomes a mailto: link', () => {
    expect(warehouseMailtoUrl('dock@example.com')).toBe('mailto:dock@example.com');
    expect(warehouseMailtoUrl(' jo.lee+north@lab.example.org ')).toBe(
      'mailto:jo.lee%2Bnorth@lab.example.org',
    );
  });

  it('an address that would do more than address one person is not a link', () => {
    for (const email of [
      'a@b.com?bcc=x@y.z',
      'a@b.com,c@d.com',
      'a@b.com;c@d.com',
      'a b@c.com',
      'a@b',
      'a@@b.com',
      '"a"@b.com',
      'a@b.com#x',
      'jöe@b.com',
      '',
      'x'.repeat(65) + '@b.com',
    ]) {
      expect(warehouseMailtoUrl(email), JSON.stringify(email)).toBeNull();
    }
    expect(warehouseMailtoUrl(null)).toBeNull();
  });
});

describe('newOrderFromWarehouseHref (CONFLICTS D2)', () => {
  it('sends the warehouseId the storefront reads, not the ignored ?warehouse=', () => {
    const id = '5eed0000-0003-4000-8000-000000000001';
    const href = newOrderFromWarehouseHref(id);
    expect(href).toBe(`/dashboard/orders/new?warehouseId=${id}`);
    const url = new URL(href, 'http://x');
    expect(url.searchParams.get('warehouseId')).toBe(id);
    expect(url.searchParams.has('warehouse')).toBe(false);
  });
});
