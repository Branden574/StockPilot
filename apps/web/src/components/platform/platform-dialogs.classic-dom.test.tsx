// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, admin lane). The platform
 * console's dialogs the Platform-Console board draws or that its pages open
 * (Order items access, the step-up "Confirm with your authenticator", Remove
 * organization, Disable account) and the step-up as the settings pages open
 * it: their Classic DOM, normalised as the classic proof normalises a page
 * (src/test/classic-dom.ts), pinned in __classic__/ from the code BEFORE
 * Liquid Glass added its hooks. Liquid Glass may add only inert hook
 * attributes and glass-only elements; with them stripped each open dialog
 * must render exactly the pinned DOM under the `off` rollout (no glass-only
 * element at all) and under `default`, and no Classic element may change its
 * place among its siblings. Fix the change, never the snapshot.
 *
 * The mocks are the dialogs' own tests' (order-items-access-dialog.test.tsx,
 * remove-org-dialog.test.tsx, step-up-modal.test.tsx).
 */

const h = vi.hoisted(() => ({
  listFactors: vi.fn(),
  ensure: vi.fn(async () => true),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/platform/orgs/0413c000-0000-4000-8000-000000000001',
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { mfa: { listFactors: () => h.listFactors() } } }),
}));
vi.mock('@/server/actions/mfa', () => ({ challengeFactorAction: vi.fn() }));
vi.mock('@/server/actions/platform-admin', () => ({ removeOrgAction: vi.fn() }));
vi.mock('@/server/actions/platform/permission-exceptions', () => ({
  setOrderItemsAccessAction: vi.fn(),
}));

import { useStepUp } from '@/components/auth/step-up-modal';

import { DisableAccountDialog } from './disable-account-dialog';
import { OrderItemsAccessDialog, type OrderItemsAccessTarget } from './order-items-access-dialog';
import { RemoveOrgDialog } from './remove-org-dialog';

const TARGET: OrderItemsAccessTarget = {
  organizationId: '0413c000-0000-4000-8000-000000000001',
  userId: '0413c000-0000-4000-8000-0000000000a1',
  name: 'Riley Example',
  role: 'manager',
  disabled: false,
  exception: 'deny',
  ordersModuleEnabled: true,
  canRequestOrders: true,
};

function StepUpHarness() {
  const stepUp = useStepUp();
  return (
    <>
      <button type="button" onClick={() => void stepUp.ensure()}>
        Open step-up
      </button>
      {stepUp.modal}
    </>
  );
}

const STATES: Array<{
  name: string;
  ui: () => React.ReactElement;
  open?: string;
  dialog: RegExp;
}> = [
  {
    name: 'order-items-access',
    ui: () => (
      <OrderItemsAccessDialog
        open
        onOpenChange={() => undefined}
        target={TARGET}
        ensureStepUp={h.ensure}
      />
    ),
    dialog: /order items access/i,
  },
  {
    name: 'order-items-access-disabled-member',
    ui: () => (
      <OrderItemsAccessDialog
        open
        onOpenChange={() => undefined}
        target={{ ...TARGET, role: 'staff', disabled: true, exception: 'allow' }}
        ensureStepUp={h.ensure}
      />
    ),
    dialog: /order items access/i,
  },
  {
    name: 'remove-org',
    ui: () => <RemoveOrgDialog organizationId="org-1" orgName="Example Schools" />,
    open: 'Remove organization',
    dialog: /remove/i,
  },
  {
    name: 'disable-account',
    ui: () => (
      <DisableAccountDialog
        open
        onOpenChange={() => undefined}
        email="target@example.test"
        pending={false}
        onConfirm={() => undefined}
      />
    ),
    dialog: /disable/i,
  },
  {
    name: 'step-up',
    ui: () => <StepUpHarness />,
    open: 'Open step-up',
    dialog: /confirm with your authenticator/i,
  },
];

beforeEach(() => {
  h.listFactors.mockResolvedValue({
    data: { totp: [{ id: 'factor-1', friendly_name: 'Phone', status: 'verified' }] },
    error: null,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

async function renderUnder(rollout: 'off' | 'default', state: (typeof STATES)[number]) {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  render(state.ui());
  if (state.open) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: state.open }));
    });
  }
  expect(await screen.findByRole('dialog', { name: state.dialog })).toBeInTheDocument();
  // The dialogs are portalled to body, so the whole body is read.
  return {
    dom: classicDom(document.body),
    structure: classicStructure(document.body),
    glassOnly: glassOnlyCount(document.body),
  };
}

describe('Platform console dialogs, Classic DOM', () => {
  for (const state of STATES) {
    it(`${state.name}: the pinned Classic DOM under off and under default`, async () => {
      const off = await renderUnder('off', state);
      expect(off.glassOnly).toBe(0);
      const glass = await renderUnder('default', state);
      expect(glass.dom).toBe(off.dom);
      expect(glass.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/platform-dialogs.${state.name}.txt`);
    });
  }
});
