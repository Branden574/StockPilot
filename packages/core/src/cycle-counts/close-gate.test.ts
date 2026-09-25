import { describe, expect, it } from 'vitest';

import type { Role } from '../constants/roles';

import {
  CYCLE_COUNT_MANAGER_POSTS_COPY,
  CYCLE_COUNT_POST_MANAGER_ONLY_COPY,
  cycleCountCloseGate,
} from './close-gate';

describe('cycleCountCloseGate', () => {
  // Mutation caught: gating Post on stock:adjust alone (the old web rule).
  // Staff hold stock:adjust, so they saw Post and the database refused them.
  it('staff with stock:adjust get neither Post nor Cancel', () => {
    expect(cycleCountCloseGate({ role: 'staff', canAdjust: true, canAssign: true })).toEqual({
      canPost: false,
      canCancel: false,
    });
    expect(cycleCountCloseGate({ role: 'viewer', canAdjust: true, canAssign: true })).toEqual({
      canPost: false,
      canCancel: false,
    });
  });

  it('a manager needs stock:adjust to post, and cycle_counts:assign as well to cancel', () => {
    for (const role of ['owner', 'admin', 'manager'] as Role[]) {
      expect(cycleCountCloseGate({ role, canAdjust: true, canAssign: true })).toEqual({
        canPost: true,
        canCancel: true,
      });
      expect(cycleCountCloseGate({ role, canAdjust: true, canAssign: false })).toEqual({
        canPost: true,
        canCancel: false,
      });
      expect(cycleCountCloseGate({ role, canAdjust: false, canAssign: true })).toEqual({
        canPost: false,
        canCancel: false,
      });
    }
  });

  it('the copy says a manager posts, and does not blame anyone', () => {
    expect(CYCLE_COUNT_MANAGER_POSTS_COPY).toBe('A manager reviews and posts this count.');
    expect(CYCLE_COUNT_POST_MANAGER_ONLY_COPY).toContain(CYCLE_COUNT_MANAGER_POSTS_COPY);
  });
});
