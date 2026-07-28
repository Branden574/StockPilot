import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Read-only rendering contract (auditor visibility): a visitor holding
// cycle_counts:read but NOT stock:adjust gets canAdjust=false, which must
// strip EVERY write affordance from an in-progress count — entry inputs,
// clear buttons, "Cancel count", and "Review & post" — while all count
// data stays visible.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/cycle-counts/cc-1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/server/actions/cycle-counts', () => ({
  assignCycleCountAction: vi.fn(),
  cancelCycleCountAction: vi.fn(),
  clearCycleCountLineAction: vi.fn(),
  postCycleCountAction: vi.fn(),
  recordCycleCountLineAction: vi.fn(),
}));

import { CycleCountDetail } from './cycle-count-detail';

import type {
  CycleCountLineWithItem,
  CycleCountRow,
  CycleCountSummary,
} from '@/server/services/cycle-counts';

const header = {
  id: 'cc-1',
  status: 'in_progress',
  warehouse_id: null,
  notes: null,
  assigned_to: null,
  started_at: '2026-07-01T00:00:00Z',
  completed_at: null,
} as unknown as CycleCountRow;

const lines = [
  {
    id: 'line-1',
    counted_quantity: 4,
    expected_quantity: 5,
    item: { name: 'Widget', sku: 'W-1', barcode: null },
  },
  {
    id: 'line-2',
    counted_quantity: null,
    expected_quantity: 2,
    item: { name: 'Gadget', sku: 'G-1', barcode: null },
  },
] as unknown as CycleCountLineWithItem[];

const summary: CycleCountSummary = {
  total: 2,
  counted: 1,
  varianceCount: 1,
  netDelta: -1,
} as CycleCountSummary;

const baseProps = {
  header,
  lines,
  summary,
  page: 1,
  pageSize: 50,
  total: 2,
  search: '',
  filter: 'all' as const,
};

describe('CycleCountDetail read-only mode (canAdjust=false)', () => {
  it('hides every write affordance and renders counts as text', () => {
    render(<CycleCountDetail {...baseProps} canAdjust={false} />);

    // No post / cancel controls.
    expect(screen.queryByText('Review & post')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel count')).not.toBeInTheDocument();
    // No count-entry inputs (the '—' placeholder marks the entry boxes; the
    // page-level search box remains, which is a read affordance).
    expect(screen.queryByPlaceholderText('—')).not.toBeInTheDocument();
    // No per-line clear buttons.
    expect(screen.queryByTitle('Clear count')).not.toBeInTheDocument();
    // Data stays visible: items, counted value as plain text, view-only note.
    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.getByText('Gadget')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(
      screen.getByText(/view-only access to this count/i),
    ).toBeInTheDocument();
  });

  it('defaults to read-only when canAdjust is omitted (fail closed)', () => {
    render(<CycleCountDetail {...baseProps} />);
    expect(screen.queryByText('Review & post')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('—')).not.toBeInTheDocument();
  });

  it('read-only + canAssign=false shows the assignee as a plain badge', () => {
    render(
      <CycleCountDetail {...baseProps} canAdjust={false} canAssign={false} assigneeName="Ana" />,
    );
    expect(screen.getByText('Ana')).toBeInTheDocument();
    // Radix Select trigger (the assign dropdown) must not render.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});

describe('CycleCountDetail counting mode (canAdjust=true)', () => {
  it('keeps the write UI for stock:adjust holders (unchanged behavior)', () => {
    render(<CycleCountDetail {...baseProps} canAdjust />);
    expect(screen.getByText('Review & post')).toBeInTheDocument();
    expect(screen.getByText('Cancel count')).toBeInTheDocument();
    // One entry input per line.
    expect(screen.getAllByPlaceholderText('—')).toHaveLength(2);
  });
});

/**
 * Counting BY VARIANT. A size run is several rows whose only real difference
 * is a hex SKU, so the row has to say which variant it is or the counter is
 * matching strings to shoeboxes.
 */
describe('CycleCountDetail — variant identity', () => {
  const variantLines = [
    {
      id: 'line-9',
      counted_quantity: null,
      expected_quantity: 4,
      item: {
        name: 'Nike Pegasus 41',
        sku: 'PEG-9',
        barcode: null,
        group_id: 'g1',
        variant_size: '9.5',
        jersey_number: null,
      },
    },
    {
      id: 'line-j',
      counted_quantity: null,
      expected_quantity: 2,
      item: {
        name: 'Falcons Home Jersey',
        sku: 'FAL-12-XL',
        barcode: null,
        group_id: 'g2',
        variant_size: 'XL',
        jersey_number: '12',
      },
    },
  ] as unknown as CycleCountLineWithItem[];

  it('names the size on a shoe line, half sizes included', () => {
    render(<CycleCountDetail {...baseProps} lines={variantLines} canAdjust />);
    expect(screen.getByText('Size 9.5')).toBeInTheDocument();
  });

  it('renders a jersey NUMBER as a number, never as a serial', () => {
    render(<CycleCountDetail {...baseProps} lines={variantLines} canAdjust />);
    expect(screen.getByText('#12 · Size XL')).toBeInTheDocument();
    // The word "serial" must appear nowhere near a uniform number.
    expect(screen.queryByText(/serial/i)).toBeNull();
  });

  it('renders an ungrouped count with no variant line at all', () => {
    render(<CycleCountDetail {...baseProps} canAdjust />);
    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.queryByText(/^Size /)).toBeNull();
    expect(screen.queryByText(/^#/)).toBeNull();
  });
});
