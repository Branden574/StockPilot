import { describe, expect, it } from 'vitest';

import { supplierMailtoUrl } from './supplier-mailto';

describe('supplierMailtoUrl', () => {
  it('links one plain address', () => {
    expect(supplierMailtoUrl('orders@acme.com')).toBe('mailto:orders@acme.com');
    expect(supplierMailtoUrl('  orders@acme.com ')).toBe('mailto:orders@acme.com');
    expect(supplierMailtoUrl('first.last+po@mail.acme.co.uk')).toBe(
      'mailto:first.last%2Bpo@mail.acme.co.uk',
    );
  });

  it('gives no link for an address that would do more than address one person', () => {
    expect(supplierMailtoUrl('a@b.com?bcc=x@y.z')).toBeNull();
    expect(supplierMailtoUrl('a@b.com,x@y.z')).toBeNull();
    expect(supplierMailtoUrl('a@b.com;x@y.z')).toBeNull();
    expect(supplierMailtoUrl('a@b.com?subject=hi')).toBeNull();
    expect(supplierMailtoUrl('a b@c.com')).toBeNull();
  });

  it('gives no link for look-alike, non-ASCII or malformed text', () => {
    // Cyrillic "а" (U+0430) in place of the Latin "a".
    expect(supplierMailtoUrl('orders@аcme.com')).toBeNull();
    expect(supplierMailtoUrl('оrders@acme.com')).toBeNull();
    expect(supplierMailtoUrl('orders@acme')).toBeNull();
    expect(supplierMailtoUrl('ordersacme.com')).toBeNull();
    expect(supplierMailtoUrl('a@@b.com')).toBeNull();
    expect(supplierMailtoUrl('.a@b.com')).toBeNull();
    expect(supplierMailtoUrl(`${'a'.repeat(65)}@b.com`)).toBeNull();
    expect(supplierMailtoUrl(null)).toBeNull();
    expect(supplierMailtoUrl('')).toBeNull();
  });
});
