import { render } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, insights lane): the states a
 * route shows instead of its page. Every loading skeleton (the 31
 * loading.tsx files under src/app), the error boundaries this lane owns (the
 * root one, the dashboard group's and Book Order Totals') and the 404 page,
 * normalised as the classic proof normalises a page (src/test/classic-dom.ts)
 * and pinned in __classic__/ from the code BEFORE the glass hooks were added.
 * Liquid Glass may add only inert hook attributes and glass-only elements;
 * with them stripped, each state must render exactly the pinned DOM:
 *   - under the `off` rollout, with no glass-only element rendered at all;
 *   - under `default` (the Classic chooser's page: the same tree), once
 *     those are dropped;
 *   - and under `default` every Classic element keeps its place among its
 *     siblings (classicStructure).
 * A failure here means a change touched Classic: fix the change, never the
 * pinned file (regenerate one only from a commit whose Classic output is the
 * accepted baseline).
 *
 * The tokens of every class attribute are sorted before comparing, as the
 * lab comparison sorts them (DECISIONS.md, CLASS-ORDER NORMALISATION): the
 * repository's Prettier sorts Tailwind classes in any file it formats, a
 * pure reordering of the same tokens cannot change rendering, and a changed
 * token SET still fails here.
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
    scroll: _scroll,
    replace: _replace,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: unknown;
    scroll?: unknown;
    replace?: unknown;
  }) => (
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

/** Every loading.tsx under src/app, keyed by its path from here. */
const LOADING = import.meta.glob<{ default: () => React.ReactElement }>('./**/loading.tsx', {
  eager: true,
});

/** The route a loading file stands for (its folder, route groups dropped). */
function routeOf(file: string): string {
  const parts = file
    .replace(/^\.\//u, '')
    .replace(/\/?loading\.tsx$/u, '')
    .split('/')
    .filter((p) => p !== '' && !/^\(.+\)$/u.test(p));
  return `/${parts.join('/')}`;
}

/** A file-safe name for a pinned state. */
function slug(text: string): string {
  return (
    text
      .replace(/^\//u, '')
      .replace(/\[([^\]]+)\]/gu, '$1')
      .replace(/[^a-z0-9]+/giu, '-')
      .replace(/^-|-$/gu, '') || 'root'
  );
}

/** A path inside the route, for the files that read it (a [param] gets a value). */
function pathIn(route: string): string {
  return route.replace(/\[[^\]]+\]/gu, '0b6f3c1e-1d2a-4c55-9f1e-6a1f0e3b2c4d');
}

const ERROR = Object.assign(new Error('Boom: the read failed.'), { digest: 'digest-1' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Sorts the tokens of every class attribute (see above). */
function sortClassTokens(dom: string): string {
  return dom.replace(
    /\bclass="([^"]*)"/gu,
    (_, value: string) => `class="${value.split(/\s+/u).filter(Boolean).sort().join(' ')}"`,
  );
}

/** The state's normalised Classic DOM under one rollout. */
function classicOf(rollout: 'off' | 'default', node: () => React.ReactElement) {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const view = render(node());
  const out = {
    dom: sortClassTokens(classicDom(view.container)),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

function expectPinned(name: string, node: () => React.ReactElement) {
  const off = classicOf('off', node);
  const glassBuild = classicOf('default', node);
  expect(off.glassOnly, 'no glass-only part under off').toBe(0);
  expect(glassBuild.dom, 'default normalises to the off DOM').toBe(off.dom);
  expect(glassBuild.structure, 'default moves no Classic element').toBe(off.structure);
  return expect(off.dom).toMatchFileSnapshot(`./__classic__/states.${name}.txt`);
}

/** The dashboard group's own loading file draws a skeleton per route. */
const GROUP_LOADING_PATHS = [
  '/dashboard',
  '/dashboard/inventory',
  '/dashboard/orders',
  '/dashboard/purchase-orders',
  '/dashboard/help',
  '/dashboard/audit',
];

describe('loading states: the Classic DOM is the pinned one', () => {
  const files = Object.keys(LOADING).sort();

  it('reads every loading.tsx (31 files)', () => {
    expect(files).toHaveLength(31);
  });

  for (const file of files) {
    const route = routeOf(file);
    const Loading = LOADING[file]!.default;
    const paths = route === '/' ? GROUP_LOADING_PATHS : [pathIn(route)];
    for (const path of paths) {
      const name = `loading.${slug(route === '/' ? `group${path}` : route)}`;
      it(`${file} at ${path}: off and default normalise to the pinned DOM`, async () => {
        nav.pathname = path;
        await expectPinned(name, () => <Loading />);
      });
    }
  }
});

describe('error and not-found states: the Classic DOM is the pinned one', () => {
  it('the root error boundary (app/error.tsx)', async () => {
    nav.pathname = '/dashboard/inventory';
    await expectPinned('error.root', () => <RootError error={ERROR} reset={() => undefined} />);
  });

  it('the dashboard group error boundary (app/(dashboard)/error.tsx)', async () => {
    nav.pathname = '/dashboard/inventory';
    await expectPinned('error.dashboard', () => (
      <DashboardError error={ERROR} reset={() => undefined} />
    ));
  });

  it('the dashboard group error boundary with no digest and no message', async () => {
    nav.pathname = '/dashboard/inventory';
    await expectPinned('error.dashboard-bare', () => (
      <DashboardError error={new Error('')} reset={() => undefined} />
    ));
  });

  it("Book Order Totals' error boundary", async () => {
    nav.pathname = '/dashboard/reports/book-order-totals';
    await expectPinned('error.book-order-totals', () => (
      <BookOrderTotalsError error={ERROR} reset={() => undefined} />
    ));
  });

  it('the 404 page (app/not-found.tsx)', async () => {
    nav.pathname = '/nowhere';
    await expectPinned('not-found', () => <NotFound />);
  });
});
