import { describe, expect, it } from 'vitest';

import { mergeOlderActivityEvents, nextActivityCursor } from './activity-pagination';

import type { ActivityEvent } from '@/server/services/activity';

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: overrides.id ?? 'm:1',
    kind: overrides.kind ?? 'movement',
    type: overrides.type ?? 'adjust',
    createdAt: overrides.createdAt ?? '2025-01-01T00:00:00.000Z',
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
    actor: overrides.actor ?? 'System',
    actorEmail: overrides.actorEmail ?? null,
    metadata: overrides.metadata ?? null,
  };
}

describe('mergeOlderActivityEvents', () => {
  it('appends a strictly-older page after the existing feed with no overlap', () => {
    const existing = [
      makeEvent({ id: 'm:2', createdAt: '2025-03-01T00:00:00.000Z' }),
      makeEvent({ id: 'm:1', createdAt: '2025-02-01T00:00:00.000Z' }),
    ];
    const older = [
      makeEvent({ id: 'a:1', kind: 'audit', createdAt: '2025-01-15T00:00:00.000Z' }),
      makeEvent({ id: 'm:0', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    const merged = mergeOlderActivityEvents(existing, older);
    expect(merged.map((e) => e.id)).toEqual(['m:2', 'm:1', 'a:1', 'm:0']);
  });

  it('de-dupes by id when the older page re-fetches a row already present', () => {
    const existing = [
      makeEvent({ id: 'm:2', createdAt: '2025-03-01T00:00:00.000Z' }),
      makeEvent({ id: 'm:1', createdAt: '2025-02-01T00:00:00.000Z' }),
    ];
    // The MAX-cursor strategy (see nextActivityCursor) can legitimately
    // re-request a row the caller already has — e.g. when the audit cursor
    // trails the movement cursor. `m:1` shows up again here.
    const older = [
      makeEvent({ id: 'm:1', createdAt: '2025-02-01T00:00:00.000Z' }),
      makeEvent({ id: 'm:0', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    const merged = mergeOlderActivityEvents(existing, older);
    expect(merged).toHaveLength(3);
    expect(merged.map((e) => e.id)).toEqual(['m:2', 'm:1', 'm:0']);
  });

  it('re-sorts by createdAt desc even if the two pages were passed out of order', () => {
    const existing = [makeEvent({ id: 'm:1', createdAt: '2025-02-01T00:00:00.000Z' })];
    const older = [makeEvent({ id: 'a:1', kind: 'audit', createdAt: '2025-03-01T00:00:00.000Z' })];
    const merged = mergeOlderActivityEvents(existing, older);
    // Even though `older` is passed second, its (newer) event sorts first.
    expect(merged.map((e) => e.id)).toEqual(['a:1', 'm:1']);
  });

  it('returns the existing list unchanged (content-wise) when the older page is empty', () => {
    const existing = [makeEvent({ id: 'm:1' })];
    expect(mergeOlderActivityEvents(existing, [])).toEqual(existing);
  });
});

describe('nextActivityCursor', () => {
  it('returns null when the page has no events', () => {
    expect(nextActivityCursor([])).toBeNull();
  });

  it('returns the single kind\'s oldest createdAt when only one kind is present', () => {
    const page = [
      makeEvent({ id: 'm:2', createdAt: '2025-03-01T00:00:00.000Z' }),
      makeEvent({ id: 'm:1', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    expect(nextActivityCursor(page)).toBe('2025-01-01T00:00:00.000Z');
  });

  // ── The core correctness property: the LATER (more recent) of the two
  // per-kind boundaries wins, never the earlier one. ────────────────────

  it('picks the LATER per-kind boundary when movements go further back than audits', () => {
    const page = [
      makeEvent({ id: 'm:2', createdAt: '2025-06-01T00:00:00.000Z' }),
      makeEvent({ id: 'a:2', kind: 'audit', createdAt: '2025-05-01T00:00:00.000Z' }),
      // Audits' oldest fetched row (cap not fully spent — few audit rows
      // exist) is more recent than movements' oldest fetched row.
      makeEvent({ id: 'a:1', kind: 'audit', createdAt: '2025-04-01T00:00:00.000Z' }),
      makeEvent({ id: 'm:1', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    // Movements' boundary = 2025-01-01, audits' boundary = 2025-04-01.
    // The LATER one (2025-04-01) must win — using 2025-01-01 would skip
    // any as-yet-unfetched audit rows between 2025-01-01 and 2025-04-01.
    expect(nextActivityCursor(page)).toBe('2025-04-01T00:00:00.000Z');
  });

  it('picks the LATER per-kind boundary when audits go further back than movements', () => {
    const page = [
      makeEvent({ id: 'm:1', createdAt: '2025-03-01T00:00:00.000Z' }),
      makeEvent({ id: 'a:2', kind: 'audit', createdAt: '2025-02-01T00:00:00.000Z' }),
      makeEvent({ id: 'a:1', kind: 'audit', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    // Movements' boundary = 2025-03-01, audits' boundary = 2025-01-01.
    // The LATER one (2025-03-01) wins.
    expect(nextActivityCursor(page)).toBe('2025-03-01T00:00:00.000Z');
  });
});
