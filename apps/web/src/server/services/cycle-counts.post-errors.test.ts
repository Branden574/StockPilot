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
