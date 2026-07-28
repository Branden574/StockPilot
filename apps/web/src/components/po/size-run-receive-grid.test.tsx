// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  SizeRunReceiveGrid,
  splitIntoRuns,
  type ReceiveRunLine,
  type SizeRunGroup,
} from './size-run-receive-grid';

function line(over: Partial<ReceiveRunLine> & { id: string }): ReceiveRunLine {
  return {
    name: `Item ${over.id}`,
    sku: `SKU-${over.id}`,
    quantityOrdered: 10,
    quantityReceived: 0,
    trackingType: 'none',
    groupId: null,
    variantSize: null,
    ...over,
  };
}

/** Indexed access that fails loudly instead of handing a test `undefined`. */
function nth<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected an element at index ${i}, got ${arr.length}`);
  return v;
}

const shoeGroup: SizeRunGroup = {
  name: 'Nike Mercurial · Black',
  countingUnit: 'pair',
  // Deliberately NOT alphabetical, and deliberately not the natural numeric
  // ladder either — a scale that wins proves the grid reads sort_order.
  sizeOrder: new Map([
    ['9', 0],
    ['10', 1],
    ['11', 2],
  ]),
};

// ─── splitIntoRuns ──────────────────────────────────────────────────────────

describe('splitIntoRuns', () => {
  it('collapses 3 lines sharing a group into ONE run', () => {
    const lines = [
      line({ id: 'a', groupId: 'g1', variantSize: '9' }),
      line({ id: 'b', groupId: 'g1', variantSize: '10' }),
      line({ id: 'c', groupId: 'g1', variantSize: '11' }),
    ];
    const blocks = splitIntoRuns(lines);
    expect(blocks).toHaveLength(1);
    expect(nth(blocks, 0)).toMatchObject({ kind: 'run', groupId: 'g1' });
    expect(nth(blocks, 0).lines.map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('renders a SINGLE grouped line loose — one line is not a run', () => {
    const blocks = splitIntoRuns([line({ id: 'a', groupId: 'g1', variantSize: 'M' })]);
    expect(blocks).toEqual([
      expect.objectContaining({ kind: 'loose', lines: [expect.objectContaining({ id: 'a' })] }),
    ]);
  });

  it('renders ungrouped lines loose — every line in every existing org', () => {
    const lines = [line({ id: 'a' }), line({ id: 'b' }), line({ id: 'c' })];
    const blocks = splitIntoRuns(lines);
    expect(blocks).toHaveLength(3);
    expect(blocks.every((b) => b.kind === 'loose')).toBe(true);
    expect(blocks.flatMap((b) => b.lines.map((l) => l.id))).toEqual(['a', 'b', 'c']);
  });

  it('keeps loose lines in their ORIGINAL position around a run', () => {
    const lines = [
      line({ id: 'loose1' }),
      line({ id: 'a', groupId: 'g1', variantSize: '9' }),
      line({ id: 'loose2' }),
      line({ id: 'b', groupId: 'g1', variantSize: '10' }),
      line({ id: 'loose3' }),
    ];
    const blocks = splitIntoRuns(lines);
    // The run anchors where its FIRST line was, so a receiver's eye does not
    // have to jump to the bottom of the dialog to find the sizes.
    expect(blocks.map((b) => (b.kind === 'run' ? b.groupId : b.lines[0].id))).toEqual([
      'loose1',
      'g1',
      'loose2',
      'loose3',
    ]);
  });

  it('sorts a run by the scale sort_order, not alphabetically', () => {
    const lines = [
      line({ id: 'c', groupId: 'g1', variantSize: '11' }),
      line({ id: 'b', groupId: 'g1', variantSize: '10' }),
      line({ id: 'a', groupId: 'g1', variantSize: '9' }),
    ];
    const blocks = splitIntoRuns(lines, { g1: shoeGroup });
    // Alphabetically this would be 10, 11, 9.
    expect(nth(blocks, 0).lines.map((l) => l.variantSize)).toEqual(['9', '10', '11']);
  });

  it('sorts XL after L with no scale at all', () => {
    const lines = [
      line({ id: 'x', groupId: 'g1', variantSize: 'XL' }),
      line({ id: 'l', groupId: 'g1', variantSize: 'L' }),
      line({ id: 'm', groupId: 'g1', variantSize: 'M' }),
    ];
    expect(nth(splitIntoRuns(lines), 0).lines.map((l) => l.variantSize)).toEqual(['M', 'L', 'XL']);
  });

  it('keeps two different groups as two separate runs', () => {
    const lines = [
      line({ id: 'a', groupId: 'g1', variantSize: '9' }),
      line({ id: 'x', groupId: 'g2', variantSize: 'M' }),
      line({ id: 'b', groupId: 'g1', variantSize: '10' }),
      line({ id: 'y', groupId: 'g2', variantSize: 'L' }),
    ];
    const blocks = splitIntoRuns(lines);
    expect(blocks.map((b) => b.kind === 'run' && b.groupId)).toEqual(['g1', 'g2']);
  });
});

// ─── SizeRunReceiveGrid ─────────────────────────────────────────────────────

function renderGrid(
  over: {
    lines?: ReceiveRunLine[];
    entries?: Record<string, { received: number }>;
    group?: SizeRunGroup;
    onChange?: (id: string, patch: { received: number }) => void;
  } = {},
) {
  const lines = over.lines ?? [
    line({ id: 'a', groupId: 'g1', variantSize: '9', quantityOrdered: 4 }),
    line({ id: 'b', groupId: 'g1', variantSize: '10', quantityOrdered: 8, quantityReceived: 2 }),
    line({ id: 'c', groupId: 'g1', variantSize: '11', quantityOrdered: 12 }),
  ];
  const onChange = over.onChange ?? vi.fn();
  render(
    <SizeRunReceiveGrid
      groupId="g1"
      group={over.group ?? shoeGroup}
      lines={lines}
      entries={over.entries ?? {}}
      onChange={onChange}
    />,
  );
  return { lines, onChange };
}

describe('SizeRunReceiveGrid', () => {
  it('renders one row per size under a single group heading', () => {
    renderGrid();
    expect(screen.getByText('Nike Mercurial · Black')).toBeInTheDocument();
    const rows = screen.getAllByTestId('size-run-row');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => within(r).getByTestId('size-run-size').textContent)).toEqual([
      '9',
      '10',
      '11',
    ]);
  });

  it('shows ordered and already-received per size', () => {
    renderGrid();
    const row = nth(screen.getAllByTestId('size-run-row'), 1);
    expect(within(row).getByTestId('size-run-ordered')).toHaveTextContent('8');
    expect(within(row).getByTestId('size-run-already')).toHaveTextContent('2');
  });

  it('sums the per-size receiving quantities and names the counting unit', () => {
    renderGrid({ entries: { a: { received: 4 }, b: { received: 6 }, c: { received: 14 } } });
    // 4 + 6 + 14 = 24, across the 3 sizes that carry a quantity.
    expect(screen.getByTestId('size-run-subtotal')).toHaveTextContent(
      'Receiving 24 pairs across 3 sizes',
    );
  });

  it('counts only the sizes actually being received in the subtotal', () => {
    renderGrid({ entries: { a: { received: 4 }, b: { received: 0 } } });
    expect(screen.getByTestId('size-run-subtotal')).toHaveTextContent(
      'Receiving 4 pairs across 1 size',
    );
  });

  it('names the group counting unit verbatim — never inferred', () => {
    renderGrid({
      group: { ...shoeGroup, countingUnit: 'set' },
      entries: { a: { received: 2 } },
    });
    expect(screen.getByTestId('size-run-subtotal')).toHaveTextContent('Receiving 2 sets across 1 size');
  });

  it('reads nothing when no size is being received yet', () => {
    renderGrid();
    expect(screen.getByTestId('size-run-subtotal')).toHaveTextContent('Nothing entered yet');
  });

  it('"Receive all ordered" fills every size with its outstanding quantity', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderGrid({ onChange });
    await user.click(screen.getByRole('button', { name: /receive all ordered/i }));
    // Outstanding = ordered - already received, per size, never negative.
    expect(onChange.mock.calls).toEqual([
      ['a', { received: 4 }],
      ['b', { received: 6 }],
      ['c', { received: 12 }],
    ]);
  });

  it('derives accepted from the entered quantity and never rejects silently', () => {
    renderGrid({ entries: { a: { received: 3 } } });
    const row = nth(screen.getAllByTestId('size-run-row'), 0);
    expect(within(row).getByTestId('size-run-accepted')).toHaveTextContent('3');
    expect(within(row).getByTestId('size-run-rejected')).toHaveTextContent('0');
  });

  it('renders the per-size extras slot so serial capture still appears inside a run', () => {
    render(
      <SizeRunReceiveGrid
        groupId="g1"
        group={shoeGroup}
        lines={[line({ id: 'a', groupId: 'g1', variantSize: '9', trackingType: 'serial' })]}
        entries={{ a: { received: 2 } }}
        onChange={vi.fn()}
        renderExtras={(l) => <div data-testid={`extras-${l.id}`}>capture</div>}
      />,
    );
    expect(screen.getByTestId('extras-a')).toBeInTheDocument();
  });

  it('labels a size-less variant rather than rendering a blank cell, and sorts it last', () => {
    // Through the real path: splitIntoRuns owns the ordering, the grid renders
    // what it is handed.
    const blocks = splitIntoRuns([
      line({ id: 'a', groupId: 'g1', variantSize: null }),
      line({ id: 'b', groupId: 'g1', variantSize: '9' }),
    ]);
    renderGrid({ lines: nth(blocks, 0).lines });
    const sizes = screen.getAllByTestId('size-run-size').map((n) => n.textContent);
    expect(sizes).toEqual(['9', 'No size']);
  });
});
