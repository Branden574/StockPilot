// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestockOptionsLine, RestockSource } from '@stockpilot/core';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, operations lane). The RMA
 * workbench's Classic DOM (Return-Detail.dc.html in glass), normalised as the
 * classic proof normalises it (src/test/classic-dom.ts), pinned in
 * __classic__/ from the code BEFORE the glass composition and its glass-only
 * progress rail were added, for a return in each state the workbench draws.
 * With the inert hooks stripped and every glass-only element dropped, the
 * workbench must render the pinned DOM under the `off` rollout (with no
 * glass-only element at all) and under `default`, and under `default` no
 * Classic element may change its place among its siblings (classicStructure).
 * Fixtures as return-workbench.layout.test.tsx builds them.
 */

vi.mock('@/server/actions/returns', () => ({
  runReturnStepsAction: vi.fn(),
  denyReturnAction: vi.fn(),
  cancelReturnAction: vi.fn(),
  planReturnDispositionsAction: vi.fn(),
  buyReturnLabelAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      children,
      className,
    }: {
      href: string;
      children: React.ReactNode;
      className?: string;
    }) => React.createElement('a', { href, className }, children),
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { ReturnWorkbench } from './return-workbench';

const R31 = '44444444-4444-4444-8444-444444444444';

function src(
  locationId: string,
  name: string,
  remaining: number,
  valid = true,
  reason: string | null = null,
  over: Partial<RestockSource> = {},
): RestockSource {
  return {
    locationId,
    name,
    kind: 'rack',
    type: 'shelf',
    drawn: remaining,
    restored: 0,
    remaining,
    cap: remaining,
    valid,
    reason,
    writable: true,
    ...over,
  };
}

function opts(over: Partial<RestockOptionsLine> = {}): RestockOptionsLine {
  return {
    returnLineId: 'l1',
    itemId: 'i1',
    quantity: 1,
    disposition: 'restock',
    applied: false,
    plan: null,
    case: 'single_source',
    notRecordedReason: null,
    sources: [src(R31, '31-C', 1)],
    offerOriginal: true,
    offerSourceIds: [],
    preselect: 'original',
    ...over,
  };
}

function bench(
  status: string,
  line: Partial<RestockOptionsLine> | null = {},
  over: Record<string, unknown> = {},
) {
  const restock = line === null ? null : opts(line);
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
    revision: status === 'requested' ? 0 : 1,
    planSeq: 4,
    createdOnCounter: false,
    destinationsUnavailable: false,
    lines: [
      {
        id: 'l1',
        orderRequestLineId: 'ol1',
        itemId: 'i1',
        quantity: 1,
        disposition: 'restock',
        applied: status === 'closed',
        item: {
          name: 'Walk New Hire Shirt',
          sku: 'NH-M',
          variant: 'Size M',
          deleted: false,
          imageUrl: null,
          thumbUrl: null,
        },
        restock: status === 'closed' ? null : restock,
        legs: [],
        inboundState: status === 'received' ? 'Received' : 'Waiting',
      },
    ],
    decisions: [],
    chain: [],
    viewer: { canManageReturns: true, canApproveOrders: true, canReadDecisions: true },
    actions: { primary: null, secondary: [], readOnlyReason: null },
    ...over,
  } as never;
}

const NOW = new Date('2026-10-05T18:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const withReturn = (
  status: string,
  line: Partial<RestockOptionsLine> | null,
  over: Record<string, unknown>,
) => {
  const base = bench(status, line) as { return: Record<string, unknown> };
  return bench(status, line, {
    ...over,
    return: {
      ...base.return,
      requesterName: 'Pat Lee',
      reasonCode: 'damaged',
      notes: 'Two pairs have loose rivets.',
      ...((over.return as Record<string, unknown> | undefined) ?? {}),
    },
  });
};

const SCENARIOS: Array<[string, () => unknown]> = [
  [
    'requested',
    () =>
      withReturn(
        'requested',
        {},
        {
          actions: { primary: 'approve', secondary: ['deny', 'cancel'], readOnlyReason: null },
        },
      ),
  ],
  [
    'approved',
    () =>
      withReturn(
        'approved',
        {},
        {
          actions: { primary: 'receive', secondary: ['cancel'], readOnlyReason: null },
          return: { approvedAt: '2026-10-02T00:00:00Z' },
        },
      ),
  ],
  [
    'received',
    () =>
      withReturn(
        'received',
        {},
        {
          actions: { primary: 'process', secondary: [], readOnlyReason: null },
          return: { approvedAt: '2026-10-02T00:00:00Z', receivedAt: '2026-10-03T00:00:00Z' },
        },
      ),
  ],
  [
    'closed',
    () =>
      withReturn('closed', null, {
        return: {
          approvedAt: '2026-10-02T00:00:00Z',
          receivedAt: '2026-10-03T00:00:00Z',
          closedAt: '2026-10-04T00:00:00Z',
        },
      }),
  ],
  [
    'denied',
    () =>
      withReturn('denied', null, {
        return: { deniedAt: '2026-10-02T00:00:00Z', denialReason: 'Outside the return window.' },
      }),
  ],
  [
    'read-only',
    () =>
      withReturn(
        'requested',
        {},
        {
          viewer: { canManageReturns: false, canApproveOrders: false, canReadDecisions: false },
          actions: { primary: null, secondary: [], readOnlyReason: 'You can view this return.' },
        },
      ),
  ],
];

function classicOf(rollout: 'off' | 'default', workbench: unknown) {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const view = render(<ReturnWorkbench workbench={workbench as never} />);
  const out = {
    dom: classicDom(view.container),
    structure: classicStructure(view.container),
    glassOnly: glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

describe('RMA workbench: the Classic DOM is the pinned one', () => {
  for (const [name, make] of SCENARIOS) {
    it(`${name}: off renders no glass-only part, off and default normalise to the pinned DOM, and default moves no Classic element among its siblings`, async () => {
      const off = classicOf('off', make());
      const glassBuild = classicOf('default', make());
      expect(off.glassOnly).toBe(0);
      expect(glassBuild.dom).toBe(off.dom);
      expect(glassBuild.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/return-workbench.${name}.txt`);
    });
  }
});
