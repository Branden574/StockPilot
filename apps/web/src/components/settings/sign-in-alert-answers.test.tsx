import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MySignInAlert } from '@/server/services/sign-in-alerts';

/**
 * Part 3 (sign-in alerts) on Active sessions: a session that has an alert
 * shows what was new ("New device", "New country: Mexico"), and while the
 * alert is open, "This was me" and "This was not me". Alerts whose session
 * has ended show under the list in "Recent sign-in alerts". "This was not me"
 * asks once more (it ends this device's session too), then sends the member
 * to reset their password. The words promise what happens and no more (review
 * 1, finding 1), and say nothing about who is told before it is known
 * (finding 8).
 */

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  report: vi.fn(),
  revokeOthers: vi.fn(),
  refresh: vi.fn(),
  assign: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock('@/server/actions/sign-in-alerts', () => ({
  confirmSignInAlertAction: (a: unknown) => h.confirm(a),
  reportSignInAlertAction: (a: unknown) => h.report(a),
}));
vi.mock('@/server/actions/sessions', () => ({
  renameSessionAction: vi.fn(),
  revokeOtherSessionsAction: () => h.revokeOthers(),
  revokeSessionAction: vi.fn(),
}));

import { ActiveSessions } from './active-sessions';
import { leaveAfterReport } from './sign-in-alert-answers';

const SESSION = '5e551011-0000-4000-8000-0000000000c1';
const ENDED = '5e551011-0000-4000-8000-0000000000c2';

function alert(extra: Partial<MySignInAlert> = {}): MySignInAlert {
  return {
    id: 'a1e27000-0000-4000-8000-000000000001',
    sessionId: SESSION,
    newDevice: true,
    newCountry: true,
    client: 'web',
    deviceLabel: 'Firefox on Windows',
    country: 'MX',
    city: 'Tijuana',
    status: 'open',
    createdAt: '2026-11-20T15:30:00Z',
    ...extra,
  };
}

const SESSIONS = [
  {
    id: SESSION,
    label: 'Firefox on Windows',
    customName: null,
    ip: '203.0.113.7',
    lastActiveAt: '2026-11-20T15:31:00Z',
    isCurrent: false,
    isMfa: false,
  },
  {
    id: '5e551011-0000-4000-8000-0000000000c3',
    label: 'Safari on macOS',
    customName: null,
    ip: '198.51.100.4',
    lastActiveAt: '2026-11-20T15:35:00Z',
    isCurrent: true,
    isMfa: true,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.confirm.mockResolvedValue({ ok: true, data: { answer: 'confirmed' } });
  h.report.mockResolvedValue({ ok: true, data: { signedOut: true } });
  h.revokeOthers.mockResolvedValue({ ok: true, data: undefined });
  leaveAfterReport.go = h.assign;
});

describe('a session with an open alert', () => {
  it('shows what was new and both answers', () => {
    render(<ActiveSessions sessions={SESSIONS as never} alerts={[alert()]} />);
    const row = screen.getByText('Firefox on Windows', { selector: 'span' }).closest('li')!;
    expect(within(row).getByText('New device')).toBeTruthy();
    expect(within(row).getByText('New country: Mexico')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'This was me' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'This was not me' })).toBeTruthy();
    // The other session has no alert.
    const other = screen.getByText('Safari on macOS', { selector: 'span' }).closest('li')!;
    expect(within(other).queryByText('New device')).toBeNull();
  });

  it('"This was me" sends the alert id and refreshes', async () => {
    render(<ActiveSessions sessions={SESSIONS as never} alerts={[alert()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'This was me' }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledWith({ alertId: alert().id }));
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it('"This was not me" asks once more, then reports and goes to reset the password', async () => {
    render(<ActiveSessions sessions={SESSIONS as never} alerts={[alert()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'This was not me' }));
    expect(h.report).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/ends every session of your account, this one too/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'End every session' }));
    await waitFor(() => expect(h.report).toHaveBeenCalledWith({ alertId: alert().id }));
    await waitFor(() => expect(h.assign).toHaveBeenCalledWith('/reset'));
  });

  it('the question says what happens and no more: an open device has up to about an hour, the reset closes the door', async () => {
    render(<ActiveSessions sessions={SESSIONS as never} alerts={[alert()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'This was not me' }));
    const dialog = await screen.findByRole('dialog');
    const words = dialog.textContent ?? '';
    expect(words).toContain('End every session?');
    expect(words).toContain(
      'A device that is already open can keep working for a short while, until its current pass expires. That is about an hour at most.',
    );
    expect(words).toContain('Then reset your password. That is what closes the door.');
    expect(words).not.toMatch(/signs you out|sign me out|every device|everywhere|right away/i);
    // Whether anyone is told is not known before the press.
    expect(words).not.toMatch(/owners and admins/);
  });

  it('an alert already reported elsewhere: says so, stays on the page and reloads the list', async () => {
    h.report.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message: 'You already reported this sign-in. Every session of your account was ended then.' },
    });
    render(<ActiveSessions sessions={SESSIONS as never} alerts={[alert()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'This was not me' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'End every session' }));
    expect(await within(dialog).findByText(/You already reported this sign-in/)).toBeTruthy();
    expect(h.assign).not.toHaveBeenCalled();
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it('a report that could not finish stays on the page and says why', async () => {
    h.report.mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'We could not finish this just now. Press the button again in a minute.' },
    });
    render(<ActiveSessions sessions={SESSIONS as never} alerts={[alert()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'This was not me' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'End every session' }));
    expect(await within(dialog).findByText(/could not finish this just now/)).toBeTruthy();
    expect(h.assign).not.toHaveBeenCalled();
  });

  it('an alert answered "this was me" shows the badges and no answer buttons on its session', () => {
    render(<ActiveSessions sessions={SESSIONS as never} alerts={[alert({ status: 'was_me' })]} />);
    const row = screen.getByText('Firefox on Windows', { selector: 'span' }).closest('li')!;
    expect(within(row).getByText('New device')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'This was me' })).toBeNull();
    expect(within(row).getByText('You said this was you.')).toBeTruthy();
  });
});

describe('Recent sign-in alerts', () => {
  it('lists the alerts whose session has ended, with their answer', () => {
    render(
      <ActiveSessions
        sessions={SESSIONS as never}
        alerts={[
          alert({ id: 'a1e27000-0000-4000-8000-000000000002', sessionId: ENDED, newCountry: false, city: null }),
          alert({ id: 'a1e27000-0000-4000-8000-000000000003', sessionId: null, newDevice: false, status: 'not_me', deviceLabel: 'StockPilot app on iPhone' }),
        ]}
      />,
    );
    const recent = screen.getByRole('region', { name: 'Recent sign-in alerts' });
    const items = within(recent).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Firefox on Windows')).toBeTruthy();
    expect(within(items[0]!).getByText(/Mexico \(approximate\)/)).toBeTruthy();
    expect(within(items[0]!).getByRole('button', { name: 'This was not me' })).toBeTruthy();
    expect(within(items[1]!).getByText('StockPilot app on iPhone')).toBeTruthy();
    expect(within(items[1]!).getByText(/^You reported this sign-in\./)).toBeTruthy();
    // A reported alert cannot be reported again: neither answer is offered.
    expect(within(items[1]!).queryByRole('button', { name: 'This was not me' })).toBeNull();
    expect(within(items[1]!).queryByRole('button', { name: 'This was me' })).toBeNull();
  });

  it('a reported alert says the sessions were ended then, and has the existing "Sign out all other devices" control next to it', async () => {
    render(
      <ActiveSessions
        sessions={SESSIONS as never}
        alerts={[alert({ sessionId: null, status: 'not_me' })]}
      />,
    );
    const recent = screen.getByRole('region', { name: 'Recent sign-in alerts' });
    const item = within(recent).getByRole('listitem');
    expect(item.textContent).toContain(
      'You reported this sign-in. Every session of your account was ended then. If someone is using your account again, sign out all other devices and reset your password.',
    );
    expect(item.textContent).not.toMatch(/signed out|everywhere|right away/i);
    fireEvent.click(within(item).getByRole('button', { name: 'Sign out all other devices' }));
    await waitFor(() => expect(h.revokeOthers).toHaveBeenCalledTimes(1));
    expect(h.report).not.toHaveBeenCalled();
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it('with no other device signed in, a reported alert shows its state and no control', () => {
    render(
      <ActiveSessions
        sessions={SESSIONS.filter((s) => s.isCurrent) as never}
        alerts={[alert({ sessionId: null, status: 'not_me' })]}
      />,
    );
    const item = within(screen.getByRole('region', { name: 'Recent sign-in alerts' })).getByRole('listitem');
    expect(within(item).getByText(/^You reported this sign-in\./)).toBeTruthy();
    expect(within(item).queryByRole('button')).toBeNull();
  });

  it('no alerts, or alerts that could not be read: no list (and a plain line for the second)', () => {
    const { unmount } = render(<ActiveSessions sessions={SESSIONS as never} alerts={[]} />);
    expect(screen.queryByRole('region', { name: 'Recent sign-in alerts' })).toBeNull();
    unmount();
    render(<ActiveSessions sessions={SESSIONS as never} alerts={null} />);
    expect(screen.queryByRole('region', { name: 'Recent sign-in alerts' })).toBeNull();
    expect(screen.getByText('Your sign-in alerts could not be loaded just now.')).toBeTruthy();
  });

  it('without the alerts prop the list renders as before', () => {
    render(<ActiveSessions sessions={SESSIONS as never} />);
    expect(screen.queryByText('Your sign-in alerts could not be loaded just now.')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recent sign-in alerts' })).toBeNull();
  });
});
