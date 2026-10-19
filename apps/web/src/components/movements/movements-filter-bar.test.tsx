import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, refresh: vi.fn() }),
}));

import type { MovementsFilterQuery } from '@/lib/movements-filters';

import { MovementsFilterBar } from './movements-filter-bar';

const EMPTY: MovementsFilterQuery = { q: '', type: '', from: '', to: '' };

beforeEach(() => {
  replaceMock.mockClear();
});

function searchBox() {
  return screen.getByLabelText('Search stock movements') as HTMLInputElement;
}

describe('MovementsFilterBar debounced search', () => {
  // SP-034: the instant-mode table passes a MODULE CONSTANT as `initial`
  // ({q:''} forever), so a mount guard written as `q === initial.q` also
  // swallows the moment the user backspaces the box empty again — the
  // ledger (and the Export CSV href built from the same filter state)
  // stayed pinned to the old needle while the box read empty.
  it('emits the empty needle when the search is backspaced clear (client mode)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<MovementsFilterBar mode="client" initial={EMPTY} onChange={onChange} />);

    await user.type(searchBox(), 'lanyard');
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ q: 'lanyard', type: '', from: '', to: '' });
    });

    onChange.mockClear();
    await user.clear(searchBox());
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ q: '', type: '', from: '', to: '' });
    });
  });

  // Retyping the SAME needle after clearing must still land — the applied-ref
  // tracks what was last handed upstream, not the mount-time value.
  it('re-applies a needle that was cleared and typed again (client mode)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<MovementsFilterBar mode="client" initial={EMPTY} onChange={onChange} />);

    await user.type(searchBox(), 'abc');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...EMPTY, q: 'abc' }));
    await user.clear(searchBox());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...EMPTY, q: '' }));

    onChange.mockClear();
    await user.type(searchBox(), 'abc');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...EMPTY, q: 'abc' }));
  });

  // Revert-proof for the mount skip: a server-mode bar rendered from a URL
  // that already carries ?q= must NOT router.replace() itself on mount
  // (that would fight the user's own navigation / reset ?page).
  it('does not navigate on mount in server mode', async () => {
    render(<MovementsFilterBar mode="server" initial={{ ...EMPTY, q: 'lanyard' }} />);
    await new Promise((r) => setTimeout(r, 400));
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // …but backspacing that server-mode box empty still commits the cleared
  // search to the URL.
  it('commits an emptied search to the URL in server mode', async () => {
    const user = userEvent.setup();
    render(<MovementsFilterBar mode="server" initial={{ ...EMPTY, q: 'lanyard' }} />);

    await user.clear(searchBox());
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard/movements'));
  });
});

describe('MovementsFilterBar type chips', () => {
  // The redesign draws the type filter as chips (DESIGN-SPEC 6.6) in place of
  // the "Filter by movement type" select. PLAN P3.7: chips may replace the
  // select only if all 10 real types plus All stay and ?type= is unchanged.
  const ALL_LABELS = [
    'All types',
    'Add',
    'Remove',
    'Adjust',
    'Transfer',
    'Receive PO',
    'Return',
    'Damage',
    'Loss',
    'Correction',
    'Initial',
  ];

  function chipGroup() {
    return screen.getByRole('group', { name: 'Filter by movement type' });
  }

  function chip(name: string) {
    return within(chipGroup()).getByRole('button', { name });
  }

  it('offers All types and the 10 real types, in the order the select listed them', () => {
    render(<MovementsFilterBar mode="client" initial={EMPTY} onChange={vi.fn()} />);
    const names = within(chipGroup())
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual(ALL_LABELS);
  });

  it('has no "Pick" chip: Pick is not a movement type', () => {
    render(<MovementsFilterBar mode="client" initial={EMPTY} onChange={vi.fn()} />);
    expect(within(chipGroup()).queryByRole('button', { name: /pick/i })).toBeNull();
  });

  it('presses exactly the chip for the type in effect (All types when none)', () => {
    const { unmount } = render(
      <MovementsFilterBar mode="client" initial={EMPTY} onChange={vi.fn()} />,
    );
    expect(chip('All types')).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(chipGroup())
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(1);
    unmount();

    render(<MovementsFilterBar mode="server" initial={{ ...EMPTY, type: 'receive_po' }} />);
    expect(chip('Receive PO')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('All types')).toHaveAttribute('aria-pressed', 'false');
  });

  it('server mode: a chip writes the same ?type= the select wrote, back on page 1', async () => {
    const user = userEvent.setup();
    render(<MovementsFilterBar mode="server" initial={EMPTY} />);

    await user.click(chip('Receive PO'));
    expect(replaceMock).toHaveBeenLastCalledWith('/dashboard/movements?type=receive_po');
    expect(chip('Receive PO')).toHaveAttribute('aria-pressed', 'true');

    await user.click(chip('Transfer'));
    expect(replaceMock).toHaveBeenLastCalledWith('/dashboard/movements?type=transfer');
  });

  it('server mode: a chip keeps the search and dates already in the URL', async () => {
    const user = userEvent.setup();
    render(
      <MovementsFilterBar
        mode="server"
        initial={{ q: 'lanyard', type: '', from: '2026-09-01', to: '2026-09-30' }}
      />,
    );

    await user.click(chip('Adjust'));
    expect(replaceMock).toHaveBeenLastCalledWith(
      '/dashboard/movements?q=lanyard&type=adjust&from=2026-09-01&to=2026-09-30',
    );
  });

  it('server mode: All types takes ?type= off the URL', async () => {
    const user = userEvent.setup();
    render(<MovementsFilterBar mode="server" initial={{ ...EMPTY, q: 'tape', type: 'loss' }} />);

    await user.click(chip('All types'));
    expect(replaceMock).toHaveBeenLastCalledWith('/dashboard/movements?q=tape');
  });

  it('pressing the chip already on does nothing, as re-picking the select option did', async () => {
    const user = userEvent.setup();
    render(<MovementsFilterBar mode="server" initial={{ ...EMPTY, type: 'damage' }} />);

    await user.click(chip('Damage'));
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('client mode: a chip hands the type to the instant ledger, with no navigation', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<MovementsFilterBar mode="client" initial={EMPTY} onChange={onChange} />);

    await user.click(chip('Return'));
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY, type: 'return' });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('Clear filters takes the type off with everything else', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<MovementsFilterBar mode="client" initial={EMPTY} onChange={onChange} />);

    await user.click(chip('Correction'));
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onChange).toHaveBeenLastCalledWith(EMPTY);
    expect(chip('All types')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('MovementsFilterBar controls keep their names', () => {
  it('search, both dates and the clear controls keep their accessible names', async () => {
    const user = userEvent.setup();
    render(<MovementsFilterBar mode="client" initial={EMPTY} onChange={vi.fn()} />);

    expect(searchBox()).toHaveAttribute('placeholder', 'Search by item name or SKU…');
    expect(screen.getByLabelText('From date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('To date')).toHaveAttribute('type', 'date');
    // The clear controls appear once there is something to clear.
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    await user.type(searchBox(), 'x');
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('draws what it is handed at the end of the search row (the top pager)', () => {
    render(
      <MovementsFilterBar
        mode="client"
        initial={EMPTY}
        onChange={vi.fn()}
        trailing={<nav aria-label="Top pager" />}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Top pager' })).toBeInTheDocument();
  });
});

describe('MovementsFilterBar follows the URL in server mode', () => {
  // Next keeps the bar's state when only the search params change, so a link
  // that clears the URL from outside the bar (the no-match state's "Clear
  // filters", the sidebar's Movements link, the breadcrumb) used to leave the
  // old search, chip and dates showing over an unfiltered ledger, and the
  // next chip press sent the stale search back.
  it('takes the filters off when the URL is cleared from outside the bar', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MovementsFilterBar
        mode="server"
        initial={{ q: 'zzz', type: 'adjust', from: '2026-09-01', to: '2026-09-30' }}
      />,
    );
    expect(searchBox()).toHaveValue('zzz');

    rerender(<MovementsFilterBar mode="server" initial={EMPTY} />);

    expect(searchBox()).toHaveValue('');
    const group = screen.getByRole('group', { name: 'Filter by movement type' });
    expect(within(group).getByRole('button', { name: 'All types' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(group).getByRole('button', { name: 'Adjust' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByLabelText('From date')).toHaveValue('');
    expect(screen.getByLabelText('To date')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(replaceMock).not.toHaveBeenCalled();

    // The next chip press carries no stale search.
    await user.click(within(group).getByRole('button', { name: 'Loss' }));
    expect(replaceMock).toHaveBeenLastCalledWith('/dashboard/movements?type=loss');
  });

  it('takes new filters from a URL changed from outside the bar', () => {
    const { rerender } = render(<MovementsFilterBar mode="server" initial={EMPTY} />);
    rerender(
      <MovementsFilterBar
        mode="server"
        initial={{ q: 'tape', type: 'damage', from: '2026-08-01', to: '' }}
      />,
    );
    expect(searchBox()).toHaveValue('tape');
    expect(screen.getByRole('button', { name: 'Damage' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('From date')).toHaveValue('2026-08-01');
  });

  it("keeps characters typed while the bar's own debounced search makes its round trip", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MovementsFilterBar mode="server" initial={EMPTY} />);

    await user.type(searchBox(), 'lan ');
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard/movements?q=lan'));
    // More typed before the URL lands...
    await user.type(searchBox(), 'yard');
    // ...then the URL the bar sent arrives (trimmed, as the URL keeps it).
    rerender(<MovementsFilterBar mode="server" initial={{ ...EMPTY, q: 'lan' }} />);
    expect(searchBox()).toHaveValue('lan yard');
    await waitFor(() =>
      expect(replaceMock).toHaveBeenLastCalledWith('/dashboard/movements?q=lan+yard'),
    );
  });

  it('a fresh but equal filter set changes nothing', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MovementsFilterBar mode="server" initial={{ ...EMPTY, q: 'tape' }} />,
    );
    await user.type(searchBox(), 's');
    rerender(<MovementsFilterBar mode="server" initial={{ ...EMPTY, q: 'tape' }} />);
    expect(searchBox()).toHaveValue('tapes');
  });

  it('client mode ignores a changed initial (the instant ledger owns its filters)', () => {
    const { rerender } = render(
      <MovementsFilterBar mode="client" initial={{ ...EMPTY, q: 'zzz' }} onChange={vi.fn()} />,
    );
    rerender(<MovementsFilterBar mode="client" initial={EMPTY} onChange={vi.fn()} />);
    expect(searchBox()).toHaveValue('zzz');
  });
});
