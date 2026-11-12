import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordAction = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/server/actions/return-request', () => ({
  recordReturnRequestDraftedAction: (...args: unknown[]) => recordAction(...args),
}));
const reportErrorMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/lib/error-reporter-core', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

import {
  deliveryRequestRecipients,
  DRAFT_URL_LIMIT,
  prepareReturnRequestEmail,
  RETURN_REQUEST_COPY,
  type ReturnRequestEmailContent,
} from '@stockpilot/core';

import { RETURN_REQUEST_PRESS_BURST_MS, ReturnRequestAction } from './return-request-action';
import { SendReturnRequestButton } from './send-return-request-button';

// Reserved test domains only. Nothing here can reach a real mailbox, and no
// test opens a real window: window.open and location.assign are spies.
const ROUTING = { to: 'intake@warehouse.test', cc: 'copy@warehouse.test', toName: 'Warehouse Intake' };
const ORDER = 'b3f1c2d4-1111-4222-8333-444455556666';

const CONTENT: ReturnRequestEmailContent = {
  returnNumber: 'RMA-20261110-AB12CD',
  orderNumber: 'SO-000085',
  status: 'requested',
  reasonCode: 'damaged',
  requestedBy: 'Sample Requester',
  requesterEmail: 'requester@school.test',
  site: null,
  warehouseName: 'Main Warehouse',
  items: [{ text: 'Staff Polo, M ×2', sku: 'POLO-M', replacement: null }],
  link: 'https://app.example.test/dashboard/returns/r1',
};

const LONG: ReturnRequestEmailContent = {
  ...CONTENT,
  items: Array.from({ length: 60 }, (_, i) => ({
    text: `Uniform piece number ${i + 1}, XL ×3`,
    sku: `UNI-${i + 1}`,
    replacement: null,
  })),
};
const OVERSIZED: ReturnRequestEmailContent = { ...CONTENT, requestedBy: 'N'.repeat(2500) };

let openSpy: ReturnType<typeof vi.fn>;
let assignSpy: ReturnType<typeof vi.fn>;
let originalOpen: PropertyDescriptor | undefined;
let originalClipboard: PropertyDescriptor | undefined;
let originalLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  recordAction.mockImplementation(async () => undefined);
  originalOpen = Object.getOwnPropertyDescriptor(window, 'open');
  openSpy = vi.fn(() => ({ opener: {} }) as unknown as Window);
  Object.defineProperty(window, 'open', { value: openSpy, configurable: true, writable: true });
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
  assignSpy = vi.fn();
  originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign: assignSpy },
    configurable: true,
  });
});

afterEach(() => {
  if (originalOpen) Object.defineProperty(window, 'open', originalOpen);
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
});

function renderAction(over: Partial<Parameters<typeof ReturnRequestAction>[0]> = {}) {
  return render(
    <ReturnRequestAction orderId={ORDER} surface="return" content={CONTENT} recipients={ROUTING} {...over} />,
  );
}
const primary = () => screen.getByRole('button', { name: 'Email return request' });

/** Fake timers that still move with the clock (so waitFor and userEvent run),
 *  and a step past one press's burst. */
function useBurstClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}
function passTheBurst() {
  act(() => {
    vi.advanceTimersByTime(RETURN_REQUEST_PRESS_BURST_MS);
  });
}
afterEach(() => {
  vi.useRealTimers();
});

describe('ReturnRequestAction: opening the draft', () => {
  it('opens the web compose link the default prepare measured, with no features string, and cuts the opener', async () => {
    renderAction();
    await userEvent.click(primary());
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target, features] = openSpy.mock.calls[0]!;
    const prepared = prepareReturnRequestEmail({ ...CONTENT, recipients: deliveryRequestRecipients(ROUTING) });
    expect(url).toBe(prepared.outlookUrl);
    expect(String(url).length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(String(url)).toContain(encodeURIComponent(encodeURIComponent('copy@warehouse.test')));
    expect(target).toBe('_blank');
    expect(features).toBeUndefined();
    expect((openSpy.mock.results[0]!.value as { opener: unknown }).opener).toBeNull();
  });

  it('records after the open, never before, with the order, the return number and the surface', async () => {
    const order: string[] = [];
    openSpy.mockImplementation(() => {
      order.push('open');
      return { opener: {} } as unknown as Window;
    });
    recordAction.mockImplementation(async () => {
      order.push('record');
    });
    renderAction({ surface: 'order' });
    await userEvent.click(primary());
    await waitFor(() => expect(order).toEqual(['open', 'record']));
    expect(recordAction).toHaveBeenCalledTimes(1);
    expect(recordAction).toHaveBeenCalledWith({
      orderId: ORDER,
      returnNumber: 'RMA-20261110-AB12CD',
      isCondensed: false,
      surface: 'order',
    });
  });

  it('says only that Outlook opened, in the live region', async () => {
    renderAction();
    await userEvent.click(primary());
    expect(screen.getByTestId('return-request-live')).toHaveTextContent(RETURN_REQUEST_COPY.success);
  });

  it('makes no network call of its own on the press', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
    renderAction();
    await userEvent.click(primary());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('a record that rejects is absorbed and leaves a breadcrumb', async () => {
    recordAction.mockRejectedValueOnce(new Error('offline'));
    renderAction();
    await userEvent.click(primary());
    await waitFor(() => expect(reportErrorMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('return-request-live')).toHaveTextContent(RETURN_REQUEST_COPY.success);
  });
});

describe('ReturnRequestAction: a second draft', () => {
  it('shows no warning before the first draft, and the warning as soon as one was opened', async () => {
    renderAction();
    expect(screen.queryByTestId('return-request-repeat')).not.toBeInTheDocument();
    await userEvent.click(primary());
    expect(screen.getByTestId('return-request-repeat')).toHaveTextContent(
      'You have already opened a draft for this return. Sending more than one creates duplicate requests for the warehouse.',
    );
  });

  it('a second press is warned about, not refused: it opens and records again', async () => {
    const user = useBurstClock();
    renderAction();
    await user.click(primary());
    passTheBurst();
    await user.click(primary());
    expect(openSpy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(recordAction).toHaveBeenCalledTimes(2));
  });

  it('a double click is one press: one window.open, one record, and the button is disabled for the burst', async () => {
    // The skeptic round (2026-11-12, replay.log line 2): a real double click
    // called window.open twice and opened two drafts.
    const user = useBurstClock();
    renderAction();
    await user.dblClick(primary());
    expect(openSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(recordAction).toHaveBeenCalledTimes(1));
    expect(primary()).toBeDisabled();
    // A third click inside the same burst opens nothing either.
    await user.click(primary());
    expect(openSpy).toHaveBeenCalledTimes(1);
    passTheBurst();
    expect(primary()).toBeEnabled();
  });

  it('a double click on a blocked pop-up navigates to mailto once and tries window.open once', async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    const user = useBurstClock();
    renderAction();
    await user.dblClick(primary());
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Try Outlook Again' })).toBeDisabled();
    passTheBurst();
    expect(screen.getByRole('button', { name: 'Try Outlook Again' })).toBeEnabled();
  });
});

describe('ReturnRequestAction: pop-up blocked', () => {
  it('shows the panel, navigates to mailto once, and records nothing', async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    const user = useBurstClock();
    renderAction();
    await user.click(primary());
    expect(await screen.findByText('Outlook could not be opened automatically.', { selector: 'p' })).toBeInTheDocument();
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(String(assignSpy.mock.calls[0]![0])).toMatch(/^mailto:intake@warehouse\.test\?cc=copy%40warehouse\.test/);
    expect(recordAction).not.toHaveBeenCalled();
    passTheBurst();
    await user.click(screen.getByRole('button', { name: 'Try Outlook Again' }));
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(recordAction).not.toHaveBeenCalled();
    expect(screen.getByTestId('return-request-live')).not.toHaveTextContent(RETURN_REQUEST_COPY.success);
  });

  it('a later press that does open is recorded, and the panel goes', async () => {
    openSpy.mockReturnValueOnce(null as unknown as Window);
    const user = useBurstClock();
    renderAction();
    await user.click(primary());
    passTheBurst();
    await user.click(screen.getByRole('button', { name: 'Try Outlook Again' }));
    await waitFor(() => expect(recordAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Outlook could not be opened automatically.', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('a window.open that throws is treated as blocked', async () => {
    openSpy.mockImplementation(() => {
      throw new Error('denied');
    });
    renderAction();
    await userEvent.click(primary());
    expect(await screen.findByText('Outlook could not be opened automatically.', { selector: 'p' })).toBeInTheDocument();
    expect(recordAction).not.toHaveBeenCalled();
  });
});

describe('ReturnRequestAction: length', () => {
  it('a long return opens shortened, says so, and records is_condensed', async () => {
    renderAction({ content: LONG });
    expect(screen.getByText(RETURN_REQUEST_COPY.condensed)).toBeInTheDocument();
    await userEvent.click(primary());
    expect(String(openSpy.mock.calls[0]![0]).length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    await waitFor(() =>
      expect(recordAction).toHaveBeenCalledWith(expect.objectContaining({ isCondensed: true })),
    );
  });

  it('a draft too long even shortened opens nothing, offers no mail app button, and keeps Copy details', async () => {
    renderAction({ content: OVERSIZED });
    expect(screen.getByText(RETURN_REQUEST_COPY.oversized)).toBeInTheDocument();
    expect(primary()).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Open in Default Email App' })).not.toBeInTheDocument();
    await userEvent.click(primary());
    expect(openSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeEnabled();
  });
});

describe('ReturnRequestAction: copy and the mail app', () => {
  it('copies the complete message, both mailboxes included, and says where to paste it', async () => {
    renderAction({ content: LONG });
    await userEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    const write = vi.mocked(navigator.clipboard.writeText);
    expect(write).toHaveBeenCalledTimes(1);
    const text = String(write.mock.calls[0]![0]);
    expect(text).toContain('TO: intake@warehouse.test');
    expect(text).toContain('CC: copy@warehouse.test');
    expect(text).toContain('Uniform piece number 60, XL ×3 (SKU UNI-60)');
    expect(screen.getByTestId('return-request-live')).toHaveTextContent(
      'Return request copied. Create a new email to intake@warehouse.test, CC copy@warehouse.test, and paste the copied details.',
    );
    expect(recordAction).not.toHaveBeenCalled();
  });

  it('a refused clipboard shows the whole text to select by hand', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    const box = await screen.findByLabelText('Return request text to copy manually');
    expect((box as HTMLTextAreaElement).value).toContain('Return: RMA-20261110-AB12CD');
  });

  it('Open in Default Email App navigates to the mailto and records nothing', async () => {
    renderAction();
    await userEvent.click(screen.getByRole('button', { name: 'Open in Default Email App' }));
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(String(assignSpy.mock.calls[0]![0])).toMatch(/^mailto:intake@warehouse\.test\?/);
    expect(recordAction).not.toHaveBeenCalled();
  });
});

describe('ReturnRequestAction: what it shows and says', () => {
  it('names both mailboxes and shows the message before anything opens', () => {
    renderAction();
    expect(screen.getByTestId('return-request-recipients')).toHaveTextContent(
      'This request will be emailed to intake@warehouse.test. A copy will also be sent to copy@warehouse.test.',
    );
    const preview = screen.getByTestId('return-request-preview');
    expect(preview).toHaveTextContent('Return: RMA-20261110-AB12CD');
    expect(preview).toHaveTextContent('Reason: Damaged');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('always says it opens a draft, does not send and does not create a ticket', () => {
    renderAction();
    expect(screen.getByTestId('return-request-notice')).toHaveTextContent(RETURN_REQUEST_COPY.honesty);
  });

  it('never claims a ticket, a send or a notification, in any state', async () => {
    const banned = ['Ticket created', 'Request submitted', 'Email sent', 'has been sent', 'was sent'];
    const sweep = () => {
      for (const b of banned) expect(document.body.textContent).not.toContain(b);
      expect(document.body.textContent).not.toMatch(/\b[A-Z][a-z]+ notified\b/);
    };
    const first = renderAction();
    await userEvent.click(primary());
    sweep();
    first.unmount();
    openSpy.mockReturnValue(null as unknown as Window);
    const second = renderAction();
    await userEvent.click(primary());
    sweep();
    second.unmount();
    renderAction({ content: OVERSIZED });
    sweep();
  });

  it('renders nothing, and reports it, for a mailbox the factory refuses', () => {
    const { container } = renderAction({ recipients: { to: 'not-an-address', cc: 'copy@warehouse.test' } });
    expect(container).toBeEmptyDOMElement();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe('SendReturnRequestButton', () => {
  const button = () => screen.queryByRole('button', { name: 'Send return request' });

  it('offers the dialog for an open return with a resolved mailbox pair', async () => {
    render(<SendReturnRequestButton orderId={ORDER} surface="return" content={CONTENT} recipients={ROUTING} />);
    await userEvent.click(button()!);
    expect(await screen.findByRole('dialog', { name: 'Send return request' })).toBeInTheDocument();
    expect(primary()).toBeInTheDocument();
    // The dialog header carries the Liquid Glass hook its sibling carries.
    expect(document.querySelector('[data-glass="dialog-header"]')).not.toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('renders nothing with no mailbox pair, with no content, or once the return is closed, denied or cancelled', () => {
    const cases: Array<[ReturnRequestEmailContent | null, typeof ROUTING | null]> = [
      [CONTENT, null],
      [null, ROUTING],
      [{ ...CONTENT, status: 'closed' }, ROUTING],
      [{ ...CONTENT, status: 'denied' }, ROUTING],
      [{ ...CONTENT, status: 'cancelled' }, ROUTING],
    ];
    for (const [content, recipients] of cases) {
      const { container, unmount } = render(
        <SendReturnRequestButton orderId={ORDER} surface="order" content={content} recipients={recipients} />,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('is offered while the return is requested, approved or received', () => {
    for (const status of ['requested', 'approved', 'received']) {
      const { unmount } = render(
        <SendReturnRequestButton orderId={ORDER} surface="order" content={{ ...CONTENT, status }} recipients={ROUTING} />,
      );
      expect(button(), status).toBeInTheDocument();
      unmount();
    }
  });
});
