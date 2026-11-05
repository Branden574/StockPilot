import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, admin lane). The settings hub
 * page (/dashboard/settings): its Classic DOM for an owner with every
 * destination, and for a viewer with the five ungated ones, normalised as
 * the classic proof normalises a page (src/test/classic-dom.ts), pinned in
 * __classic__/ from the code BEFORE Liquid Glass added its hooks. Liquid
 * Glass may add only inert hook attributes and glass-only elements; with them
 * stripped the page must render exactly the pinned DOM under the `off`
 * rollout and under `default`. Fix the change, never the snapshot.
 *
 * The mocks are page.test.tsx's.
 */

const ctxHolder = vi.hoisted(() => ({
  current: { role: 'owner' as 'owner' | 'viewer' },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    organizationName: 'Org',
    role: ctxHolder.current.role,
  })),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/settings',
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/onboarding/tours', () => ({ SETTINGS_TOUR: {} }));

import SettingsHubPage from './page';

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

async function renderUnder(rollout: 'off' | 'default', role: 'owner' | 'viewer') {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  ctxHolder.current = { role };
  render(await SettingsHubPage());
  return {
    dom: classicDom(document.body),
    structure: classicStructure(document.body),
    glassOnly: glassOnlyCount(document.body),
  };
}

describe('Settings hub page, Classic DOM', () => {
  for (const role of ['owner', 'viewer'] as const) {
    it(`${role}: the pinned Classic DOM under off and under default`, async () => {
      const off = await renderUnder('off', role);
      expect(off.glassOnly).toBe(0);
      const glass = await renderUnder('default', role);
      expect(glass.dom).toBe(off.dom);
      expect(glass.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/settings-hub.${role}.txt`);
    });
  }
});
