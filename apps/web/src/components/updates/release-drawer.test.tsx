import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientRelease } from '@stockpilot/core';

const nav = vi.hoisted(() => ({ prefetch: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/inventory',
  useRouter: () => ({ prefetch: nav.prefetch }),
}));
// A plain anchor that records the prefetch it was given (data-prefetch), so a
// test can read what each link in the drawer asks for.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean | null;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

import { ReleaseDrawer, type ReleaseDrawerProps } from './release-drawer';

const release: ClientRelease = {
  id: 'september-2026',
  revision: 1,
  status: 'published',
  version: '2026.09',
  title: 'September improvements',
  summary: 'Faster staging and clearer stock numbers.',
  publishedAt: '2026-09-18T17:00:00Z',
  entryCount: 2,
  state: { read: false, dismissed: false },
  entries: [
    {
      id: 'staging',
      category: 'improved',
      area: 'Inventory',
      title: 'Find staged stock faster',
      whatChanged: 'Staging has a search box.',
      whyItMatters: 'Long lists were slow to scan.',
      howItAffectsYou: 'Type part of a name to narrow the list.',
      whatToDo: 'No action needed.',
      link: { href: '/dashboard/inventory/staging', label: 'Open Staging' },
    },
    {
      id: 'email',
      category: 'action',
      area: 'Account',
      title: 'Confirm your sign-in email',
      whatChanged: 'You can change your sign-in email.',
      whyItMatters: 'Addresses change.',
      howItAffectsYou: 'You confirm from both addresses.',
      whatToDo: 'Check the address on your profile.',
    },
  ],
};

function setup(over: Partial<ReleaseDrawerProps> = {}) {
  const props: ReleaseDrawerProps = {
    open: true,
    detail: { phase: 'ready', release },
    refreshRequired: false,
    rolledBack: false,
    blockedBy: [],
    saveFailed: false,
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onRefresh: vi.fn(),
    onRefreshAnyway: vi.fn(),
    onKeepWorking: vi.fn(),
    onLinkClick: vi.fn(),
    ...over,
  };
  render(<ReleaseDrawer {...props} />);
  return props;
}

describe('ReleaseDrawer', () => {
  it('is a real, labelled dialog', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'What’s New' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('The latest improvements to StockPilot')).toBeInTheDocument();
  });

  it('shows identity, availability, highlights, and every change answering the four questions', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'September improvements' })).toBeInTheDocument();
    expect(screen.getByText('2026.09')).toBeInTheDocument();
    expect(screen.getByText('Available now')).toBeInTheDocument();
    expect(screen.getByText('Faster staging and clearer stock numbers.')).toBeInTheDocument();
    const card = screen
      .getByRole('heading', { name: 'Find staged stock faster' })
      .closest('article')!;
    for (const label of [
      'What changed',
      'Why it matters',
      'How this affects you',
      'What you need to do',
    ]) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
    // Category is a TEXT label, never colour alone.
    expect(within(card).getByText('Improved')).toBeInTheDocument();
    expect(screen.getByText('Action needed')).toBeInTheDocument();
  });

  it('keeps long explanations folded until asked, but opens an entry that NEEDS action', () => {
    setup();
    const folded = screen
      .getByRole('heading', { name: 'Find staged stock faster' })
      .closest('article')!;
    const toggle = within(folded).getByRole('button', { name: /why it matters/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const action = screen
      .getByRole('heading', { name: 'Confirm your sign-in email' })
      .closest('article')!;
    expect(within(action).getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('when this tab is behind: says refresh is required, holds feature links back, and offers the refresh', () => {
    const p = setup({ refreshRequired: true });
    expect(screen.getByText('Refresh required')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open staging/i })).toBeNull();
    expect(screen.getByText('Available after you refresh.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /refresh to update/i }));
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('when this tab is current: working feature links and NO refresh button', () => {
    const p = setup();
    expect(screen.queryByRole('button', { name: /refresh to update/i })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: /open staging/i }));
    expect(p.onLinkClick).toHaveBeenCalledTimes(1);
  });

  it('a withdrawn release explains itself and sends nobody anywhere', () => {
    setup({
      detail: {
        phase: 'ready',
        release: {
          ...release,
          status: 'withdrawn',
          withdrawnNote: 'Rolled back while we fix an issue.',
          entries: [],
        },
      },
    });
    expect(screen.getByText('Withdrawn')).toBeInTheDocument();
    expect(screen.getByText('Rolled back while we fix an issue.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open/i })).toBeNull();
    expect(screen.queryByText('Highlights')).toBeNull();
  });

  it('loading holds the layout and says it is busy', () => {
    setup({ detail: { phase: 'loading', releaseId: 'september-2026' } });
    expect(screen.getByRole('status', { name: 'Loading release details' })).toBeInTheDocument();
  });

  it('a failed load says so, reassures about the page behind, and offers a retry', () => {
    const p = setup({ detail: { phase: 'error', releaseId: 'september-2026', offline: false } });
    expect(screen.getByRole('alert')).toHaveTextContent('The release details could not be loaded');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Nothing on the page behind this panel was changed',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(p.onRetry).toHaveBeenCalledTimes(1);
  });

  it('offline is named as offline', () => {
    setup({ detail: { phase: 'error', releaseId: 'september-2026', offline: true } });
    expect(screen.getByRole('alert')).toHaveTextContent('You are offline');
  });

  it('says so when the read could not be saved, instead of pretending', () => {
    setup({ saveFailed: true });
    expect(screen.getByText(/could not save that you read this/i)).toBeInTheDocument();
  });

  it('guards the refresh inside the drawer too', () => {
    const p = setup({ refreshRequired: true, blockedBy: [{ id: 'item-form', label: 'New item' }] });
    expect(screen.getByText('Refresh StockPilot?')).toBeInTheDocument();
    expect(screen.getByText(/unsaved changes in New item/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }));
    expect(p.onKeepWorking).toHaveBeenCalledTimes(1);
  });

  it('closes from its own labelled button and from Escape', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Close What’s New' }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  it('links to the permanent history, and closes on the way', () => {
    const p = setup();
    const link = screen.getByRole('link', { name: 'View release history' });
    expect(link).toHaveAttribute('href', '/dashboard/whats-new');
    fireEvent.click(link);
    expect(p.onClose).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    setup({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/**
 * NO LINK IN THE DRAWER PREFETCHES ITS PAGE ON SIGHT (PLAN 0.6; P2.3 review
 * follow-up). A default <Link> prefetches as soon as it is on screen: opening
 * the drawer fetched every entry's feature page and the history page at once,
 * two requests each, and the release page (whats-new/[slug]) did the same for
 * every entry it lists. Each link warms its page when a person comes to it
 * instead, as the top bar's links do.
 */
describe('the drawer warms a page when a person comes to its link, never on sight', () => {
  // The entry card's feature link and the drawer's own history link.
  const LINKS = ['/dashboard/inventory/staging', '/dashboard/whats-new'];

  /** A spy's calls with every non-string reduced to its type, safe to print. */
  const callsOf = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : `<${typeof a}>`)));

  beforeEach(() => nav.prefetch.mockReset());

  // Mutation caught: prefetch={false} dropped from the entry link or the
  // history link, or a new link added to the drawer without it.
  it('every link in the drawer is rendered with prefetch={false}, and opening it warms nothing', () => {
    setup();
    const links = within(screen.getByRole('dialog')).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href')).sort()).toEqual([...LINKS].sort());
    for (const a of links) {
      expect(a, a.getAttribute('href') ?? '').toHaveAttribute('data-prefetch', 'false');
    }
    expect(callsOf(nav.prefetch)).toEqual([]);
  });

  // Mutation caught: a link left with no warm-up (its click then waits for the
  // whole page), or a handler that hands the warm-up the event, not the href.
  it.each([
    ['hover', (el: Element) => fireEvent.pointerEnter(el)],
    ['keyboard focus', (el: Element) => fireEvent.focus(el)],
    ['pointer-down', (el: Element) => fireEvent.pointerDown(el)],
  ])('%s on the entry link or the history link warms that page', (_label, approach) => {
    setup();
    const dialog = screen.getByRole('dialog');
    for (const href of LINKS) {
      nav.prefetch.mockClear();
      const link = within(dialog)
        .getAllByRole('link')
        .find((a) => a.getAttribute('href') === href)!;
      approach(link);
      expect(callsOf(nav.prefetch), href).toEqual([[href]]);
    }
  });

  it('an entry whose link is held back (this tab is behind) has nothing to warm', () => {
    setup({ refreshRequired: true });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Available after you refresh.')).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/dashboard/whats-new']);
  });
});
