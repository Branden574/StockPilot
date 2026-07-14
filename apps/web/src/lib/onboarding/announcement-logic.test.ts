import { describe, expect, it } from 'vitest';

import type { Announcement } from './announcements';
import { computeSeenViewedMap, filterUnseenForClient } from './announcement-logic';

/**
 * These lock the semantics BOTH the web action and the mobile Bearer route
 * depend on — both write the same user_onboarding.viewed_announcements row, so
 * any drift here silently disagrees the two platforms' "seen" state.
 */

const A = (id: string, extra: Partial<Announcement> = {}): Announcement => ({
  id,
  date: '2026-07-01',
  title: `T-${id}`,
  body: `B-${id}`,
  ...extra,
});

describe('filterUnseenForClient', () => {
  it('drops already-seen ids and keeps registry (array) order, not date order', () => {
    const reg = [A('a'), A('b'), A('c')];
    const out = filterUnseenForClient(reg, { b: { at: 'x', outcome: 'seen' } }, 'staff');
    expect(out.map((o) => o.id)).toEqual(['a', 'c']);
  });

  it('caps at 3 even when more are unseen', () => {
    const reg = [A('a'), A('b'), A('c'), A('d'), A('e')];
    const out = filterUnseenForClient(reg, {}, 'staff');
    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('role-gates: an entry with roles is hidden from a role not in the list', () => {
    const reg = [A('open'), A('gated', { roles: ['owner', 'admin', 'manager'] })];
    expect(filterUnseenForClient(reg, {}, 'staff').map((o) => o.id)).toEqual(['open']);
    expect(filterUnseenForClient(reg, {}, 'manager').map((o) => o.id)).toEqual(['open', 'gated']);
  });

  it('an entry with no roles is shown to everyone', () => {
    expect(filterUnseenForClient([A('x')], {}, 'viewer').map((o) => o.id)).toEqual(['x']);
  });

  it('strips the roles field from the returned items', () => {
    const out = filterUnseenForClient([A('g', { roles: ['owner'] })], {}, 'owner');
    expect(out[0]).not.toHaveProperty('roles');
    expect(out[0]).toMatchObject({ id: 'g', date: '2026-07-01', title: 'T-g', body: 'B-g' });
  });
});

describe('computeSeenViewedMap', () => {
  const allIds = ['a', 'b', 'c', 'd'];

  it('all=true stamps the ENTIRE registry, not just the shown ids', () => {
    const out = computeSeenViewedMap({}, ['a'], 'seen', true, allIds, 'T0');
    expect(Object.keys(out).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(out.a).toEqual({ at: 'T0', outcome: 'seen' });
    expect(out.d).toEqual({ at: 'T0', outcome: 'seen' });
  });

  it('all=false stamps only the shown ids', () => {
    const out = computeSeenViewedMap({}, ['a', 'b'], 'dismissed', false, allIds, 'T1');
    expect(Object.keys(out).sort()).toEqual(['a', 'b']);
    expect(out.a).toEqual({ at: 'T1', outcome: 'dismissed' });
  });

  it('preserves an already-present entry (does not overwrite at/outcome)', () => {
    const current = { a: { at: 'ORIGINAL', outcome: 'seen' } };
    const out = computeSeenViewedMap(current, ['a'], 'dismissed', true, allIds, 'T2');
    expect(out.a).toEqual({ at: 'ORIGINAL', outcome: 'seen' }); // untouched
    expect(out.b).toEqual({ at: 'T2', outcome: 'dismissed' }); // new
  });

  it('merges with unrelated existing keys', () => {
    const current = { zzz: { at: 'keep', outcome: 'seen' } };
    const out = computeSeenViewedMap(current, ['a'], 'seen', false, allIds, 'T3');
    expect(out.zzz).toEqual({ at: 'keep', outcome: 'seen' });
    expect(out.a).toEqual({ at: 'T3', outcome: 'seen' });
  });
});
