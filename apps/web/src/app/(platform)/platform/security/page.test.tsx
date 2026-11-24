import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { cloneElement, isValidElement, Suspense, type ReactElement, type ReactNode } from 'react';
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
 *
 * And the events list on its own: the page body answers its tree without
 * reading the events (so the gate, the header, the Passkeys section and the
 * briefing never wait for them); the list is the last part, inside a
 * <Suspense> of its own; a read that fails is a notice in the table's place
 * and one warning, never a thrown page.
 */

const h = vi.hoisted(() => ({
  order: [] as string[],
  list: vi.fn(),
  gate: vi.fn(),
  report: vi.fn(),
  briefingProps: [] as Array<Record<string, unknown>>,
  passkeysProps: [] as Array<Record<string, unknown>>,
  zone: null as string | null,
}));
vi.mock('@/lib/platform/viewer-time-zone', () => ({
  readPlatformViewerTimeZone: async () => {
    h.order.push('zone');
    return h.zone;
  },
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      prefetch,
      children,
      className,
      ...rest
    }: {
      href: string;
      prefetch?: boolean | null;
      children: React.ReactNode;
      className?: string;
    }) =>
      React.createElement(
        'a',
        { ...rest, href, className, 'data-prefetch': String(prefetch) },
        children,
      ),
  };
});
vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: async () => {
    h.order.push('gate');
    return h.gate();
  },
}));
vi.mock('@/lib/error-reporter', async () => {
  const core = await vi.importActual<typeof import('@/lib/error-reporter-core')>(
    '@/lib/error-reporter-core',
  );
  return {
    isNextControlFlowError: core.isNextControlFlowError,
    reportError: async (...a: unknown[]) => {
      h.report(...a);
    },
  };
});
vi.mock('@/server/services/platform/security-events', () => ({
  PLATFORM_SECURITY_EVENT_LIMIT: 200,
  listPlatformSecurityEvents: (...a: unknown[]) => {
    h.order.push('read');
    return h.list(...a);
  },
}));

vi.mock('@/components/platform/platform-passkeys-section', () => ({
  PlatformPasskeysSection: (props: Record<string, unknown>) => {
    h.order.push('passkeys');
    h.passkeysProps.push(props);
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

/**
 * A tree with its async server components awaited in place, as the server
 * streams them in: jsdom's React renders only what is already there. The
 * page's own function is not one of them; it is awaited by the caller.
 */
async function settled(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(settled));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === 'function' && el.type.constructor.name === 'AsyncFunction') {
    const component = el.type as unknown as (props: unknown) => Promise<ReactNode>;
    return settled(await component(el.props));
  }
  const children = el.props.children;
  if (children === undefined) return el;
  const done = Array.isArray(children)
    ? await Promise.all(children.map(settled))
    : [await settled(children)];
  return cloneElement(el, undefined, ...done);
}

/** The whole page on screen: the body's tree, then every streamed part. */
async function renderPage(query: { org?: string | string[] } = {}) {
  return render(<>{await settled(await PlatformSecurityEventsPage(query))}</>);
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
  h.passkeysProps = [];
  h.zone = null;
  h.report.mockReset();
  h.gate.mockResolvedValue({ userId: 'p1', email: 'owner@example.com' });
  h.list.mockResolvedValue([row()]);
});

describe('the gate', () => {
  it('requirePlatformAdmin runs before the reads', async () => {
    await renderPage();
    // The gate first. (The events read is second here only because this
    // test awaits the streamed parts before it draws anything.)
    expect(h.order).toEqual(['gate', 'zone', 'read', 'passkeys', 'briefing']);
    expect(h.list).toHaveBeenCalledWith({ limit: 200 });
  });

  it('the page body answers its tree without reading the events: nothing above the list waits for them', async () => {
    const tree = await PlatformSecurityEventsPage();
    // The gate has answered (and the viewer's zone, from the load the gate
    // made), and the tree is back, with no events read asked.
    expect(h.order).toEqual(['gate', 'zone']);
    expect(h.list).not.toHaveBeenCalled();
    // The Passkeys section and the briefing are in that tree already.
    const parts = elements(tree).map((e) => e.el.type);
    expect(parts).toContain(PlatformPasskeysSection);
    expect(parts).toContain(PlatformSecurityBriefingSection);
  });

  it('a refused gate reads nothing', async () => {
    h.gate.mockRejectedValueOnce(new Error('NEXT_REDIRECT'));
    await expect(PlatformSecurityEventsPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(h.order).toEqual(['gate']);
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe('the attack map', () => {
  it('a clear button to it in the header, never prefetched; the map itself is not on this page', async () => {
    await renderPage();
    // The owner could not find a small text link (2026-11-24): the console's outline
    // button, as Act as this org on an organization's page, with the button's focus ring.
    const link = screen.getByRole('link', { name: 'Open attack map' });
    expect(link).toHaveAttribute('href', '/platform/security/map');
    expect(link).toHaveAttribute('data-prefetch', 'false');
    expect(link).toHaveAttribute('data-glass', 'button');
    expect(link).toHaveAttribute('data-glass-variant', 'outline');
    expect(link.className).toContain('focus-visible:ring-2');
    expect(screen.queryByRole('link', { name: 'Attack map' })).toBeNull();
    // The link is in the header, before the Passkeys section.
    expect(
      link.compareDocumentPosition(screen.getByRole('region', { name: 'Passkeys section' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Attack map' })).toBeNull();
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
    await renderPage();
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
        '20 Nov 2026, 10:15 AM UTC',
        'Request for a settings fileExploit attempts · Blocked',
        'No organization',
        'Leipzig, DE',
        'Website',
        '12',
        'Stopped: nothing to doHow to respond',
      ],
      [
        '20 Nov 2026, 10:15 AM UTC',
        'Wrong password at sign-inPassword guessing · Blocked',
        'Example School District',
        'Fresno, US',
        'Website',
        '3',
        'Stopped: nothing to doHow to respond',
      ],
      [
        '20 Nov 2026, 10:15 AM UTC',
        'More events than could be listedPassword guessing · Blocked',
        ORG,
        '—',
        'Website',
        '4,100',
        'Look todayHow to respond',
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
    // Each row's "How to respond" is named for its event, so a list of them can be told apart.
    expect(
      within(table)
        .getAllByRole('button', { name: /^How to respond: / })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'How to respond: Request for a settings file',
      'How to respond: Wrong password at sign-in',
      'How to respond: More events than could be listed',
    ]);
  });

  it("each event's How to respond opens its card, with what the row shows on top and its organization in the links", async () => {
    h.list.mockResolvedValueOnce([
      row({
        id: 'e2',
        category: 'password_guessing',
        reason: 'wrong_password',
        organizationId: ORG,
        organizationName: 'Example School District',
        country: 'US',
        city: 'Example Falls',
        count: 3,
      }),
      row({
        id: 'e3',
        category: 'password_guessing',
        reason: 'over_minute_cap',
        organizationId: null,
        country: null,
        city: null,
        count: 4100,
      }),
    ]);
    await renderPage();
    const facts = (panel: HTMLElement) =>
      [...within(panel).getByTestId('security-response-context').querySelectorAll('dt')].map(
        (dt) => [dt.textContent, dt.nextElementSibling?.textContent],
      );
    fireEvent.click(
      screen.getByRole('button', { name: 'How to respond: Wrong password at sign-in' }),
    );
    let panel = await screen.findByRole('dialog');
    expect(panel).toHaveAttribute('data-card', 'wrong-password');
    expect(facts(panel)).toEqual([
      ['Kind', 'Password guessing'],
      // The country's name, as a card opened from the map says it (lab walk 3, F5).
      ['Where', 'Example Falls, United States'],
      ['When', '20 Nov 2026, 10:15 AM UTC'],
      ['Organization', 'Example School District'],
    ]);
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // A count past a cap has no place; an event of no organization says so.
    fireEvent.click(
      screen.getByRole('button', { name: 'How to respond: More events than could be listed' }),
    );
    panel = await screen.findByRole('dialog');
    expect(panel).toHaveAttribute('data-card', 'counts-past-limit');
    expect(facts(panel)).toEqual([
      ['Kind', 'Password guessing'],
      ['When', '20 Nov 2026, 10:15 AM UTC'],
      ['Organization', 'No organization'],
    ]);
  });

  it('a refused file is "Malware" on the console, never "Refused file" (part 6), and opens the card of its reason', async () => {
    h.list.mockResolvedValueOnce([
      row({ id: 'e6', category: 'malware', reason: 'upload_hidden_file', organizationId: ORG, organizationName: 'Example School District', count: 1 }),
    ]);
    await renderPage();
    const table = screen.getByRole('region', { name: 'Security events' });
    expect(within(table).getByText(/^Malware · Blocked$/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Refused file/);
    fireEvent.click(
      screen.getByRole('button', { name: 'How to respond: A file with another file hidden inside it was refused' }),
    );
    const panel = await screen.findByRole('dialog');
    expect(panel).toHaveAttribute('data-card', 'upload-refused');
    expect(panel.textContent).not.toMatch(/Refused file/);
  });

  it('a sign-in alert is named "Sign-in alert": no text on the page or in its card says Phishing or Malware (lab walk 3, F1)', async () => {
    h.list.mockResolvedValueOnce([
      row(),
      row({
        id: 'e4',
        category: 'phishing',
        outcome: 'flagged',
        reason: 'sign_in_new_country',
        organizationId: ORG,
        organizationName: 'Example School District',
        country: 'IT',
        city: 'Example Piazza',
        count: 1,
      }),
      row({
        id: 'e5',
        category: 'phishing',
        outcome: 'flagged',
        reason: 'sign_in_not_me',
        organizationId: ORG,
        organizationName: 'Example School District',
        country: 'PT',
        city: null,
        count: 1,
      }),
    ]);
    await renderPage();
    expect(document.body.textContent).not.toMatch(/phishing|malware/i);
    const table = screen.getByRole('region', { name: 'Security events' });
    expect(within(table).getAllByText(/^Sign-in alert · Flagged$/)).toHaveLength(2);
    const facts = (panel: HTMLElement) =>
      [...within(panel).getByTestId('security-response-context').querySelectorAll('dt')].map(
        (dt) => [dt.textContent, dt.nextElementSibling?.textContent],
      );
    for (const [what, where] of [
      // The city, then the country's name, as the map's card says it (F5).
      ['Sign-in from a new country', 'Example Piazza, Italy'],
      // No city: the country's name alone, never its code.
      ['A member said a sign-in was not them', 'Portugal'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: `How to respond: ${what}` }));
      const panel = await screen.findByRole('dialog');
      expect(panel.textContent, what).not.toMatch(/phishing|malware/i);
      expect(facts(panel).slice(0, 2), what).toEqual([
        ['Kind', 'Sign-in alert'],
        ['Where', where],
      ]);
      expect(document.body.textContent, what).not.toMatch(/phishing|malware/i);
      fireEvent.keyDown(panel, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it('each row\'s badge and "How to respond" stay on one line, "Stopped: nothing to do" too, so the rows are of one height (lab walk 3, F4)', async () => {
    h.list.mockResolvedValueOnce([
      row(),
      row({
        id: 'e2',
        category: 'password_guessing',
        reason: 'over_minute_cap',
        country: null,
        city: null,
      }),
      row({ id: 'e3', category: 'phishing', outcome: 'flagged', reason: 'sign_in_not_me' }),
    ]);
    await renderPage();
    const controls = [...document.querySelectorAll('[data-slot="security-response-control"]')];
    expect(controls.map((c) => c.getAttribute('data-level'))).toEqual(
      expect.arrayContaining(['stopped', 'look_today']),
    );
    expect(controls).toHaveLength(3);
    for (const c of controls) {
      const classes = c.className.split(/\s+/);
      expect(classes, c.getAttribute('data-level')!).toEqual(
        expect.arrayContaining(['flex-nowrap', 'whitespace-nowrap']),
      );
      expect(classes, c.getAttribute('data-level')!).not.toContain('flex-wrap');
      // The badge never wraps inside itself.
      expect(within(c as HTMLElement).getByTestId('security-response-level').className).toContain(
        'whitespace-nowrap',
      );
    }
  });

  it('the times are in the zone the viewer chose, named, with the exact UTC in the title and for screen readers; the sections are handed it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T06:00:00Z'));
    try {
      h.zone = 'America/Los_Angeles';
      h.list.mockResolvedValueOnce([
        row(),
        // The night the clocks go back: the same wall clock, PDT then PST.
        row({ id: 'e2', lastSeenAt: '2026-11-01T08:30:00Z' }),
        row({ id: 'e3', lastSeenAt: '2026-11-01T09:30:00Z' }),
      ]);
      await renderPage();
      const table = screen.getByRole('region', { name: 'Security events' });
      const times = [...table.querySelectorAll('tbody time')];
      expect(times.map((t) => t.firstChild?.textContent)).toEqual([
        '20 Nov 2026, 2:15 AM PST',
        '1 Nov 2026, 1:30 AM PDT',
        '1 Nov 2026, 1:30 AM PST',
      ]);
      expect(times.map((t) => t.getAttribute('title'))).toEqual([
        '20 Nov 2026, 10:15 UTC',
        '1 Nov 2026, 08:30 UTC',
        '1 Nov 2026, 09:30 UTC',
      ]);
      expect(times[0]!.querySelector('.sr-only')?.textContent).toBe(' (20 Nov 2026, 10:15 UTC)');
      expect(within(table).getByRole('columnheader', { name: 'When' })).toHaveAttribute(
        'title',
        'In Pacific Standard Time (America/Los_Angeles).',
      );
      expect(h.passkeysProps).toEqual([{ timeZone: 'America/Los_Angeles' }]);
      expect(h.briefingProps[0]).toMatchObject({ timeZone: 'America/Los_Angeles' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a zone east of UTC; and with no zone chosen the server prints UTC', async () => {
    h.zone = 'Europe/Berlin';
    h.list.mockResolvedValueOnce([row()]);
    const { unmount } = await renderPage();
    let cell = screen.getByRole('region', { name: 'Security events' }).querySelector('tbody time')!;
    expect(cell.firstChild?.textContent).toBe('20 Nov 2026, 11:15 AM GMT+1');
    unmount();
    h.zone = null;
    h.list.mockResolvedValueOnce([row()]);
    await renderPage();
    const table = screen.getByRole('region', { name: 'Security events' });
    cell = table.querySelector('tbody time')!;
    expect(cell.textContent).toBe('20 Nov 2026, 10:15 AM UTC');
    expect(cell.querySelector('.sr-only')).toBeNull();
    expect(within(table).getByRole('columnheader', { name: 'When' })).toHaveAttribute(
      'title',
      'In UTC.',
    );
  });

  it("a row's card says its time in the viewer's zone, with the exact UTC", async () => {
    h.zone = 'America/Los_Angeles';
    h.list.mockResolvedValueOnce([row()]);
    await renderPage();
    fireEvent.click(
      screen.getByRole('button', { name: 'How to respond: Request for a settings file' }),
    );
    const panel = await screen.findByRole('dialog');
    const when = [
      ...within(panel).getByTestId('security-response-context').querySelectorAll('dt'),
    ].find((dt) => dt.textContent === 'When')!.nextElementSibling!;
    expect(when.firstChild?.textContent).toBe('20 Nov 2026, 2:15 AM PST');
    expect(when).toHaveAttribute('title', '20 Nov 2026, 10:15 UTC');
    expect(when.querySelector('.sr-only')?.textContent).toBe(' (20 Nov 2026, 10:15 UTC)');
  });

  it('nothing recorded: the empty words', async () => {
    h.list.mockResolvedValueOnce([]);
    await renderPage();
    expect(screen.getByText('No security events recorded yet.')).toBeTruthy();
  });

  it('the Passkeys section comes before the events list, so the kill switch is never below it', async () => {
    h.list.mockResolvedValue([row(), row({ id: 'e2' })]);
    await renderPage();
    const passkeys = screen.getByRole('region', { name: 'Passkeys section' });
    const events = screen.getByRole('region', { name: 'Security events' });
    expect(
      passkeys.compareDocumentPosition(events) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("the read fails: the page is still drawn, with the Passkeys section, the briefing and a notice in the table's place", async () => {
    h.list.mockRejectedValue(new Error('security_events read failed (57014)'));
    // No throw: the failed read is not the page's failure.
    await renderPage();
    expect(screen.getByRole('region', { name: 'Passkeys section' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Security briefing section' })).toBeInTheDocument();
    const notice = screen.getByText(
      'Security events could not be loaded just now. Refresh to try again.',
    );
    // Where the table would be: after the briefing, and no table at all.
    expect(
      screen
        .getByRole('region', { name: 'Security briefing section' })
        .compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Security events' })).toBeNull();
    expect(screen.queryByText('No security events recorded yet.')).toBeNull();
    // The words of the error are for the log, never for the screen.
    expect(document.body.textContent).not.toMatch(/57014|read failed/);
  });

  it("the read fails: one warning under the list's own tag, with the error and nothing else", async () => {
    const failure = new Error('security_events read failed (57014)');
    h.list.mockRejectedValue(failure);
    await renderPage();
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(failure, {
      tag: 'platform.security-events.list',
      level: 'warning',
    });
    // A read that answers reports nothing.
    h.report.mockReset();
    h.list.mockResolvedValue([row()]);
    await renderPage();
    expect(h.report).not.toHaveBeenCalled();
  });

  it("a signal of Next's own from the read is passed on: not a notice, not a warning", async () => {
    for (const digest of ['NEXT_REDIRECT;replace;/signin;307;', 'NEXT_NOT_FOUND']) {
      const signal = Object.assign(new Error('NEXT'), { digest });
      h.list.mockRejectedValue(signal);
      await expect(renderPage()).rejects.toBe(signal);
    }
    expect(h.report).not.toHaveBeenCalled();
  });

  it('shows the Passkeys section after the gate, and a refused gate shows none', async () => {
    h.order = [];
    h.list.mockResolvedValue([]);
    await renderPage();
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
    await renderPage();
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

  it('the events list is inside a <Suspense> of its own, last: the switches and the briefing never wait for it', async () => {
    const tree = elements(await PlatformSecurityEventsPage());
    const named = (name: string) =>
      tree.find((e) => typeof e.el.type === 'function' && e.el.type.name === name);
    const list = named('PlatformSecurityEventsList');
    const briefing = tree.find((e) => e.el.type === PlatformSecurityBriefingSection);
    const passkeys = tree.find((e) => e.el.type === PlatformPasskeysSection);
    expect(list).toBeDefined();

    const boundaries = tree.filter((e) => e.el.type === Suspense).map((e) => e.el);
    expect(boundaries).toHaveLength(2);
    const ofList = list!.inside.filter((e) => e.type === Suspense);
    const ofBriefing = briefing!.inside.filter((e) => e.type === Suspense);
    // One boundary each, and not the same one: neither waits for the other.
    expect(ofList).toEqual([boundaries[1]]);
    expect(ofBriefing).toEqual([boundaries[0]]);
    expect(passkeys!.inside.some((e) => e.type === Suspense)).toBe(false);
    // The order on the page: Passkeys, the briefing, the events.
    expect(tree.indexOf(passkeys!)).toBeLessThan(tree.indexOf(briefing!));
    expect(tree.indexOf(briefing!)).toBeLessThan(tree.indexOf(list!));

    // What is shown while the events are being read.
    const fallback = (boundaries[1] as ReactElement<{ fallback: ReactNode }>).props.fallback;
    render(<>{fallback}</>);
    expect(screen.getByText('Loading security events...')).toBeInTheDocument();
  });

  it('no ?org=: the section is asked for all organizations only, for the admin the gate answered', async () => {
    await renderPage();
    expect(h.briefingProps).toEqual([
      { organizationId: null, actor: { userId: 'p1', email: 'owner@example.com' }, timeZone: null },
    ]);
  });

  it('?org=<uuid>: the section is handed that organization; a repeated ?org= hands the first', async () => {
    await renderPage({ org: ORG_PARAM });
    expect(h.briefingProps[0]).toMatchObject({ organizationId: ORG_PARAM });
    h.briefingProps = [];
    await renderPage({ org: [ORG_PARAM, 'second'] });
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
