import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { orderManagerActions, type OrderManagerActionsInput } from './order-manager-actions';

/**
 * Slice D (migration 0390): the order screen's MANAGER ACTIONS follow the
 * rule the server applies to each action, not role rank. Each case names the
 * mutation it catches.
 */

const base: OrderManagerActionsInput = {
  status: 'pending_approval',
  fulfillmentType: 'delivery',
  canApproveOrders: false,
  canAssignDelivery: false,
  isManagerByRole: false,
  isAssignedDriver: false,
  hasAssignedDriver: false,
  machineOffersReopen: false,
  isViewerRole: false,
};
const manager = { ...base, canApproveOrders: true, canAssignDelivery: true, isManagerByRole: true, machineOffersReopen: true };
const grantedStaff = { ...base, canApproveOrders: true };
const revokedManager = { ...base, canAssignDelivery: true, isManagerByRole: true, machineOffersReopen: true };
const staffDriver = { ...base, isAssignedDriver: true, hasAssignedDriver: true };
const at = (who: OrderManagerActionsInput, status: string, extra: Partial<OrderManagerActionsInput> = {}) =>
  orderManagerActions({ ...who, status, ...extra });

describe('orderManagerActions: approval follows orders:approve', () => {
  it('a staff member granted orders:approve sees Approve, Approve partial and Deny (mutation: gate on role rank)', () => {
    const a = at(grantedStaff, 'pending_approval');
    expect(a).toMatchObject({ showSection: true, approve: true, approvePartial: true, deny: true });
  });

  it('a manager whose orders:approve was revoked does not (mutation: isManagerByRole || canApproveOrders)', () => {
    for (const status of ['pending_approval', 'approved', 'picking_complete', 'packing_slip_generated', 'backordered']) {
      const a = at(revokedManager, status);
      expect(a.showSection, status).toBe(false);
      expect(a.approve || a.deny || a.generatePickSlip || a.generatePackingSlips || a.reopenPicking || a.backorderedActions).toBe(false);
    }
  });

  it('a manager by role default keeps every action where it was', () => {
    expect(at(manager, 'pending_approval')).toMatchObject({ approve: true, approvePartial: true, deny: true });
    expect(at(manager, 'approved').generatePickSlip).toBe(true);
    expect(at(manager, 'picking_complete')).toMatchObject({ generatePackingSlips: true, reopenPicking: true });
    expect(at(manager, 'packing_slip_generated', { fulfillmentType: 'pickup' })).toMatchObject({ stageForPickup: true, stageForDelivery: false, reopenPicking: true });
    expect(at(manager, 'packing_slip_generated', { fulfillmentType: 'delivery' })).toMatchObject({ stageForPickup: false, stageForDelivery: true });
    expect(at(manager, 'staged_for_delivery', { hasAssignedDriver: true })).toMatchObject({ assignDelivery: true, markInTransit: true });
    expect(at(manager, 'in_transit')).toMatchObject({ digitalSignature: true, physicalSignature: true });
    expect(at(manager, 'staged_for_pickup')).toMatchObject({ digitalSignature: true, physicalSignature: true });
    expect(at(manager, 'backordered').backorderedActions).toBe(true);
  });

  it('reopen needs orders:approve AND the shared machine (mutation: drop either)', () => {
    expect(at({ ...manager, canApproveOrders: false }, 'picking_complete').reopenPicking).toBe(false);
    expect(at({ ...grantedStaff, machineOffersReopen: false }, 'picking_complete').reopenPicking).toBe(false);
    expect(at({ ...grantedStaff, machineOffersReopen: true }, 'packing_slip_generated').reopenPicking).toBe(true);
  });

  it('Assign delivery follows orders:assign_delivery, the server gate (mutation: canApproveOrders alone)', () => {
    expect(at(grantedStaff, 'staged_for_delivery').assignDelivery).toBe(false);
    expect(at({ ...grantedStaff, canAssignDelivery: true }, 'staged_for_delivery').assignDelivery).toBe(true);
  });
});

describe('orderManagerActions: the assigned driver (owner decision O3, default)', () => {
  it('a staff driver without orders:approve sees the section in transit, never Mark in transit', () => {
    const staged = at(staffDriver, 'staged_for_delivery');
    expect(staged.markInTransit).toBe(false);
    // Nothing else to do there for them: no empty section.
    expect(staged.showSection).toBe(false);
    const transit = at(staffDriver, 'in_transit');
    expect(transit).toMatchObject({ showSection: true, digitalSignature: true, physicalSignature: true, markInTransit: false });
    expect(transit.approve || transit.assignDelivery || transit.backorderedActions).toBe(false);
  });

  it('a driver who holds orders:approve marks their delivery in transit (mutation: driver excluded)', () => {
    expect(at({ ...staffDriver, canApproveOrders: true }, 'staged_for_delivery').markInTransit).toBe(true);
  });

  it('no driver, no Mark in transit (mutation: drop hasAssignedDriver)', () => {
    expect(at(manager, 'staged_for_delivery', { hasAssignedDriver: false }).markInTransit).toBe(false);
  });

  it('the driver sees nothing at statuses that are not theirs', () => {
    for (const status of ['pending_approval', 'approved', 'picking_complete', 'packing_slip_generated', 'staged_for_pickup', 'backordered', 'completed']) {
      expect(at(staffDriver, status).showSection, status).toBe(false);
    }
  });
});

describe('orderManagerActions: a viewer is never offered an approval-class action (slice D review, findings 1 and 10)', () => {
  // The app refuses every write for role viewer (assertWarehouseAccess:
  // "Read-only auditor cannot perform write operations."), and each of these
  // actions asks warehouse write first; the sign route never hands an order
  // over for a viewer who is not the driver (handOverAllowed). Before 0390
  // the phone showed the section by role, so no viewer saw it.
  const grantedViewer = { ...base, canApproveOrders: true, canAssignDelivery: true, machineOffersReopen: true, isViewerRole: true };

  it('a viewer granted orders:approve sees no section at any status (mutation: drop the viewer rule)', () => {
    for (const status of ['pending_approval', 'approved', 'picking_complete', 'packing_slip_generated', 'staged_for_delivery', 'staged_for_pickup', 'in_transit', 'backordered']) {
      const a = at(grantedViewer, status, { hasAssignedDriver: true, fulfillmentType: status === 'staged_for_pickup' ? 'pickup' : 'delivery' });
      expect(a.showSection, status).toBe(false);
      expect(Object.entries(a).filter(([, v]) => v === true).map(([k]) => k), status).toEqual([]);
    }
  });

  it('a viewer who is the assigned driver keeps the driver\'s own steps, never Mark in transit (mutation: viewer rule on the driver too)', () => {
    const driver = { ...grantedViewer, isAssignedDriver: true, hasAssignedDriver: true };
    expect(at(driver, 'staged_for_delivery')).toMatchObject({ showSection: false, markInTransit: false, assignDelivery: false });
    expect(at(driver, 'in_transit')).toMatchObject({ showSection: true, digitalSignature: true, physicalSignature: true, markInTransit: false, backorderedActions: false });
  });

  it('staff are unaffected by the viewer rule', () => {
    expect(at({ ...grantedStaff, isViewerRole: false }, 'pending_approval').approve).toBe(true);
  });
});

describe('orderManagerActions: Physical signature is a manager by role or the driver', () => {
  it('a granted staff approver sees Collect signature but not Physical signature (confirm_physical_signature refuses them)', () => {
    expect(at(grantedStaff, 'in_transit')).toMatchObject({ digitalSignature: true, physicalSignature: false });
  });

  it('a manager by role and the driver see it (mutation: canApproveOrders instead of the role)', () => {
    expect(at(manager, 'in_transit').physicalSignature).toBe(true);
    expect(at(staffDriver, 'in_transit').physicalSignature).toBe(true);
  });
});

describe('orderManagerActions: never an empty or a wrong-status section', () => {
  it('terminal and picking statuses render nothing here', () => {
    for (const status of ['completed', 'cancelled', 'denied', 'pending_confirmation', 'pick_slip_generated', 'picking_in_progress', null, undefined]) {
      expect(at(manager, status as string).showSection, String(status)).toBe(false);
    }
  });

  it('a viewer with nothing sees nothing', () => {
    for (const status of ['pending_approval', 'staged_for_delivery', 'in_transit']) {
      expect(at(base, status).showSection, status).toBe(false);
    }
  });
});

describe('the order screen reads these gates (wiring pins)', () => {
  const SCREEN = readFileSync(path.resolve(__dirname, '../../app/order/[id].tsx'), 'utf8');

  it('the section is the helper\'s answer, no longer role rank (mutation: restore `isManager &&`)', () => {
    expect(SCREEN).toContain('const hasPipelineActions = managerActions.showSection;');
    expect(SCREEN).not.toMatch(/const hasPipelineActions =\s*isManager/);
    expect(SCREEN).toMatch(/canApproveOrders: rpApprove,\s*canAssignDelivery: role !== null && can\(\{ role: role as Role, permissions \}, 'orders:assign_delivery'\),\s*isManagerByRole: isManager,/);
  });

  it('the screen tells the helper when the viewer is a viewer (mutation: drop or invert it)', () => {
    expect(SCREEN).toMatch(/machineOffersReopen: canReopenPicking,\s*isViewerRole: role === 'viewer',\s*\}\);/);
  });

  it('both calls to the shared machine pass the effective permission, so reopen follows orders:approve, as the web panel does (mutation: drop either)', () => {
    const calls = SCREEN.split('availableOrderActions({').slice(1).map((c) => c.slice(0, c.indexOf('})')));
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toContain('canApproveOrders: rpApprove,');
  });

  it('each button reads its own gate', () => {
    for (const gate of [
      'managerActions.approve ?',
      'managerActions.approvePartial &&',
      'managerActions.deny',
      'managerActions.generatePickSlip',
      'managerActions.generatePackingSlips',
      "order.status === 'picking_complete' && managerActions.reopenPicking",
      'managerActions.stageForPickup',
      'managerActions.stageForDelivery',
      "order.status === 'packing_slip_generated' && managerActions.reopenPicking",
      'managerActions.assignDelivery',
      'managerActions.markInTransit',
      'managerActions.digitalSignature',
      'managerActions.physicalSignature',
      'managerActions.backorderedActions ?',
    ]) {
      expect(SCREEN, gate).toContain(gate);
    }
  });
});
