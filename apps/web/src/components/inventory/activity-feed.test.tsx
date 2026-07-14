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
    movedQuantity: overrides.movedQuantity ?? null,
    fromLocationId: overrides.fromLocationId ?? null,
    toLocationId: overrides.toLocationId ?? null,
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

  // Task 8: the bulk-unarchive path now emits inventory.item.restored
  // (instead of falling into the generic .updated event) — the Activity
  // feed needs its own icon/label mapping so a restore doesn't render as
  // a plain "History" fallback row.
  it('renders Item restored label for the inventory.item.restored audit event', () => {
    const events = [
      makeEvent({ id: 'a9', kind: 'audit', type: 'inventory.item.restored' }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Item restored')).toBeInTheDocument();
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

  // ── Issue 3: "Stock transferred 0" ──────────────────────────────────────

  it('renders a transfer with the moved quantity, not the 0 net delta', () => {
    const events = [
      makeEvent({
        id: 'm4',
        kind: 'movement',
        type: 'transfer',
        delta: 0,
        quantityAfter: 500,
        movedQuantity: 250,
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Stock transferred')).toBeInTheDocument();
    expect(screen.getByText('250')).toBeInTheDocument();
    // The misleading net-zero delta never renders for transfers.
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('+0')).not.toBeInTheDocument();
  });

  it('renders an OLD transfer row (movedQuantity null) with NO number instead of 0', () => {
    const events = [
      makeEvent({
        id: 'm5',
        kind: 'movement',
        type: 'transfer',
        delta: 0,
        quantityAfter: 500,
        movedQuantity: null,
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Stock transferred')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('+0')).not.toBeInTheDocument();
  });

  it('renders the transfer route ("A → B") when a locationNames map is provided', () => {
    const events = [
      makeEvent({
        id: 'm6',
        kind: 'movement',
        type: 'transfer',
        delta: 0,
        movedQuantity: 4,
        fromLocationId: 'loc-a',
        toLocationId: 'loc-b',
      }),
    ];
    render(
      <ActivityFeed
        events={events}
        locationNames={{ 'loc-a': 'Rack A1', 'loc-b': 'Rack B2' }}
      />,
    );
    expect(screen.getByText('Rack A1 → Rack B2')).toBeInTheDocument();
  });

  it('omits the route when the location names are unknown', () => {
    const events = [
      makeEvent({
        id: 'm7',
        kind: 'movement',
        type: 'transfer',
        delta: 0,
        movedQuantity: 4,
        fromLocationId: 'loc-a',
        toLocationId: 'loc-b',
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.queryByText(/→ Rack/)).not.toBeInTheDocument();
  });

  // ── Issue 4: receipt movements ──────────────────────────────────────────

  it("labels receive_po movements 'Stock received' (the writer's type — 'receipt' was a dead branch)", () => {
    const events = [
      // delta deliberately 0 so the label can only come from the type match.
      makeEvent({ id: 'm8', kind: 'movement', type: 'receive_po', delta: 0, summary: 'PO PO-77' }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Stock received')).toBeInTheDocument();
    expect(screen.getByText('PO PO-77')).toBeInTheDocument();
  });
});
