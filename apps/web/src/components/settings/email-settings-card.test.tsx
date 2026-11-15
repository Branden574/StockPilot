import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings, Profile, Email: the card shows every email change the account
 * holds. The auth server keeps a pending address without a request time after
 * the password is changed (the links of that change no longer work); the card
 * shows that change as waiting with its links expired, so the person can send
 * the links again, name another address, or cancel it.
 */

const refresh = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: vi.fn(async () => true), modal: null }),
}));

const actions = vi.hoisted(() => ({
  cancelEmailChangeAction: vi.fn(),
  requestEmailChangeAction: vi.fn(),
  resendEmailChangeAction: vi.fn(),
}));
vi.mock('@/server/actions/email-change', () => actions);

import { EmailSettingsCard, type EmailSettingsCardProps } from './email-settings-card';

const CURRENT = 'person@example.com';
const WAITING = 'person.new@example.com';
const EXPIRED_COPY = 'The verification links have expired. Resend them to continue.';

function card(props: Partial<EmailSettingsCardProps> = {}) {
  return render(
    <EmailSettingsCard
      email={CURRENT}
      pendingEmail={null}
      sentAt={null}
      expiresAt={null}
      expired={false}
      justChanged={false}
      {...props}
    />,
  );
}

/** The panel that names the address a change is waiting on. */
const pendingPanel = () => screen.getByText('Pending:').closest('[role="status"]') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EmailSettingsCard: nothing waiting', () => {
  it('shows the address as verified with Change email, and no pending panel', () => {
    card();
    expect(screen.getByText(CURRENT)).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change email' })).toBeInTheDocument();
    expect(screen.queryByText('Pending:')).toBeNull();
  });
});

describe('EmailSettingsCard: a change waiting with its request time', () => {
  it('names the waiting address as pending, with Resend, another address and Cancel', () => {
    const sentAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 55 * 60_000).toISOString();
    card({ pendingEmail: WAITING, sentAt, expiresAt });
    const panel = pendingPanel();
    expect(within(panel).getByText(WAITING)).toBeInTheDocument();
    expect(within(panel).getByText('Pending')).toBeInTheDocument();
    expect(within(panel).queryByText('Expired')).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Resend verification' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: 'Cancel change' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Change email' })).toBeNull();
  });
});

describe('EmailSettingsCard: a change waiting without a request time', () => {
  const HELD = { pendingEmail: WAITING, sentAt: null, expiresAt: null, expired: true };

  it('shows the change the account holds: the waiting address, marked expired, in the words of expired links', () => {
    card(HELD);
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.queryByText('Verified')).toBeNull();
    const panel = pendingPanel();
    expect(within(panel).getByText(WAITING)).toBeInTheDocument();
    expect(within(panel).getByText('Expired')).toBeInTheDocument();
    expect(within(panel).getByText(EXPIRED_COPY)).toBeInTheDocument();
    // Never the words of links that still work.
    expect(panel.textContent).not.toMatch(/Verification links sent/);
  });

  it('offers Resend, another address and Cancel, and not a bare Change email', () => {
    card(HELD);
    const panel = pendingPanel();
    expect(within(panel).getByRole('button', { name: 'Resend verification' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: 'Use a different address' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: 'Cancel change' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Change email' })).toBeNull();
  });

  it('is shown as expired whatever the expired flag says: without a request time no link is live', () => {
    card({ ...HELD, expired: false });
    expect(within(pendingPanel()).getByText('Expired')).toBeInTheDocument();
    expect(within(pendingPanel()).getByText(EXPIRED_COPY)).toBeInTheDocument();
  });

  it('Cancel change cancels it: the panel goes and the page is read again', async () => {
    actions.cancelEmailChangeAction.mockResolvedValue({ ok: true, data: { cancelled: true } });
    const user = userEvent.setup();
    card(HELD);
    await user.click(within(pendingPanel()).getByRole('button', { name: 'Cancel change' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel change' }));
    await waitFor(() => expect(actions.cancelEmailChangeAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Resend verification sends new links: the change is pending again, with its new times', async () => {
    const sentAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    actions.resendEmailChangeAction.mockResolvedValue({
      ok: true,
      data: { pendingEmail: WAITING, sentAt, expiresAt },
    });
    const user = userEvent.setup();
    const view = card(HELD);
    // The page is read again after a resend: the server's new answer arrives
    // as props.
    refresh.mockImplementation(() =>
      view.rerender(
        <EmailSettingsCard
          email={CURRENT}
          pendingEmail={WAITING}
          sentAt={sentAt}
          expiresAt={expiresAt}
          expired={false}
          justChanged={false}
        />,
      ),
    );
    await user.click(within(pendingPanel()).getByRole('button', { name: 'Resend verification' }));
    await waitFor(() => expect(actions.resendEmailChangeAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(pendingPanel()).getByText('Pending')).toBeInTheDocument());
    expect(within(pendingPanel()).queryByText('Expired')).toBeNull();
  });
});
