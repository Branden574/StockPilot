import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

import { ManagerActionsPanel } from './manager-actions-panel';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 3, orders lane). The order page's
 * Manager actions card (the page's own pin stubs it), in the pipeline's main
 * states, and the Deny dialog open: its Classic DOM, normalised as the
 * classic proof normalises a page (src/test/classic-dom.ts), pinned in
 * __classic__/ from the code BEFORE Liquid Glass added its hooks. Liquid
 * Glass may add only inert hook attributes and glass-only elements; with them
 * stripped the card and its dialog must render exactly the pinned DOM under
 * the `off` rollout (no glass-only element at all) and under `default`. Fix
 * the change, never the snapshot.
 *
 * The mocks are manager-actions-panel.test.tsx's.
 */

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/order-requests', () => ({
  approveOrderPartialAction: vi.fn(),
  approveOrderRequestAction: vi.fn(),
  closePartialAction: vi.fn(),
  confirmPhysicalSignatureAction: vi.fn(),
  resumeFulfillmentAction: vi.fn(),
  assignDeliveryAction: vi.fn(),
  assignPickingAction: vi.fn(),
  claimPickingAction: vi.fn(),
  completePickingAction: vi.fn(),
  denyOrderRequestAction: vi.fn(),
  generatePackingSlipsAction: vi.fn(),
  generatePickSlipAction: vi.fn(),
  markInTransitAction: vi.fn(),
  releasePickingAction: vi.fn(),
  reopenPickingAction: vi.fn(),
  setOrderInternalNotesAction: vi.fn(),
  setOrderNeededByAction: vi.fn(),
  stageOrderAction: vi.fn(),
  suggestNeededByAction: vi.fn(),
}));
vi.mock('@/server/actions/returns', () => ({ releaseReturnReplacementAction: vi.fn() }));

type PanelProps = React.ComponentProps<typeof ManagerActionsPanel>;

function props(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    orderId: 'order-1',
    status: 'pick_slip_generated',
    internalNotes: null,
    neededBy: null,
    orgTimeZone: 'America/Los_Angeles',
    hasRequesterNote: false,
    fulfillmentType: 'pickup',
    assignedDeliveryUserId: null,
    signatureToken: null,
    hasSignature: false,
    canPrintWarehouseSlip: true,
    signedByName: null,
    signedAt: null,
    drivers: [],
    canApprove: false,
    canAssignDelivery: false,
    viewerRole: 'staff',
    viewerUserId: 'me',
    assignedPickerId: null,
    assignedPickerName: null,
    pickers: [],
    viewerCanPick: true,
    completionConfirm: null,
    departureLines: [],
    ...overrides,
  };
}

const MANAGER = { canApprove: true, viewerRole: 'manager' as const };

const STATES: Array<{ name: string; props: PanelProps; openDeny?: boolean }> = [
  {
    name: 'pending-approval-deny-open',
    props: props({
      ...MANAGER,
      status: 'pending_approval',
      internalNotes: 'Check the polo sizes before picking.',
      stockGates: { approvePartial: 'enabled', resume: 'waiting', notice: null, canRetry: false },
      approveNotice:
        '1 line asks for more than is available now, so Approve will be refused. Use Approve partial or change the lines.',
    }),
    openDeny: true,
  },
  { name: 'approved', props: props({ ...MANAGER, status: 'approved' }) },
  { name: 'picking-unassigned-staff', props: props({ status: 'pick_slip_generated' }) },
  {
    name: 'picking-mine-staff',
    props: props({
      status: 'picking_in_progress',
      assignedPickerId: 'me',
      assignedPickerName: 'Robin Example',
    }),
  },
  { name: 'denied', props: props({ ...MANAGER, status: 'denied' }) },
];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-02T18:00:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  cleanup();
});

async function renderUnder(rollout: 'off' | 'default', state: (typeof STATES)[number]) {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  render(<ManagerActionsPanel {...state.props} />);
  if (state.openDeny) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    });
    expect(screen.getByRole('dialog', { name: 'Deny this request?' })).toBeInTheDocument();
  }
  // The dialog is portalled to body, so the whole body is read.
  return {
    dom: classicDom(document.body),
    structure: classicStructure(document.body),
    glassOnly: glassOnlyCount(document.body),
  };
}

describe('Manager actions card, Classic DOM', () => {
  for (const state of STATES) {
    it(`${state.name}: the pinned Classic DOM under off and under default`, async () => {
      const off = await renderUnder('off', state);
      expect(off.glassOnly).toBe(0);
      const glass = await renderUnder('default', state);
      expect(glass.dom).toBe(off.dom);
      // No Classic element changes its place among its siblings (classicStructure).
      expect(glass.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(
        `./__classic__/manager-actions-panel.${state.name}.txt`,
      );
    });
  }
});
