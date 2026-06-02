import { describe, expect, it, vi } from 'vitest';
const shareLocation = vi.fn();
vi.mock('@/server/services/delivery-tracking', () => ({
  DeliveryTrackingService: { forCurrentUser: vi.fn(async () => ({ shareLocation })) },
}));
import { shareDeliveryLocationAction } from './delivery-tracking';

describe('shareDeliveryLocationAction', () => {
  it('rejects invalid coords', async () => {
    const res = await shareDeliveryLocationAction({ orderId: 'o1', lat: 999, lng: 0 });
    expect(res.ok).toBe(false);
  });
  it('delegates valid input and returns ok', async () => {
    shareLocation.mockResolvedValueOnce(undefined);
    const res = await shareDeliveryLocationAction({ orderId: '11111111-1111-1111-1111-111111111111', lat: 36.7, lng: -119.7 });
    expect(res.ok).toBe(true);
    expect(shareLocation).toHaveBeenCalledOnce();
  });
});
