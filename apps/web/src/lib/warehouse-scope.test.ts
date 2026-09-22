import { describe, expect, it } from 'vitest';

import {
  buildWarehouseScope,
  scopedWarehouseMessage,
  WAREHOUSE_ACCESS_UNREADABLE_MESSAGE,
} from './warehouse-scope';

const WAREHOUSES = [
  { id: 'wh-a', name: 'Main Warehouse' },
  { id: 'wh-b', name: 'East Annex' },
  { id: 'wh-c', name: 'Overflow' },
];

describe('buildWarehouseScope', () => {
  it('all-access: every warehouse name, in given order', () => {
    const scope = buildWarehouseScope(
      { hasAllAccess: true, readableIds: ['wh-a', 'wh-b', 'wh-c'] },
      WAREHOUSES,
    );
    expect(scope).toEqual({
      hasAllAccess: true,
      warehouseNames: ['Main Warehouse', 'East Annex', 'Overflow'],
    });
  });

  it('scoped: narrows to the readable subset even when given the full org list', () => {
    const scope = buildWarehouseScope(
      { hasAllAccess: false, readableIds: ['wh-b'] },
      WAREHOUSES,
    );
    expect(scope).toEqual({ hasAllAccess: false, warehouseNames: ['East Annex'] });
  });

  it('scoped with zero assignments: empty names, never the org list (snapshot zero-assignment edge)', () => {
    const scope = buildWarehouseScope({ hasAllAccess: false, readableIds: [] }, WAREHOUSES);
    expect(scope).toEqual({ hasAllAccess: false, warehouseNames: [] });
  });

  it('an UNREADABLE access answer is flagged, never passed off as zero assignments', () => {
    const scope = buildWarehouseScope(
      { hasAllAccess: false, readableIds: [], unreadable: true },
      WAREHOUSES,
    );
    expect(scope).toEqual({ hasAllAccess: false, warehouseNames: [], unreadable: true });
  });

  it('a failed name list (null) for a user WITH warehouses is flagged, not "none"', () => {
    const scope = buildWarehouseScope({ hasAllAccess: false, readableIds: ['wh-b'] }, null);
    expect(scope).toEqual({ hasAllAccess: false, warehouseNames: [], namesUnreadable: true });
  });

  it('a failed name list for a user with genuinely no warehouse is still "none"', () => {
    const scope = buildWarehouseScope({ hasAllAccess: false, readableIds: [] }, null);
    expect(scope).toEqual({ hasAllAccess: false, warehouseNames: [] });
  });

  it('all-access with a failed name list: all access, no names', () => {
    expect(buildWarehouseScope({ hasAllAccess: true, readableIds: [] }, null)).toEqual({
      hasAllAccess: true,
      warehouseNames: [],
    });
  });

  it('produces exactly the mobile snapshot payload shape (hasAllAccess + warehouseNames)', () => {
    const scope = buildWarehouseScope(
      { hasAllAccess: false, readableIds: ['wh-a', 'wh-c'] },
      WAREHOUSES,
    );
    expect(Object.keys(scope).sort()).toEqual(['hasAllAccess', 'warehouseNames']);
    expect(typeof scope.hasAllAccess).toBe('boolean');
    expect(scope.warehouseNames).toEqual(['Main Warehouse', 'Overflow']);
  });
});

describe('scopedWarehouseMessage', () => {
  it('all-access renders no banner', () => {
    expect(
      scopedWarehouseMessage({ hasAllAccess: true, warehouseNames: ['Main Warehouse'] }),
    ).toBeNull();
  });

  it('one warehouse', () => {
    expect(
      scopedWarehouseMessage({ hasAllAccess: false, warehouseNames: ['Main Warehouse'] }),
    ).toBe(
      "You're viewing Main Warehouse only. An admin can adjust warehouse access from the Team page.",
    );
  });

  it('several warehouses, comma-joined', () => {
    expect(
      scopedWarehouseMessage({
        hasAllAccess: false,
        warehouseNames: ['Main Warehouse', 'East Annex'],
      }),
    ).toBe(
      "You're viewing Main Warehouse, East Annex only. An admin can adjust warehouse access from the Team page.",
    );
  });

  it('zero warehouses gets the no-assignment variant', () => {
    expect(scopedWarehouseMessage({ hasAllAccess: false, warehouseNames: [] })).toBe(
      'You have no assigned warehouses. An admin can adjust warehouse access from the Team page.',
    );
  });

  it('unreadable access gets the could-not-load line, not the no-assignment one', () => {
    expect(
      scopedWarehouseMessage({ hasAllAccess: false, warehouseNames: [], unreadable: true }),
    ).toBe(WAREHOUSE_ACCESS_UNREADABLE_MESSAGE);
    expect(WAREHOUSE_ACCESS_UNREADABLE_MESSAGE).toBe(
      "We couldn't load your warehouse access. Refresh the page to try again.",
    );
  });

  it('a failed name list gets a line that names no warehouse and claims no absence', () => {
    expect(
      scopedWarehouseMessage({ hasAllAccess: false, warehouseNames: [], namesUnreadable: true }),
    ).toBe(
      "You're viewing only the warehouses assigned to you. An admin can adjust warehouse access from the Team page.",
    );
  });
});
