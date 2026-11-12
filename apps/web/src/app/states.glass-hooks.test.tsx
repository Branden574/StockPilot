import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Liquid Glass hooks of the states a route shows instead of its page
 * (stage 4, insights lane; styles/liquid-glass/states.css). The stylesheet
 * is global and reads only these hooks, so a skeleton, an error boundary or
 * the 404 page that lost one would silently fall back to the Classic layout
 * with glass colours. Pinned here:
 *   - every skeleton page box names the width the glass page takes (1480 px
 *     lists, records and reports; 768 px reading pages), or is listed as
 *     keeping its own box (a page no glass composition draws, or one another
 *     lane's frame owns);
 *   - every bar of every skeleton carries the skeleton hook (the shine), and
 *     every card a material hook;
 *   - the full-screen states have at most four parts (states.css places
 *     four rows) and the in-pane error card its four hooked parts.
 * The Classic DOM itself is pinned by states.classic-dom.test.tsx.
 */

const nav = vi.hoisted(() => ({ pathname: '/dashboard' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
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
vi.mock('@/lib/error-reporter-core', () => ({ reportError: vi.fn(async () => undefined) }));

import DashboardError from './(dashboard)/error';
import BookOrderTotalsError from './(dashboard)/dashboard/reports/book-order-totals/error';
import RootError from './error';
import NotFound from './not-found';

const LOADING = import.meta.glob<{ default: () => React.ReactElement }>('./**/loading.tsx', {
  eager: true,
});

const UUID = '0b6f3c1e-1d2a-4c55-9f1e-6a1f0e3b2c4d';

/** The width each route's glass page takes, and so its skeleton's box. */
const WIDTH: Record<string, 'wide' | 'reading' | 'own' | 'none'> = {
  // The operations lane's lists and records (pages/ops.css: 1480 px).
  './(dashboard)/dashboard/bundles/loading.tsx': 'wide',
  './(dashboard)/dashboard/categories/loading.tsx': 'wide',
  './(dashboard)/dashboard/cycle-counts/loading.tsx': 'wide',
  './(dashboard)/dashboard/exceptions/[id]/loading.tsx': 'wide',
  './(dashboard)/dashboard/locations/loading.tsx': 'wide',
  './(dashboard)/dashboard/locations/[id]/loading.tsx': 'wide',
  './(dashboard)/dashboard/maintenance/loading.tsx': 'wide',
  './(dashboard)/dashboard/movements/loading.tsx': 'wide',
  './(dashboard)/dashboard/planning/loading.tsx': 'wide',
  './(dashboard)/dashboard/procedures/loading.tsx': 'wide',
  './(dashboard)/dashboard/purchase-orders/loading.tsx': 'wide',
  './(dashboard)/dashboard/rentals/loading.tsx': 'wide',
  './(dashboard)/dashboard/returns/loading.tsx': 'wide',
  './(dashboard)/dashboard/returns/[id]/loading.tsx': 'wide',
  './(dashboard)/dashboard/schedule/loading.tsx': 'wide',
  './(dashboard)/dashboard/suppliers/loading.tsx': 'wide',
  './(dashboard)/dashboard/tags/loading.tsx': 'wide',
  './(dashboard)/dashboard/warehouses/loading.tsx': 'wide',
  // This lane's wide pages (pages/insights.css data-glass-width="wide").
  './(dashboard)/dashboard/reports/loading.tsx': 'wide',
  './(dashboard)/dashboard/team/loading.tsx': 'wide',
  // This lane's reading pages (max-w-3xl).
  './(dashboard)/dashboard/insights/loading.tsx': 'reading',
  './(dashboard)/dashboard/notifications/loading.tsx': 'reading',
  './(dashboard)/dashboard/whats-new/loading.tsx': 'reading',
  './(dashboard)/dashboard/whats-new/[slug]/loading.tsx': 'reading',
  // The glass page box at the skeleton's own width.
  './(dashboard)/dashboard/zendesk/loading.tsx': 'own',
  './(dashboard)/dashboard/ai/loading.tsx': 'own',
  './(dashboard)/dashboard/admin/loading.tsx': 'own',
  // No glass page box: no glass composition draws the page (product
  // groups; the Overview at /dashboard), the settings frame is the admin
  // lane's, and Place an order's skeleton is the storefront's own
  // (storefront.glass.css).
  './(dashboard)/dashboard/product-groups/loading.tsx': 'none',
  './(dashboard)/dashboard/settings/loading.tsx': 'none',
  './(dashboard)/dashboard/orders/new/loading.tsx': 'none',
};

/** The dashboard group's own loading file, per route it draws. */
const GROUP: Record<string, 'wide' | 'own' | 'none'> = {
  '/dashboard': 'none',
  '/dashboard/inventory': 'wide',
  '/dashboard/orders': 'wide',
  '/dashboard/purchase-orders': 'wide',
  '/dashboard/help': 'own',
  '/dashboard/audit': 'own',
};

function pathOf(file: string): string {
  const parts = file
    .replace(/^\.\//u, '')
    .replace(/\/?loading\.tsx$/u, '')
    .split('/')
    .filter((p) => p !== '' && !/^\(.+\)$/u.test(p))
    .map((p) => (/^\[.+\]$/u.test(p) ? UUID : p));
  return `/${parts.join('/')}`;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** What the skeleton's box says to glass. */
function boxOf(root: Element | null): 'wide' | 'reading' | 'own' | 'none' {
  if (!root || root.getAttribute('data-glass') !== 'skeleton-page') return 'none';
  const width = root.getAttribute('data-glass-width');
  return width === 'wide' || width === 'reading' ? width : 'own';
}

/** The glass hooks a skeleton's parts carry: bars without the shine hook,
 *  cards without a material hook (or not flush inside a hooked card). */
function unhooked(container: HTMLElement) {
  const bars = [...container.querySelectorAll('.animate-pulse')].filter(
    (el) => el.getAttribute('data-glass') !== 'skeleton',
  );
  const MATERIAL = ['card', 'panel', 'skeleton-strip'];
  const cards = [...container.querySelectorAll('.bg-card.border')].filter((el) => {
    if (MATERIAL.includes(el.getAttribute('data-glass') ?? '')) return false;
    // A strip's cells are drawn by the strip.
    if (el.getAttribute('data-glass-role') === 'skeleton-strip-cell') return false;
    return true;
  });
  return { bars: bars.length, cards: cards.map((el) => el.className) };
}

describe('skeletons: the glass box and the material hooks', () => {
  const files = Object.keys(LOADING).sort();

  it('names a width for every loading.tsx', () => {
    expect(files.filter((f) => f !== './(dashboard)/loading.tsx').sort()).toEqual(
      Object.keys(WIDTH).sort(),
    );
  });

  for (const file of files) {
    if (file === './(dashboard)/loading.tsx') continue;
    const Loading = LOADING[file]!.default;
    it(`${file}: the box the glass page takes, every bar shining, every card glass`, () => {
      nav.pathname = pathOf(file);
      const view = render(<Loading />);
      const root = view.container.querySelector('[data-glass="skeleton-page"]');
      expect(boxOf(root), 'the box').toBe(WIDTH[file]);
      if (file.endsWith('/orders/new/loading.tsx')) return; // the storefront's own parts
      expect(unhooked(view.container)).toEqual({ bars: 0, cards: [] });
      view.unmount();
    });
  }

  for (const [path, width] of Object.entries(GROUP)) {
    it(`the dashboard group's loading at ${path}: the box and the hooks`, () => {
      nav.pathname = path;
      const Loading = LOADING['./(dashboard)/loading.tsx']!.default;
      const view = render(<Loading />);
      const root = view.container.querySelector('[data-glass="skeleton-page"]');
      expect(boxOf(root)).toBe(width);
      expect(unhooked(view.container)).toEqual({ bars: 0, cards: [] });
      view.unmount();
    });
  }

  it('the title and subline boxes of the shared head are hooked', () => {
    nav.pathname = '/dashboard/reports';
    const Loading = LOADING['./(dashboard)/dashboard/reports/loading.tsx']!.default;
    const view = render(<Loading />);
    expect(view.container.querySelector('[data-glass-role="skeleton-title"]')).not.toBeNull();
    expect(view.container.querySelector('[data-glass-role="skeleton-subline"]')).not.toBeNull();
    // The figures are one strip in Classic and one card per figure in glass.
    const strip = view.container.querySelector('[data-glass="skeleton-strip"]');
    expect(strip?.querySelectorAll('[data-glass-role="skeleton-strip-cell"]')).toHaveLength(4);
  });
});

const ERROR = Object.assign(new Error('Boom: the read failed.'), { digest: 'digest-1' });

describe('error and 404 states: the glass hooks', () => {
  it('the 404 page is a state screen of three parts, the code its eyebrow', () => {
    const view = render(<NotFound />);
    const screen = view.container.querySelector('[data-glass="state-screen"]');
    expect(screen).not.toBeNull();
    expect(screen!.children.length).toBeLessThanOrEqual(4);
    expect(screen!.querySelector('[data-glass-role="state-eyebrow"]')?.textContent).toBe('404');
  });

  it('the root error boundary is a state screen of at most four parts', () => {
    const view = render(<RootError error={ERROR} reset={() => undefined} />);
    const screen = view.container.querySelector('[data-glass="state-screen"]');
    expect(screen).not.toBeNull();
    // The heading, the line, Try again and (in glass) Use classic design.
    expect(screen!.children.length).toBeLessThanOrEqual(4);
  });

  it("the dashboard's error card names its card, error id and message", () => {
    const view = render(<DashboardError error={ERROR} reset={() => undefined} />);
    const frame = view.container.querySelector('[data-glass="error-frame"]');
    expect(frame?.querySelector('[data-glass-role="error-card"]')).not.toBeNull();
    expect(frame?.querySelector('[data-glass-role="error-digest"]')?.textContent).toContain(
      'digest-1',
    );
    expect(frame?.querySelector('[data-glass-role="error-message"]')?.textContent).toBe(
      'Boom: the read failed.',
    );
  });

  it("Book Order Totals' failed read is a wide state page", () => {
    const view = render(<BookOrderTotalsError error={ERROR} reset={() => undefined} />);
    const page = view.container.querySelector('[data-glass="state-page"]');
    expect(page?.getAttribute('data-glass-width')).toBe('wide');
    expect(page?.querySelector('[data-glass="state-panel"]')).not.toBeNull();
  });
});

describe('states.css reads only these hooks', () => {
  const css = readFileSync(join(__dirname, '..', 'styles', 'liquid-glass', 'states.css'), 'utf8');
  it('every data-glass value it names is one these states draw', () => {
    const named = new Set([...css.matchAll(/\[data-glass='([\w-]+)'\]/gu)].map((m) => m[1]));
    expect([...named].sort()).toEqual(
      [
        'button',
        'card',
        'error-frame',
        'page-header',
        'skeleton-page',
        'skeleton-strip',
        'state-page',
        'state-panel',
        'state-screen',
      ].sort(),
    );
  });
  it('the status card behind the 404 and root error words spans their rows: the frame stretches its items', () => {
    // Both frames carry the classic class items-center (align-items: center), which a grid reads too.
    // Centred, the card (the frame's ::before and ::after, placed on every row) took its own height,
    // nothing, and the words sat on the bare picture (lab 2026-11-11: a 2 px line; "Pilot" 2.9:1 in Day).
    for (const view of [
      render(<NotFound />),
      render(<RootError error={ERROR} reset={() => undefined} />),
    ]) {
      const frame = view.container.querySelector('[data-glass="state-screen"]');
      expect(frame!.className).toMatch(/(^|\s)items-center(\s|$)/u);
    }
    const frameRule = new RegExp(
      String.raw`:root\[data-appearance='liquid-glass'\] \[data-glass='state-screen'\] \{([^}]*)\}`,
      'u',
    ).exec(css.replace(/\/\*[\s\S]*?\*\//gu, ''));
    expect(frameRule).not.toBeNull();
    expect(frameRule![1]).toMatch(/display: grid;/u);
    expect(frameRule![1]).toMatch(/align-items: stretch;/u);
    const card = new RegExp(
      String.raw`\[data-glass='state-screen'\]::before,\s*:root\[data-appearance='liquid-glass'\] \[data-glass='state-screen'\]::after \{([^}]*)\}`,
      'u',
    ).exec(css.replace(/\/\*[\s\S]*?\*\//gu, ''));
    expect(card![1]).toMatch(/grid-row: 1 \/ -1;/u);
    // Nothing on the card or the frame's children undoes the stretch.
    expect(css.replace(/\/\*[\s\S]*?\*\//gu, '')).not.toMatch(
      /\[data-glass='state-screen'\][^{]*\{[^}]*align-(self|items): (center|start|end)/u,
    );
  });
  it('every rule that names a shared hook is anchored to a state hook', () => {
    const SHARED = /\[data-glass='(button|card|page-header|state-panel)'\]/u;
    const STATE =
      /\[data-glass='(skeleton-page|skeleton-strip|state-screen|error-frame|state-page)'\]|\[data-glass-role='skeleton-/u;
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/gu)]
      .map((m) => m[2]!.replace(/\/\*[\s\S]*?\*\//gu, '').trim())
      .filter((s) => s.startsWith(':root'));
    for (const list of selectors) {
      for (const selector of list.split(/,(?![^(]*\))/u)) {
        if (SHARED.test(selector)) expect(selector, selector).toMatch(STATE);
      }
    }
  });
});
