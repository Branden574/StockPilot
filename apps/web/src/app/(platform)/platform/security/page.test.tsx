import { render, screen, within } from '@testing-library/react';
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
  h.report.mockReset();
  h.gate.mockResolvedValue({ userId: 'p1', email: 'owner@example.com' });
  h.list.mockResolvedValue([row()]);
});

describe('the gate', () => {
  it('requirePlatformAdmin runs before the reads', async () => {
    await renderPage();
    // The gate first. (The events read is second here only because this
    // test awaits the streamed parts before it draws anything.)
    expect(h.order).toEqual(['gate', 'read', 'passkeys', 'briefing']);
    expect(h.list).toHaveBeenCalledWith({ limit: 200 });
  });

  it('the page body answers its tree without reading the events: nothing above the list waits for them', async () => {
    const tree = await PlatformSecurityEventsPage();
    // The gate has answered, and the tree is back, with no events read asked.
    expect(h.order).toEqual(['gate']);
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
        '20 Nov 2026, 10:15 UTC',
        'Request for a settings fileExploit attempts · Blocked',
        'No organization',
        'Leipzig, DE',
        'Website',
        '12',
        'Stopped: nothing to doHow to respond',
      ],
      [
        '20 Nov 2026, 10:15 UTC',
        'Wrong password at sign-inPassword guessing · Blocked',
        'Example School District',
        'Fresno, US',
        'Website',
        '3',
        'Stopped: nothing to doHow to respond',
      ],
      [
        '20 Nov 2026, 10:15 UTC',
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
      { organizationId: null, actor: { userId: 'p1', email: 'owner@example.com' } },
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
