// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Liquid Glass stage 4, admin lane: the dialog anatomy pages/admin.css draws
 * (the board's .dialog: head, reading area, foot; the step-up's own parts) is
 * named by inert hooks on today's dialog parts. This pins each hook and the
 * place the stylesheet looks for it (a direct child of the dialog, or of the
 * step-up's form). The Classic DOM itself is pinned in
 * platform-dialogs.classic-dom.test.tsx. The mocks are that file's.
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

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
  h.listFactors.mockResolvedValue({
    data: {
      totp: [
        { id: 'factor-1', friendly_name: 'Phone', status: 'verified' },
        { id: 'factor-2', friendly_name: 'Tablet', status: 'verified' },
      ],
    },
    error: null,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

const childHooks = (el: Element) =>
  Array.from(el.children)
    .map((c) => c.getAttribute('data-glass'))
    .filter(Boolean);

describe('the console dialogs name their parts', () => {
  const CASES: Array<{ role: string; ui: () => React.ReactElement; open?: string; name: RegExp }> =
    [
      {
        role: 'order-items-access',
        ui: () => (
          <OrderItemsAccessDialog
            open
            onOpenChange={() => undefined}
            target={TARGET}
            ensureStepUp={h.ensure}
          />
        ),
        name: /order items access/i,
      },
      {
        role: 'remove-org',
        ui: () => <RemoveOrgDialog organizationId="org-1" orgName="Example Schools" />,
        open: 'Remove organization',
        name: /remove/i,
      },
      {
        role: 'disable-account',
        ui: () => (
          <DisableAccountDialog
            open
            onOpenChange={() => undefined}
            email="target@example.test"
            pending={false}
            onConfirm={() => undefined}
          />
        ),
        name: /disable/i,
      },
    ];

  for (const c of CASES) {
    it(`${c.role}: the role on the dialog, then head, reading area and foot as its children`, async () => {
      render(c.ui());
      if (c.open) {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: c.open }));
        });
      }
      const dialog = await screen.findByRole('dialog', { name: c.name });
      expect(dialog.getAttribute('data-glass')).toBe('dialog');
      expect(dialog.getAttribute('data-glass-role')).toBe(c.role);
      expect(childHooks(dialog)).toEqual(['dialog-header', 'dialog-body', 'dialog-footer']);
      const head = dialog.querySelector(':scope > [data-glass="dialog-header"]')!;
      expect(head.querySelector(':scope > h2[id]')).not.toBeNull();
    });
  }

  it('order-items-access: the "after saving" note is marked inside the reading area', async () => {
    render(
      <OrderItemsAccessDialog
        open
        onOpenChange={() => undefined}
        target={TARGET}
        ensureStepUp={h.ensure}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: /order items access/i });
    const note = dialog.querySelector('[data-glass-role="order-items-access-after"]');
    expect(note).not.toBeNull();
    expect(note!.closest('[data-glass="dialog-body"]')).not.toBeNull();
  });
});

describe('the step-up names its own parts', () => {
  it('head and form under the dialog; the fields and the foot straight inside the form', async () => {
    render(<StepUpHarness />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open step-up' }));
    });
    const dialog = await screen.findByRole('dialog', { name: /confirm with your authenticator/i });
    await screen.findByLabelText('Authenticator');
    expect(dialog.getAttribute('data-glass-role')).toBe('step-up');
    expect(childHooks(dialog)).toEqual(['step-up-head', 'step-up-form']);
    const form = dialog.querySelector(':scope > [data-glass="step-up-form"]')!;
    expect(form.tagName).toBe('FORM');
    expect(childHooks(form)).toEqual(['step-up-field', 'step-up-field', 'step-up-foot']);
    // The code field is the numeric input the stylesheet sizes (48 px, 20 px digits).
    const code = screen.getByLabelText('Authentication code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(code.getAttribute('data-glass')).toBe('input');
    expect(code.closest('[data-glass="step-up-field"]')).not.toBeNull();
  });
});
