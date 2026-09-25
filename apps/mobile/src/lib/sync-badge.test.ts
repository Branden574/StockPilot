import { describe, expect, it } from 'vitest';

import { syncBadgeState, type SyncBadgeInput } from './sync-badge';

const idle = (over: Partial<SyncBadgeInput> = {}): SyncBadgeInput => ({
  status: 'idle',
  pendingCount: 0,
  rejectedCount: 0,
  unconfirmedCount: 0,
  ...over,
});

describe('syncBadgeState — the header sync pill', () => {
  it('never says "All synced" over rejected work', () => {
    expect(syncBadgeState(idle())).toEqual({
      label: 'All synced',
      tone: 'success',
      spinner: false,
    });
    expect(syncBadgeState(idle({ rejectedCount: 2 }))).toEqual({
      label: '2 not sent',
      tone: 'destructive',
      spinner: false,
    });
  });

  it('never calls a not-confirmed stock adjustment "not sent": it left the phone and may have been applied', () => {
    expect(syncBadgeState(idle({ rejectedCount: 1, unconfirmedCount: 1 }))).toEqual({
      label: '1 not confirmed',
      tone: 'warning',
      spinner: false,
    });
    expect(syncBadgeState(idle({ rejectedCount: 3, unconfirmedCount: 1 }))).toEqual({
      label: '3 need checking',
      tone: 'destructive',
      spinner: false,
    });
    // Counts read a moment apart can disagree: clamped, never negative.
    expect(syncBadgeState(idle({ rejectedCount: 1, unconfirmedCount: 4 })).label).toBe(
      '1 not confirmed',
    );
  });

  it('the other states are unchanged', () => {
    expect(syncBadgeState(idle({ status: 'syncing' }))).toEqual({
      label: 'Syncing…',
      tone: 'primary',
      spinner: true,
    });
    expect(syncBadgeState(idle({ status: 'offline', pendingCount: 3 })).label).toBe(
      'Offline · 3 queued',
    );
    expect(syncBadgeState(idle({ status: 'offline' })).label).toBe('Offline');
    expect(syncBadgeState(idle({ status: 'failing' })).label).toBe('Sync issue · retrying');
    expect(syncBadgeState(idle({ pendingCount: 2, rejectedCount: 1 }))).toEqual({
      label: '2 pending',
      tone: 'warning',
      spinner: false,
    });
  });
});
