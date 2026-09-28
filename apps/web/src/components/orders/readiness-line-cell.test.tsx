import { cleanup, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { OrderReadinessResult } from '@stockpilot/core';

import { PHYSICAL_COUNT_ANCHOR } from '@/components/inventory/item-verification-card';
import {
  hiddenItemFacts,
  orderReadinessFacts,
  readinessOk,
  visibleItemFacts,
  type FactsLine,
} from '@/test/order-readiness-facts';

import { itemPhysicalCountHref, ReadinessLineCell } from './readiness-line-cell';

// The real button opens the recount dialog through a server action; this file
// only cares whether the cell offers it, and for which item.
const countThisItemProps = vi.fn();
vi.mock('@/components/exceptions/count-this-item-button', () => ({
  CountThisItemButton: (props: Record<string, unknown>) => {
    countThisItemProps(props);
    return <button type="button">Count this item</button>;
  },
}));

const TZ = 'America/Los_Angeles';
const ORDER = '11111111-1111-1111-1111-111111111111';

function assessed(
  status: string,
  lines: FactsLine[],
  items: Record<string, unknown>[],
  neededBy: string | null = null,
) {
  const result: OrderReadinessResult = readinessOk(
    orderReadinessFacts(ORDER, status, lines, items, { neededBy }),
  );
  if (result.state !== 'ok' || result.assessment.phase !== 'to_pick')
    throw new Error('to_pick expected');
  return result.assessment;
}

function renderLine(
  status: string,
  lines: FactsLine[],
  items: Record<string, unknown>[],
  opts: { at?: number; canCountItem?: boolean; neededBy?: string | null; position?: number } = {},
) {
  const a = assessed(status, lines, items, opts.neededBy ?? null);
  const line = a.lines[opts.at ?? 0]!;
  const item = a.items.find((it) => it.itemId === line.itemId) ?? null;
  render(
    <ReadinessLineCell
      line={line}
      item={item}
      timeZone={TZ}
      canCountItem={opts.canCountItem ?? false}
      position={opts.position}
    />,
  );
  return screen.getByTestId('readiness-line');
}

describe('ReadinessLineCell', () => {
  it('ready: the chip (words and an icon), the sentence, and no rack recorded when served from Unplaced', () => {
    const cell = renderLine(
      'pending_approval',
      [{ lineId: 'L1', itemId: 'a', requested: 12 }],
      [visibleItemFacts('a', { here: { rack: 4, unplaced: 8 } })],
    );
    expect(cell).toHaveAttribute('data-state', 'ready');
    const chip = within(cell).getByTestId('readiness-chip');
    expect(chip).toHaveTextContent('Ready to pick');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(within(cell).getByTestId('readiness-sentence')).toHaveTextContent(
      '12 on the shelf for this order. Includes 8 with no rack recorded.',
    );
    // Not at a hold status: no hold annotation.
    expect(within(cell).queryByTestId('readiness-hold')).toBeNull();
  });

  it('needs put-away: the screen-reader label names the line, the state and the number', () => {
    const cell = renderLine(
      'approved',
      [
        { lineId: 'L1', itemId: 'a', requested: 2 },
        { lineId: 'L2', itemId: 'b', requested: 10 },
      ],
      [
        visibleItemFacts('a', { here: { rack: 2 }, heldOwn: 2 }),
        visibleItemFacts('b', { here: { rack: 6, staging: 4 }, heldOwn: 10 }),
      ],
      { at: 1 },
    );
    expect(cell).toHaveAttribute('data-state', 'needs_put_away');
    expect(cell).toHaveTextContent('Line 2, Needs put-away, 4 in Staging.');
    expect(within(cell).getByTestId('readiness-sentence')).toHaveTextContent(
      '6 on the shelf. 4 more are in Staging and must be put away before picking can take them.',
    );
    expect(within(cell).getByTestId('readiness-hold')).toHaveTextContent('Held for this order');
    expect(within(cell).getByTestId('readiness-why')).toHaveTextContent('In Staging 4');
  });

  it("the screen-reader \"Line N\" is the row's place on the page when the page gives it", () => {
    const cell = renderLine(
      'approved',
      [
        { lineId: 'L1', itemId: 'a', requested: 2 },
        { lineId: 'L2', itemId: 'b', requested: 10 },
      ],
      [
        visibleItemFacts('a', { here: { rack: 2 }, heldOwn: 2 }),
        visibleItemFacts('b', { here: { rack: 6, staging: 4 }, heldOwn: 10 }),
      ],
      { at: 1, position: 1 },
    );
    expect(within(cell).getByTestId('readiness-sr-label')).toHaveTextContent('Line 1, Needs put-away, 4 in Staging.');
  });

  it('a handed-over line: its own chip (words and an icon), never "Ready to pick"', () => {
    const cell = renderLine(
      'backordered',
      [{ lineId: 'L1', itemId: 'a', requested: 4, fulfilled: 4 }],
      [visibleItemFacts('a')],
    );
    expect(cell).toHaveAttribute('data-state', 'handed_over');
    const chip = within(cell).getByTestId('readiness-chip');
    expect(chip).toHaveTextContent('Handed over');
    expect(chip.querySelector('svg.lucide-package-check')).not.toBeNull();
    expect(cell).not.toHaveTextContent(/Ready to pick/);
    expect(within(cell).getByTestId('readiness-sentence')).toHaveTextContent(
      'Nothing left to pick: all of this line was handed over.',
    );
    expect(within(cell).getByTestId('readiness-sr-label')).toHaveTextContent('Line 1, Handed over, nothing left to pick.');
  });

  it('waiting on a PO: the date is expected, not a promise', () => {
    const cell = renderLine(
      'pending_approval',
      [{ lineId: 'L1', itemId: 'a', requested: 10 }],
      [
        visibleItemFacts('a', {
          here: { rack: 6 },
          inbound: {
            rows: [
              {
                poId: 'p1',
                poNumber: 'PO-2026-0042',
                status: 'ordered',
                // A calendar date, as the PO form stores it (midnight UTC).
                expectedAt: '2026-10-03T00:00:00Z',
                remaining: 12,
              },
            ],
            hiddenRemaining: 0,
            truncated: false,
            truncatedRemaining: 0,
          },
        }),
      ],
    );
    expect(cell).toHaveAttribute('data-state', 'awaiting_po');
    expect(within(cell).getByTestId('readiness-sentence')).toHaveTextContent(
      '6 on the shelf. 4 short now. PO-2026-0042 expects 12 on Oct 3 (an expected date, not a promise).',
    );
  });

  it('not held at a hold status says another order could take the stock', () => {
    const cell = renderLine(
      'approved',
      [{ lineId: 'L1', itemId: 'a', requested: 5 }],
      [visibleItemFacts('a', { here: { rack: 10 } })],
    );
    expect(within(cell).getByTestId('readiness-hold')).toHaveTextContent(
      'Not held: another order could take this stock.',
    );
  });

  it("an item the viewer cannot read: can't confirm, no numbers, no Why, no link", () => {
    const cell = renderLine(
      'pending_approval',
      [{ lineId: 'L1', itemId: 'a', requested: 5 }],
      [hiddenItemFacts('a')],
    );
    expect(cell).toHaveAttribute('data-state', 'unknown');
    expect(within(cell).getByTestId('readiness-sentence')).toHaveTextContent(
      "This item isn't visible to you, so its stock can't be checked.",
    );
    expect(within(cell).queryByTestId('readiness-why')).toBeNull();
    expect(within(cell).queryByText('Last physical count')).toBeNull();
  });

  it("the Why links to the item page's physical count card; a deleted item has no link", () => {
    const cell = renderLine(
      'pending_approval',
      [{ lineId: 'L1', itemId: 'a', requested: 5 }],
      [visibleItemFacts('a', { here: { rack: 10 } })],
    );
    expect(within(cell).getByText('Last physical count').closest('a')).toHaveAttribute(
      'href',
      itemPhysicalCountHref('a'),
    );
    cleanup();
    const deleted = renderLine(
      'pending_approval',
      [{ lineId: 'L1', itemId: 'a', requested: 5 }],
      [visibleItemFacts('a', { here: { rack: 10 }, deleted: true })],
    );
    expect(within(deleted).getByTestId('readiness-sentence')).toHaveTextContent(
      'This item was deleted. Remove the line.',
    );
    expect(within(deleted).queryByText('Last physical count')).toBeNull();
  });

  it("the link's anchor is the one the item page's card carries", () => {
    expect(itemPhysicalCountHref('abc')).toBe(`/dashboard/inventory/abc#${PHYSICAL_COUNT_ANCHOR}`);
  });

  it('records disagree: Count this item only when the viewer can count this item', () => {
    const facts = [visibleItemFacts('a', { here: { rack: 7 }, onHand: 10 })];
    const cell = renderLine(
      'pending_approval',
      [{ lineId: 'L1', itemId: 'a', requested: 5 }],
      facts,
      {
        canCountItem: true,
      },
    );
    expect(cell).toHaveAttribute('data-state', 'unknown');
    expect(within(cell).getByRole('button', { name: 'Count this item' })).toBeInTheDocument();
    expect(countThisItemProps).toHaveBeenCalledWith({ itemId: 'a', timeZone: TZ });
    cleanup();
    const without = renderLine(
      'pending_approval',
      [{ lineId: 'L1', itemId: 'a', requested: 5 }],
      facts,
      {
        canCountItem: false,
      },
    );
    expect(within(without).queryByRole('button', { name: 'Count this item' })).toBeNull();
  });

  it('Count this item is never offered where records agree, even to a viewer who can count', () => {
    const cell = renderLine(
      'pending_approval',
      [{ lineId: 'L1', itemId: 'a', requested: 5 }],
      [visibleItemFacts('a', { here: { rack: 2 } })],
      { canCountItem: true },
    );
    expect(cell).toHaveAttribute('data-state', 'short');
    expect(within(cell).queryByRole('button', { name: 'Count this item' })).toBeNull();
  });

  it('a line readiness did not see says it was not checked', () => {
    render(<ReadinessLineCell line={null} item={null} timeZone={TZ} canCountItem />);
    expect(screen.getByTestId('readiness-line-unchecked')).toHaveTextContent(
      'Not checked. Check again to see this line.',
    );
  });
});
