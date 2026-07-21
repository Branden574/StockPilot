import { describe, expect, it } from 'vitest';

import { buildWarehouseScope, scopedWarehouseMessage } from './warehouse-scope';

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
});
