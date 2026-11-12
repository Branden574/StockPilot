import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

import { PERMISSIONS } from '@stockpilot/core';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, admin lane). The settings area's
 * frame, the sub-nav beside or above every settings page, the grouped hub,
 * a settings page with its panels, the area's loading skeleton and its error
 * boundary: their Classic DOM, normalised as the classic proof normalises a
 * page (src/test/classic-dom.ts), pinned in __classic__/ from the code BEFORE
 * Liquid Glass added its hooks. Liquid Glass may add only inert hook
 * attributes and glass-only elements; with them stripped every state must
 * render exactly the pinned DOM under the `off` rollout (no glass-only
 * element at all) and under `default`, and no Classic element may change its
 * place among its siblings (classicStructure). Fix the change, never the
 * snapshot.
 */

const pathHolder = vi.hoisted(() => ({ current: '/dashboard/settings/security' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathHolder.current,
  useRouter: () => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
// The error boundary reports through the isomorphic core (error.test.tsx's mock).
vi.mock('@/lib/error-reporter-core', () => ({ reportError: vi.fn(async () => undefined) }));

import SettingsError from '@/app/(dashboard)/dashboard/settings/error';
import SettingsLoading from '@/app/(dashboard)/dashboard/settings/loading';

import {
  SettingsFrame,
  SettingsIndex,
  SettingsPage,
  SettingsPanel,
  SettingsSubNav,
  type SettingsNavAccess,
} from './settings-nav';

const EVERYTHING: SettingsNavAccess = {
  permissions: [...PERMISSIONS],
  modules: ['maintenance_requests'],
};
const UNCHECKED: SettingsNavAccess = {
  permissions: [...PERMISSIONS],
  modules: [],
  uncheckedModules: ['maintenance_requests'],
};
const BASE: SettingsNavAccess = { permissions: [], modules: [] };

/** A settings page as the pages draw one: header, an everyday card, a list card, the danger card. */
function Page({ width }: { width?: 'form' | 'wide' }) {
  return (
    <SettingsPage width={width}>
      <PageHeader
        title="Security"
        subline="Two-factor authentication and org MFA policy."
        back={
          <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
        }
      />
      <SettingsPanel
        title="Two-factor authentication"
        description="Use an authenticator app for a second step when you sign in."
        aside={<span>On</span>}
      >
        <p>Body text.</p>
      </SettingsPanel>
      <SettingsPanel title="Active sessions" flush headingId="sessions-heading" landmark={false}>
        <ul>
          <li>This browser</li>
        </ul>
      </SettingsPanel>
      <SettingsPanel tone="danger" title="Delete account" description="Permanently remove it.">
        <button type="button">Delete my account</button>
      </SettingsPanel>
    </SettingsPage>
  );
}

const STATES: Array<{
  name: string;
  path: string;
  ui: () => React.ReactElement;
  openPhoneMenu?: boolean;
}> = [
  {
    name: 'frame-subnav-everything',
    path: '/dashboard/settings/security',
    ui: () => (
      <SettingsFrame nav={<SettingsSubNav access={EVERYTHING} />}>
        <Page />
      </SettingsFrame>
    ),
  },
  {
    name: 'frame-subnav-phone-menu-open',
    path: '/dashboard/settings/migrate/sage50',
    ui: () => (
      <SettingsFrame nav={<SettingsSubNav access={EVERYTHING} />}>
        <Page width="wide" />
      </SettingsFrame>
    ),
    openPhoneMenu: true,
  },
  {
    name: 'frame-subnav-unchecked-module',
    path: '/dashboard/settings/profile',
    ui: () => (
      <SettingsFrame nav={<SettingsSubNav access={UNCHECKED} />}>
        <Page />
      </SettingsFrame>
    ),
  },
  {
    name: 'frame-subnav-base',
    path: '/dashboard/settings/notifications',
    ui: () => (
      <SettingsFrame nav={<SettingsSubNav access={BASE} />}>
        <Page />
      </SettingsFrame>
    ),
  },
  {
    name: 'hub-index',
    path: '/dashboard/settings',
    ui: () => (
      <SettingsFrame nav={<SettingsSubNav access={EVERYTHING} />}>
        <div>
          <SettingsIndex access={UNCHECKED} />
        </div>
      </SettingsFrame>
    ),
  },
  {
    name: 'loading',
    path: '/dashboard/settings/organization',
    ui: () => (
      <SettingsFrame nav={<SettingsSubNav access={EVERYTHING} />}>
        <SettingsLoading />
      </SettingsFrame>
    ),
  },
  {
    name: 'error',
    path: '/dashboard/settings/organization',
    ui: () => (
      <SettingsFrame nav={<SettingsSubNav access={EVERYTHING} />}>
        <SettingsError
          error={Object.assign(new Error('boom'), { digest: 'abc123' })}
          retry={() => undefined}
        />
      </SettingsFrame>
    ),
  },
  {
    name: 'error-hub',
    path: '/dashboard/settings',
    ui: () => (
      <SettingsFrame nav={<SettingsSubNav access={EVERYTHING} />}>
        <SettingsError error={new Error('boom')} retry={() => undefined} />
      </SettingsFrame>
    ),
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

async function renderUnder(rollout: 'off' | 'default', state: (typeof STATES)[number]) {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  pathHolder.current = state.path;
  render(state.ui());
  if (state.openPhoneMenu) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    });
    expect(screen.getByRole('button', { name: /^Settings/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  }
  return {
    dom: classicDom(document.body),
    structure: classicStructure(document.body),
    glassOnly: glassOnlyCount(document.body),
  };
}

describe('Settings frame, sub-nav, hub, page, loading and error: Classic DOM', () => {
  for (const state of STATES) {
    it(`${state.name}: the pinned Classic DOM under off and under default`, async () => {
      const off = await renderUnder('off', state);
      expect(off.glassOnly).toBe(0);
      const glass = await renderUnder('default', state);
      expect(glass.dom).toBe(off.dom);
      expect(glass.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/settings-frame.${state.name}.txt`);
    });
  }
});
