// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/actions/returns', () => ({
  runReturnStepsAction: vi.fn(),
  denyReturnAction: vi.fn(),
  cancelReturnAction: vi.fn(),
  planReturnDispositionsAction: vi.fn(),
  buyReturnLabelAction: vi.fn(),
}));
vi.mock('@/server/actions/return-request', () => ({ recordReturnRequestDraftedAction: vi.fn(async () => undefined) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { ReturnWorkbench } from './return-workbench';

/**
 * F14 on the return page's header: "Send return request" and "Report a
 * problem". The page decides both for the viewer and passes plain values;
 * this file pins what the workbench draws from them, and that a workbench
 * given neither draws exactly the header it drew before.
 */

const ROUTING = { to: 'intake@warehouse.test', cc: 'copy@warehouse.test' };
const LINK = 'https://app.example.test/dashboard/returns/11111111-1111-4111-8111-111111111111';

function bench(status: string, over: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    return: {
      id: '11111111-1111-4111-8111-111111111111',
      returnNumber: 'RMA-20261110-AB12CD',
      status,
      source: 'requester',
      reasonCode: 'damaged',
      notes: 'STAFF NOTE never in a draft',
      denialReason: 'DENIAL TEXT never in a draft',
      orderRequestId: '22222222-2222-4222-8222-222222222222',
      orderNumber: 103,
      warehouseId: 'w1',
      warehouseName: 'Main',
      requesterName: 'Sample Requester',
      requesterEmail: 'requester@school.test',
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
    revision: 0,
    planSeq: 0,
    createdOnCounter: false,
    destinationsUnavailable: false,
    lines: [
      {
        id: 'l1',
        orderRequestLineId: 'ol1',
        itemId: 'i1',
        quantity: 2,
        disposition: 'restock',
        applied: status === 'closed',
        item: { name: 'Staff Polo', sku: 'POLO-M', variant: 'Size M', deleted: false, imageUrl: null, thumbUrl: null },
        restock: null,
        legs: [],
        inboundState: 'Waiting',
      },
    ],
    decisions: [],
    chain: [],
    viewer: { canManageReturns: false, canApproveOrders: false, canReadDecisions: true },
    actions: { primary: null, secondary: [], readOnlyReason: null },
    ...over,
  } as never;
}

const send = () => screen.queryByRole('button', { name: 'Send return request' });
const report = () => screen.queryByRole('link', { name: 'Report a problem' });
const actionsRow = (c: HTMLElement) => c.querySelector('[data-slot="page-header-actions"]');

beforeEach(() => vi.clearAllMocks());

describe('ReturnWorkbench header (F14)', () => {
  it('given neither prop, the header has no actions row: the page it drew before', () => {
    const { container } = render(<ReturnWorkbench workbench={bench('requested')} />);
    expect(actionsRow(container)).toBeNull();
    expect(send()).not.toBeInTheDocument();
    expect(report()).not.toBeInTheDocument();
    expect(screen.queryByTestId('return-request-routing-hint')).not.toBeInTheDocument();
  });

  it('both gates closed draws no actions row either', () => {
    const { container } = render(
      <ReturnWorkbench
        workbench={bench('requested')}
        returnRequest={{ recipients: null, link: LINK, showRoutingHint: false }}
        reportProblem={{ moduleEnabled: true, canSubmit: false }}
      />,
    );
    expect(actionsRow(container)).toBeNull();
  });

  it('draws both in the actions row, each an outline button with the Liquid Glass hooks its siblings carry', () => {
    const { container } = render(
      <ReturnWorkbench
        workbench={bench('approved')}
        returnRequest={{ recipients: ROUTING, link: LINK, showRoutingHint: false }}
        reportProblem={{ moduleEnabled: true, canSubmit: true }}
      />,
    );
    const row = actionsRow(container)!;
    expect(row.contains(send())).toBe(true);
    expect(row.contains(report())).toBe(true);
    for (const el of [send()!, report()!]) {
      expect(el).toHaveAttribute('data-glass', 'button');
      expect(el).toHaveAttribute('data-glass-variant', 'outline');
    }
    expect(report()).toHaveAttribute(
      'href',
      '/dashboard/maintenance/new?orderRequestId=22222222-2222-4222-8222-222222222222&subject=Return+RMA-20261110-AB12CD%3A+',
    );
  });

  it('offers Send return request while the return is requested, approved or received, and not after', () => {
    for (const [status, shown] of [
      ['requested', true],
      ['approved', true],
      ['received', true],
      ['closed', false],
      ['denied', false],
      ['cancelled', false],
    ] as const) {
      const { unmount } = render(
        <ReturnWorkbench
          workbench={bench(status)}
          returnRequest={{ recipients: ROUTING, link: LINK, showRoutingHint: true }}
          reportProblem={{ moduleEnabled: true, canSubmit: true }}
        />,
      );
      expect(Boolean(send()), status).toBe(shown);
      // Report a problem does not depend on the return's status.
      expect(report(), status).toBeInTheDocument();
      unmount();
    }
  });

  it('a return with no number has no Send return request', () => {
    render(
      <ReturnWorkbench
        workbench={bench('requested', { return: { ...(bench('requested') as { return: object }).return, returnNumber: null } })}
        returnRequest={{ recipients: ROUTING, link: LINK, showRoutingHint: false }}
      />,
    );
    expect(send()).not.toBeInTheDocument();
  });

  it('the draft says what the page shows, with SKU and reason, and never the notes or the denial reason', async () => {
    render(
      <ReturnWorkbench
        workbench={bench('requested')}
        returnRequest={{ recipients: ROUTING, link: LINK, showRoutingHint: false }}
      />,
    );
    await userEvent.click(send()!);
    const dialog = await screen.findByRole('dialog', { name: 'Send return request' });
    const body = dialog.querySelector('[data-testid="return-request-preview"]')!.textContent ?? '';
    expect(body.split('\n')).toEqual([
      'Return request',
      '',
      'Return: RMA-20261110-AB12CD',
      'Order: SO-000103',
      'Status: Requested',
      'Reason: Damaged',
      'Requested by: Sample Requester, requester@school.test',
      'Warehouse: Main',
      '',
      'Items coming back:',
      '- Staff Polo, M ×2 (SKU POLO-M)',
      '',
      'Open in StockPilot:',
      LINK,
    ]);
    expect(dialog.textContent).not.toContain('STAFF NOTE');
    expect(dialog.textContent).not.toContain('DENIAL TEXT');
  });

  it('the settings hint shows only when asked for, with no mailboxes, on a return that could be written about', () => {
    const hint = () => screen.queryByTestId('return-request-routing-hint');
    const cases: Array<[string, { recipients: typeof ROUTING | null; link: string; showRoutingHint: boolean }, boolean]> = [
      ['requested', { recipients: null, link: LINK, showRoutingHint: true }, true],
      ['requested', { recipients: null, link: LINK, showRoutingHint: false }, false],
      ['requested', { recipients: ROUTING, link: LINK, showRoutingHint: true }, false],
      ['closed', { recipients: null, link: LINK, showRoutingHint: true }, false],
    ];
    for (const [status, rr, shown] of cases) {
      const { unmount } = render(<ReturnWorkbench workbench={bench(status)} returnRequest={rr} />);
      expect(Boolean(hint()), `${status} ${JSON.stringify(rr)}`).toBe(shown);
      unmount();
    }
  });
});
