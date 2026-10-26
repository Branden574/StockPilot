import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

// B40: Refresh book prices set `loading`, awaited the action with no catch and
// cleared it only when it answered. A refresh that got no answer (offline, a
// server error, a deploy) said "Refreshing…" forever with no message.

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/price-tracking', () => ({ refreshBookPricesAction: vi.fn() }));

import { toast } from 'sonner';

import { refreshBookPricesAction } from '@/server/actions/price-tracking';

import { RefreshBookPricesButton } from './refresh-book-prices-button';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RefreshBookPricesButton when the refresh gets no answer', () => {
  it('says the book prices were not refreshed, and the button works again', async () => {
    vi.mocked(refreshBookPricesAction).mockRejectedValueOnce(offline());
    render(<RefreshBookPricesButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh book prices' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('refresh the book prices')),
    );
    expect(screen.getByRole('button', { name: 'Refresh book prices' })).toBeEnabled();
  });
});
