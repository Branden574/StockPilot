import { describe, expect, it } from 'vitest';

import { userCanAccessInventory, type UserAssignment } from './access-predicate';

const WH_A = '11111111-1111-1111-1111-111111111111';
const WH_B = '22222222-2222-2222-2222-222222222222';
const CH_X = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CH_Y = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const allChartersAtA: UserAssignment[] = [{ warehouse_id: WH_A, charter_id: null }];
const charterXAtA: UserAssignment[] = [{ warehouse_id: WH_A, charter_id: CH_X }];

describe('userCanAccessInventory', () => {
  // ── Scenario 1: managers see everything ─────────────────────────────
  it('manager reads any (warehouse, charter) pair', () => {
    expect(
      userCanAccessInventory({
        role: 'manager',
        assignments: [],
        warehouseId: WH_A,
        charterId: CH_X,
        op: 'read',
      }),
    ).toBe(true);
  });

  it('admin writes to any warehouse', () => {
    expect(
      userCanAccessInventory({
        role: 'admin',
        assignments: [],
        warehouseId: WH_B,
        charterId: null,
        op: 'write',
      }),
    ).toBe(true);
  });

  // ── Scenario 2: staff with "all charters at A" ──────────────────────
  it('staff with all-charters assignment at A sees specific charter at A', () => {
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: allChartersAtA,
        warehouseId: WH_A,
        charterId: CH_X,
        op: 'read',
      }),
    ).toBe(true);
  });

  it('staff with all-charters at A writes to generic at A', () => {
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: allChartersAtA,
        warehouseId: WH_A,
        charterId: null,
        op: 'write',
      }),
    ).toBe(true);
  });

  it('staff with all-charters at A is blocked from warehouse B', () => {
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: allChartersAtA,
        warehouseId: WH_B,
        charterId: CH_X,
        op: 'read',
      }),
    ).toBe(false);
  });

  // ── Scenario 3: charter-scoped staff at A ───────────────────────────
  it('staff scoped to (A, X) reads matching item', () => {
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: charterXAtA,
        warehouseId: WH_A,
        charterId: CH_X,
        op: 'read',
      }),
    ).toBe(true);
  });

  it('staff scoped to (A, X) is blocked from charter Y at A', () => {
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: charterXAtA,
        warehouseId: WH_A,
        charterId: CH_Y,
        op: 'read',
      }),
    ).toBe(false);
  });

  it('staff scoped to (A, X) sees generic stock at A', () => {
    // Generic = any charter the warehouse services. The user has access
    // to the warehouse, so they can see/use generic stock.
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: charterXAtA,
        warehouseId: WH_A,
        charterId: null,
        op: 'read',
      }),
    ).toBe(true);
  });

  // ── Scenario 4: viewer ──────────────────────────────────────────────
  it('viewer at A can read but never write', () => {
    const viewerAtA: UserAssignment[] = [{ warehouse_id: WH_A, charter_id: null }];
    expect(
      userCanAccessInventory({
        role: 'viewer',
        assignments: viewerAtA,
        warehouseId: WH_A,
        charterId: CH_X,
        op: 'read',
      }),
    ).toBe(true);
    expect(
      userCanAccessInventory({
        role: 'viewer',
        assignments: viewerAtA,
        warehouseId: WH_A,
        charterId: CH_X,
        op: 'write',
      }),
    ).toBe(false);
  });

  // ── Scenario 5: unassigned staff is blocked everywhere ──────────────
  it('staff with no assignments is blocked everywhere', () => {
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: [],
        warehouseId: WH_A,
        charterId: CH_X,
        op: 'read',
      }),
    ).toBe(false);
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: [],
        warehouseId: WH_A,
        charterId: null,
        op: 'read',
      }),
    ).toBe(false);
  });

  // ── Scenario 6: multi-charter assignment per warehouse ──────────────
  it('staff with charter X at A and charter Y at A sees both, not Y at B', () => {
    const both: UserAssignment[] = [
      { warehouse_id: WH_A, charter_id: CH_X },
      { warehouse_id: WH_A, charter_id: CH_Y },
    ];
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: both,
        warehouseId: WH_A,
        charterId: CH_X,
        op: 'write',
      }),
    ).toBe(true);
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: both,
        warehouseId: WH_A,
        charterId: CH_Y,
        op: 'write',
      }),
    ).toBe(true);
    expect(
      userCanAccessInventory({
        role: 'staff',
        assignments: both,
        warehouseId: WH_B,
        charterId: CH_Y,
        op: 'read',
      }),
    ).toBe(false);
  });
});
