import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ActivityFeed } from './activity-feed';

import type { ActivityEvent } from '@/server/services/activity';

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: overrides.id ?? 'e1',
    kind: overrides.kind ?? 'movement',
    type: overrides.type ?? 'adjustment',
    createdAt: overrides.createdAt ?? new Date(Date.now() - 60_000).toISOString(),
    delta: overrides.delta ?? null,
    quantityAfter: overrides.quantityAfter ?? null,
    summary: overrides.summary ?? null,
    actor: overrides.actor ?? 'Jane Doe',
    actorEmail: overrides.actorEmail ?? null,
  };
}

describe('ActivityFeed', () => {
  it('renders empty state when no events', () => {
    render(<ActivityFeed events={[]} />);
    expect(screen.getByText(/No activity yet/i)).toBeInTheDocument();
  });

  it('renders a positive movement as Stock received with +N delta', () => {
    const events = [
      makeEvent({ id: 'm1', kind: 'movement', type: 'adjustment', delta: 5, quantityAfter: 12 }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Stock received')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
  });

  it('renders a negative movement as Stock removed', () => {
    const events = [
      makeEvent({ id: 'm2', kind: 'movement', type: 'adjustment', delta: -3 }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Stock removed')).toBeInTheDocument();
    // delta renders without leading '+' for negatives
    expect(screen.getByText('-3')).toBeInTheDocument();
  });

  it('renders Item created label for the inventory.item.created audit event', () => {
    const events = [
      makeEvent({ id: 'a1', kind: 'audit', type: 'inventory.item.created' }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Item created')).toBeInTheDocument();
  });

  it('shows actor name and a relative time string together', () => {
    const events = [
      makeEvent({
        id: 'a2',
        kind: 'audit',
        type: 'inventory.item.updated',
        actor: 'Branden',
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Branden')).toBeInTheDocument();
    // Some kind of "minutes ago" relative string from formatRelative.
    expect(screen.getByText(/ago|minute|now/i)).toBeInTheDocument();
  });

  it('renders the summary as italic text when present', () => {
    const events = [
      makeEvent({ id: 'a3', kind: 'audit', type: 'inventory.item.updated', summary: 'Renamed item' }),
    ];
    render(<ActivityFeed events={events} />);
    const italic = screen.getByText('Renamed item');
    expect(italic).toBeInTheDocument();
    expect(italic).toHaveClass('italic');
  });
});
