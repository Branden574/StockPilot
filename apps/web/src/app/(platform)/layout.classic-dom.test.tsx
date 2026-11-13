import { cleanup, render } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, admin lane). The platform
 * console's shell (app/(platform)/layout.tsx: the top bar, the console nav,
 * the Platform admin marker, the operator and the way back) around its
 * Organizations directory, with organizations and with none: their Classic
 * DOM, normalised as the classic proof normalises a page
 * (src/test/classic-dom.ts), pinned in __classic__/ from the code BEFORE
 * Liquid Glass added its hooks. Liquid Glass may add only inert hook
 * attributes and glass-only elements; with them stripped the console must
 * render exactly the pinned DOM under the `off` rollout and under
 * `default`. Fix the change, never the snapshot.
 *
 * The mocks are layout.test.tsx's and platform/page.test.tsx's.
 */

const h = vi.hoisted(() => ({
  listOrgsForPlatform: vi.fn(),
  getPlatformMetrics: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    children,
    ...rest
  }: {
    href: string;
    prefetch?: boolean | null;
    children?: ReactNode;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/platform' }));
vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: vi.fn(async () => ({ userId: 'god', email: 'operator@example.test' })),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { org_deletion_passphrase_hash: 'x' } }) }),
      }),
    }),
  }),
}));
vi.mock('@/server/services/platform/orgs', () => ({
  listOrgsForPlatform: (...a: unknown[]) => h.listOrgsForPlatform(...a),
  getPlatformMetrics: (...a: unknown[]) => h.getPlatformMetrics(...a),
}));
vi.mock('@/components/platform/deletion-passphrase-form', () => ({
  DeletionPassphraseForm: ({ isConfigured }: { isConfigured: boolean }) => (
    <div data-testid="passphrase-form">{String(isConfigured)}</div>
  ),
}));

import PlatformLayout from './layout';
import PlatformOrgsPage from './platform/page';

function org(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `org-${n}`,
    name: `Example Org ${n}`,
    slug: `example-${n}`,
    industry: n === 1 ? 'Education' : null,
    createdAt: '2026-01-01T00:00:00Z',
    timezone: 'America/Los_Angeles',
    effective: { tier: 'pro', source: 'manual', trialDaysRemaining: null },
    billingArrangement: 'standard',
    memberCount: 3 * n,
    itemCount: 10 * n,
    ...over,
  };
}

beforeEach(() => {
  h.getPlatformMetrics.mockResolvedValue({
    totalOrgs: 1234,
    totalUsers: 56,
    totalItems: 7890,
    totalInventoryValue: 12345.67,
    totalPurchaseOrders: 11,
    totalOrders: 22,
    totalMovements: 33,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

const STATES = [
  {
    name: 'directory',
    orgs: [
      org(1, { billingArrangement: 'comped' }),
      org(2, {
        effective: { tier: 'business', source: 'trial', trialDaysRemaining: 9 },
      }),
      org(3, { effective: { tier: 'starter', source: 'stripe', trialDaysRemaining: null } }),
    ],
    capped: false,
    q: undefined,
  },
  { name: 'directory-capped-search', orgs: [org(4)], capped: true, q: 'example' },
  { name: 'directory-empty', orgs: [], capped: false, q: undefined },
] as const;

async function renderUnder(rollout: 'off' | 'default', state: (typeof STATES)[number]) {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  h.listOrgsForPlatform.mockResolvedValue({ orgs: state.orgs, capped: state.capped });
  const page = await PlatformOrgsPage({
    searchParams: Promise.resolve(state.q ? { q: state.q } : {}),
  });
  render(await PlatformLayout({ children: page }));
  return {
    dom: classicDom(document.body),
    structure: classicStructure(document.body),
    glassOnly: glassOnlyCount(document.body),
  };
}

describe('Platform console shell and Organizations directory, Classic DOM', () => {
  for (const state of STATES) {
    it(`${state.name}: the pinned Classic DOM under off and under default`, async () => {
      const off = await renderUnder('off', state);
      expect(off.glassOnly).toBe(0);
      const glass = await renderUnder('default', state);
      expect(glass.dom).toBe(off.dom);
      expect(glass.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/platform-shell.${state.name}.txt`);
    });
  }
});
