// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RETURNS_COPY, type RestockOptionsLine, type RestockSource } from '@stockpilot/core';

/**
 * The RMA workbench in the redesign (P4.B3, matrix W-OR-06, 06a, 06d, 06e):
 * the shared page header (one h1, the back link, the badges, "Against order
 * ..."), the next-step bar with "The item is here" as the shared switch, the
 * RETURNING card's photo frame, the native destination radios, the return
 * label as label / value rows and the history as the shared timeline. Words,
 * names and gates as before; the lifecycle is covered by
 * return-workbench.test.tsx and return-workbench.exchange.test.tsx.
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
const R32 = '55555555-5555-4555-8555-555555555555';

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

beforeEach(() => vi.clearAllMocks());

const requested = (over: Record<string, unknown> = {}) =>
  bench(
    'requested',
    {},
    {
      actions: { primary: 'approve', secondary: ['deny', 'cancel'], readOnlyReason: null },
      ...over,
    },
  );

describe('the workbench header', () => {
  it('is the shared page header: one h1 (the RMA number), the back link, the three badges and the order line', () => {
    render(
      <ReturnWorkbench
        workbench={requested({
          return: {
            ...(bench('requested') as { return: Record<string, unknown> }).return,
            requesterName: 'Pat Lee',
            reasonCode: 'damaged',
          },
        })}
      />,
    );
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('RMA-1');
    expect(screen.getByRole('link', { name: '← Back to returns' })).toHaveAttribute(
      'href',
      '/dashboard/returns',
    );
    expect(screen.getByText(RETURNS_COPY.typeReturn)).toBeInTheDocument();
    expect(screen.getByText(RETURNS_COPY.createdByStaff)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'SO-000103' })).toHaveAttribute(
      'href',
      '/dashboard/orders/o1',
    );
    expect(screen.getByText(/Against order/).textContent).toBe(
      'Against order SO-000103 · Pat Lee · Main · Damaged',
    );
  });
});

describe('the next-step bar', () => {
  it('puts the primary first, then the secondaries, then "The item is here" as a switch named by its words', () => {
    render(<ReturnWorkbench workbench={requested()} />);
    const bar = screen.getByRole('region', { name: 'Next step' });
    const buttons = within(bar)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons).toEqual(['Approve return', 'Deny', 'Cancel return']);
    const sw = within(bar).getByRole('switch', { name: RETURNS_COPY.itemIsHere });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAccessibleDescription(RETURNS_COPY.itemIsHereHelp);
  });

  it('the visible words switch it on, and the primary then reads "Approve and receive"', () => {
    render(
      <ReturnWorkbench
        workbench={requested({
          actions: { primary: 'approve', secondary: ['deny', 'cancel'], readOnlyReason: null },
        })}
      />,
    );
    fireEvent.click(screen.getByText(RETURNS_COPY.itemIsHere));
    expect(screen.getByRole('switch', { name: RETURNS_COPY.itemIsHere })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Approve and receive' })).toBeInTheDocument();
  });

  it('a read-only viewer gets no switch and the reason, inside the bar', () => {
    render(
      <ReturnWorkbench
        workbench={requested({
          viewer: { canManageReturns: false, canApproveOrders: false, canReadDecisions: true },
          actions: {
            primary: null,
            secondary: [],
            readOnlyReason: "You don't have permission to manage returns.",
          },
        })}
      />,
    );
    const bar = screen.getByRole('region', { name: 'Next step' });
    expect(within(bar).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(bar).queryAllByRole('button')).toHaveLength(0);
    expect(
      within(bar).getByText("You don't have permission to manage returns."),
    ).toBeInTheDocument();
  });

  it('a closed return says there is nothing further, inside the bar', () => {
    render(<ReturnWorkbench workbench={bench('closed')} />);
    expect(
      within(screen.getByRole('region', { name: 'Next step' })).getByText(
        'No further steps for this return.',
      ),
    ).toBeInTheDocument();
  });
});

describe('RETURNING', () => {
  it('frames the photo on white, the hatch when there is none, and keeps the line words', () => {
    const { container, rerender } = render(<ReturnWorkbench workbench={requested()} />);
    const region = screen.getByRole('region', { name: RETURNS_COPY.returning });
    expect(
      within(region).getByRole('heading', { level: 2, name: RETURNS_COPY.returning }),
    ).toBeInTheDocument();
    expect(container.querySelector('article [data-slot="missing-photo"]')).not.toBeNull();
    expect(within(region).getByText('Size M · NH-M')).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: 'Walk New Hire Shirt' })).toHaveAttribute(
      'href',
      '/dashboard/inventory/i1',
    );

    const withPhoto = requested() as unknown as { lines: Array<{ item: Record<string, unknown> }> };
    withPhoto.lines[0]!.item = {
      ...withPhoto.lines[0]!.item,
      thumbUrl: 'https://signed.test/shirt-thumb.jpg',
    };
    rerender(<ReturnWorkbench workbench={withPhoto as never} />);
    expect(screen.getByRole('img', { name: 'Walk New Hire Shirt' })).toHaveAttribute(
      'src',
      'https://signed.test/shirt-thumb.jpg',
    );
  });

  it('keeps the disposition and destination as native radios in named groups', () => {
    render(<ReturnWorkbench workbench={requested()} />);
    const disposition = screen.getByRole('radiogroup', {
      name: /RETURN DISPOSITION for Walk New Hire Shirt/,
    });
    const destination = screen.getByRole('radiogroup', {
      name: /RETURNED ITEM DESTINATION for Walk New Hire Shirt/,
    });
    for (const group of [disposition, destination]) {
      for (const radio of within(group).getAllByRole('radio'))
        expect(radio).toHaveAttribute('type', 'radio');
    }
    expect(within(disposition).getByLabelText(RETURNS_COPY.restock)).toBeChecked();
  });
});

describe('the return label', () => {
  const label = {
    status: 'purchased',
    carrier: 'USPS',
    service: 'Ground Advantage',
    rate_cents: 845,
    currency: 'USD',
    tracking_code: '9400TEST',
    tracking_url: 'https://track.test/9400TEST',
    label_url: 'https://label.test/l.pdf',
  };

  it('offers "Buy return label" on an approved return with none yet', () => {
    render(<ReturnWorkbench workbench={bench('approved')} canManageShipping returnLabel={null} />);
    expect(screen.getByRole('heading', { name: 'Return label' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buy return label' })).toBeInTheDocument();
  });

  it('prints the label as label / value rows with the tracking link and the download', () => {
    render(<ReturnWorkbench workbench={bench('received')} canManageShipping returnLabel={label} />);
    expect(screen.queryByRole('button', { name: 'Buy return label' })).not.toBeInTheDocument();
    const terms = screen.getAllByRole('term').map((t) => t.textContent);
    expect(terms).toEqual(['Carrier', 'Tracking #', 'Cost']);
    expect(screen.getByText('USPS')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /9400TEST/ })).toHaveAttribute(
      'href',
      'https://track.test/9400TEST',
    );
    expect(screen.getByText('$8.45')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download return label/ })).toHaveAttribute(
      'href',
      'https://label.test/l.pdf',
    );
  });

  it('is not there without shipping:manage', () => {
    render(<ReturnWorkbench workbench={bench('approved')} canManageShipping={false} />);
    expect(screen.queryByRole('heading', { name: 'Return label' })).not.toBeInTheDocument();
  });
});

describe('History', () => {
  it('lists the chain in order as activity rows, each with who and a machine-readable time', () => {
    const chain = [
      {
        at: '2026-10-01T00:00:00Z',
        kind: 'created',
        label: 'Return requested by the requester',
        actorName: null,
      },
      { at: '2026-10-02T00:00:00Z', kind: 'approved', label: 'Return approved', actorName: 'Dana' },
    ];
    render(<ReturnWorkbench workbench={bench('approved', {}, { chain })} />);
    const history = screen.getByRole('region', { name: 'History' });
    const items = within(within(history).getByRole('list')).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Return requested by the requester');
    expect(items[1]).toHaveTextContent('Return approved · Dana');
    expect(items[1]!.querySelector('time')).toHaveAttribute('dateTime', '2026-10-02T00:00:00Z');
  });

  it('says "No history yet." when the chain is empty', () => {
    render(<ReturnWorkbench workbench={bench('approved')} />);
    expect(
      within(screen.getByRole('region', { name: 'History' })).getByText('No history yet.'),
    ).toBeInTheDocument();
  });
});
