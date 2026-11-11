import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cssRules, normaliseQuotes } from '@/styles/liquid-glass/glass-css';
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

/**
 * THE PHONE'S NEXT-STEP BAR (Liquid Glass, fidelity lane phone;
 * Order-Detail-Mobile.dc.html .cartbar). At 760 px and under,
 * pages/order-detail.css fixes the card's own step that moves the order on
 * (the FIRST default-variant button of its button row) to the foot of the
 * screen and draws the bar behind it with that row's ::after: no copy of the
 * button, so its busy state and confirms are the panel's. This checks, in
 * each state, which node that selector picks (happy-dom cannot match its
 * ":not(… ~ *)", so the pick is computed the same way here and the rule's
 * text is pinned), and that the bar is drawn only when there is a step.
 * Fails on a stylesheet without the phone bar.
 */
describe('Liquid Glass phone next-step bar', () => {
  const ROOT = ":root[data-appearance='liquid-glass']";
  const ROW =
    "[data-glass-page='order-detail'] [data-glass-role='order-manager-actions'] [data-testid='manager-actions-buttons']";
  const STEP = `${ROOT} ${ROW} > [data-glass-variant='default']:not([data-glass-variant='default'] ~ *)`;
  const rules = cssRules('pages/order-detail.css');
  const phone = (media: string[]) => media.includes('(max-width: 760px)');
  const ruleFor = (selector: string) =>
    rules.find(
      (r) =>
        phone(r.media) &&
        r.selectors.some((s) => normaliseQuotes(s.replace(/\s+/g, ' ')) === selector),
    );

  it('fixes the first default-variant button of the row to the foot, over the row’s ::after bar', () => {
    expect(ruleFor(STEP)?.decls).toMatchObject({
      position: 'fixed',
      right: '20px',
      'z-index': '41',
      height: '44px',
    });
    const bar = ruleFor(`${ROOT} ${ROW}:has(> [data-glass-variant='default'])::after`)?.decls;
    expect(bar).toMatchObject({
      // The order's status, as the page head's badge names it (the row's
      // data-glass-status), in the 104 px the widest button leaves.
      content: "attr(data-glass-status) / ''",
      padding: '0 calc(100vw - 144px) 0 16px',
      overflow: 'hidden',
      position: 'fixed',
      left: '12px',
      right: '12px',
      height: '60px',
      'z-index': '40',
      'pointer-events': 'none',
    });
  });

  // The bar's words: the status badge's label for each state.
  const STATUS_WORDS: Record<string, string> = {
    'pending-approval-deny-open': 'Pending',
    approved: 'Approved',
    'picking-unassigned-staff': 'Pick slip',
    'picking-mine-staff': 'Picking',
    denied: 'Denied',
  };

  it('lifts the toast dock over the bar while there is a step', () => {
    const globals = cssRules('globals.glass.css');
    const STEP_ON_PAGE = `${ROW} > [data-glass-variant='default']`;
    const lift = globals.find(
      (r) =>
        phone(r.media) &&
        r.selectors.some(
          (sel) =>
            normaliseQuotes(sel.replace(/\s+/g, ' ').replace(/\( | \)/g, (m) => m.trim())) ===
            `${ROOT}:has(${STEP_ON_PAGE}) ol[data-sonner-toaster][data-y-position='bottom']`,
        ),
    );
    expect(lift?.decls.bottom).toBe('calc(84px + var(--sp-update-card-offset, 0px))');
  });

  const EXPECTED: Record<string, string | null> = {
    'pending-approval-deny-open': 'Approve',
    approved: 'Generate pick slip',
    'picking-unassigned-staff': 'Claim picking',
    'picking-mine-staff': 'Open digital pick',
    denied: null,
  };

  for (const state of STATES) {
    it(`${state.name}: the bar carries ${EXPECTED[state.name] ?? 'nothing'}`, () => {
      cleanup();
      vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', 'default');
      document.documentElement.setAttribute('data-appearance', 'liquid-glass');
      try {
        render(
          <div data-glass-page="order-detail">
            <ManagerActionsPanel {...state.props} />
          </div>,
        );
        const row = document.querySelector(`${ROOT} ${ROW}`)!;
        expect(row).not.toBeNull();
        const defaults = [...row.children].filter(
          (el) => el.getAttribute('data-glass-variant') === 'default',
        );
        // The rule's pick: a default-variant child with no default-variant
        // sibling before it, i.e. the first one.
        const picked = defaults.filter(
          (el) =>
            ![...row.children]
              .slice(0, [...row.children].indexOf(el))
              .some((prev) => prev.getAttribute('data-glass-variant') === 'default'),
        );
        expect(picked.map((el) => el.textContent?.trim())).toEqual(
          EXPECTED[state.name] ? [EXPECTED[state.name]] : [],
        );
        // The bar (and the page's room for it, and the toast dock's lift)
        // only with a step.
        expect(row.matches(`${ROOT} ${ROW}:has(> [data-glass-variant='default'])`)).toBe(
          picked.length > 0,
        );
        expect(document.querySelector(`${ROW} > [data-glass-variant='default']`) !== null).toBe(
          picked.length > 0,
        );
        expect(row.getAttribute('data-glass-status')).toBe(STATUS_WORDS[state.name]);
      } finally {
        document.documentElement.removeAttribute('data-appearance');
      }
    });
  }
});
