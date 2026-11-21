import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MySignInAlert } from '@/server/services/sign-in-alerts';

/**
 * Part 3 (sign-in alerts) on Active sessions: a session that has an alert
 * shows what was new ("New device", "New country: Mexico"), and while the
 * alert is open, "This was me" and "This was not me". Alerts whose session
 * has ended show under the list in "Recent sign-in alerts". "This was not me"
 * asks once more (it signs this device out too), then sends the member to
 * reset their password.
 */

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  report: vi.fn(),
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
  revokeOtherSessionsAction: vi.fn(),
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
    expect(within(dialog).getByText(/signs you out on every device, this one too/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign me out everywhere' }));
    await waitFor(() => expect(h.report).toHaveBeenCalledWith({ alertId: alert().id }));
    await waitFor(() => expect(h.assign).toHaveBeenCalledWith('/reset'));
  });

  it('a report that could not finish stays on the page and says why', async () => {
    h.report.mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'We could not sign you out everywhere just now. Press the button again in a minute.' },
    });
    render(<ActiveSessions sessions={SESSIONS as never} alerts={[alert()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'This was not me' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign me out everywhere' }));
    expect(await within(dialog).findByText(/could not sign you out everywhere/)).toBeTruthy();
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
    expect(within(items[1]!).getByText('You reported this sign-in.')).toBeTruthy();
    expect(within(items[1]!).queryByRole('button')).toBeNull();
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
