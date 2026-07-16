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

  it('de-dupes by id when the older page re-fetches a row already present (double-click / retry safety net)', () => {
    const existing = [
      makeEvent({ id: 'm:2', createdAt: '2025-03-01T00:00:00.000Z' }),
      makeEvent({ id: 'm:1', createdAt: '2025-02-01T00:00:00.000Z' }),
    ];
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
  it('returns null when the page has no events and there is no previous cursor', () => {
    expect(nextActivityCursor([])).toBeNull();
  });

  it('returns a per-kind cursor with only the present kind populated', () => {
    const page = [
      makeEvent({ id: 'm:2', createdAt: '2025-03-01T00:00:00.000Z' }),
      makeEvent({ id: 'm:1', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    expect(nextActivityCursor(page)).toEqual({
      movement: { createdAt: '2025-01-01T00:00:00.000Z', id: '1' },
    });
  });

  it('computes an independent boundary per kind — never a shared/later-wins value', () => {
    const page = [
      makeEvent({ id: 'm:2', createdAt: '2025-06-01T00:00:00.000Z' }),
      makeEvent({ id: 'a:2', kind: 'audit', createdAt: '2025-05-01T00:00:00.000Z' }),
      // Audits' oldest fetched row (cap not fully spent) is far more recent
      // than movements' oldest fetched row — under the OLD shared-cursor
      // design this would have forced picking movements' boundary for
      // BOTH kinds. The per-kind design just reports each independently.
      makeEvent({ id: 'a:1', kind: 'audit', createdAt: '2025-04-01T00:00:00.000Z' }),
      makeEvent({ id: 'm:1', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    expect(nextActivityCursor(page)).toEqual({
      movement: { createdAt: '2025-01-01T00:00:00.000Z', id: '1' },
      audit: { createdAt: '2025-04-01T00:00:00.000Z', id: '1' },
    });
  });

  it('strips the kind prefix (m:/a:) to recover the RAW row id for the keyset predicate', () => {
    const page = [
      makeEvent({
        id: 'a:11111111-2222-3333-4444-555555555555',
        kind: 'audit',
        createdAt: '2025-02-01T00:00:00.000Z',
      }),
    ];
    expect(nextActivityCursor(page)).toEqual({
      audit: {
        createdAt: '2025-02-01T00:00:00.000Z',
        id: '11111111-2222-3333-4444-555555555555',
      },
    });
  });

  // ── The Blocker 1 regression: a same-`created_at` tie at the cap boundary
  // must never be lost. `id` is the tiebreaker; the row with the LARGER raw
  // id (the one `ORDER BY created_at DESC, id DESC` places first, i.e. the
  // one that actually made it into this page) becomes the cursor — never
  // the bare, ambiguous `createdAt` timestamp the pre-fix code returned. ──

  it('at a tie, the cursor pins BOTH createdAt AND the exact row id — not just the shared timestamp', () => {
    const tiedCreatedAt = '2025-04-01T00:00:00.000Z';
    const page = [
      makeEvent({ id: 'm:newer', createdAt: '2025-05-01T00:00:00.000Z' }),
      // The row that "won" the tie and made it into this page (its id sorts
      // last among the kept rows, i.e. this is the true page boundary).
      makeEvent({ id: 'm:tie-winner-b', createdAt: tiedCreatedAt }),
    ];
    const cursor = nextActivityCursor(page);
    // The OLD implementation returned a bare string ('2025-04-01T...') here
    // — a `.lt('created_at', boundary)` built from that would exclude EVERY
    // row sharing `tiedCreatedAt`, including any sibling tie row cut off by
    // this page's `.limit()` (see activity.test.ts's full keyset-page test
    // for the end-to-end version of this). Asserting the shape here proves
    // the id survives all the way out of this pure function.
    expect(cursor).toEqual({ movement: { createdAt: tiedCreatedAt, id: 'tie-winner-b' } });
  });

  it('carries a kind\'s PREVIOUS boundary forward when this page returned none of that kind', () => {
    const previous = {
      movement: { createdAt: '2025-03-01T00:00:00.000Z', id: 'm-prev' },
      audit: { createdAt: '2025-03-01T00:00:00.000Z', id: 'a-prev' },
    };
    // This page's audit query — bounded by `previous.audit` — came back
    // empty (audits are exhausted); movements had one more row.
    const page = [makeEvent({ id: 'm:new', createdAt: '2025-02-01T00:00:00.000Z' })];
    expect(nextActivityCursor(page, previous)).toEqual({
      movement: { createdAt: '2025-02-01T00:00:00.000Z', id: 'new' },
      // Carried forward UNCHANGED — NOT dropped. Dropping it would make the
      // next "Load older" call issue an unfiltered audits query, silently
      // re-fetching the newest audit rows from scratch instead of staying
      // bounded at the already-established exhaustion point.
      audit: previous.audit,
    });
  });

  it('drops a kind entirely (undefined) when it has never had any rows and there is no previous cursor for it', () => {
    const page = [makeEvent({ id: 'm:1', createdAt: '2025-01-01T00:00:00.000Z' })];
    const cursor = nextActivityCursor(page, null);
    expect(cursor?.movement).toBeDefined();
    expect(cursor?.audit).toBeUndefined();
  });

  it('returns null only when NEITHER kind has a boundary from this page or the previous one', () => {
    expect(nextActivityCursor([], null)).toBeNull();
    expect(nextActivityCursor([], {})).toBeNull();
  });
});
