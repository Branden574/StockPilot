import { render } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, insights lane). The Reports hub's
 * Classic DOM, normalised as the classic proof normalises it
 * (src/test/classic-dom.ts), pinned in __classic__/ from the code BEFORE the
 * glass composition was added. Liquid Glass may add only inert hook
 * attributes and glass-only elements; with them stripped, the page must
 * render exactly the pinned DOM:
 *   - under the `off` rollout, with no glass-only element rendered at all;
 *   - under `default` (the Classic chooser's page: same tree, the glass-only
 *     parts present but hidden), once those are dropped;
 *   - and under `default` every Classic element keeps its place among its
 *     siblings (classicStructure), because a hidden glass-only sibling still
 *     counts for :first-child, :last-child and the *-of-type selectors.
 * A failure here means a change touched Classic: fix the change, never the
 * snapshot (regenerate only from a commit whose Classic output is the
 * accepted baseline).
 */

const modules = vi.hoisted(() => ({ on: new Set<string>() }));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager',
    permissions: undefined,
  })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  usePathname: () => '/dashboard/reports',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
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
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (id: string) => ({
    enabled: modules.on.has(id),
    canManage: false,
  })),
}));
vi.mock('@/components/onboarding/page-tour', () => ({
  PageTour: ({ tour }: { tour: { id: string } }) => <span data-tour={tour.id} />,
}));
vi.mock('@/components/reports/pdf-download-dropdown', () => ({
  PdfDownloadDropdown: ({ baseUrl }: { baseUrl: string }) => <span data-pdf={baseUrl} />,
}));

import ReportsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The page's normalised Classic DOM under one rollout. */
async function classicOf(rollout: 'off' | 'default') {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const view = render(await ReportsPage());
  const out = {
    dom: classicDom(view.container),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

const SCENARIOS: Array<[string, string[]]> = [
  ['every-module', ['orders', 'books', 'bundles', 'purchase_orders', 'lot_serial']],
  ['orders-and-books', ['orders', 'books']],
  ['core-only', []],
];

describe('Reports hub: the Classic DOM is the pinned one', () => {
  for (const [name, on] of SCENARIOS) {
    it(`${name}: off renders no glass-only part, off and default normalise to the pinned DOM, and default moves no Classic element among its siblings`, async () => {
      modules.on = new Set(on);
      const off = await classicOf('off');
      const glassBuild = await classicOf('default');
      expect(off.glassOnly).toBe(0);
      expect(glassBuild.dom).toBe(off.dom);
      expect(glassBuild.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/reports-hub.${name}.txt`);
    });
  }
});
