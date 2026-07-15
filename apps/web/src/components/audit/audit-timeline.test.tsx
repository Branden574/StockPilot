import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AuditTimelineList } from './audit-timeline';

import type { AuditLogRow } from '@/server/services/audit-log';

/**
 * AuditTimelineList is the presentational half of AuditTimeline (no data
 * fetching), extracted specifically so it's unit-testable without mocking
 * AuditLogService — see audit-timeline.tsx for the split rationale.
 */
function makeRow(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: overrides.id ?? 'row-1',
    event: overrides.event ?? 'inventory.item.updated',
    createdAt: overrides.createdAt ?? new Date(Date.now() - 5 * 60_000).toISOString(),
    // `overrides.actor` is deliberately `null`-vs-`undefined` sensitive —
    // `null` means "explicitly no actor" (the "System" case) and must NOT
    // fall back to the default profile the way `??` would.
    actor:
      'actor' in overrides
        ? (overrides.actor ?? null)
        : { userId: 'u1', fullName: 'Jane Doe', email: 'jane@example.com', avatarUrl: null },
    metadata: overrides.metadata ?? {},
    ip: overrides.ip ?? null,
  };
}

describe('AuditTimelineList', () => {
  it('renders nothing when there are no rows', () => {
    const { container } = render(<AuditTimelineList rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the event label, actor, and relative time for a row', () => {
    render(<AuditTimelineList rows={[makeRow({ event: 'inventory.item.updated' })]} />);
    expect(screen.getByText('Inventory Item · Updated')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('(jane@example.com)')).toBeInTheDocument();
  });

  it('renders the reason line when metadata.reason is present', () => {
    render(
      <AuditTimelineList
        rows={[makeRow({ metadata: { reason: 'Bulk price correction' } })]}
      />,
    );
    expect(screen.getByText('Bulk price correction')).toBeInTheDocument();
  });

  it('renders the before/after diff drawer for a row with metadata.before/after', () => {
    render(
      <AuditTimelineList
        rows={[
          makeRow({
            event: 'user.role.changed',
            metadata: { before: { role: 'staff' }, after: { role: 'manager' } },
          }),
        ]}
      />,
    );
    expect(screen.getByText('Show 1 field change')).toBeInTheDocument();
    expect(screen.getByText('staff')).toBeInTheDocument();
    expect(screen.getByText('manager')).toBeInTheDocument();
  });

  it('renders the changed_keys chip for a row with no before/after diff', () => {
    render(
      <AuditTimelineList
        rows={[
          makeRow({
            event: 'category.updated',
            metadata: { changed_keys: ['name', 'color'] },
          }),
        ]}
      />,
    );
    expect(screen.getByText('Fields changed: Name, Color')).toBeInTheDocument();
  });

  it('renders no diff drawer or chip for a row with neither before/after nor changed_keys', () => {
    render(
      <AuditTimelineList
        rows={[makeRow({ event: 'inventory.item.created', metadata: {} })]}
      />,
    );
    expect(screen.queryByText(/Show \d+ field change/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fields changed:/)).not.toBeInTheDocument();
  });

  it('never crashes on a row with weird/arbitrary metadata', () => {
    expect(() =>
      render(
        <AuditTimelineList
          rows={[
            makeRow({
              metadata: { before: [1, 2, 3], after: 'weird-string', changed_keys: 'not-an-array' },
            }),
          ]}
        />,
      ),
    ).not.toThrow();
  });

  it('renders "Unknown" for a row with an actor id but no resolvable profile', () => {
    render(
      <AuditTimelineList
        rows={[
          makeRow({
            actor: { userId: 'u2', fullName: null, email: null, avatarUrl: null },
          }),
        ]}
      />,
    );
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('renders "System" for a row with no actor at all', () => {
    render(<AuditTimelineList rows={[makeRow({ actor: null })]} />);
    expect(screen.getByText('System')).toBeInTheDocument();
  });
});
