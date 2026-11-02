import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

// B40: Upgrade and Manage subscription, when the request got no answer
// (offline, a server error, a deploy), stayed disabled with a spinner and
// said nothing.

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const actions = vi.hoisted(() => ({
  createCheckoutSessionAction: vi.fn(),
  createPortalSessionAction: vi.fn(),
}));
vi.mock('@/server/actions/billing', () => actions);

import { BillingActions } from './billing-actions';

beforeEach(() => vi.clearAllMocks());

describe('BillingActions when the request gets no answer', () => {
  it('Upgrade to Pro stops its spinner and says checkout did not open', async () => {
    actions.createCheckoutSessionAction.mockRejectedValueOnce(offline());
    render(<BillingActions currentPlan="free" hasStripeCustomer={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'open checkout')),
    );
    expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeEnabled();
  });

  it('Manage subscription stops its spinner and says the portal did not open', async () => {
    actions.createPortalSessionAction.mockRejectedValueOnce(offline());
    render(<BillingActions currentPlan="pro" hasStripeCustomer />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage subscription' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'open the billing portal'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Manage subscription' })).toBeEnabled();
  });
});
