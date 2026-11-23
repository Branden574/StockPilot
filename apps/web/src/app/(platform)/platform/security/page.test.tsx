import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The platform console's Security events page. Pinned: the gate
 * (requirePlatformAdmin) runs before the read, and a refused gate reads
 * nothing; every organization's rows and the rows with no organization, with
 * the organization's name (its id when the name could not be read); the
 * place, and none for an entry that counts events past a cap; the empty
 * words; the Passkeys section above the events list.
 */

const h = vi.hoisted(() => ({ order: [] as string[], list: vi.fn(), gate: vi.fn() }));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      prefetch,
      children,
      className,
    }: {
      href: string;
      prefetch?: boolean | null;
      children: React.ReactNode;
      className?: string;
    }) =>
      React.createElement('a', { href, className, 'data-prefetch': String(prefetch) }, children),
  };
});
vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: async () => {
    h.order.push('gate');
    return h.gate();
  },
}));
vi.mock('@/server/services/platform/security-events', () => ({
  PLATFORM_SECURITY_EVENT_LIMIT: 200,
  listPlatformSecurityEvents: (...a: unknown[]) => {
    h.order.push('read');
    return h.list(...a);
  },
}));

vi.mock('@/components/platform/platform-passkeys-section', () => ({
  PlatformPasskeysSection: () => {
    h.order.push('passkeys');
    return <section aria-label="Passkeys section" />;
  },
}));

import PlatformSecurityEventsPage from './page';

const ORG = '5eed0000-0001-4000-8000-000000000001';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    minute: '2026-11-20T10:15:00Z',
    lastSeenAt: '2026-11-20T10:15:31Z',
    category: 'exploit',
    outcome: 'blocked',
    reason: 'env_file',
    source: 'web',
    organizationId: null,
    organizationName: null,
    country: 'DE',
    city: 'Leipzig',
    count: 12,
    ...over,
  };
}

beforeEach(() => {
  h.order = [];
  h.gate.mockResolvedValue({ userId: 'p1' });
  h.list.mockResolvedValue([row()]);
});

describe('the gate', () => {
  it('requirePlatformAdmin runs before the reads', async () => {
    render(await PlatformSecurityEventsPage());
    // The gate first; then the events, then the passkey switches.
    expect(h.order).toEqual(['gate', 'read', 'passkeys']);
    expect(h.list).toHaveBeenCalledWith({ limit: 200 });
  });

  it('a refused gate reads nothing', async () => {
    h.gate.mockRejectedValueOnce(new Error('NEXT_REDIRECT'));
    await expect(PlatformSecurityEventsPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(h.order).toEqual(['gate']);
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe('the table', () => {
  it('rows of every organization and none, with names, places and counts', async () => {
    h.list.mockResolvedValueOnce([
      row(),
      row({
        id: 'e2',
        category: 'password_guessing',
        reason: 'wrong_password',
        organizationId: ORG,
        organizationName: 'Example School District',
        country: 'US',
        city: 'Fresno',
        count: 3,
      }),
      row({
        id: 'e3',
        category: 'password_guessing',
        reason: 'over_minute_cap',
        organizationId: ORG,
        organizationName: null,
        country: null,
        city: null,
        count: 4100,
      }),
    ]);
    render(await PlatformSecurityEventsPage());
    const table = screen.getByRole('region', { name: 'Security events' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(
      rows.map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      [
        '20 Nov 2026, 10:15 UTC',
        'Request for a settings fileExploit attempts · Blocked',
        'No organization',
        'Leipzig, DE',
        'Website',
        '12',
      ],
      [
        '20 Nov 2026, 10:15 UTC',
        'Wrong password at sign-inPassword guessing · Blocked',
        'Example School District',
        'Fresno, US',
        'Website',
        '3',
      ],
      [
        '20 Nov 2026, 10:15 UTC',
        'More events than could be listedPassword guessing · Blocked',
        ORG,
        '—',
        'Website',
        '4,100',
      ],
    ]);
    const links = within(table).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `/platform/orgs/${ORG}`,
      `/platform/orgs/${ORG}`,
    ]);
    // Opening an organization's page writes an audit row, so its link is
    // never prefetched.
    expect(links.map((a) => a.getAttribute('data-prefetch'))).toEqual(['false', 'false']);
  });

  it('nothing recorded: the empty words', async () => {
    h.list.mockResolvedValueOnce([]);
    render(await PlatformSecurityEventsPage());
    expect(screen.getByText('No security events recorded yet.')).toBeTruthy();
  });

  it('the Passkeys section comes before the events list, so the kill switch is never below it', async () => {
    h.list.mockResolvedValue([row(), row({ id: 'e2' })]);
    render(await PlatformSecurityEventsPage());
    const passkeys = screen.getByRole('region', { name: 'Passkeys section' });
    const events = screen.getByRole('region', { name: 'Security events' });
    expect(
      passkeys.compareDocumentPosition(events) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows the Passkeys section after the gate, and a refused gate shows none', async () => {
    h.order = [];
    h.gate.mockResolvedValue(undefined);
    h.list.mockResolvedValue([]);
    render(await PlatformSecurityEventsPage());
    expect(screen.getByRole('region', { name: 'Passkeys section' })).toBeInTheDocument();
    expect(h.order[0]).toBe('gate');
    expect(h.order).toContain('passkeys');
    h.order = [];
    h.gate.mockRejectedValue(new Error('NOT_FOUND'));
    await expect(PlatformSecurityEventsPage()).rejects.toThrow('NOT_FOUND');
    expect(h.order).toEqual(['gate']);
  });
});
