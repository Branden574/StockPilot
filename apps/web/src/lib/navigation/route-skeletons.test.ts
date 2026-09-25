import { describe, expect, it } from 'vitest';

import { lateSkeletonFor, routeSkeletonFor } from './route-skeletons';

/**
 * The skeleton shape each dashboard route shows outside a loading.tsx of its
 * own (the late skeleton, and the (dashboard) group fallback on a hard load).
 * Each row keeps the shape the route had before Overview, Items, Books and
 * Orders lost their loading.tsx; late-skeleton-routes.guard.test.ts checks the
 * map against the files on disk.
 */
describe('routeSkeletonFor (C1)', () => {
  it.each([
    ['/dashboard', 'overview'],
    ['/dashboard/inventory', 'table-10'],
    ['/dashboard/inventory/abc', 'table-10'],
    ['/dashboard/inventory/abc/edit', 'table-10'],
    ['/dashboard/inventory/staging', 'table-10'],
    ['/dashboard/books', 'table-10'],
    ['/dashboard/books/abc', 'table-10'],
    // orders/loading.tsx was rows=8, not the list pages' 10.
    ['/dashboard/orders', 'table-8'],
    ['/dashboard/orders/abc', 'table-8'],
    ['/dashboard/orders/abc/pick', 'table-8'],
    // The storefront keeps its own loading.tsx.
    ['/dashboard/orders/new', null],
    ['/dashboard/orders/new/checkout', null],
    ['/dashboard/purchase-orders', 'table-6'],
    ['/dashboard/purchase-orders/imports', 'table-6'],
    ['/dashboard/admin', 'page'],
    ['/dashboard/admin/warehouses', 'page'],
    ['/dashboard/reports/stock', 'page'],
    ['/dashboard/help', 'page'],
    ['/dashboard/audit', 'page'],
    ['/dashboard/customers', 'page'],
    ['/dashboard/exceptions', 'page'],
    // The occurrence page has its own loading.tsx: no late skeleton.
    ['/dashboard/exceptions/abc', null],
    ['/dashboard/exceptionsx', null],
    ['/dashboard/support', 'page'],
    ['/dashboard/suppliers', null],
    ['/dashboard/movements', null],
    ['/dashboard/settings/team', null],
    // Prefix boundaries: a different segment that merely starts the same way.
    ['/dashboardx', null],
    ['/dashboard/inventoryx', null],
    ['/dashboard/orders-archive', null],
    ['/login', null],
  ])('%s -> %s', (pathname, kind) => {
    expect(routeSkeletonFor(pathname)).toBe(kind);
  });
});

/**
 * The late skeleton also looks at the page being left: inside admin,
 * purchase-orders and reports the section layout is already mounted, so the
 * section's own loading.tsx shows, as it did before the late skeleton existed.
 */
describe('lateSkeletonFor (C2)', () => {
  it.each([
    ['/dashboard/reports/dead-stock', '/dashboard/reports', null],
    ['/dashboard/reports', '/dashboard/reports/dead-stock', null],
    ['/dashboard/admin/warehouses', '/dashboard/admin/users', null],
    ['/dashboard/purchase-orders/abc', '/dashboard/purchase-orders', null],
    ['/dashboard/purchase-orders/imports', '/dashboard/purchase-orders/abc', null],
    // Entering the section from outside: the layout must render first.
    ['/dashboard/reports/dead-stock', '/dashboard/inventory', 'page'],
    ['/dashboard/purchase-orders/abc', '/dashboard/reports', 'table-6'],
    ['/dashboard/admin/users', '/dashboard', 'page'],
    ['/dashboard/reports', '/dashboard/reportsx', 'page'],
    ['/dashboard/reports', '', 'page'],
    // Everywhere else the page being left does not matter.
    ['/dashboard/inventory/abc', '/dashboard/inventory', 'table-10'],
    ['/dashboard/orders/abc', '/dashboard/orders', 'table-8'],
    ['/dashboard/customers', '/dashboard/customers', 'page'],
    ['/dashboard/suppliers', '/dashboard/inventory', null],
  ])('%s from %s -> %s', (target, from, kind) => {
    expect(lateSkeletonFor(target, from)).toBe(kind);
  });
});
