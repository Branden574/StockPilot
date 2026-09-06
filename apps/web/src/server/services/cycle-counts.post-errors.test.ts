import { describe, expect, it, vi } from 'vitest';

// The service imports these symbols at module load; the mapper under test
// is pure and never reaches them.
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import { mapPostCycleCountError } from './cycle-counts';

/**
 * post_cycle_count raises stable codes (v2 0079, v4 0339). The web service
 * turns each into a ServiceError with a user-facing message; the mobile app
 * mirrors the same strings in app/cycle-count/[id].tsx. Pinned literally so
 * a code rename in a future migration fails here, not in a toast.
 */
describe('mapPostCycleCountError — post_cycle_count raise codes (0079 + 0339)', () => {
  it('cycle_count_stale_line (0339): a pre-0339 line whose stock moved -> validation_error, recount copy', () => {
    const e = mapPostCycleCountError('cycle_count_stale_line');
    expect(e.code).toBe('validation_error');
    expect(e.message).toBe(
      'A line was counted before its stock changed and cannot be posted safely. Clear and recount that line, then post again.',
    );
  });

  it('cycle_count_negative_result (0339): live + variance < 0 -> validation_error, recount copy', () => {
    const e = mapPostCycleCountError('cycle_count_negative_result');
    expect(e.code).toBe('validation_error');
    expect(e.message).toBe(
      'Posting would take an item below zero because stock moved out after it was counted. Recount that line, then post again.',
    );
  });

  it('item_out_of_scope (0079, carried by 0339) -> validation_error', () => {
    const e = mapPostCycleCountError('item_out_of_scope');
    expect(e.code).toBe('validation_error');
    expect(e.message).toContain('moved to a different warehouse mid-count');
  });

  it('cycle_count_not_found -> not_found; cycle_count_not_open -> conflict; forbidden -> forbidden', () => {
    expect(mapPostCycleCountError('cycle_count_not_found').code).toBe('not_found');
    expect(mapPostCycleCountError('cycle_count_not_open').code).toBe('conflict');
    expect(mapPostCycleCountError('forbidden').code).toBe('forbidden');
  });

  it('an unknown message stays an internal_error (raw text kept server-side only, S13)', () => {
    const e = mapPostCycleCountError('something else entirely');
    expect(e.code).toBe('internal_error');
    expect(e.internalDetail).toBe('something else entirely');
    expect(e.message).not.toContain('something else entirely');
  });

  it('matches PostgREST-wrapped messages (the raise text is embedded, not exact)', () => {
    expect(mapPostCycleCountError('P0001: cycle_count_stale_line').code).toBe('validation_error');
    expect(mapPostCycleCountError('P0001: cycle_count_negative_result').code).toBe(
      'validation_error',
    );
  });
});

/**
 * 0342/0343 counted-location validation. post_cycle_count refuses a line whose
 * counted_location_id is in another org (42501) or outside the count's
 * warehouse scope (22023). Neither code contains any of the older substrings
 * (`item_out_of_scope` is NOT a substring of `cycle_count_location_out_of_scope`),
 * so before SP-098 they fell through to internal_error and the operator saw
 * either a generic "internal error" toast (web) or the raw Postgres string
 * (mobile). Recurring bug pattern #28(b): enumerate the RPC's raises and map
 * every sibling class.
 */
describe('mapPostCycleCountError — counted-location raises (0342 + 0343)', () => {
  it('cycle_count_location_out_of_scope -> validation_error with clear/recount copy', () => {
    const e = mapPostCycleCountError('cycle_count_location_out_of_scope');
    expect(e.code).toBe('validation_error');
    expect(e.message).toContain('location');
    expect(e.message).toContain('Clear and recount');
  });

  it('cycle_count_location_out_of_org -> validation_error with clear/recount copy', () => {
    const e = mapPostCycleCountError('cycle_count_location_out_of_org');
    expect(e.code).toBe('validation_error');
    expect(e.message).toContain('location');
    expect(e.message).toContain('Clear and recount');
  });

  it('the more specific location codes win over the older item_out_of_scope mapping', () => {
    // Ordering guard: `…location_out_of_scope` must not be swallowed by a
    // looser substring test added later.
    expect(mapPostCycleCountError('P0001: cycle_count_location_out_of_scope').message).not.toBe(
      mapPostCycleCountError('item_out_of_scope').message,
    );
  });
});
