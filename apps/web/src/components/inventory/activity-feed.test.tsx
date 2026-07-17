import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The inline note editor (EditableMovementNote) reaches for the Next router +
// the action + sonner. Stub them so the feed's movement rows can render the
// editable affordance under the test DOM (same mocks the island's own test uses).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/movements', () => ({
  editMovementNoteAction: vi.fn(async () => ({ ok: true as const, data: { note: null } })),
}));

import { ActivityFeed } from './activity-feed';

import type { ActivityEvent } from '@/server/services/activity';

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: overrides.id ?? 'e1',
    kind: overrides.kind ?? 'movement',
    type: overrides.type ?? 'adjustment',
    createdAt: overrides.createdAt ?? new Date(Date.now() - 60_000).toISOString(),
    delta: overrides.delta ?? null,
    previousQuantity: overrides.previousQuantity ?? null,
    quantityAfter: overrides.quantityAfter ?? null,
    movedQuantity: overrides.movedQuantity ?? null,
    fromLocationId: overrides.fromLocationId ?? null,
    toLocationId: overrides.toLocationId ?? null,
    referenceType: overrides.referenceType ?? null,
    referenceId: overrides.referenceId ?? null,
    referenceLabel: overrides.referenceLabel ?? null,
    reason: overrides.reason ?? null,
    notes: overrides.notes ?? null,
    noteEditable: overrides.noteEditable ?? (overrides.kind === 'audit' ? false : true),
    actor: overrides.actor ?? 'Jane Doe',
    actorEmail: overrides.actorEmail ?? null,
    metadata: overrides.metadata ?? null,
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

  it('renders the reason as italic text when present', () => {
    const events = [
      makeEvent({ id: 'a3', kind: 'audit', type: 'inventory.item.updated', reason: 'Renamed item' }),
    ];
    render(<ActivityFeed events={events} />);
    const italic = screen.getByText('Renamed item');
    expect(italic).toBeInTheDocument();
    expect(italic).toHaveClass('italic');
  });

  // ── Issue 3: notes must never be dropped ────────────────────────────────

  it('renders BOTH reason and notes for a movement — notes is never dropped when reason is also set', () => {
    const events = [
      makeEvent({
        id: 'm9',
        kind: 'movement',
        type: 'adjustment',
        delta: -5,
        reason: 'Damaged in transit',
        notes: 'Box was crushed on the top shelf, 3 units unsellable',
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Damaged in transit')).toBeInTheDocument();
    expect(
      screen.getByText('“Box was crushed on the top shelf, 3 units unsellable”'),
    ).toBeInTheDocument();
  });

  it('renders notes alone when there is no reason', () => {
    const events = [
      makeEvent({ id: 'm10', kind: 'movement', type: 'adjustment', delta: 2, notes: 'Found in back room' }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('“Found in back room”')).toBeInTheDocument();
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

  // ── Issue 5: from→to context for non-transfer movement types ────────────

  it('renders a "→ B" destination for a receive_po movement (to_location_id only, no from)', () => {
    const events = [
      makeEvent({
        id: 'm11',
        kind: 'movement',
        type: 'receive_po',
        delta: 10,
        toLocationId: 'loc-b',
      }),
    ];
    render(<ActivityFeed events={events} locationNames={{ 'loc-b': 'Rack B2' }} />);
    expect(screen.getByText('→ Rack B2')).toBeInTheDocument();
  });

  it('renders an "A →" source for a removal movement (from_location_id only, no to)', () => {
    const events = [
      makeEvent({
        id: 'm12',
        kind: 'movement',
        type: 'remove',
        delta: -4,
        fromLocationId: 'loc-a',
      }),
    ];
    render(<ActivityFeed events={events} locationNames={{ 'loc-a': 'Rack A1' }} />);
    expect(screen.getByText('Rack A1 →')).toBeInTheDocument();
  });

  // ── Issue 2: previous_quantity → new_quantity ────────────────────────────

  it('renders "previous → after" instead of just the after value', () => {
    const events = [
      makeEvent({
        id: 'm13',
        kind: 'movement',
        type: 'adjustment',
        delta: -15,
        previousQuantity: 250,
        quantityAfter: 235,
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('250 → 235 on hand')).toBeInTheDocument();
  });

  // ── Issue 4: receipt movements ──────────────────────────────────────────

  it("labels receive_po movements 'Stock received' (the writer's type — 'receipt' was a dead branch)", () => {
    const events = [
      // delta deliberately 0 so the label can only come from the type match.
      makeEvent({ id: 'm8', kind: 'movement', type: 'receive_po', delta: 0, reason: 'PO PO-77' }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Stock received')).toBeInTheDocument();
    expect(screen.getByText('PO PO-77')).toBeInTheDocument();
  });

  // ── Issue 4: clickable source links ──────────────────────────────────────

  it('renders a clickable link for a movement with a resolvable reference route + label', () => {
    const events = [
      makeEvent({
        id: 'm14',
        kind: 'movement',
        type: 'remove',
        delta: -2,
        referenceType: 'order_request',
        referenceId: 'req-123',
        referenceLabel: 'SO-000049',
      }),
    ];
    render(<ActivityFeed events={events} />);
    const link = screen.getByRole('link', { name: 'SO-000049' });
    expect(link).toHaveAttribute('href', '/dashboard/orders/req-123');
  });

  it('renders a known-route reference with NO resolved label using a generic type label, still linked', () => {
    const events = [
      makeEvent({
        id: 'm15',
        kind: 'movement',
        type: 'adjust',
        delta: 3,
        referenceType: 'cycle_count',
        referenceId: 'cc-1',
        referenceLabel: null,
      }),
    ];
    render(<ActivityFeed events={events} />);
    const link = screen.getByRole('link', { name: 'Cycle count' });
    expect(link).toHaveAttribute('href', '/dashboard/cycle-counts/cc-1');
  });

  it('degrades an UNKNOWN reference_type to a plain label — never a broken link', () => {
    const events = [
      makeEvent({
        id: 'm16',
        kind: 'movement',
        type: 'adjust',
        delta: 1,
        referenceType: 'ai_shelf_scan',
        referenceId: 'scan-9',
        referenceLabel: null,
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Ai shelf scan')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  // ── Review fix: receipt_line notes are system-managed (not editable) ─────

  it('shows the add-note affordance for an editable movement when canEditNotes is set', () => {
    const events = [
      makeEvent({ id: 'm18', kind: 'movement', type: 'adjustment', delta: 2, noteEditable: true }),
    ];
    render(<ActivityFeed events={events} canEditNotes />);
    expect(screen.getByRole('button', { name: /add note/i })).toBeInTheDocument();
  });

  it('HIDES the note affordance on a system-managed receipt_line row even with canEditNotes', () => {
    const events = [
      makeEvent({
        id: 'm19',
        kind: 'movement',
        type: 'receive_po',
        delta: 3,
        // Resolved PO reason still shows; notes is masked to null for these
        // rows and the note is system-managed → never editable.
        reason: 'PO PO-77',
        notes: null,
        noteEditable: false,
      }),
    ];
    render(<ActivityFeed events={events} canEditNotes />);
    // The resolved reason still renders…
    expect(screen.getByText('PO PO-77')).toBeInTheDocument();
    // …but the editor affordance must NOT appear for the receipt_line row.
    expect(screen.queryByRole('button', { name: /add note|edit note|save note/i })).toBeNull();
  });

  // ── Unit 2: before/after diff drawer + changed_keys chip ─────────────────
  // (ported into item-detail's Activity tab now that it's the sole renderer
  // of audit rows there — see the removed item-detail AuditTimeline mount)

  it('renders a before/after diff drawer for an audit row that carries metadata.before/after', () => {
    const events = [
      makeEvent({
        id: 'a10',
        kind: 'audit',
        type: 'item.public_visibility_changed',
        metadata: {
          before: { public_visibility: 'internal_only' },
          after: { public_visibility: 'public' },
        },
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Show 1 field change')).toBeInTheDocument();
    expect(screen.getByText('internal_only')).toBeInTheDocument();
    expect(screen.getByText('public')).toBeInTheDocument();
  });

  it('renders a changed_keys chip for an audit row with no before/after', () => {
    const events = [
      makeEvent({
        id: 'a11',
        kind: 'audit',
        type: 'inventory.item.updated',
        metadata: { changed_keys: ['name', 'reorder_point'] },
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Fields on the edit (exact changes not recorded for this entry): Name, Reorder point')).toBeInTheDocument();
  });

  it('never renders the diff drawer or chip for a movement row, even if metadata were somehow set', () => {
    const events = [
      makeEvent({
        id: 'm17',
        kind: 'movement',
        type: 'adjustment',
        delta: 2,
        // Movements never actually carry metadata (always null from
        // ActivityService), but the guard is `e.kind === 'audit'` — this
        // proves the movement branch is never evaluated even defensively.
        metadata: { before: { a: 1 }, after: { a: 2 } },
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.queryByText(/Show \d+ field change/)).not.toBeInTheDocument();
  });

  // ── Unit 2 de-dupe: parity ported from the removed item-detail
  // AuditTimeline (verifying no info was lost) ─────────────────────────────

  it('formats an audit event with no bespoke icon/label mapping as "Subject · Action" (ported from AuditTimeline), not a raw dotted string', () => {
    const events = [
      makeEvent({ id: 'a12', kind: 'audit', type: 'category.updated' }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Category · Updated')).toBeInTheDocument();
    expect(screen.queryByText('category updated')).not.toBeInTheDocument();
  });

  it('shows the actor email in parens alongside the name (ported from AuditTimeline)', () => {
    const events = [
      makeEvent({
        id: 'a13',
        kind: 'audit',
        type: 'inventory.item.updated',
        actor: 'Jane Smith',
        actorEmail: 'jane@example.com',
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
    expect(screen.getByText('(jane@example.com)')).toBeInTheDocument();
  });

  it('does not duplicate the email when the actor name IS the email (no full_name on the profile)', () => {
    const events = [
      makeEvent({
        id: 'a14',
        kind: 'audit',
        type: 'inventory.item.updated',
        actor: 'jane@example.com',
        actorEmail: 'jane@example.com',
      }),
    ];
    render(<ActivityFeed events={events} />);
    expect(screen.queryByText('(jane@example.com)')).not.toBeInTheDocument();
  });

  it('renders the exact absolute local date+time VISIBLY next to the relative time (owner ask 2026-07-15 — was hover-only)', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    const events = [
      makeEvent({ id: 'a15', kind: 'audit', type: 'inventory.item.updated', createdAt: iso }),
    ];
    const { container } = render(<ActivityFeed events={events} />);
    const timeEl = container.querySelector('time');
    expect(timeEl).not.toBeNull();
    expect(timeEl!.getAttribute('dateTime')).toBe(iso);
    const absolute = new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(container.textContent).toContain(absolute);
  });
});
