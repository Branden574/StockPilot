import { describe, expect, it } from 'vitest';
import { resolveSurface, SECTION_ORDER } from './resolve';
import { DEFAULT_MODULE_IDS, MODULE_REGISTRY, type ModuleId } from './registry';

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
  it('read-permission grants surface the five auditor-readable modules for a viewer', () => {
    // Default viewer: none of the five read perms → none of the surfaces.
    const without = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['items:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    for (const href of [
      '/dashboard/cycle-counts', '/dashboard/schedule', '/dashboard/bundles',
      '/dashboard/rentals', '/dashboard/audit',
    ]) expect(without).not.toContain(href);

    // Grant the read perms (Auditor preset shape) → every surface appears,
    // WITHOUT any write permission and without being an admin.
    const withReads = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set([
        'items:read', 'cycle_counts:read', 'schedule:read', 'bundles:read',
        'rentals:read', 'activity_logs:read',
      ]),
    }).flatMap((s) => s.items.map((i) => i.href));
    for (const href of [
      '/dashboard/cycle-counts', '/dashboard/schedule', '/dashboard/bundles',
      '/dashboard/rentals', '/dashboard/audit',
    ]) expect(withReads).toContain(href);
  });
  it('returns placement gates on returns:read (module on, web only)', () => {
    const withReturns = new Set<ModuleId>([...ALL, 'returns']);
    const granted = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: withReturns,
      permissions: new Set(['returns:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(granted).toContain('/dashboard/returns');
    const ungranted = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: withReturns,
      permissions: new Set(['items:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(ungranted).not.toContain('/dashboard/returns');
  });
  it('mobile audit drawer item is permission-gated, not admin-gated', () => {
    const granted = resolveSurface('mobile_drawer', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['activity_logs:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(granted).toContain('/admin/audit');
    // …but the rest of the admin section stays requiresAdmin-only.
    expect(granted).not.toContain('/admin');
    expect(granted).not.toContain('/admin/users');
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
      // Exceptions (sortOrder 7) lands between Staging (5) and Books (20).
      // This list is FROZEN on purpose — it is the guard that a nav change is
      // deliberate rather than an accident of registry ordering. Updated here
      // knowingly: the Exception Center is a new inventory-oversight surface.
      '/dashboard/exceptions',
      '/dashboard/books', '/dashboard/categories', '/dashboard/tags',
      '/dashboard/movements', '/dashboard/rentals', '/dashboard/bundles', '/dashboard/orders',
      '/dashboard/cycle-counts', '/dashboard/procedures', '/dashboard/purchase-orders',
      '/dashboard/purchase-orders/recurring',
      '/dashboard/purchase-orders/imports', '/dashboard/locations', '/dashboard/suppliers',
      '/dashboard/reports',
      '/dashboard/ai', '/dashboard/insights', '/dashboard/schedule', '/dashboard/notifications',
      '/dashboard/team', '/dashboard/support', '/dashboard/settings',
      '/dashboard/admin', '/dashboard/admin/charters', '/dashboard/admin/warehouses',
      '/dashboard/admin/bins', '/dashboard/admin/users', '/dashboard/admin/vendor-mappings',
      // Audit log moved to the grantable non-admin route (auditor visibility);
      // same position in the Admin section.
      '/dashboard/admin/uom-conversions', '/dashboard/admin/reconciliation', '/dashboard/audit',
    ]);
  });

  it('mobile_drawer (admin, full set) matches the legacy DRAWER_SECTIONS order', () => {
    const hrefs = resolveSurface('mobile_drawer', { role: 'admin', enabledModules: ALL })
      .flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toEqual([
      '/',
      // Staging gained a native twin (put-away is done on foot; it used to be
      // desk-only). Deliberate addition to the frozen sequence, placed exactly
      // where the web sidebar already puts it: sortOrder 5, immediately after
      // Items. Everything else is byte-for-byte the legacy order.
      '/inventory', '/staging',
      '/books', '/categories', '/tags', '/movements', '/rentals', '/bundles',
      '/orders', '/cycle-counts', '/procedures', '/receive', '/purchase-orders', '/recurring-pos', '/po-imports',
      '/locations', '/suppliers', '/reports',
      '/ai', '/schedule', '/notifications', '/team', '/settings',
      '/scan',
      '/admin', '/admin/charters', '/admin/warehouses', '/admin/bins', '/admin/users',
      '/admin/vendor-mappings', '/admin/uom-conversions', '/admin/reconciliation', '/admin/audit',
    ]);
  });
});

describe('requiresAnyOf (read-or-write nav fallback)', () => {
  it('shows a surface when the caller holds ONLY the paired write permission', () => {
    // An org can grant a role e.g. schedule:manage via the matrix without the
    // schedule:read default (viewer). The nav must not hide the surface from
    // someone who can WRITE to it.
    const sections = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['schedule:manage']),
    });
    const hrefs = sections.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain('/dashboard/schedule');
  });

  it('shows a surface for a read-only grantee and hides it with neither perm', () => {
    const withRead = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set(['cycle_counts:read']),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(withRead).toContain('/dashboard/cycle-counts');

    const withNeither = resolveSurface('web_sidebar', {
      role: 'viewer',
      enabledModules: ALL,
      permissions: new Set([]),
    }).flatMap((s) => s.items.map((i) => i.href));
    expect(withNeither).not.toContain('/dashboard/cycle-counts');
    expect(withNeither).not.toContain('/dashboard/bundles');
    expect(withNeither).not.toContain('/dashboard/rentals');
    expect(withNeither).not.toContain('/dashboard/returns');
    expect(withNeither).not.toContain('/dashboard/schedule');
  });
});
