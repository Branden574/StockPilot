import { render, screen, within } from '@testing-library/react';
import { isValidElement, Suspense, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The platform console's Security events page. Pinned: the gate
 * (requirePlatformAdmin) runs before the read, and a refused gate reads
 * nothing; every organization's rows and the rows with no organization, with
 * the organization's name (its id when the name could not be read); the
 * place, and none for an entry that counts events past a cap; the empty
 * words; the Passkeys section above the events list.
 *
 * And the security briefing section: after the Passkeys section and before
 * the events list, inside <Suspense> (so a slow briefing never delays the
 * passkey switches); handed the ?org= value and the platform admin the gate
 * answered; an ?org= that is not a uuid is Page not found before anything is
 * read.
 */

const h = vi.hoisted(() => ({
  order: [] as string[],
  list: vi.fn(),
  gate: vi.fn(),
  briefingProps: [] as Array<Record<string, unknown>>,
}));

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

vi.mock('@/components/platform/platform-security-briefing-section', () => ({
  PlatformSecurityBriefingSection: (props: Record<string, unknown>) => {
    h.order.push('briefing');
    h.briefingProps.push(props);
    return <section aria-label="Security briefing section" />;
  },
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import { PlatformPasskeysSection } from '@/components/platform/platform-passkeys-section';
import { PlatformSecurityBriefingSection } from '@/components/platform/platform-security-briefing-section';

import Page from './page';

/** The page as a request for /platform/security, with its query string. */
function PlatformSecurityEventsPage(query: { org?: string | string[] } = {}) {
  return Page({ searchParams: Promise.resolve(query) });
}

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
  h.briefingProps = [];
  h.gate.mockResolvedValue({ userId: 'p1', email: 'owner@example.com' });
  h.list.mockResolvedValue([row()]);
});

describe('the gate', () => {
  it('requirePlatformAdmin runs before the reads', async () => {
    render(await PlatformSecurityEventsPage());
    // The gate first; then the events, then the passkey switches, then the briefing.
    expect(h.order).toEqual(['gate', 'read', 'passkeys', 'briefing']);
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

/** Every element of a rendered tree, in document order, with the elements it sits inside. */
function elements(
  node: ReactNode,
  inside: ReactElement[] = [],
): Array<{ el: ReactElement; inside: ReactElement[] }> {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, inside));
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [{ el, inside }, ...elements(el.props.children, [...inside, el])];
}

describe('the security briefing section', () => {
  const ORG_PARAM = '5eed0000-0001-4000-8000-0000000000aa';

  it('comes after the Passkeys section and before the events list', async () => {
    render(await PlatformSecurityEventsPage());
    const passkeys = screen.getByRole('region', { name: 'Passkeys section' });
    const briefing = screen.getByRole('region', { name: 'Security briefing section' });
    const events = screen.getByRole('region', { name: 'Security events' });
    expect(
      passkeys.compareDocumentPosition(briefing) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      briefing.compareDocumentPosition(events) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('is inside <Suspense>, and the Passkeys section is not: the switches never wait for the briefing', async () => {
    const tree = elements(await PlatformSecurityEventsPage());
    const briefing = tree.find((e) => e.el.type === PlatformSecurityBriefingSection);
    const passkeys = tree.find((e) => e.el.type === PlatformPasskeysSection);
    expect(briefing).toBeDefined();
    expect(passkeys).toBeDefined();

    const boundary = briefing!.inside.find((e) => e.type === Suspense) as
      ReactElement<{ fallback: ReactNode }> | undefined;
    expect(boundary).toBeDefined();
    expect(passkeys!.inside.some((e) => e.type === Suspense)).toBe(false);
    // The Passkeys section is before the boundary in the page.
    expect(tree.indexOf(passkeys!)).toBeLessThan(tree.findIndex((e) => e.el === boundary));

    // What is shown while the briefing is being read.
    render(<>{boundary!.props.fallback}</>);
    expect(screen.getByText("Checking this week's summary...")).toBeInTheDocument();
  });

  it('no ?org=: the section is asked for all organizations only, for the admin the gate answered', async () => {
    render(await PlatformSecurityEventsPage());
    expect(h.briefingProps).toEqual([
      { organizationId: null, actor: { userId: 'p1', email: 'owner@example.com' } },
    ]);
  });

  it('?org=<uuid>: the section is handed that organization; a repeated ?org= hands the first', async () => {
    render(await PlatformSecurityEventsPage({ org: ORG_PARAM }));
    expect(h.briefingProps[0]).toMatchObject({ organizationId: ORG_PARAM });
    h.briefingProps = [];
    render(await PlatformSecurityEventsPage({ org: [ORG_PARAM, 'second'] }));
    expect(h.briefingProps[0]).toMatchObject({ organizationId: ORG_PARAM });
  });

  it('an ?org= that is not a uuid is Page not found: no read, and no section to write an audit row', async () => {
    for (const org of [
      'not-a-uuid',
      '',
      '------------------------------------',
      ['x', ORG_PARAM],
    ]) {
      h.order = [];
      await expect(PlatformSecurityEventsPage({ org })).rejects.toThrow('NEXT_NOT_FOUND');
      // The gate ran; nothing was read and nothing was rendered.
      expect(h.order).toEqual(['gate']);
    }
    expect(h.list).not.toHaveBeenCalled();
    expect(h.briefingProps).toEqual([]);
  });

  it('a refused gate checks no ?org= and renders no section', async () => {
    h.gate.mockRejectedValueOnce(new Error('NEXT_REDIRECT'));
    await expect(PlatformSecurityEventsPage({ org: 'not-a-uuid' })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(h.order).toEqual(['gate']);
  });
});
