import { describe, expect, it } from 'vitest';

import {
  countReadFilter,
  countReadScope,
  countScopeWarehouseIds,
  mayReadCount,
  type CountReadScope,
} from './count-read-scope';

const ME = 'u-dana';

const limited = (readableIds: string[]) => ({ hasAllAccess: false, readableIds });

describe('countReadScope: which counts a member reads', () => {
  it('a caller decided by role (no access read) reads every count', () => {
    expect(countReadScope(null, ME)).toEqual({ kind: 'every' });
  });

  it('a member with every warehouse reads every count, whatever the id list holds', () => {
    expect(countReadScope({ hasAllAccess: true, readableIds: [] }, ME)).toEqual({ kind: 'every' });
    expect(countReadScope({ hasAllAccess: true, readableIds: ['wh-a'] }, ME)).toEqual({
      kind: 'every',
    });
  });

  it('a member limited to some warehouses is scoped to the ones they can read, and to themselves', () => {
    expect(countReadScope(limited(['wh-a', 'wh-b']), ME)).toEqual({
      kind: 'warehouses',
      warehouseIds: ['wh-a', 'wh-b'],
      assigneeId: ME,
    });
  });

  it('a member with no readable warehouse reads none', () => {
    expect(countReadScope(limited([]), ME)).toEqual({ kind: 'none' });
  });

  it('reads the readable list only: a read-only member is scoped like any other', () => {
    const access = { hasAllAccess: false, readableIds: ['wh-a'], writableIds: [] };
    expect(countReadScope(access, ME)).toMatchObject({ kind: 'warehouses', warehouseIds: ['wh-a'] });
  });
});

describe('mayReadCount: one count against the scope', () => {
  const every: CountReadScope = { kind: 'every' };
  const none: CountReadScope = { kind: 'none' };
  const scoped = countReadScope(limited(['wh-a']), ME);

  const COUNTS = {
    inMine: { warehouse_id: 'wh-a', assigned_to: null },
    inOther: { warehouse_id: 'wh-b', assigned_to: null },
    inOtherMine: { warehouse_id: 'wh-b', assigned_to: ME },
    noWarehouseMine: { warehouse_id: null, assigned_to: ME },
    noWarehouseNobody: { warehouse_id: null, assigned_to: null },
    noWarehouseTheirs: { warehouse_id: null, assigned_to: 'u-lee' },
  };

  it('every: all of them', () => {
    for (const c of Object.values(COUNTS)) expect(mayReadCount(every, c)).toBe(true);
  });

  it('none: not one, an own assignment included', () => {
    for (const c of Object.values(COUNTS)) expect(mayReadCount(none, c)).toBe(false);
  });

  it('scoped: a readable warehouse, or no warehouse and assigned to the member', () => {
    expect(mayReadCount(scoped, COUNTS.inMine)).toBe(true);
    expect(mayReadCount(scoped, COUNTS.noWarehouseMine)).toBe(true);
    expect(mayReadCount(scoped, COUNTS.inOther)).toBe(false);
    expect(mayReadCount(scoped, COUNTS.inOtherMine)).toBe(false);
    expect(mayReadCount(scoped, COUNTS.noWarehouseNobody)).toBe(false);
    expect(mayReadCount(scoped, COUNTS.noWarehouseTheirs)).toBe(false);
  });

  it('an empty or missing value never matches: no warehouse is not "the warehouse with an empty id"', () => {
    const odd = { kind: 'warehouses', warehouseIds: [''], assigneeId: '' } as CountReadScope;
    expect(mayReadCount(odd, { warehouse_id: '', assigned_to: '' })).toBe(false);
    expect(mayReadCount(odd, { warehouse_id: null, assigned_to: null })).toBe(false);
    expect(mayReadCount(odd, { warehouse_id: undefined, assigned_to: undefined })).toBe(false);
  });
});

describe('the same scope as a list filter', () => {
  it('countScopeWarehouseIds: null for every count, the readable ids when scoped, nothing to ask when none', () => {
    expect(countScopeWarehouseIds({ kind: 'every' })).toBeNull();
    expect(countScopeWarehouseIds(countReadScope(limited(['wh-a', 'wh-b']), ME))).toEqual([
      'wh-a',
      'wh-b',
    ]);
    expect(countScopeWarehouseIds({ kind: 'none' })).toEqual([]);
  });

  it('countReadFilter: the two arms of the scoped rule, and no filter for every count', () => {
    expect(countReadFilter({ kind: 'every' })).toBeNull();
    expect(countReadFilter(countReadScope(limited(['wh-a', 'wh-b']), ME))).toBe(
      `warehouse_id.in.(wh-a,wh-b),and(warehouse_id.is.null,assigned_to.eq.${ME})`,
    );
  });

  it('countReadFilter refuses to build a filter for a member who reads none: that read is not sent', () => {
    expect(() => countReadFilter({ kind: 'none' })).toThrow();
  });
});
