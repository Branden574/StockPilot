import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { UpdateCard, updateAnnouncement, type UpdateCardProps } from './update-card';

const release = {
  title: 'September improvements',
  version: '2026.09',
  publishedAt: '2026-09-18T17:00:00Z',
};

function setup(over: Partial<UpdateCardProps> = {}) {
  const props: UpdateCardProps = {
    model: { kind: 'update', release },
    blockedBy: [],
    onWhatsNew: vi.fn(),
    onRefresh: vi.fn(),
    onRefreshAnyway: vi.fn(),
    onKeepWorking: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  };
  render(<UpdateCard {...props} />);
  return props;
}

describe('UpdateCard', () => {
  it('a new build with a release: headline, explanation, release label and date, and TWO separate actions', () => {
    setup();
    expect(
      screen.getByRole('heading', { name: 'A new StockPilot update is available' }),
    ).toBeInTheDocument();
    expect(screen.getByText('See what changed and how it affects your work.')).toBeInTheDocument();
    expect(screen.getByText('2026.09')).toBeInTheDocument();
    expect(screen.getByText('Sep 18, 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /what’s new/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh to update/i })).toBeInTheDocument();
  });

  it('reading the notes and applying the update are separate: What’s New never refreshes', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /what’s new/i }));
    expect(p.onWhatsNew).toHaveBeenCalledTimes(1);
    expect(p.onRefresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /refresh to update/i }));
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
    expect(p.onWhatsNew).toHaveBeenCalledTimes(1);
  });

  it('a new build with NO release notes keeps the legitimate refresh and says the honest thing', () => {
    setup({ model: { kind: 'update', release: null } });
    expect(
      screen.getByText('Refresh when convenient to use the latest version.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /what’s new/i })).toBeNull();
    expect(screen.getByRole('button', { name: /refresh to update/i })).toBeInTheDocument();
  });

  it('already on the current version with unread notes: no unnecessary refresh button', () => {
    setup({ model: { kind: 'unread', release } });
    expect(screen.getByRole('heading', { name: 'What’s new in StockPilot' })).toBeInTheDocument();
    expect(
      screen.getByText('Explore the latest changes and see what they mean for your work.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.getByRole('button', { name: /what’s new/i })).toBeInTheDocument();
  });

  it('a rollback is not called new, and offers nothing to read', () => {
    setup({ model: { kind: 'rollback' } });
    expect(
      screen.getByRole('heading', { name: 'StockPilot was restored to an earlier version' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/new stockpilot update/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /what’s new/i })).toBeNull();
  });

  it('a reload that did not reach the new version says so, once, with a manual retry', () => {
    const p = setup({ model: { kind: 'reload-failed' } });
    expect(screen.getByRole('heading', { name: 'The update did not load' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(p.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('close dismisses and does nothing else', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
    expect(p.onDismiss).toHaveBeenCalledTimes(1);
    expect(p.onWhatsNew).not.toHaveBeenCalled();
    expect(p.onRefresh).not.toHaveBeenCalled();
  });

  it('is NONMODAL and never takes focus when it appears', () => {
    setup();
    expect(document.activeElement).toBe(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: 'Product update' })).toBeInTheDocument();
  });

  it('unsaved work: names it, focuses the SAFE answer, and makes "Refresh anyway" explicit', () => {
    const p = setup({
      blockedBy: [
        { id: 'item-form', label: 'New item' },
        { id: 'receive', label: 'Receiving PO-1042' },
      ],
    });
    expect(screen.getByRole('heading', { name: 'Refresh StockPilot?' })).toBeInTheDocument();
    expect(screen.getByText(/unsaved changes in New item, Receiving PO-1042/)).toBeInTheDocument();
    // It never claims the work is saved.
    expect(screen.queryByText(/saved your/i)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep working' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }));
    expect(p.onKeepWorking).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh anyway' }));
    expect(p.onRefreshAnyway).toHaveBeenCalledTimes(1);
    expect(p.onRefresh).not.toHaveBeenCalled();
  });
});

describe('the unsaved-work confirmation, for a keyboard or screen-reader user', () => {
  const blockedBy = [{ id: 'item-form', label: 'New item' }];

  it('says WHY focus moved: the button it lands on is described by the explanation', () => {
    setup({ blockedBy });
    const keep = screen.getByRole('button', { name: 'Keep working' });
    expect(keep).toHaveFocus();
    const described = document.getElementById(keep.getAttribute('aria-describedby')!);
    expect(described).toHaveTextContent('You have unsaved changes in New item.');
    expect(screen.getByRole('group', { name: 'Refresh StockPilot?' })).toBeInTheDocument();
  });

  it('hands focus BACK to Refresh after Keep working, instead of dropping it to <body>', () => {
    const props = {
      model: { kind: 'update', release } as const,
      onWhatsNew: vi.fn(),
      onRefresh: vi.fn(),
      onRefreshAnyway: vi.fn(),
      onKeepWorking: vi.fn(),
      onDismiss: vi.fn(),
    };
    const { rerender } = render(<UpdateCard {...props} blockedBy={blockedBy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }));
    rerender(<UpdateCard {...props} blockedBy={[]} />);
    expect(screen.getByRole('button', { name: /refresh to update/i })).toHaveFocus();
  });

  it('does NOT take focus when the confirmation clears by itself, because the work was saved', () => {
    const props = {
      model: { kind: 'update', release } as const,
      onWhatsNew: vi.fn(),
      onRefresh: vi.fn(),
      onRefreshAnyway: vi.fn(),
      onKeepWorking: vi.fn(),
      onDismiss: vi.fn(),
    };
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    const { rerender } = render(<UpdateCard {...props} blockedBy={blockedBy} />);
    elsewhere.focus(); // the person went back to the page and saved
    rerender(<UpdateCard {...props} blockedBy={[]} />);
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });

  it('announces the pause: the card changed and focus moved, and silence would explain neither', () => {
    expect(updateAnnouncement({ kind: 'update', release }, blockedBy)).toBe(
      'Refresh paused. You have unsaved changes in New item.',
    );
  });
});

describe('updateAnnouncement', () => {
  it('is one short sentence per state, for the polite live region', () => {
    expect(updateAnnouncement({ kind: 'update', release })).toBe(
      'A new StockPilot update is available. See what changed and how it affects your work.',
    );
    expect(updateAnnouncement({ kind: 'update', release: null })).toBe(
      'A new StockPilot update is available',
    );
  });
});
