// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A return's Liquid Glass progress rail (Return-Detail.dc.html, the
 * "Return progress" steps under the head): Requested, Approved, Received,
 * Processed, with the steps before the return's status done (a check), its
 * status the current step (aria-current="step") and the rest to come. Glass
 * only and stateless: the words come from the return's status, which the
 * workbench already has (no new read), rendered under opt-in and default
 * and hidden in Classic by styles/liquid-glass/visibility.css, never under
 * off. A denied or cancelled return has no rail (the board draws none; its
 * status says it). It sits right after the page head, before the Next step
 * card, so no Classic element changes its place among its siblings
 * (return-workbench.classic-dom.test.tsx).
 */

vi.mock('@/server/actions/returns', () => ({
  runReturnStepsAction: vi.fn(),
  denyReturnAction: vi.fn(),
  cancelReturnAction: vi.fn(),
  planReturnDispositionsAction: vi.fn(),
  buyReturnLabelAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { ReturnWorkbench } from './return-workbench';

function bench(status: string) {
  return {
    organizationId: 'org-1',
    return: {
      id: '11111111-1111-4111-8111-111111111111',
      returnNumber: 'RMA-1',
      status,
      source: 'internal',
      reasonCode: null,
      notes: null,
      denialReason: null,
      orderRequestId: 'o1',
      orderNumber: 103,
      warehouseId: 'w1',
      warehouseName: 'Main',
      requesterName: null,
      requesterEmail: null,
      createdAt: '2026-10-01T00:00:00Z',
      approvedAt: null,
      receivedAt: null,
      closedAt: null,
      deniedAt: null,
      requestedByName: null,
      approvedByName: null,
      receivedByName: null,
      closedByName: null,
      deniedByName: null,
    },
    revision: 1,
    planSeq: 4,
    createdOnCounter: false,
    destinationsUnavailable: false,
    lines: [],
    decisions: [],
    chain: [],
    viewer: { canManageReturns: true, canApproveOrders: true, canReadDecisions: true },
    actions: { primary: null, secondary: [], readOnlyReason: null },
  } as never;
}

function view(status: string, rollout: 'off' | 'opt-in' | 'default' = 'default') {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  return render(<ReturnWorkbench workbench={bench(status)} />);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Each step as "<state> <mark> <label>", with (current) on the current one. */
function steps(container: HTMLElement): string[] {
  const rail = container.querySelector('ol[aria-label="Return progress"]');
  if (!rail) return [];
  return [...rail.querySelectorAll(':scope > li[data-state]')].map((li) => {
    const mark = li.querySelector('[data-glass="return-step-mark"]')?.textContent ?? '';
    const label = li.textContent!.replace(mark, '');
    const current = li.getAttribute('aria-current') === 'step' ? ' (current)' : '';
    return `${li.getAttribute('data-state')} ${mark} ${label}${current}`;
  });
}

describe('A return in Liquid Glass: the board’s progress rail', () => {
  it('requested: the first step is the current one, the rest to come', () => {
    expect(steps(view('requested').container)).toEqual([
      'now 1 Requested (current)',
      'todo 2 Approved',
      'todo 3 Received',
      'todo 4 Processed',
    ]);
  });

  it('approved: Requested is done, Approved is current', () => {
    expect(steps(view('approved').container)).toEqual([
      'done ✓ Requested',
      'now 2 Approved (current)',
      'todo 3 Received',
      'todo 4 Processed',
    ]);
  });

  it('received: two done, Received current', () => {
    expect(steps(view('received').container)).toEqual([
      'done ✓ Requested',
      'done ✓ Approved',
      'now 3 Received (current)',
      'todo 4 Processed',
    ]);
  });

  it('closed: every step done, none current', () => {
    expect(steps(view('closed').container)).toEqual([
      'done ✓ Requested',
      'done ✓ Approved',
      'done ✓ Received',
      'done ✓ Processed',
    ]);
  });

  it('is glass-only, its marks hidden from assistive technology, right after the head and before Next step', () => {
    const { container } = view('approved');
    const rail = container.querySelector('ol[aria-label="Return progress"]')!;
    expect(rail.hasAttribute('data-glass-only')).toBe(true);
    expect(rail.getAttribute('data-glass')).toBe('return-rail');
    for (const mark of rail.querySelectorAll('[data-glass="return-step-mark"]')) {
      expect(mark.getAttribute('aria-hidden')).toBe('true');
    }
    const root = container.firstElementChild!;
    expect(root.children[0]!.getAttribute('data-slot')).toBe('page-header');
    expect(root.children[1]).toBe(rail);
    expect(root.children[2]!.getAttribute('aria-label')).toBe('Next step');
  });

  it('draws the board’s line between two steps as a hidden list item, so the list reads as four steps', () => {
    const { container } = view('received');
    const items = [...container.querySelectorAll('ol[aria-label="Return progress"] > li')];
    expect(
      items.map((li) => li.getAttribute('data-glass') ?? li.getAttribute('data-state')),
    ).toEqual([
      'done',
      'return-step-sep',
      'done',
      'return-step-sep',
      'now',
      'return-step-sep',
      'todo',
    ]);
    for (const sep of items.filter((li) => li.getAttribute('data-glass') === 'return-step-sep')) {
      expect(sep.getAttribute('aria-hidden')).toBe('true');
      expect(sep.childNodes).toHaveLength(0);
    }
  });

  it('draws no rail for a denied or a cancelled return', () => {
    expect(steps(view('denied').container)).toEqual([]);
    expect(steps(view('cancelled').container)).toEqual([]);
  });

  it('draws it under opt-in, and not at all under the off rollout', () => {
    expect(steps(view('requested', 'opt-in').container)).toHaveLength(4);
    const { container } = view('requested', 'off');
    expect(container.querySelector('[data-glass="return-rail"]')).toBeNull();
    expect(container.querySelectorAll('[data-glass-only]')).toHaveLength(0);
  });
});
