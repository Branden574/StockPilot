import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

// B40: Refresh set `loading`, awaited the action with no catch and cleared it
// only when it answered. A lookup that got no answer (offline, a server
// error, a deploy) said "Fetching…" forever with no message.

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/price-tracking', () => ({ fetchItemPriceAction: vi.fn() }));

import { toast } from 'sonner';

import { fetchItemPriceAction } from '@/server/actions/price-tracking';

import { MarketPricePanel } from './market-price-panel';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MarketPricePanel when Refresh gets no answer', () => {
  it('says the market price was not refreshed, and Refresh works again', async () => {
    vi.mocked(fetchItemPriceAction).mockRejectedValueOnce(offline());
    render(<MarketPricePanel itemId="item-1" initial={null} ourRetail={null} ourCost={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'refresh the market price'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(screen.queryByText('Fetching…')).toBeNull();
  });
});
