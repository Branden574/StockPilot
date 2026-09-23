import { describe, expect, it } from 'vitest';

import { routeSkeletonFor } from './route-skeletons';

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
