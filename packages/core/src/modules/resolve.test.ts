import { describe, expect, it } from 'vitest';
import { resolveSurface, SECTION_ORDER } from './resolve';
import { DEFAULT_MODULE_IDS, MODULE_REGISTRY } from './registry';

const ALL = new Set(DEFAULT_MODULE_IDS);

describe('SECTION_ORDER', () => {
  it('covers every section used by any registry placement', () => {
    const used = new Set<string>();
    for (const def of Object.values(MODULE_REGISTRY))
      for (const p of def.placements) used.add(p.section);
    for (const s of used) expect(SECTION_ORDER).toContain(s);
  });
});

describe('resolveSurface', () => {
  it('admin sees the web sidebar including admin items', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/dashboard/inventory');
    expect(hrefs).toContain('/dashboard/admin');
  });
  it('staff does NOT see admin items', () => {
    const out = resolveSurface('web_sidebar', { role: 'staff', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs.some((h) => h.startsWith('/dashboard/admin'))).toBe(false);
  });
  it('effective permissions gate `requires` links (revoked purchase_orders:read hides the PO link)', () => {
    // A viewer normally has purchase_orders:read → sees the PO link…
    const withRead = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['items:read', 'purchase_orders:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(withRead).toContain('/dashboard/purchase-orders');

    // …revoke it via the effective set and the link disappears, even though the
    // static viewer role would include it.
    const withoutRead = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['items:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(withoutRead).not.toContain('/dashboard/purchase-orders');
  });
  it('disabling an optional module removes its items (core stays)', () => {
    const without = new Set([...ALL].filter((m) => m !== 'rentals'));
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: without });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain('/dashboard/rentals');
    expect(hrefs).toContain('/dashboard/inventory');
  });
  it('a core module renders even if absent from enabledModules', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: new Set() });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/dashboard');
  });
  it('drops empty sections and sorts by defaultSortOrder', () => {
    const out = resolveSurface('web_sidebar', { role: 'admin', enabledModules: ALL });
    expect(out.every((s) => s.items.length > 0)).toBe(true);
    for (const s of out) {
      const orders = s.items.map((i) => i.sortOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    }
  });
  it('mobile_drawer resolves too (parity)', () => {
    const out = resolveSurface('mobile_drawer', { role: 'admin', enabledModules: ALL });
    const hrefs = out.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/inventory');
    expect(hrefs).toContain('/scan');
  });
});

// Zero-visual-change guards: pin the EXACT ordered href sequence an admin
// with the full charter module set sees on each surface to what the original
// static nav (web BASE_NAV+ADMIN_NAV / mobile DRAWER_SECTIONS) produced. Any
// future sortOrder/section drift fails here instead of silently reordering nav.
describe('nav order is frozen to the original static nav', () => {
  it('web_sidebar (admin, full set) matches the legacy BASE_NAV+ADMIN_NAV order', () => {
    const hrefs = resolveSurface('web_sidebar', { role: 'admin', enabledModules: ALL })
      .flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toEqual([
      '/dashboard',
      '/dashboard/inventory', '/dashboard/inventory/staging',
      '/dashboard/books', '/dashboard/categories', '/dashboard/tags',
      '/dashboard/movements', '/dashboard/rentals', '/dashboard/bundles', '/dashboard/orders',
      '/dashboard/cycle-counts', '/dashboard/procedures', '/dashboard/purchase-orders',
      '/dashboard/purchase-orders/recurring',
      '/dashboard/purchase-orders/imports', '/dashboard/locations', '/dashboard/suppliers',
      '/dashboard/reports',
      '/dashboard/ai', '/dashboard/insights', '/dashboard/schedule', '/dashboard/notifications',
      '/dashboard/team', '/dashboard/settings',
      '/dashboard/admin', '/dashboard/admin/charters', '/dashboard/admin/warehouses',
      '/dashboard/admin/bins', '/dashboard/admin/users', '/dashboard/admin/vendor-mappings',
      '/dashboard/admin/uom-conversions', '/dashboard/admin/reconciliation', '/dashboard/admin/audit',
    ]);
  });

  it('mobile_drawer (admin, full set) matches the legacy DRAWER_SECTIONS order', () => {
    const hrefs = resolveSurface('mobile_drawer', { role: 'admin', enabledModules: ALL })
      .flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toEqual([
      '/',
      '/inventory', '/books', '/categories', '/tags', '/movements', '/rentals', '/bundles',
      '/orders', '/cycle-counts', '/procedures', '/receive', '/purchase-orders', '/recurring-pos', '/po-imports',
      '/locations', '/suppliers', '/reports',
      '/ai', '/schedule', '/notifications', '/team', '/settings',
      '/scan',
      '/admin', '/admin/charters', '/admin/warehouses', '/admin/bins', '/admin/users',
      '/admin/vendor-mappings', '/admin/uom-conversions', '/admin/reconciliation', '/admin/audit',
    ]);
  });
});
