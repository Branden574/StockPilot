import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrgEmailRoutingReadState } from '@stockpilot/core';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock, back: vi.fn() }),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

type ActionResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: { reason?: string } } };
const actionMock = vi.fn(
  async (..._args: unknown[]): Promise<ActionResult> => ({ ok: true, data: {} }),
);
vi.mock('@/server/actions/email-routing-settings', () => ({
  setOrgEmailRoutingAction: (...args: unknown[]) => actionMock(...args),
}));

// The step-up modal is UX plumbing proven in its own suite; here it only
// matters WHEN ensure() is consulted (exclusively on an aal2_required
// refusal) and that a granted step-up retries the identical payload.
const ensureMock = vi.fn(async () => true);
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: ensureMock, modal: null }),
}));

import { EmailRoutingPanel } from './email-routing-panel';

const UNSET: OrgEmailRoutingReadState = { state: 'unset' };
const VALID: OrgEmailRoutingReadState = {
  state: 'valid',
  recipients: {
    to: 'intake@acme-tenant.invalid',
    cc: 'copy@acme-tenant.invalid',
    toName: 'Acme Intake',
    ccName: 'Acme Ops',
  },
};

function renderPanel(
  delivery: OrgEmailRoutingReadState = UNSET,
  maintenance: OrgEmailRoutingReadState = UNSET,
) {
  return render(<EmailRoutingPanel initialDelivery={delivery} initialMaintenance={maintenance} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  actionMock.mockResolvedValue({ ok: true, data: {} });
  ensureMock.mockResolvedValue(true);
});

describe('EmailRoutingPanel — status per read state', () => {
  it('unset: both cards say "Not configured" and that members do not see the action', () => {
    renderPanel();
    expect(screen.getByText('Delivery requests')).toBeInTheDocument();
    expect(screen.getByText('Maintenance requests')).toBeInTheDocument();
    expect(
      screen.getAllByText('Not configured — members do not see the email action.'),
    ).toHaveLength(2);
  });

  it('valid: shows Active and prefills the stored recipients', () => {
    renderPanel(VALID, UNSET);
    expect(screen.getByText('Active — members see the email action.')).toBeInTheDocument();
    expect(screen.getByLabelText('To address (required)', { selector: '#delivery-request-to' }))
      .toHaveValue('intake@acme-tenant.invalid');
    expect(
      screen.getByLabelText('CC address (required)', { selector: '#delivery-request-cc' }),
    ).toHaveValue('copy@acme-tenant.invalid');
    expect(
      screen.getByLabelText('To display name (optional)', {
        selector: '#delivery-request-to-name',
      }),
    ).toHaveValue('Acme Intake');
  });

  it('invalid: surfaces the stored-value guard reason VERBATIM and says the action is hidden', () => {
    const reason =
      'Email recipient "cc" must be exactly one plain email address with no display name, separator or whitespace.';
    renderPanel({ state: 'invalid', reason }, UNSET);
    expect(
      screen.getByText(`Invalid: ${reason} The email action is hidden until this is fixed.`),
    ).toBeInTheDocument();
  });

  it("fallback: the migration-pending line says storage is not available yet and that the release's built-in recipients are in use", () => {
    // The 'fallback' read state exists ONLY for the code-before-migration
    // deploy window (Postgres 42703 — see OrgEmailRoutingReadState). The
    // amber copy is the one place an admin learns why their save would not
    // stick yet, so it is pinned verbatim.
    renderPanel({ state: 'fallback' }, UNSET);
    expect(
      screen.getByText(
        "Email-routing storage is not available yet (a database migration is pending). The release's built-in recipients are in use until it lands; saving here will work after the migration.",
      ),
    ).toBeInTheDocument();
    // Only the delivery card is in the fallback state; the unset maintenance
    // card keeps its own status line — the two cards' states are independent.
    expect(
      screen.getByText('Not configured — members do not see the email action.'),
    ).toBeInTheDocument();
  });

  it('valid: renders the LIVE notice preview — the exact sentence members read', () => {
    renderPanel(VALID, UNSET);
    expect(
      screen.getByText(
        'This request will be emailed to intake@acme-tenant.invalid. A copy will also be sent to copy@acme-tenant.invalid.',
      ),
    ).toBeInTheDocument();
  });
});

describe('EmailRoutingPanel — validation runs the reader-side factory', () => {
  it('a malformed cc gets the guard message verbatim on blur, and Save never calls the action', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByLabelText('To address (required)', { selector: '#delivery-request-to' }), 'intake@ok.invalid');
    await user.type(
      screen.getByLabelText('CC address (required)', { selector: '#delivery-request-cc' }),
      'a?cc=attacker@evil.test',
    );
    await user.tab();
    expect(
      await screen.findByText(
        'Email recipient "cc" must be exactly one plain email address with no display name, separator or whitespace.',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Save routing' })[0]!);
    expect(actionMock).not.toHaveBeenCalled();
  });

  it('an unsafe display name (the silent-CC-drop class) is refused with the RFC 5322 message', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByLabelText('To address (required)', { selector: '#delivery-request-to' }), 'intake@ok.invalid');
    await user.type(screen.getByLabelText('CC address (required)', { selector: '#delivery-request-cc' }), 'copy@ok.invalid');
    await user.type(
      screen.getByLabelText('CC display name (optional)', { selector: '#delivery-request-cc-name' }),
      'Ops, Manager',
    );
    await user.tab();
    expect(await screen.findByText(/RFC 5322 specials/)).toBeInTheDocument();
    expect(actionMock).not.toHaveBeenCalled();
  });
});

describe('EmailRoutingPanel — save', () => {
  it('saves trimmed fields under the right feature, dropping empty display names', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(
      screen.getByLabelText('To address (required)', { selector: '#delivery-request-to' }),
      '  intake@ok.invalid  ',
    );
    await user.type(
      screen.getByLabelText('CC address (required)', { selector: '#delivery-request-cc' }),
      ' copy@ok.invalid ',
    );
    await user.click(screen.getAllByRole('button', { name: 'Save routing' })[0]!);
    expect(actionMock).toHaveBeenCalledTimes(1);
    expect(actionMock).toHaveBeenCalledWith({
      feature: 'delivery_request',
      recipients: { to: 'intake@ok.invalid', cc: 'copy@ok.invalid' },
    });
    expect(toastSuccess).toHaveBeenCalledWith('Delivery requests email routing saved.');
    expect(refreshMock).toHaveBeenCalled();
  });

  it('the maintenance card saves under maintenance_request — never the sibling feature', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(
      screen.getByLabelText('To address (required)', { selector: '#maintenance-request-to' }),
      'facilities@ok.invalid',
    );
    await user.type(
      screen.getByLabelText('CC address (required)', { selector: '#maintenance-request-cc' }),
      'copy@ok.invalid',
    );
    await user.click(screen.getAllByRole('button', { name: 'Save routing' })[1]!);
    expect(actionMock).toHaveBeenCalledWith({
      feature: 'maintenance_request',
      recipients: { to: 'facilities@ok.invalid', cc: 'copy@ok.invalid' },
    });
  });

  it("aal2_required: challenges the step-up modal in place and retries the IDENTICAL payload once", async () => {
    const user = userEvent.setup();
    actionMock
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'forbidden',
          message: 'Re-authenticate with MFA before performing this action.',
          details: { reason: 'aal2_required' },
        },
      })
      .mockResolvedValueOnce({ ok: true, data: {} });
    renderPanel();
    await user.type(screen.getByLabelText('To address (required)', { selector: '#delivery-request-to' }), 'intake@ok.invalid');
    await user.type(screen.getByLabelText('CC address (required)', { selector: '#delivery-request-cc' }), 'copy@ok.invalid');
    await user.click(screen.getAllByRole('button', { name: 'Save routing' })[0]!);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(actionMock).toHaveBeenCalledTimes(2);
    expect(actionMock.mock.calls[0]).toEqual(actionMock.mock.calls[1]);
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('a DISMISSED step-up saves nothing and claims nothing', async () => {
    const user = userEvent.setup();
    ensureMock.mockResolvedValueOnce(false);
    actionMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Re-authenticate with MFA before performing this action.',
        details: { reason: 'aal2_required' },
      },
    });
    renderPanel();
    await user.type(screen.getByLabelText('To address (required)', { selector: '#delivery-request-to' }), 'intake@ok.invalid');
    await user.type(screen.getByLabelText('CC address (required)', { selector: '#delivery-request-cc' }), 'copy@ok.invalid');
    await user.click(screen.getAllByRole('button', { name: 'Save routing' })[0]!);
    expect(actionMock).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('a server refusal surfaces its message under the card', async () => {
    const user = userEvent.setup();
    actionMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden', message: 'You do not have permission to configure email routing.' },
    });
    renderPanel();
    await user.type(screen.getByLabelText('To address (required)', { selector: '#delivery-request-to' }), 'intake@ok.invalid');
    await user.type(screen.getByLabelText('CC address (required)', { selector: '#delivery-request-cc' }), 'copy@ok.invalid');
    await user.click(screen.getAllByRole('button', { name: 'Save routing' })[0]!);
    expect(
      await screen.findByText('You do not have permission to configure email routing.'),
    ).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('EmailRoutingPanel — clear routing', () => {
  it('offers Clear only for configured (or invalid) features, behind an inline confirm, and sends recipients: null', async () => {
    const user = userEvent.setup();
    renderPanel(VALID, UNSET);
    // The unset maintenance card offers no Clear at all.
    expect(screen.getAllByRole('button', { name: 'Clear routing' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Clear routing' }));
    // Nothing sent yet — the inline confirm is the gate.
    expect(actionMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm clear' }));
    expect(actionMock).toHaveBeenCalledWith({ feature: 'delivery_request', recipients: null });
    expect(toastSuccess).toHaveBeenCalledWith(
      'Delivery requests email routing cleared. Members no longer see the email action.',
    );
  });

  it('an INVALID stored value can be cleared too — the recovery path from a bad out-of-band write', () => {
    renderPanel({ state: 'invalid', reason: 'whatever the guard said' }, UNSET);
    expect(screen.getByRole('button', { name: 'Clear routing' })).toBeInTheDocument();
  });
});
