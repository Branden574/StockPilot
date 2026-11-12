import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, admin lane). The Admin hub
 * (/dashboard/admin) with and without the platform-only block: its Classic
 * DOM, normalised as the classic proof normalises a page
 * (src/test/classic-dom.ts), pinned in __classic__/ from the code BEFORE
 * Liquid Glass added its hooks. Liquid Glass may add only inert hook
 * attributes and glass-only elements; with them stripped the page must
 * render exactly the pinned DOM under the `off` rollout and under `default`.
 * Fix the change, never the snapshot.
 *
 * The mocks are page.test.tsx's.
 */

const platform = vi.hoisted(() => ({ admin: false }));
vi.mock('@/lib/auth/platform-admin', () => ({
  currentUserIsPlatformAdmin: vi.fn(async () => platform.admin),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u1', role: 'owner' })),
}));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(async (_href: string, fallback: string) => fallback),
}));
const COUNTS: Record<string, number> = {
  charters: 3,
  warehouses: 2,
  organization_members: 7,
  organization_invites: 1,
  audit_logs: 4210,
};
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      const result = { count: COUNTS[table] ?? 0, data: null, error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ['eq', 'neq', 'not', 'is', 'gt']) chain[m] = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
      return { select: () => chain };
    },
  })),
}));

import AdminOverviewPage from './page';

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

async function renderUnder(rollout: 'off' | 'default', platformAdmin: boolean) {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  platform.admin = platformAdmin;
  render(await AdminOverviewPage());
  return {
    dom: classicDom(document.body),
    structure: classicStructure(document.body),
    glassOnly: glassOnlyCount(document.body),
  };
}

describe('Admin hub, Classic DOM', () => {
  for (const [name, platformAdmin] of [
    ['org-admin', false],
    ['platform-admin', true],
  ] as const) {
    it(`${name}: the pinned Classic DOM under off and under default`, async () => {
      const off = await renderUnder('off', platformAdmin);
      expect(off.glassOnly).toBe(0);
      const glass = await renderUnder('default', platformAdmin);
      expect(glass.dom).toBe(off.dom);
      expect(glass.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/admin-hub.${name}.txt`);
    });
  }
});
