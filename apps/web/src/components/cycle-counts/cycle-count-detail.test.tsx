import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Read-only rendering contract (auditor visibility): a visitor holding
// cycle_counts:read but NOT stock:adjust gets canAdjust=false, which must
// strip EVERY write affordance from an in-progress count — entry inputs,
// clear buttons, "Cancel count", and "Review & post" — while all count
// data stays visible.

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
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

import { toast } from 'sonner';

import {
  cancelCycleCountAction,
  clearCycleCountLineAction,
  postCycleCountAction,
  recordCycleCountLineAction,
} from '@/server/actions/cycle-counts';

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
  it('keeps the write UI for a manager who holds stock:adjust and cycle_counts:assign', () => {
    render(<CycleCountDetail {...baseProps} canAdjust canAssign role="manager" />);
    expect(screen.getByText('Review & post')).toBeInTheDocument();
    expect(screen.getByText('Cancel count')).toBeInTheDocument();
    // One entry input per line.
    expect(screen.getAllByPlaceholderText('—')).toHaveLength(2);
    expect(screen.queryByTestId('manager-posts')).not.toBeInTheDocument();
  });
});

/**
 * THE POST/CANCEL FIX (F1-2). ledger.post_cycle_count and the cycle_counts
 * UPDATE policy a cancel runs under are manager-only, but the page used to
 * show both buttons to anyone with stock:adjust, which staff hold: they
 * pressed Post and got a refusal. The page now asks core cycleCountCloseGate,
 * the predicate the phone and the service use.
 */
describe('CycleCountDetail: who sees Post and Cancel', () => {
  // Mutation caught: gating the buttons on stock:adjust (canAdjust) alone.
  it('staff who can count see neither button, and are told a manager posts', () => {
    render(<CycleCountDetail {...baseProps} canAdjust canAssign={false} role="staff" />);
    expect(screen.queryByText('Review & post')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel count')).not.toBeInTheDocument();
    expect(screen.getByTestId('manager-posts')).toHaveTextContent('A manager reviews and posts this count.');
    // They can still count.
    expect(screen.getAllByPlaceholderText('—')).toHaveLength(2);
  });

  it('staff granted cycle_counts:assign by an override still see neither (the role floor)', () => {
    render(<CycleCountDetail {...baseProps} canAdjust canAssign role="staff" />);
    expect(screen.queryByText('Review & post')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel count')).not.toBeInTheDocument();
    expect(screen.getByTestId('manager-posts')).toBeInTheDocument();
  });

  it('a manager without cycle_counts:assign can post but not cancel', () => {
    render(<CycleCountDetail {...baseProps} canAdjust canAssign={false} role="manager" />);
    expect(screen.getByText('Review & post')).toBeInTheDocument();
    expect(screen.queryByText('Cancel count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('manager-posts')).not.toBeInTheDocument();
  });

  it('a manager without stock:adjust sees neither and no "manager posts" line (read-only)', () => {
    render(<CycleCountDetail {...baseProps} canAdjust={false} canAssign role="admin" />);
    expect(screen.queryByText('Review & post')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('manager-posts')).not.toBeInTheDocument();
  });

  it('defaults to no Post or Cancel when the role is not passed (fail closed)', () => {
    render(<CycleCountDetail {...baseProps} canAdjust canAssign />);
    expect(screen.queryByText('Review & post')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel count')).not.toBeInTheDocument();
  });

  it('a closed count shows neither, even to a manager', () => {
    render(
      <CycleCountDetail
        {...baseProps}
        header={{ ...header, status: 'completed' } as CycleCountRow}
        canAdjust
        canAssign
        role="owner"
      />,
    );
    expect(screen.queryByText('Review & post')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('manager-posts')).not.toBeInTheDocument();
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

/**
 * A FAILED save must not leave the row looking counted.
 *
 * The row's input is blur-to-save and the box resyncs from the server value
 * only via an effect keyed on `line.counted_quantity`. When the action fails
 * that prop never changes, so without an explicit revert the box keeps the
 * typed number AND the variance cell renders it exactly like a saved line —
 * while the DB still holds null, the header stats disagree, and post() skips
 * it. The only feedback was a 4s toast (recurring pattern #20: toast-only is
 * a silent failure), so the counter walks 200 lines believing they saved.
 *
 * Reachable in production: the row is enabled by `!open || !canAdjust` alone,
 * while the service refuses a non-manager on a count assigned to someone else
 * (assertAssignee -> 'forbidden') and refuses cancelled/RLS-blocked lines.
 */
describe('CycleCountDetail — failed line save', () => {
  const failure = {
    ok: false as const,
    error: {
      code: 'forbidden',
      message: 'This cycle count is assigned to another employee.',
    },
  };

  function rowFor(name: string): HTMLElement {
    const row = screen.getByText(name).closest('tr');
    if (!row) throw new Error(`no row for ${name}`);
    return row as HTMLElement;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverts the box, drops the variance, and shows an inline alert', async () => {
    vi.mocked(recordCycleCountLineAction).mockResolvedValue(failure as never);

    render(<CycleCountDetail {...baseProps} canAdjust />);

    // Gadget: expected 2, counted null (uncounted).
    const row = rowFor('Gadget');
    const input = within(row).getByPlaceholderText('—') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(within(row).getByRole('alert')).toHaveTextContent(
        'This cycle count is assigned to another employee.',
      );
    });
    // (a) the box is back to the server value (empty = uncounted)
    expect(input.value).toBe('');
    // (b) the variance cell shows no variance, not '+5'
    expect(within(row).queryByText('+5')).toBeNull();
    expect(row.querySelector('td:nth-child(5)')?.textContent).toBe('—');
  });

  it('restores the saved count when CLEARING the line fails', async () => {
    vi.mocked(clearCycleCountLineAction).mockResolvedValue(failure as never);

    render(<CycleCountDetail {...baseProps} canAdjust />);

    // Widget: counted 4, expected 5.
    const row = rowFor('Widget');
    const input = within(row).getByPlaceholderText('—') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(within(row).getByRole('alert')).toBeInTheDocument();
    });
    expect(input.value).toBe('4');
    expect(row.querySelector('td:nth-child(5)')?.textContent).toBe('-1');
  });

  it('keeps the typed value and shows no alert when the save succeeds', async () => {
    vi.mocked(recordCycleCountLineAction).mockResolvedValue({ ok: true } as never);

    render(<CycleCountDetail {...baseProps} canAdjust />);

    const row = rowFor('Gadget');
    const input = within(row).getByPlaceholderText('—') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(recordCycleCountLineAction).toHaveBeenCalled();
    });
    expect(input.value).toBe('7');
    expect(within(row).queryByRole('alert')).toBeNull();
  });
});

/**
 * A box is read by the rule every count box reads by, here and on the phone
 * (core countFromText): a plain number of 0 or more. A box that held
 * something else (a second point, a comma, a minus sign) was left as typed,
 * saving nothing and saying nothing, while a post applied the count saved
 * before; and Number() saved "1e3" as 1000 and "0x10" as 16. The line now
 * says so, saves nothing and puts the saved count back, as it does for a
 * negative number, so the box never shows a count other than the one a post
 * applies.
 */
describe('CycleCountDetail: a box that does not hold a count', () => {
  const NOT_A_NUMBER = 'Enter a number of 0 or more, such as 5 or 2.5.';

  function rowFor(name: string): HTMLElement {
    const row = screen.getByText(name).closest('tr');
    if (!row) throw new Error(`no row for ${name}`);
    return row as HTMLElement;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['1.2.3', '2,5', '1e3', '0x10', '+5', '-1', '-', '.', 'abc'])(
    '"%s" over a saved count saves nothing, says so on the line, and puts the saved count back',
    async (typed) => {
      render(<CycleCountDetail {...baseProps} canAdjust />);
      // Widget: counted 4, expected 5.
      const row = rowFor('Widget');
      const input = within(row).getByPlaceholderText('—') as HTMLInputElement;
      fireEvent.change(input, { target: { value: typed } });
      // While the box holds it, no variance it will never apply.
      expect(row.querySelector('td:nth-child(5)')?.textContent).toBe('—');
      fireEvent.blur(input);

      await waitFor(() => {
        expect(within(row).getByRole('alert')).toHaveTextContent(NOT_A_NUMBER);
      });
      expect(toast.error).toHaveBeenCalledWith(NOT_A_NUMBER);
      expect(recordCycleCountLineAction).not.toHaveBeenCalled();
      expect(clearCycleCountLineAction).not.toHaveBeenCalled();
      expect(input.value).toBe('4');
      expect(row.querySelector('td:nth-child(5)')?.textContent).toBe('-1');
    },
  );

  it('over an uncounted line, the box empties again and the line stays uncounted', async () => {
    render(<CycleCountDetail {...baseProps} canAdjust />);
    // Gadget: expected 2, uncounted.
    const row = rowFor('Gadget');
    const input = within(row).getByPlaceholderText('—') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2,5' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(within(row).getByRole('alert')).toHaveTextContent(NOT_A_NUMBER);
    });
    expect(recordCycleCountLineAction).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    expect(row.querySelector('td:nth-child(5)')?.textContent).toBe('—');
  });

  it.each([
    ['2.5', 2.5],
    ['.5', 0.5],
    [' 7 ', 7],
    ['0', 0],
  ])('a plain number "%s" saves %s', async (typed, saved) => {
    vi.mocked(recordCycleCountLineAction).mockResolvedValue({ ok: true } as never);
    render(<CycleCountDetail {...baseProps} canAdjust />);
    const row = rowFor('Gadget');
    const input = within(row).getByPlaceholderText('—') as HTMLInputElement;
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(recordCycleCountLineAction).toHaveBeenCalledWith({
        cycleCountId: 'cc-1',
        lineId: 'line-2',
        countedQuantity: saved,
      });
    });
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it('reads the box by the shared rule (core countFromText), as the phone does', async () => {
    const source = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(__dirname, 'cycle-count-detail.tsx'),
      'utf8',
    );
    // The save, the blur and the live variance all read by it; nothing reads
    // a box with Number() or parseFloat any more.
    expect(source.match(/countFromText\(/g)?.length).toBe(3);
    expect(source).not.toMatch(/Number\((raw|trimmed|trimmedDraft|draft)\)/);
    expect(source).not.toMatch(/parseFloat/);
  });
});

/**
 * THE REDESIGNED COUNT PAGE (M6) keeps the four whole-count numbers, the
 * "x of y counted · z with variance" line, the server-side line filters and
 * the entry / posting split: posting is a manager's step behind the
 * "Post this count?" confirmation, and it is allowed with lines uncounted.
 */
describe('CycleCountDetail: the whole-count numbers', () => {
  const bigSummary = {
    total: 142,
    counted: 68,
    varianceCount: 3,
    netDelta: -4,
  } as CycleCountSummary;

  it('prints the four numbers from the whole-count summary, never from the page of lines', () => {
    render(
      <CycleCountDetail {...baseProps} summary={bigSummary} total={142} canAdjust role="staff" />,
    );
    expect(screen.getByTestId('count-stat-in-scope')).toHaveTextContent('Items in scope142');
    expect(screen.getByTestId('count-stat-counted')).toHaveTextContent('Counted68');
    expect(screen.getByTestId('count-stat-uncounted')).toHaveTextContent('Uncounted74');
    expect(screen.getByTestId('count-stat-net-variance')).toHaveTextContent('Net variance-4');
    expect(screen.getByText('68 of 142 counted · 3 with variance')).toBeInTheDocument();
  });

  it('signs a positive net variance', () => {
    render(
      <CycleCountDetail
        {...baseProps}
        summary={{ ...bigSummary, netDelta: 5 }}
        total={142}
        canAdjust
        role="staff"
      />,
    );
    expect(screen.getByTestId('count-stat-net-variance')).toHaveTextContent('Net variance+5');
  });
});

describe('CycleCountDetail: line search and filters stay in the URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('All / Uncounted / Variance say which is chosen and push ?filter= back to page 1', () => {
    render(<CycleCountDetail {...baseProps} page={2} canAdjust role="staff" />);
    const filters = screen.getByRole('group', { name: 'Filter lines' });
    expect(within(filters).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(filters).getByRole('button', { name: 'Variance' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fireEvent.click(within(filters).getByRole('button', { name: 'Variance' }));
    expect(router.push).toHaveBeenCalledWith('/dashboard/cycle-counts/cc-1?filter=variance');
  });

  it('pressing the filter already chosen does not navigate', () => {
    render(<CycleCountDetail {...baseProps} filter="uncounted" canAdjust role="staff" />);
    const filters = screen.getByRole('group', { name: 'Filter lines' });
    fireEvent.click(within(filters).getByRole('button', { name: 'Uncounted' }));
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('CycleCountDetail: Review & post', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cannot be opened before a single line is counted', () => {
    render(
      <CycleCountDetail
        {...baseProps}
        summary={{ total: 2, counted: 0, varianceCount: 0, netDelta: 0 } as CycleCountSummary}
        canAdjust
        canAssign
        role="manager"
      />,
    );
    expect(screen.getByRole('button', { name: 'Review & post' })).toBeDisabled();
  });

  it('confirms the adjustments, warns about uncounted lines, and posts with them uncounted', async () => {
    vi.mocked(postCycleCountAction).mockResolvedValue({ ok: true } as never);
    render(<CycleCountDetail {...baseProps} canAdjust canAssign role="manager" />);

    fireEvent.click(screen.getByRole('button', { name: 'Review & post' }));
    const dialog = await screen.findByRole('dialog', { name: 'Post this count?' });
    expect(dialog).toHaveTextContent(
      'This will post 1 adjustment (net -1 units). Each line moves stock by counted minus the system quantity at the time it was counted; stock that moved after a line was counted is kept.',
    );
    expect(dialog).toHaveTextContent("1 item weren't counted — they'll be left unchanged.");
    expect(dialog).toHaveTextContent('This is irreversible');
    // Nothing is posted by opening the review.
    expect(postCycleCountAction).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Post adjustments' }));
    await waitFor(() => {
      expect(postCycleCountAction).toHaveBeenCalledWith('cc-1');
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Cycle count posted. 1 adjustment applied.');
    });
    expect(router.refresh).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Post this count?' })).not.toBeInTheDocument();
    });
  });

  it('a refused post keeps the dialog open and says why inside it, as well as in the toast', async () => {
    const message = 'A line was counted by a newer count. Clear and recount that line.';
    vi.mocked(postCycleCountAction).mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message },
    } as never);
    render(<CycleCountDetail {...baseProps} canAdjust canAssign role="manager" />);

    fireEvent.click(screen.getByRole('button', { name: 'Review & post' }));
    const dialog = await screen.findByRole('dialog', { name: 'Post this count?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post adjustments' }));

    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent(message);
    });
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(screen.getByRole('dialog', { name: 'Post this count?' })).toBeInTheDocument();
  });

  it('a refused cancel keeps the confirmation open and says why inside it', async () => {
    const message = 'Only a manager can cancel this count.';
    vi.mocked(cancelCycleCountAction).mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message },
    } as never);
    render(<CycleCountDetail {...baseProps} canAdjust canAssign role="manager" />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel count' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this cycle count?' });
    expect(within(dialog).getByRole('button', { name: 'Keep counting' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel count' }));

    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent(message);
    });
    expect(toast.error).toHaveBeenCalledWith(message);
  });
});

/**
 * THE COUNT ON A PHONE (R4). The redesign drew the line as six columns at
 * least 600 px wide, so at 390 px a one-item search put the count box past the
 * screen's edge (about a 111 px sideways swipe, where before it needed none).
 * Without the floor the six columns still needed 600 to 647 px of their own,
 * so below sm the SKU, Expected and Variance columns fold into the Item cell:
 * the item, its box and Clear count show whole on the screen, and from sm up
 * the line is the six columns as before. happy-dom lays nothing out; the lab
 * measured 320 to 1280 px in Chromium and WebKit. These pin the classes and
 * the words.
 */
describe('CycleCountDetail: the count on a phone', () => {
  const FOLDED = ['hidden', 'sm:table-cell'];

  // Mutation caught: the 600 px floor at every width.
  it('keeps the 600 px floor from sm up only', () => {
    render(<CycleCountDetail {...baseProps} canAdjust role="staff" />);
    const table = screen.getByRole('table');
    expect(table).toHaveClass('sm:min-w-[600px]');
    expect(table).not.toHaveClass('min-w-[600px]');
  });

  // Mutation caught: a column left out of the fold (its cell stays at every
  // width), or Item, Counted or Clear count folded away.
  it('folds SKU, Expected and Variance below sm and keeps Item, Counted and Clear count', () => {
    render(<CycleCountDetail {...baseProps} canAdjust role="staff" />);
    const table = screen.getByRole('table');
    const heads = within(table).getAllByRole('columnheader');
    expect(heads.map((h) => h.textContent)).toEqual([
      'Item',
      'SKU',
      'Expected',
      'Counted',
      'Variance',
      '',
    ]);
    const cells = Array.from(screen.getByText('Widget').closest('tr')!.querySelectorAll('td'));
    for (const i of [1, 2, 4]) {
      expect(heads[i]).toHaveClass(...FOLDED);
      expect(cells[i]).toHaveClass(...FOLDED);
    }
    for (const i of [0, 3, 5]) {
      expect(heads[i]).not.toHaveClass('hidden');
      expect(cells[i]).not.toHaveClass('hidden');
    }
    // The Item column takes 112 px at least below sm (a 320 px phone shows the
    // item, its box and Clear count side by side) and 160 from sm up, as before.
    expect(cells[0]).toHaveClass('min-w-28', 'sm:min-w-[160px]');
  });

  // Mutation caught: the folded line left out, shown from sm up as well, or
  // not following the box as it is typed.
  it('shows the SKU, Expected and Variance under the name below sm, the variance following the box', () => {
    render(<CycleCountDetail {...baseProps} canAdjust role="staff" />);
    // Widget: SKU W-1, expected 5, counted 4.
    const item = screen.getByText('Widget').closest('td')!;
    expect(within(item).getByText('W-1')).toHaveClass('sm:hidden', 'font-mono');
    const folded = within(item).getByTestId('count-line-folded-numbers');
    expect(folded).toHaveClass('sm:hidden');
    expect(folded).toHaveTextContent('Expected 5 · Variance -1');
    expect(within(folded).getByText('-1')).toHaveClass('text-destructive');

    const row = item.closest('tr')!;
    fireEvent.change(within(row).getByPlaceholderText('—'), { target: { value: '7' } });
    expect(folded).toHaveTextContent('Expected 5 · Variance +2');
    expect(within(folded).getByText('+2')).toHaveClass('text-success');
    // The Variance column says the same.
    expect(row.querySelector('td:nth-child(5)')).toHaveTextContent('+2');

    // An uncounted line reads "Variance —", as its column does.
    const gadget = screen.getByText('Gadget').closest('td')!;
    expect(within(gadget).getByTestId('count-line-folded-numbers')).toHaveTextContent(
      'Expected 2 · Variance —',
    );
  });

  // Mutation caught: the Expected help folded away with its column on a phone.
  it('keeps the Expected help reachable on a phone, beside Counted', () => {
    render(<CycleCountDetail {...baseProps} canAdjust role="staff" />);
    const heads = within(screen.getByRole('table')).getAllByRole('columnheader');
    const tips = screen.getAllByRole('button', { name: 'What is the Expected quantity?' });
    expect(tips).toHaveLength(2);
    // From sm up, in the Expected column's header; below sm, beside Counted.
    expect(heads[2]).toContainElement(tips[0]!);
    expect(heads[3]).toContainElement(tips[1]!);
    expect(tips[1]!.parentElement).toHaveClass('sm:hidden');
  });

  // A read-only reader (no stock:adjust) gets the same fold, with the counted
  // quantity as text.
  it('folds the same way for a read-only reader', () => {
    render(<CycleCountDetail {...baseProps} canAdjust={false} />);
    const item = screen.getByText('Widget').closest('td')!;
    expect(within(item).getByTestId('count-line-folded-numbers')).toHaveTextContent(
      'Expected 5 · Variance -1',
    );
    expect(screen.queryByPlaceholderText('—')).not.toBeInTheDocument();
  });
});
