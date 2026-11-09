import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { render } from '@testing-library/react';
import Link from 'next/link';
import type * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BooksGlassColumnsMenu } from '@/components/books/books-glass-columns';
import {
  ItemGlassAside,
  ItemGlassSummary,
  type ItemGlassFacts,
} from '@/components/inventory/item-glass-summary';
import { ItemMoreActions } from '@/components/inventory/item-more-actions';
import { OrderFulfilmentBadge } from '@/components/orders/order-fulfilment-badge';
import { OrderPhoneCards } from '@/components/orders/order-phone-cards';
import { OrderRequesterNoteAside } from '@/components/orders/order-requester-note-aside';
import { DetailSection } from '@/components/patterns/detail-section';
import { ReportsHubGlass, type HubReport } from '@/components/reports/reports-hub-glass';
import * as TOURS from '@/lib/onboarding/tours';
import type { TourDefinition } from '@/lib/onboarding/types';
import type { OrderRequestSummary } from '@/server/services/order-requests';

/**
 * WHICH TOUR STEPS MATCH AN APPEARANCE TWIN (page-tour.tsx findTarget skips
 * the twin the page is not showing: [data-glass-only] in Classic,
 * [data-classic-only] in glass). A step whose selector never matches a twin
 * finds exactly main's element in every appearance; the ones that do are
 * proved per appearance in page-tour.target.test.tsx.
 *
 * 1. From the source: every file that carries a twin attribute, and every
 *    route (page plus its layouts) that renders both a twin carrier and a
 *    <PageTour>, through the import graph. Those carriers are the ones a
 *    running tour can meet.
 * 2. Each of those carriers' twins is rendered (the component itself, or its
 *    markup as the source writes it where it sits inline in a page), and
 *    every step of every tour is run against them.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => vi.unstubAllEnvs());

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const FILES = new Map(
  walk(SRC).map((f) => [relative(SRC, f), withoutComments(readFileSync(f, 'utf8'))] as const),
);

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = join(dirname(from), spec);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    const full = join(SRC, candidate);
    if (FILES.has(candidate) && existsSync(full) && statSync(full).isFile()) return candidate;
  }
  return null;
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function closure(start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of FILES.get(file)!.matchAll(IMPORT)) {
      const target = resolveImport(file, m[1]!);
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return seen;
}

/** A route's page and every layout above it. */
function routeFiles(page: string): string[] {
  const out = [page];
  let dir = dirname(page);
  while (dir.startsWith('app')) {
    const layout = join(dir, 'layout.tsx');
    if (FILES.has(layout)) out.push(layout);
    dir = dirname(dir);
  }
  return out;
}

const CARRIERS = [...FILES]
  .filter(([file, text]) => file.endsWith('.tsx') && /data-(glass|classic)-only=/.test(text))
  .map(([file]) => file)
  .sort();

const TOUR_MOUNTS = new Set([...FILES].filter(([, t]) => /<PageTour\b/.test(t)).map(([f]) => f));

/** The twin carriers rendered on a page that also runs a tour. */
function touredCarriers(): string[] {
  const out = new Set<string>();
  for (const page of [...FILES.keys()].filter((f) => /^app\/.*\/page\.tsx$/.test(f))) {
    const all = new Set(routeFiles(page).flatMap((f) => [...closure(f)]));
    if (![...all].some((f) => TOUR_MOUNTS.has(f))) continue;
    for (const c of CARRIERS) if (all.has(c)) out.add(c);
  }
  return [...out].sort();
}

describe('the twin carriers a tour can meet', () => {
  it('finds the source, the carriers and the tour mounts', () => {
    expect(FILES.size).toBeGreaterThan(500);
    expect(CARRIERS.length).toBeGreaterThan(5);
    expect(TOUR_MOUNTS.size).toBeGreaterThan(10);
  });

  it('are exactly the ones rendered below', () => {
    expect(touredCarriers()).toEqual([
      'app/(dashboard)/dashboard/orders/[id]/page.tsx',
      'app/(dashboard)/dashboard/reports/page.tsx',
      'components/books/books-glass-columns.tsx',
      'components/dashboard/sidebar.tsx',
      'components/dashboard/topbar.tsx',
      'components/dashboard/user-menu.tsx',
      'components/inventory/inventory-table.tsx',
      'components/inventory/item-detail.tsx',
      'components/inventory/item-glass-summary.tsx',
      'components/inventory/item-more-actions.tsx',
      'components/orders/order-fulfilment-badge.tsx',
      'components/orders/order-phone-cards.tsx',
      'components/orders/order-requester-note-aside.tsx',
      'components/orders/orders-export-menu.tsx',
      'components/reports/reports-hub-glass.tsx',
    ]);
  });
});

/** The inline twins, as their source writes them. */
function sourceHas(file: string, pattern: RegExp) {
  expect(FILES.get(file)).toMatch(pattern);
}

const ROW = {
  id: 'o1',
  orderNumber: 231,
  status: 'pending_approval',
  warehouseId: 'w1',
  warehouseName: 'North DC',
  requesterUserId: 'u-9',
  requesterEmail: 'pat@example.test',
  requesterName: 'Pat Lee',
  requesterOrgLabel: 'Ridge Academy',
  requesterDeleted: false,
  source: 'internal',
  lineCount: 3,
  totalQuantity: 8,
  notes: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  approvedAt: null,
  deliveredAt: null,
  fulfillmentType: 'delivery',
  inTransitAt: null,
  assignedPickerId: 'p1',
  assignedPickerName: 'Luis Ortega',
  assignedDeliveryUserId: 'd1',
  assignedDeliveryUserName: 'Sam Reyes',
  replacementForReturnId: null,
  exchange: null,
} as unknown as OrderRequestSummary;

const REPORTS: HubReport[] = [
  { slug: 'book-order-totals', name: 'Book order totals', desc: 'Totals' },
  { slug: 'inventory-valuation', name: 'Inventory valuation', desc: 'Value' },
];

/** A book with every glass-only part the item page's summary and side column draw. */
const BOOK_FACTS: ItemGlassFacts = {
  isBook: true,
  unit: 'each',
  onHand: 6,
  reserved: 2,
  reorderPoint: 10,
  reorderQuantity: 24,
  retailPrice: 35,
  unitCost: 22,
  value: 132,
  status: 'active',
  awaitingFirstReceipt: true,
  staged: 1,
  photoSrc: null,
  book: {
    isbn: '9780000000000',
    author: 'A. Writer',
    grade: '9',
    crate: { label: 'Crate', hex: null, number: '12' },
    rack: 'R1',
  },
  ordering: { visible: true },
  inFamily: true,
  bookReportHref: '/dashboard/reports/book-order-totals',
};

function Twins() {
  return (
    <>
      <header>
        <div data-twin="components/dashboard/topbar.tsx">
          <div data-glass-only="" data-glass="tb-title">
            Books
          </div>
        </div>
        <div data-twin="components/dashboard/user-menu.tsx">
          <div data-glass-only="" data-glass="um-whats-new">
            <div role="menuitem" aria-label="What’s new">
              What’s new
            </div>
          </div>
        </div>
      </header>
      <aside id="dashboard-sidebar">
        <div data-twin="components/dashboard/sidebar.tsx">
          <Link href="/dashboard/orders/new" data-glass-only="" data-glass="sb-cta">
            <span data-glass="nav-label">Place an order</span>
          </Link>
        </div>
      </aside>
      <main>
        <div data-twin="components/reports/reports-hub-glass.tsx">
          <ReportsHubGlass reports={REPORTS} />
        </div>
        <div data-twin="app/(dashboard)/dashboard/reports/page.tsx">
          <ul role="list">
            {REPORTS.map((r) => (
              <li key={r.slug} data-classic-only="">
                <a href={`/dashboard/reports/${r.slug}`}>{r.name}</a>
              </li>
            ))}
          </ul>
        </div>
        <div data-twin="components/books/books-glass-columns.tsx">
          <BooksGlassColumnsMenu shown={new Set()} onChange={() => {}} />
        </div>
        <div data-twin="components/inventory/inventory-table.tsx">
          <table>
            <tbody>
              <tr>
                <td>
                  <span>Gr 9</span>
                  <span data-glass-only="" data-glass="book-grade-bare">
                    9
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div data-twin="components/inventory/item-detail.tsx">
          <div data-testid="item-figures" data-classic-only="">
            <span>On hand</span> <span>6</span>
          </div>
          <DetailSection title="Reorder" flush data-classic-only="">
            <p>Reorder at 10 each</p>
          </DetailSection>
        </div>
        <div data-twin="components/inventory/item-more-actions.tsx">
          <ItemMoreActions />
        </div>
        <div data-twin="components/inventory/item-glass-summary.tsx">
          <ItemGlassSummary facts={BOOK_FACTS} />
          <ItemGlassAside facts={BOOK_FACTS} />
        </div>
        <div data-twin="components/orders/order-phone-cards.tsx">
          <OrderPhoneCards rows={[ROW]} />
        </div>
        <div data-twin="components/orders/orders-export-menu.tsx">
          <div role="menuitem">
            <svg data-glass-only="" />
            Export CSV<span data-glass-only=""> · All active</span>
            <span data-glass-only="" data-glass="export-item-sub">
              Every column
            </span>
          </div>
        </div>
        <div data-twin="components/orders/order-fulfilment-badge.tsx">
          <OrderFulfilmentBadge fulfillmentType="delivery" />
        </div>
        <div data-twin="app/(dashboard)/dashboard/orders/[id]/page.tsx">
          <DetailSection
            title="Requester note"
            data-testid="order-requester-note"
            data-glass-role="order-requester-note"
            data-classic-only=""
          >
            <p>Leave at the front desk.</p>
          </DetailSection>
        </div>
        <aside data-glass="order-detail-aside">
          <div data-twin="components/orders/order-requester-note-aside.tsx">
            <OrderRequesterNoteAside notes="Leave at the front desk." />
          </div>
        </aside>
      </main>
    </>
  );
}

const TOUR_LIST = Object.values(TOURS).filter(
  (t): t is TourDefinition =>
    typeof t === 'object' && t !== null && 'steps' in t && Array.isArray(t.steps),
);

describe('the tour steps that match a twin', () => {
  it('the inline twins are written as the source writes them', () => {
    sourceHas('components/dashboard/sidebar.tsx', /PLACE_ORDER_HREF = '\/dashboard\/orders\/new'/u);
    sourceHas(
      'components/dashboard/sidebar.tsx',
      /href=\{PLACE_ORDER_HREF\}[\s\S]{0,400}?data-glass-only=""\s+data-glass="sb-cta"/u,
    );
    sourceHas(
      'app/(dashboard)/dashboard/reports/page.tsx',
      /<li key=\{r\.slug\} className="min-w-0" data-classic-only="">\s*<IntentLink\s+href=\{`\/dashboard\/reports\/\$\{r\.slug\}`\}/u,
    );
    sourceHas(
      'app/(dashboard)/dashboard/orders/[id]/page.tsx',
      /<DetailSection\s+title="Requester note"[\s\S]{0,200}?data-classic-only=""/u,
    );
    sourceHas('components/dashboard/topbar.tsx', /<div data-glass-only="" data-glass="tb-title">/u);
    sourceHas(
      'components/dashboard/user-menu.tsx',
      /<div data-glass-only="" data-glass="um-whats-new">\s*<DropdownMenuItem aria-label=\{label\}/u,
    );
    sourceHas(
      'components/inventory/inventory-table.tsx',
      /<span data-glass-only="" data-glass="book-grade-bare">/u,
    );
    sourceHas(
      'components/inventory/item-detail.tsx',
      /<StatStrip variant="detail" data-testid="item-figures" data-classic-only="">/u,
    );
    sourceHas(
      'components/inventory/item-detail.tsx',
      /<DetailSection title="Reorder" flush data-classic-only="">/u,
    );
    // The export menu's glass-only parts are an icon and two spans of words.
    const menu = FILES.get('components/orders/orders-export-menu.tsx')!;
    expect(menu.match(/<(\w+)[^>]*data-glass-only=""/gu)?.map((m) => m.split(/\s/u)[0])).toEqual([
      '<List',
      '<span',
      '<span',
      '<Printer',
      '<span',
      '<span',
    ]);
  });

  it('are REPORTS_TOUR "Open any report" and ORDERS_TOUR "Place an order", and no other', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(<Twins />);
    // Every rendered carrier holds a twin.
    for (const holder of document.querySelectorAll('[data-twin]')) {
      expect(
        holder.querySelector('[data-glass-only],[data-classic-only]'),
        holder.getAttribute('data-twin')!,
      ).not.toBeNull();
    }
    expect(
      new Set(
        [...document.querySelectorAll('[data-twin]')].map((h) => h.getAttribute('data-twin')),
      ),
    ).toEqual(new Set(touredCarriers()));
    const hits: string[] = [];
    for (const tour of TOUR_LIST) {
      for (const step of tour.steps) {
        if (!step.target) continue;
        for (const el of document.querySelectorAll(step.target)) {
          const twin = el.closest('[data-glass-only],[data-classic-only]');
          if (!twin) continue;
          const kind = twin.hasAttribute('data-glass-only') ? 'glass-only' : 'classic-only';
          const where = el.closest('[data-twin]')!.getAttribute('data-twin');
          hits.push(`${tour.id} | ${step.target} | ${kind} | ${where}`);
        }
      }
    }
    // Every step runs against every twin here, whatever its route. The item
    // page's glass side column (an <aside> with the Book Order Totals link)
    // matches the order page's and the Reports hub's selectors, but neither
    // tour runs on a route that renders it (the next test), so no running
    // tour meets it.
    expect([...new Set(hits)].sort()).toEqual([
      'order-detail | main aside | glass-only | components/inventory/item-glass-summary.tsx',
      'orders-page | a[href="/dashboard/orders/new"] | glass-only | components/dashboard/sidebar.tsx',
      'reports | main a[href^="/dashboard/reports/"] | classic-only | app/(dashboard)/dashboard/reports/page.tsx',
      'reports | main a[href^="/dashboard/reports/"] | glass-only | components/inventory/item-glass-summary.tsx',
      'reports | main a[href^="/dashboard/reports/"] | glass-only | components/reports/reports-hub-glass.tsx',
    ]);
    expect(TOUR_LIST.length).toBe(14);
  });

  it('the order page and Reports hub tours never run on a route that renders the item page glass side column', () => {
    const carrier = 'components/inventory/item-glass-summary.tsx';
    const mounts = /<PageTour tour=\{(?:ORDER_DETAIL_TOUR|REPORTS_TOUR)\}/u;
    const pages = [...FILES.keys()].filter((f) => /^app\/.*\/page\.tsx$/.test(f));
    const withCarrier = pages.filter((page) =>
      routeFiles(page).some((f) => closure(f).has(carrier)),
    );
    expect(withCarrier.length).toBeGreaterThan(0);
    expect(pages.filter((page) => mounts.test(FILES.get(page)!)).length).toBe(2);
    for (const page of withCarrier) {
      const all = new Set(routeFiles(page).flatMap((f) => [...closure(f)]));
      expect(
        [...all].filter((f) => mounts.test(FILES.get(f)!)),
        page,
      ).toEqual([]);
    }
  });
});
