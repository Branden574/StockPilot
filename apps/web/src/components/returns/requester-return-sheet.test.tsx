import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { RequesterOptionsOutcome, RequesterSubmitBody, RequesterSubmitOutcome } from '@/lib/returns/requester-sheet';

import {
  RETURNS_COPY,
  type RequesterExchangeOptionsAnswer,
  type RequesterReturnableLine,
} from '@stockpilot/core';

import { RequesterReturnSheetForm } from './requester-return-sheet';

const SHIRT_LINE = '11111111-1111-4111-8111-111111111111';
const BOOK_LINE = '22222222-2222-4222-8222-222222222222';
const SIZE_S = '33333333-3333-4333-8333-333333333333';
const SIZE_L = '44444444-4444-4444-8444-444444444444';
const SIZE_XL = '55555555-5555-4555-8555-555555555555';

const SHIRT: RequesterReturnableLine = {
  orderRequestLineId: SHIRT_LINE,
  name: 'New Hire Shirt',
  sizeLabel: 'Size M',
  photo: { url: 'https://signed.test/shirt-m.jpg', thumbUrl: 'https://signed.test/shirt-m-thumb.jpg' },
  quantityFulfilled: 2,
  quantityRemaining: 2,
};
const NOTEBOOK: RequesterReturnableLine = {
  orderRequestLineId: BOOK_LINE,
  name: 'Composition Notebook',
  sizeLabel: null,
  photo: null,
  quantityFulfilled: 3,
  quantityRemaining: 1,
};

/** The server's answer: sizes in size order, the notebook left out (no group). */
const ANSWER: RequesterExchangeOptionsAnswer = {
  exchangesEnabled: true,
  lines: [
    {
      orderRequestLineId: SHIRT_LINE,
      options: [
        { itemId: SIZE_S, name: 'New Hire Shirt', sizeLabel: 'Size S', availability: 'available', photo: null },
        {
          itemId: SIZE_L,
          name: 'New Hire Shirt',
          sizeLabel: 'Size L',
          availability: 'available',
          photo: { url: 'https://signed.test/shirt-l.jpg', thumbUrl: null },
        },
        { itemId: SIZE_XL, name: 'New Hire Shirt', sizeLabel: 'Size XL', availability: 'not_in_stock', photo: null },
      ],
    },
  ],
};

function setup(
  over: Partial<React.ComponentProps<typeof RequesterReturnSheetForm>> = {},
  answers: { options?: RequesterOptionsOutcome | Error; submit?: RequesterSubmitOutcome[] } = {},
) {
  const loadOptions = vi.fn(async (): Promise<RequesterOptionsOutcome> => {
    const a = answers.options ?? { ok: true, answer: ANSWER };
    if (a instanceof Error) throw a;
    return a;
  });
  const queue = [...(answers.submit ?? [{ ok: true, returnNumber: 'RMA-20261011-ABC123', replay: false }])];
  const submit = vi.fn(async (_body: RequesterSubmitBody): Promise<RequesterSubmitOutcome> => queue.shift() ?? { ok: true, returnNumber: null, replay: true });
  const onSubmitted = vi.fn();
  const utils = render(
    <RequesterReturnSheetForm
      lines={[SHIRT, NOTEBOOK]}
      exchangesEnabled
      loadOptions={loadOptions}
      submit={submit}
      onSubmitted={onSubmitted}
      idPrefix="t"
      {...over}
    />,
  );
  return { ...utils, loadOptions, submit, onSubmitted, user: userEvent.setup() };
}

const submitButton = () => screen.getByRole('button', { name: 'Submit return request' });
const lastBody = (submit: ReturnType<typeof vi.fn>) => submit.mock.calls.at(-1)![0] as RequesterSubmitBody;

describe('RequesterReturnSheetForm: the RETURNING side', () => {
  it("shows each line's photo, name, size and what can come back, and never a SKU", () => {
    const { container } = setup();
    expect(screen.getByText('New Hire Shirt')).toBeInTheDocument();
    expect(screen.getByText('Size M')).toBeInTheDocument();
    expect(screen.getByText('2 of 2 returnable')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 returnable')).toBeInTheDocument();
    // The thumbnail first (lists use thumbnails, brief 27).
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://signed.test/shirt-m-thumb.jpg');
    expect(container.textContent).not.toMatch(/sku/i);
  });

  it('falls back from the thumbnail to the master, then to a placeholder, and never blocks the form', () => {
    const { container } = setup();
    const img = () => container.querySelector('img');
    fireEvent.error(img()!);
    expect(img()?.getAttribute('src')).toBe('https://signed.test/shirt-m.jpg');
    fireEvent.error(img()!);
    expect(img()).toBeNull();
    expect(submitButton()).toBeEnabled();
  });

  it('starts nothing ticked when several lines can come back, and asks for one in the form, never only in a toast', async () => {
    const { submit, user } = setup();
    await user.click(submitButton());
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one item to return.');
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: /New Hire Shirt/ }));
  });

  it('starts the only returnable line ticked at what can come back', () => {
    setup({ lines: [SHIRT] });
    expect(screen.getByRole('checkbox', { name: /New Hire Shirt/ })).toBeChecked();
    expect(screen.getByLabelText('Quantity to return for New Hire Shirt, M')).toHaveValue(2);
  });

  it('keeps the quantity whole and inside what can come back', async () => {
    const { user } = setup({ lines: [SHIRT] });
    const qty = screen.getByLabelText('Quantity to return for New Hire Shirt, M');
    expect(screen.getByRole('button', { name: /One more: quantity to return/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /One fewer: quantity to return/ }));
    expect(qty).toHaveValue(1);
    fireEvent.change(qty, { target: { value: '9' } });
    expect(qty).toHaveValue(2);
  });
});

describe('RequesterReturnSheetForm: Return only, or Exchange for another size', () => {
  it('asks "What would you like to do?" for a ticked line, with Return only chosen', async () => {
    const { user } = setup();
    expect(screen.queryByRole('group', { name: /What would you like to do\?/ })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /New Hire Shirt/ }));
    const choice = screen.getByRole('group', { name: /What would you like to do\? \(New Hire Shirt, M\)/ });
    expect(within(choice).getByRole('radio', { name: RETURNS_COPY.returnOnly })).toBeChecked();
    expect(within(choice).getByRole('radio', { name: RETURNS_COPY.exchangeRequester })).not.toBeChecked();
  });

  it('offers no Exchange while exchanges are switched off: a return only, as before', async () => {
    const { user, submit, loadOptions } = setup({ exchangesEnabled: false });
    await user.click(screen.getByRole('checkbox', { name: /New Hire Shirt/ }));
    expect(screen.queryByText(RETURNS_COPY.whatWouldYouLikeToDo)).toBeNull();
    expect(screen.queryByRole('radio', { name: RETURNS_COPY.exchangeRequester })).toBeNull();
    await user.click(submitButton());
    expect(loadOptions).not.toHaveBeenCalled();
    expect(lastBody(submit).lines).toEqual([{ orderRequestLineId: SHIRT_LINE, quantity: 2 }]);
  });

  it('sends a return only as the line and its quantity', async () => {
    const { user, submit, onSubmitted, loadOptions } = setup({ lines: [SHIRT] });
    await user.click(submitButton());
    expect(loadOptions).not.toHaveBeenCalled();
    expect(lastBody(submit).lines).toEqual([{ orderRequestLineId: SHIRT_LINE, quantity: 2 }]);
    expect(onSubmitted).toHaveBeenCalledWith({ returnNumber: 'RMA-20261011-ABC123', replay: false, hasExchange: false });
  });
});

describe('RequesterReturnSheetForm: the REPLACEMENT side', () => {
  it('loads the sizes once, on the first Exchange, whatever the lines and choices after it (brief 44)', async () => {
    const { user, loadOptions } = setup();
    expect(loadOptions).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: /New Hire Shirt/ }));
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    await screen.findByRole('radiogroup', { name: /REPLACEMENT for New Hire Shirt, M/ });
    await user.click(screen.getAllByRole('radio', { name: RETURNS_COPY.returnOnly })[0]!);
    await user.click(screen.getAllByRole('radio', { name: RETURNS_COPY.exchangeRequester })[0]!);
    await user.click(screen.getByRole('checkbox', { name: /Composition Notebook/ }));
    await user.click(screen.getAllByRole('radio', { name: RETURNS_COPY.exchangeRequester })[1]!);
    expect(loadOptions).toHaveBeenCalledTimes(1);
  });

  it('shows the sizes in the order the server gave (size order), each with its photo and two-state availability, never a count', async () => {
    const { user, container } = setup({ lines: [SHIRT] });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    const group = await screen.findByRole('radiogroup', { name: /REPLACEMENT for New Hire Shirt, M/ });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('value'))).toEqual([SIZE_S, SIZE_L, SIZE_XL]);
    expect(within(group).getByRole('radio', { name: /Size L/ })).toHaveAccessibleName(/Size L.*New Hire Shirt.*Available/);
    expect(within(group).getByRole('radio', { name: /Size XL/ })).toHaveAccessibleName(/Not in stock right now/);
    expect(within(group).queryByText(/\d+ available/i)).toBeNull();
    // The L's own photo (its master: it has no thumbnail).
    expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toContain('https://signed.test/shirt-l.jpg');
  });

  it('sends the chosen size with the replacement quantity, which follows the return quantity and never passes it (brief 4)', async () => {
    const { user, submit, onSubmitted } = setup({ lines: [SHIRT] });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    const group = await screen.findByRole('radiogroup', { name: /REPLACEMENT for New Hire Shirt, M/ });
    await user.click(within(group).getByRole('radio', { name: /Size L/ }));
    const rq = screen.getByLabelText('Quantity for replacement for New Hire Shirt, M');
    expect(rq).toHaveValue(2);
    await user.click(screen.getByRole('button', { name: /One fewer: quantity for replacement/ }));
    expect(rq).toHaveValue(1);
    await user.click(submitButton());
    expect(lastBody(submit).lines).toEqual([
      { orderRequestLineId: SHIRT_LINE, quantity: 2, exchange: { itemId: SIZE_L, quantity: 1 } },
    ]);
    expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ hasExchange: true }));
  });

  it('caps the replacement at a lowered return quantity', async () => {
    const { user, submit } = setup({ lines: [SHIRT] });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    const group = await screen.findByRole('radiogroup');
    await user.click(within(group).getByRole('radio', { name: /Size S/ }));
    await user.click(screen.getByRole('button', { name: /One fewer: quantity to return/ }));
    expect(screen.queryByLabelText('Quantity for replacement for New Hire Shirt, M')).toBeNull();
    expect(screen.getByText(`${RETURNS_COPY.replacementQuantity}: 1`)).toBeInTheDocument();
    await user.click(submitButton());
    expect(lastBody(submit).lines[0]?.exchange).toEqual({ itemId: SIZE_S, quantity: 1 });
  });

  it('asks for a size in the form and moves focus to the sizes when none is chosen', async () => {
    const { user, submit } = setup({ lines: [SHIRT] });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    await screen.findByRole('radiogroup');
    await user.click(submitButton());
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a size for New Hire Shirt, M.');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Size S/ }));
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-invalid', 'true');
  });

  it('offers "warehouse will review" with a note for a line with no sizes, and sends the note', async () => {
    const { user, submit } = setup({ lines: [NOTEBOOK] });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    expect(await screen.findByText(RETURNS_COPY.warehouseReview)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    const note = screen.getByLabelText(RETURNS_COPY.warehouseReviewNote);
    expect(note).toHaveAttribute('maxlength', '500');
    await user.click(submitButton());
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Tell the warehouse what you need for Composition Notebook.');
    expect(document.activeElement).toBe(note);
    await user.type(note, 'Wide ruled, please');
    expect(screen.getByText('18/500')).toBeInTheDocument();
    await user.click(submitButton());
    expect(lastBody(submit).lines).toEqual([
      { orderRequestLineId: BOOK_LINE, quantity: 1, exchange: { note: 'Wide ruled, please', quantity: 1 } },
    ]);
  });

  it("says the sizes couldn't load, offers Try again, and loads them again only when asked", async () => {
    const { user, loadOptions } = setup({ lines: [SHIRT] }, { options: { ok: false, message: RETURNS_COPY.requesterOptionsUnavailable } });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    expect(await screen.findByText(RETURNS_COPY.requesterOptionsUnavailable)).toBeInTheDocument();
    expect(loadOptions).toHaveBeenCalledTimes(1);
    loadOptions.mockResolvedValueOnce({ ok: true, answer: ANSWER });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('radiogroup');
    expect(loadOptions).toHaveBeenCalledTimes(2);
  });

  it('treats a thrown sizes call as one that could not load', async () => {
    const { user } = setup({ lines: [SHIRT] }, { options: new TypeError('network') });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    expect(await screen.findByText(RETURNS_COPY.requesterOptionsUnavailable)).toBeInTheDocument();
  });

  it('says exchanges are off when the sizes answer says so, and refuses to send the exchange', async () => {
    const { user, submit } = setup({ lines: [SHIRT] }, { options: { ok: true, answer: { exchangesEnabled: false, lines: [] } } });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    expect(await screen.findByText(RETURNS_COPY.exchangeKillSwitch)).toBeInTheDocument();
    await user.click(submitButton());
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(RETURNS_COPY.exchangeKillSwitch);
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.returnOnly }));
    expect(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester })).toBeDisabled();
  });

  // RX-3 fix round 1 (desk check L5): the token page went from its h1 to the
  // REPLACEMENT h3. The card is an article named by its label, not a heading.
  it('names the REPLACEMENT card without making it a heading (no skipped heading level)', async () => {
    const { user } = setup({ lines: [SHIRT] });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    expect(await screen.findByRole('article', { name: /REPLACEMENT for New Hire Shirt, M/ })).toBeInTheDocument();
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });

  it('marks the two sides apart with text labels and an arrow, never colour alone', async () => {
    const { user } = setup({ lines: [SHIRT] });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    expect(screen.getByRole('article', { name: `${RETURNS_COPY.returning}: New Hire Shirt, M` })).toBeInTheDocument();
    const replacement = screen.getByRole('article', { name: /REPLACEMENT for New Hire Shirt, M/ });
    expect(within(replacement).getByText(RETURNS_COPY.replacement)).toBeInTheDocument();
  });

  // RX-3 test stage, fix round 1 (E1): beside RETURNING (md and up) the card is about half the
  // page, so a column count read from the window gave three columns of about 80px and
  // "Available" ran past the card's border. The columns follow the card's own width instead
  // (two; three from 28rem), and the availability words wrap inside their size. The real
  // layout is measured in the browser flows (A, C, E, F at 1440, 1024 and 768 px; N at 390).
  it("lays the sizes out by the REPLACEMENT card's own width, never the window's, and keeps the availability words inside each size", async () => {
    const { user } = setup({ lines: [SHIRT] });
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    const group = await screen.findByRole('radiogroup', { name: /REPLACEMENT for New Hire Shirt, M/ });
    const classes = (el: Element) => el.className.split(/\s+/);
    const card = screen.getByRole('article', { name: /REPLACEMENT for New Hire Shirt, M/ });
    expect(classes(card)).toContain('@container');
    expect(classes(group)).toEqual(expect.arrayContaining(['grid-cols-2', '@md:grid-cols-3']));
    expect(classes(group).filter((c) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(c))).toEqual([]);
    for (const words of ['Available', 'Not in stock right now']) {
      for (const el of within(group).getAllByText(words)) {
        expect(classes(el)).toEqual(expect.arrayContaining(['min-w-0', 'break-words']));
      }
    }
  });
});

describe('RequesterReturnSheetForm: sending', () => {
  it('mints ONE key when the form opens and resends it as it is, even after an edit (a lost answer replays the same RMA)', async () => {
    const { user, submit } = setup(
      { lines: [SHIRT] },
      {
        submit: [
          { ok: false, message: 'Busy. Try again.', reason: 'busy' },
          { ok: true, returnNumber: 'RMA-1', replay: false },
        ],
      },
    );
    await user.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Busy. Try again.');
    await user.click(screen.getByRole('button', { name: /One fewer: quantity to return/ }));
    await user.click(submitButton());
    expect(submit).toHaveBeenCalledTimes(2);
    const [first, second] = submit.mock.calls.map((c) => (c[0] as RequesterSubmitBody).idempotencyKey);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toBe(first);
  });

  it('a new form is a new key', async () => {
    const one = setup({ lines: [SHIRT] });
    await one.user.click(submitButton());
    const k1 = lastBody(one.submit).idempotencyKey;
    one.unmount();
    const two = setup({ lines: [SHIRT] });
    await two.user.click(submitButton());
    expect(lastBody(two.submit).idempotencyKey).not.toBe(k1);
  });

  it("says the server's refusal in the form, and a kill switch refusal turns Exchange off", async () => {
    const { user, onSubmitted } = setup(
      { lines: [SHIRT] },
      { submit: [{ ok: false, message: RETURNS_COPY.exchangeKillSwitch, reason: 'exchange_not_available' }] },
    );
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    const group = await screen.findByRole('radiogroup');
    await user.click(within(group).getByRole('radio', { name: /Size L/ }));
    await user.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(RETURNS_COPY.exchangeKillSwitch);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getAllByText(RETURNS_COPY.exchangeKillSwitch).length).toBeGreaterThan(0);
  });

  // RX-3 fix round 1 (desk checks M4 and F4): after a refusal that means the
  // form is behind, the web kept its stale quantities and sizes until a full
  // reload and resent the same refused choice. It now reads the lines (the
  // page's onStale) and the sizes again, unchooses a size no longer offered,
  // and keeps its key (the refused transaction rolled back the key row).
  it('a refusal that means the form is behind reads the lines and sizes again, keeps the key, and unchooses a size no longer offered', async () => {
    const onStale = vi.fn();
    const { user, submit, loadOptions } = setup(
      { lines: [SHIRT], onStale },
      { submit: [{ ok: false, message: 'Choose another size.', reason: 'exchange_item_not_eligible' }] },
    );
    await user.click(screen.getByRole('radio', { name: RETURNS_COPY.exchangeRequester }));
    await user.click(within(await screen.findByRole('radiogroup')).getByRole('radio', { name: /Size L/ }));
    // The second sizes answer no longer offers L.
    loadOptions.mockResolvedValueOnce({
      ok: true,
      answer: { ...ANSWER, lines: [{ orderRequestLineId: SHIRT_LINE, options: ANSWER.lines[0]!.options.filter((o) => o.itemId !== SIZE_L) }] },
    });
    await user.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose another size.');
    expect(onStale).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(loadOptions).toHaveBeenCalledTimes(2));
    const group = await screen.findByRole('radiogroup');
    expect(within(group).queryByRole('radio', { name: /Size L/ })).toBeNull();
    expect(within(group).getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    await user.click(within(group).getByRole('radio', { name: /Size S/ }));
    await user.click(submitButton());
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]![0].idempotencyKey).toBe(submit.mock.calls[0]![0].idempotencyKey);
    expect(submit.mock.calls[1]![0].lines[0]!.exchange).toMatchObject({ itemId: SIZE_S });
  });

  // RX-3 fix round 1 (desk checks M4 and F3): idempotency_conflict means an
  // earlier send with this key went through (its answer was lost) with other
  // details. The form resent the same key forever. It now says so, reads the
  // page again, and starts over with nothing chosen and a new key: a press
  // alone never sends a second request.
  it('idempotency_conflict: says the earlier request went through, starts over with nothing chosen, and a press alone sends nothing', async () => {
    const onStale = vi.fn();
    const { user, submit } = setup(
      { lines: [SHIRT], onStale },
      {
        submit: [
          { ok: false, message: 'This request was already sent with different details. Reload and try again.', reason: 'idempotency_conflict' },
          { ok: true, returnNumber: 'RMA-2', replay: false },
        ],
      },
    );
    await user.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(RETURNS_COPY.requesterEarlierRequestSent);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    await user.click(submitButton());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent(RETURNS_COPY.requesterPickAtLeastOne);
    // Choosing again is a new request, with a new key.
    await user.click(screen.getByRole('checkbox'));
    await user.click(submitButton());
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]![0].idempotencyKey).not.toBe(submit.mock.calls[0]![0].idempotencyKey);
  });

  it('lines read again: each quantity stays within what is left, a line with nothing left is unticked, and a new line gets its own row', async () => {
    const { user, rerender, loadOptions, submit, onSubmitted } = setup({ lines: [SHIRT] });
    expect(screen.getByRole('checkbox')).toBeChecked();
    const props = { exchangesEnabled: true, loadOptions, submit, onSubmitted, idPrefix: 't' } as const;
    rerender(<RequesterReturnSheetForm {...props} lines={[{ ...SHIRT, quantityRemaining: 1 }, NOTEBOOK]} />);
    await user.click(submitButton());
    expect(lastBody(submit).lines).toEqual([{ orderRequestLineId: SHIRT_LINE, quantity: 1 }]);
    expect(screen.getByText('Composition Notebook')).toBeInTheDocument();
    rerender(<RequesterReturnSheetForm {...props} lines={[{ ...SHIRT, quantityRemaining: 0 }, NOTEBOOK]} />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).not.toBeChecked();
  });

  it('a send that throws says so and keeps the form', async () => {
    const submit = vi.fn(async () => {
      throw new TypeError('offline');
    });
    render(
      <RequesterReturnSheetForm lines={[SHIRT]} exchangesEnabled loadOptions={vi.fn()} submit={submit} onSubmitted={vi.fn()} idPrefix="t" />,
    );
    await userEvent.setup().click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not submit your request. Check your connection and try again.');
    await waitFor(() => expect(submitButton()).toBeEnabled());
  });

  it('sends the reason and the trimmed notes, and offers Cancel when given one', async () => {
    const onCancel = vi.fn();
    const { user, submit } = setup({ lines: [SHIRT], onCancel });
    await user.selectOptions(screen.getByLabelText('Reason (optional)'), 'wrong_item');
    await user.type(screen.getByLabelText('Notes (optional)'), '  Too small  ');
    await user.click(submitButton());
    expect(lastBody(submit)).toMatchObject({ reasonCode: 'wrong_item', notes: 'Too small' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders the honeypot off-screen and out of the tab order when given one', () => {
    setup({ honeypot: { value: '', onChange: vi.fn() } });
    const hp = document.getElementById('t-hp');
    expect(hp).not.toBeNull();
    expect(hp).toHaveAttribute('tabindex', '-1');
    expect(hp?.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

// Redesign (P4.B3): the line's tick box is drawn as the shared Checkbox's box,
// but it stays the native checkbox the public page, the portal and the order
// page rely on: an <input type="checkbox"> that its words tick, that Space
// ticks, and that a line with nothing left to return cannot tick.
describe('RequesterReturnSheetForm: the line tick box stays a native checkbox', () => {
  it('is an input checkbox that its words and Space toggle', async () => {
    const { user } = setup();
    const box = screen.getByRole('checkbox', { name: /New Hire Shirt/ });
    expect(box.tagName).toBe('INPUT');
    expect(box).toHaveAttribute('type', 'checkbox');
    expect(box).not.toBeChecked();
    await user.click(screen.getByText('New Hire Shirt'));
    expect(box).toBeChecked();
    box.focus();
    await user.keyboard(' ');
    expect(box).not.toBeChecked();
  });

  it('cannot be ticked on a line with nothing left to return', () => {
    setup({ lines: [SHIRT, { ...NOTEBOOK, quantityRemaining: 0 }] });
    expect(screen.getByRole('checkbox', { name: /Composition Notebook/ })).toBeDisabled();
  });
});
