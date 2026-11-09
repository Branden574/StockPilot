import { render } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReportsHubGlass, type HubReport } from '@/components/reports/reports-hub-glass';
import { ORDERS_TOUR, REPORTS_TOUR } from '@/lib/onboarding/tours';

import { findTarget } from './page-tour';

/**
 * A tour step's target (page-tour.tsx findTarget), per appearance.
 *
 * Under the `off` rollout, and in Classic under opt-in or default, the target
 * is main's: the first match inside the page (`main`), else the first match
 * anywhere, drawn or not. The one exception is a hidden appearance twin: in
 * Classic a [data-glass-only] element (and everything inside it) is skipped,
 * because Classic under default does carry glass-only elements that come
 * before the Classic ones (the Reports hub's glass links before its Classic
 * tiles). Under `off` no glass-only element is rendered, so nothing is
 * skipped and the result is main's exactly.
 *
 * In Liquid Glass a [data-classic-only] element is skipped, then the first
 * DRAWN match wins (the glass lane's rule), else the first match. A hidden
 * element has no client rects; this DOM has no layout, so a test that needs
 * one gives each element its rects.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports',
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

function drawn(el: Element, shown: boolean) {
  vi.spyOn(el, 'getClientRects').mockReturnValue(
    (shown ? [new DOMRect(0, 0, 10, 10)] : []) as unknown as DOMRectList,
  );
}

const byId = (id: string) => document.getElementById(id)!;

function inGlass() {
  document.documentElement.setAttribute('data-appearance', 'liquid-glass');
}

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-appearance');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** The fixtures main's rule decides, run in the two Classic settings. */
const CLASSIC_SETTINGS = [
  ['the off rollout', 'off'],
  ['Classic under the default rollout', 'default'],
] as const;

describe.each(CLASSIC_SETTINGS)("page tour target in %s: main's rule", (_name, rollout) => {
  it('keeps a hidden first match inside main (main spotlights the first match, drawn or not)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
    document.body.innerHTML =
      '<main><a id="hidden" href="/dashboard/reports/a">A</a><a id="shown" href="/dashboard/reports/a">A</a></main>';
    drawn(byId('hidden'), false);
    drawn(byId('shown'), true);
    expect(findTarget('main a[href^="/dashboard/reports/"]')?.id).toBe('hidden');
  });

  it('keeps an undrawn match inside main before a drawn one outside it', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
    document.body.innerHTML =
      '<nav><a id="outside" href="/dashboard/settings/roles">x</a></nav><main><a id="inside" href="/dashboard/settings/roles">x</a></main>';
    drawn(byId('outside'), true);
    drawn(byId('inside'), false);
    expect(findTarget('a[href="/dashboard/settings/roles"]')?.id).toBe('inside');
  });

  it('keeps a hidden first row of a table inside main', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
    document.body.innerHTML =
      '<main><table id="narrow"><tbody><tr id="r1"><td>a</td></tr></tbody></table><table id="wide"><tbody><tr id="r2"><td>a</td></tr></tbody></table></main>';
    drawn(byId('narrow'), false);
    drawn(byId('wide'), true);
    drawn(byId('r1'), false);
    drawn(byId('r2'), true);
    expect(findTarget('main table')?.id).toBe('narrow');
    expect(findTarget('table tbody tr')?.id).toBe('r1');
  });

  it('keeps the first match inside main before one outside it, both drawn', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
    document.body.innerHTML =
      '<nav><button id="shell" aria-label="Hide sidebar"></button></nav><main><button id="page" aria-label="Hide x"></button></main>';
    drawn(byId('shell'), true);
    drawn(byId('page'), true);
    expect(findTarget('button[aria-label^="Hide "]')?.id).toBe('page');
  });

  it('takes the first match anywhere when none is inside main', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
    document.body.innerHTML =
      '<aside id="dashboard-sidebar"><nav><a id="first" href="/dashboard/inventory">x</a><a id="second" href="/dashboard/inventory">x</a></nav></aside><main></main>';
    drawn(byId('first'), false);
    drawn(byId('second'), true);
    expect(findTarget('#dashboard-sidebar nav a[href="/dashboard/inventory"]')?.id).toBe('first');
  });

  it('never skips a [data-classic-only] element: it is Classic’s own', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
    document.body.innerHTML =
      '<main><ul><li data-classic-only=""><a id="tile" href="/dashboard/reports/a">A</a></li></ul><a id="later" href="/dashboard/reports/b">B</a></main>';
    expect(findTarget('main a[href^="/dashboard/reports/"]')?.id).toBe('tile');
  });

  it('finds nothing when nothing matches', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
    document.body.innerHTML = '<main></main>';
    expect(findTarget('a.none')).toBeNull();
  });
});

describe('page tour target in Classic under the default rollout: hidden glass twins are skipped', () => {
  it('skips a [data-glass-only] link before the Classic tiles, with or without layout', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    document.body.innerHTML =
      '<main><section data-glass-only=""><a id="glass" href="/dashboard/reports/a">A</a></section><ul><li data-classic-only=""><a id="tile" href="/dashboard/reports/a">A</a></li></ul></main>';
    expect(findTarget('main a[href^="/dashboard/reports/"]')?.id).toBe('tile');
    drawn(byId('glass'), false);
    drawn(byId('tile'), true);
    expect(findTarget('main a[href^="/dashboard/reports/"]')?.id).toBe('tile');
  });

  it('skips a glass-only element itself, not only what is inside one', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    document.body.innerHTML =
      '<aside><a id="cta" data-glass-only="" href="/dashboard/orders/new">Place an order</a></aside><main><a id="page" href="/dashboard/orders/new">+ Place order</a></main>';
    expect(findTarget('a[href="/dashboard/orders/new"]')?.id).toBe('page');
    document.getElementById('page')!.remove();
    expect(findTarget('a[href="/dashboard/orders/new"]')).toBeNull();
  });

  it("keeps main's hidden first match when it is not a twin", () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    document.body.innerHTML =
      '<main><section data-glass-only=""><a id="glass" href="/dashboard/reports/a">A</a></section><a id="hidden" href="/dashboard/reports/a">A</a><a id="shown" href="/dashboard/reports/a">A</a></main>';
    drawn(byId('glass'), false);
    drawn(byId('hidden'), false);
    drawn(byId('shown'), true);
    expect(findTarget('main a[href^="/dashboard/reports/"]')?.id).toBe('hidden');
  });
});

describe('page tour target in Liquid Glass: the drawn match (the glass lane’s rule)', () => {
  it('skips a hidden first match in the page for the drawn one after it', () => {
    inGlass();
    document.body.innerHTML =
      '<main><a id="hidden" href="/dashboard/reports/a">A</a><a id="shown" href="/dashboard/reports/a">A</a></main>';
    drawn(byId('hidden'), false);
    drawn(byId('shown'), true);
    expect(findTarget('main a[href^="/dashboard/reports/"]')?.id).toBe('shown');
  });

  it('keeps the first match inside main before one outside it, both drawn', () => {
    inGlass();
    document.body.innerHTML =
      '<nav><button id="shell" aria-label="Hide sidebar"></button></nav><main><button id="page" aria-label="Hide x"></button></main>';
    drawn(byId('shell'), true);
    drawn(byId('page'), true);
    expect(findTarget('button[aria-label^="Hide "]')?.id).toBe('page');
  });

  it('falls back to the first match, as before, when none is drawn', () => {
    inGlass();
    document.body.innerHTML =
      '<nav><a id="outside" href="/x">x</a></nav><main><a id="inside" href="/x">x</a></main>';
    drawn(byId('outside'), false);
    drawn(byId('inside'), false);
    expect(findTarget('a[href="/x"]')?.id).toBe('inside');
  });

  it('skips a [data-classic-only] twin even where nothing is drawn (no layout)', () => {
    inGlass();
    document.body.innerHTML =
      '<main><ul><li data-classic-only=""><a id="tile" href="/dashboard/reports/a">A</a></li></ul><section data-glass-only=""><a id="glass" href="/dashboard/reports/a">A</a></section></main>';
    expect(findTarget('main a[href^="/dashboard/reports/"]')?.id).toBe('glass');
  });

  it('finds nothing when nothing matches', () => {
    inGlass();
    document.body.innerHTML = '<main></main>';
    expect(findTarget('a.none')).toBeNull();
  });
});

/**
 * The two tour steps whose selector matches an appearance twin
 * (page-tour.twins.test.tsx finds them), on the twins' real markup.
 */
const REPORTS_TILES = REPORTS_TOUR.steps[1]!.target!;
const PLACE_ORDER = ORDERS_TOUR.steps.find((s) =>
  s.target?.includes('/dashboard/orders/new'),
)!.target!;

const REPORTS: HubReport[] = [
  { slug: 'book-order-totals', name: 'Book order totals', desc: 'Totals' },
  { slug: 'inventory-valuation', name: 'Inventory valuation', desc: 'Value' },
];

/** The Reports page's order: the glass hub, then Classic's tiles (each data-classic-only). */
function ReportsPage() {
  return (
    <main>
      <h1>Reports</h1>
      <ReportsHubGlass reports={REPORTS} />
      <ul role="list">
        {REPORTS.map((r) => (
          <li key={r.slug} data-classic-only="">
            <a id={`tile-${r.slug}`} href={`/dashboard/reports/${r.slug}`}>
              {r.name}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

describe('REPORTS_TOUR "Open any report" per appearance', () => {
  it('off: the first Classic tile (the hub is not rendered)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    render(<ReportsPage />);
    expect(document.querySelector('[data-glass-only]')).toBeNull();
    expect(findTarget(REPORTS_TILES)?.id).toBe('tile-book-order-totals');
  });

  it('Classic under default: the first Classic tile, not the hidden hub link before it', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    render(<ReportsPage />);
    expect(
      document.querySelector('[data-glass-only] a[href^="/dashboard/reports/"]'),
    ).not.toBeNull();
    expect(findTarget(REPORTS_TILES)?.id).toBe('tile-book-order-totals');
  });

  it('Liquid Glass: the hub’s first link, never a hidden Classic tile', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    inGlass();
    render(<ReportsPage />);
    const target = findTarget(REPORTS_TILES);
    expect(target?.closest('[data-glass-only]')).not.toBeNull();
    expect(target?.getAttribute('href')).toBe('/dashboard/reports/book-order-totals');
  });
});

describe('ORDERS_TOUR "Place an order" per appearance', () => {
  /** The sidebar's glass-only Place an order (sidebar.tsx) comes before main. */
  const page = (cta: boolean) =>
    `<aside id="dashboard-sidebar">${
      cta
        ? '<a id="cta" href="/dashboard/orders/new" data-glass-only="" data-glass="sb-cta">Place an order</a>'
        : ''
    }</aside><main><h1>Order requests</h1><a id="page" href="/dashboard/orders/new">+ Place order</a></main>`;

  it('off: the page’s own + Place order (no sidebar shortcut is rendered)', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'off');
    document.body.innerHTML = page(false);
    expect(findTarget(PLACE_ORDER)?.id).toBe('page');
  });

  it('Classic under default: the page’s own + Place order', () => {
    vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
    document.body.innerHTML = page(true);
    expect(findTarget(PLACE_ORDER)?.id).toBe('page');
  });

  it('Liquid Glass: the page’s own + Place order (inside main), drawn or not', () => {
    inGlass();
    document.body.innerHTML = page(true);
    expect(findTarget(PLACE_ORDER)?.id).toBe('page');
    drawn(byId('cta'), true);
    drawn(byId('page'), true);
    expect(findTarget(PLACE_ORDER)?.id).toBe('page');
  });
});
