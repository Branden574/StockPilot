// @vitest-environment node
// Rendered to a string, as the server renders it on a hard load: a `window`
// access anywhere in the fallback fails here instead of in production.
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { value: '/dashboard' } }));
vi.mock('next/navigation', () => ({ usePathname: () => pathnameRef.value }));

import { OverviewSkeleton } from '@/components/dashboard/overview-skeleton';
import { PageSkeleton, TablePageSkeleton } from '@/components/dashboard/skeletons';

import DashboardLoading from './loading';

function fallbackFor(pathname: string): string {
  pathnameRef.value = pathname;
  return renderToString(<DashboardLoading />);
}

/**
 * The (dashboard) group's loading.tsx on a hard load or refresh: the route's
 * own skeleton shape (Items, Books, Orders and Overview have no loading.tsx of
 * their own), not the generic page for every route.
 */
describe('(dashboard) loading.tsx', () => {
  it('runs without a DOM (the node docblock is in place)', () => {
    expect(typeof window).toBe('undefined');
  });

  it.each([
    ['/dashboard/inventory', <TablePageSkeleton key="t10" rows={10} />],
    ['/dashboard/inventory/abc', <TablePageSkeleton key="t10" rows={10} />],
    ['/dashboard/books', <TablePageSkeleton key="t10" rows={10} />],
    ['/dashboard/orders/abc', <TablePageSkeleton key="t8" rows={8} />],
    ['/dashboard', <OverviewSkeleton key="o" />],
    ['/dashboard/help', <PageSkeleton key="p" />],
    ['/dashboard/suppliers', <PageSkeleton key="p" />],
  ])('G1/G2 %s renders its own skeleton on the server', (pathname, expected) => {
    expect(fallbackFor(pathname)).toBe(renderToString(expected));
  });

  it('the table skeleton has the rows of the loading.tsx the route used to have', () => {
    const rows = (html: string) => html.split('grid-template-columns').length - 1;
    expect(rows(fallbackFor('/dashboard/inventory'))).toBe(10);
    expect(rows(fallbackFor('/dashboard/orders'))).toBe(8);
  });
});
