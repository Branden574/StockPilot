// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline, signInRedirect } from '@/test/rejected-request';

import { ReplacementPicker } from './replacement-picker';

/**
 * RX-2 review fix P3: the picker never cuts an item's name (the size was lost
 * in the approval review's half-width card), and below the `sm` breakpoint the
 * availability goes under the name instead of squeezing it.
 */

const LONG = 'Walk Exchange Tee With A Very Long Product Name - 2XL';

function load() {
  return vi.fn(async () => ({
    ok: true as const,
    data: {
      orderId: 'o',
      orderRequestLineId: 'l',
      returnedItemId: 'm',
      groupId: 'g',
      siblings: [
        { itemId: 'xxl', name: LONG, sku: 'WET-2XL', variantSize: '2XL', variantKey: null, groupId: 'g', sibling: true, isReturnedItem: false, onHand: 0, held: 0, free: 0 },
      ],
      matches: [],
    },
  }));
}

describe('ReplacementPicker rows', () => {
  it('show the whole name (wrapped, never truncated) with the availability under it below sm', async () => {
    render(<ReplacementPicker load={load()} needed={1} selectedItemId={null} onSelect={() => {}} label="Walk Exchange Tee - M" />);
    const name = await screen.findByText(LONG);
    expect(name.className).not.toMatch(/\btruncate\b/);
    expect(name.className).toMatch(/\bbreak-words\b/);
    const availability = screen.getByText('Short: 0 available, 1 needed.');
    // The name and the availability share one column that stacks below sm
    // and sits side by side from sm up.
    const column = availability.closest('[data-replacement-row]') as HTMLElement | null;
    expect(column).not.toBeNull();
    expect(column!.contains(name)).toBe(true);
    expect(column!.className).toMatch(/\bflex-col\b/);
    expect(column!.className).toMatch(/\bsm:flex-row\b/);
  });
});

/**
 * B40: the candidates read had no catch, so a read that got no answer left
 * "Loading" spinning under an empty list, and nothing said why.
 */
describe('ReplacementPicker when the read gets no answer', () => {
  it('stops loading, says what did not happen, and reads again when the person searches', async () => {
    const answered = load();
    const failing = vi.fn(async (q: string) => {
      if (q === '') throw offline();
      return answered();
    });
    const user = userEvent.setup();
    render(
      <ReplacementPicker
        load={failing}
        needed={1}
        selectedItemId={null}
        onSelect={() => {}}
        label="Walk Exchange Tee - M"
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'load the replacement items'),
    );
    expect(screen.queryByText('Loading')).toBeNull();

    // Searching reads again, and an answer clears the message.
    await user.type(screen.getByRole('textbox'), 'tee');
    expect(await screen.findByText(LONG)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(failing).toHaveBeenLastCalledWith('tee');
  });

  it('says nothing on the way to sign-in', async () => {
    const redirected = vi.fn(async () => {
      throw signInRedirect();
    });
    render(
      <ReplacementPicker
        load={redirected}
        needed={1}
        selectedItemId={null}
        onSelect={() => {}}
        label="Walk Exchange Tee - M"
      />,
    );
    await waitFor(() => expect(redirected).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
