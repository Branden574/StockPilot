import { render, screen, waitFor } from '@testing-library/react';
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
