// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { RequesterReturnForm } from './requester-return-form';

const LINE = {
  orderRequestLineId: '11111111-1111-4111-8111-111111111111',
  itemId: '22222222-2222-4222-8222-222222222222',
  itemName: 'New Hire Shirt',
  itemSku: 'NH-M',
  quantityFulfilled: 3,
  quantityRemaining: 3,
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function sentKeys(): string[] {
  return fetchMock.mock.calls.map((c) => (JSON.parse(String((c[1] as RequestInit).body)) as { idempotencyKey: string }).idempotencyKey);
}

describe('RequesterReturnForm idempotency key (returns RX-1 review)', () => {
  it('keeps one key for the page: a lost answer then an EDITED resend is the same request, never a second RMA', async () => {
    // The first answer is lost (the create may have committed); the requester
    // changes the quantity and sends again.
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    render(<RequesterReturnForm token={'t'.padEnd(43, 'x')} lines={[LINE as never]} requesterName={null} />);
    fireEvent.click(screen.getByLabelText(/New Hire Shirt/));
    fireEvent.click(screen.getByRole('button', { name: 'Submit return request' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit return request' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Quantity to return for New Hire Shirt'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit return request' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [first, second] = sentKeys();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });
});
