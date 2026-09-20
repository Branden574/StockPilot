import { describe, expect, it } from 'vitest';

import { toRouteTemplate } from './route-template';

const UUID = '3f2c1a9e-7b4d-4c1e-9a2f-0d5e6f7a8b9c';

describe('toRouteTemplate', () => {
  it('keeps static routes as they are', () => {
    expect(toRouteTemplate('/')).toBe('/');
    expect(toRouteTemplate('/dashboard')).toBe('/dashboard');
    expect(toRouteTemplate('/dashboard/purchase-orders')).toBe('/dashboard/purchase-orders');
    expect(toRouteTemplate('/dashboard/settings/modules/')).toBe('/dashboard/settings/modules');
  });

  it('replaces record ids', () => {
    expect(toRouteTemplate(`/dashboard/inventory/${UUID}`)).toBe('/dashboard/inventory/[id]');
    expect(toRouteTemplate(`/dashboard/inventory/${UUID}/edit`)).toBe(
      '/dashboard/inventory/[id]/edit',
    );
    expect(toRouteTemplate('/dashboard/orders/1042/pick')).toBe('/dashboard/orders/[id]/pick');
  });

  it('drops the query and the fragment, which is where search terms and filters live', () => {
    const out = toRouteTemplate(`/dashboard/inventory?q=acme+widget&sku=AB-1#row-${UUID}`);
    expect(out).toBe('/dashboard/inventory');
    expect(out).not.toMatch(/acme|AB-1|row/);
  });

  it('accepts a full URL and keeps nothing of the host or the credentials in it', () => {
    expect(
      toRouteTemplate(`https://stockpilotusa.com/dashboard/inventory/${UUID}?return=%2Fdashboard`),
    ).toBe('/dashboard/inventory/[id]');
  });

  it('never lets a share credential through, whatever it looks like', () => {
    const token = 'a'.repeat(64);
    expect(toRouteTemplate(`/r/${token}`)).toBe('/r/[token]');
    expect(toRouteTemplate(`/m/${token}/photo`)).toBe('/m/[token]/photo');
    expect(toRouteTemplate(`/orders/sign/${token}`)).toBe('/orders/sign/[token]');
    expect(toRouteTemplate(`/returns/request/${token}`)).toBe('/returns/request/[token]');
    // Even a credential slot holding a folder-shaped word is a placeholder.
    expect(toRouteTemplate('/invite/abcdefghijklmnop')).toBe('/invite/[token]');
  });

  it('is safe by default: anything that is not folder-shaped becomes a placeholder', () => {
    for (const segment of [
      'SKU-99',
      'Blue%20Widget',
      'jane@example.com',
      'ACME',
      'widget.v2',
      'a'.repeat(41),
      '9780143127741',
    ]) {
      const out = toRouteTemplate(`/dashboard/inventory/${segment}`);
      expect(out).toBe('/dashboard/inventory/[id]');
    }
  });

  it('never reads a URL quoted inside the query or the fragment as the URL being templated', () => {
    // Each of these returned a path taken from the QUERY before the fix.
    expect(toRouteTemplate('/dashboard/inventory?return=https://x/secretword')).toBe(
      '/dashboard/inventory',
    );
    expect(toRouteTemplate('/dashboard?next=https://host/leakword/another')).toBe('/dashboard');
    expect(toRouteTemplate('https://stockpilotusa.com#frag/secretword')).toBe('/');
    expect(toRouteTemplate('?q=secret://host/path/leak')).toBe('/[unknown]');
    for (const input of [
      '/dashboard/inventory?return=https://x/secretword',
      'https://stockpilotusa.com#frag/secretword',
    ]) {
      expect(toRouteTemplate(input)).not.toMatch(/secretword|leak/);
    }
  });

  it('drops the authority of any absolute or protocol-relative URL, userinfo included', () => {
    expect(toRouteTemplate('//cdn.example.com/dashboard/orders')).toBe('/dashboard/orders');
    expect(toRouteTemplate('HTTPS://StockPilotUSA.com/dashboard/orders')).toBe('/dashboard/orders');
    expect(toRouteTemplate('https://user:pass@stockpilotusa.com:8443/dashboard')).toBe(
      '/dashboard',
    );
    expect(toRouteTemplate('https://user:pass@stockpilotusa.com')).toBe('/');
  });

  it('never throws on rubbish', () => {
    expect(toRouteTemplate('')).toBe('/[unknown]');
    expect(toRouteTemplate(null)).toBe('/[unknown]');
    expect(toRouteTemplate(undefined)).toBe('/[unknown]');
    expect(toRouteTemplate('dashboard/inventory')).toBe('/[unknown]');
    expect(toRouteTemplate('https://stockpilotusa.com')).toBe('/');
  });
});
