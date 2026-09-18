import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ClientRelease } from '@stockpilot/core';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
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
