import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryRequestInput } from './storefront-logic';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import DeliveryRequestAction from './delivery-request-action';

function makeInput(overrides: Partial<DeliveryRequestInput> = {}): DeliveryRequestInput {
  return {
    orderId: 'b3f1c2d4-1111-2222-3333-444455556666',
    orderNumber: 49,
    orderUrlBase: 'https://app.stockpilotusa.com',
    fulfillmentType: 'delivery',
    warehouseName: 'DC4',
    destination: {
      id: 'ch-1',
      name: 'CVW Clovis',
      code: 'CVW-CLO',
      address: {
        line1: '1295 Shaw Ave',
        city: 'Fresno',
        region: 'California',
        postalCode: '93612',
        country: 'United States',
      },
    },
    requestedFor: 'Branden Vincent-Walker',
    requesterEmail: 'branden@cvwest.org',
    neededByLocal: '2026-08-05T09:00',
    orgTimezone: 'America/Los_Angeles',
    notes: 'Please stage these by Friday.',
    lines: [{ itemId: 'i-1', quantity: 5 }],
    itemMap: new Map([
      [
        'i-1',
        {
          id: 'i-1',
          sku: 'APP-POLO-W',
          name: "L4L Polo (Women's)",
          warehouseId: 'wh-1',
          quantityOnHand: 10,
          reservedQuantity: 0,
          itemType: null,
          categoryId: null,
          categoryName: null,
          charterId: null,
          charterName: null,
          charterCode: null,
          rackLabel: null,
          imageUrl: null,
          lqip: null,
          price: null,
          reorderPoint: 0,
        },
      ],
    ]),
    ...overrides,
  };
}

/**
 * A window.open spy that behaves like a successful open.
 *
 * The implementation takes a rest param rather than the brief's literal
 * `() => returns` so `Parameters<typeof open>` is `unknown[]`, not `[]`.
 * With `noUncheckedIndexedAccess` on, a zero-arg mock's `mock.calls[0]` is
 * an empty tuple and `mock.calls[0]![0]` fails to typecheck (TS2493) — the
 * assertions below need to read the URL and the `_blank`/`noopener` args
 * window.open was actually called with.
 */
function stubOpen(returns: unknown = { focus: vi.fn() }) {
  const open = vi.fn((..._args: unknown[]) => returns);
  vi.stubGlobal('open', open);
  return open;
}

/** The house clipboard idiom — copied per test file, not shared (mfa-recovery-codes.test.tsx:60-88). */
function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

/**
 * `window.location` is not writable in happy-dom and `vi.stubGlobal('location', ...)`
 * does not reliably replace it, so the same defineProperty idiom is used here.
 */
function stubLocationAssign(assign = vi.fn()) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign },
    configurable: true,
    writable: true,
  });
  return assign;
}

// Captured once, before any test has had a chance to overwrite either
// property with Object.defineProperty. Both stub helpers above replace an
// OWN property on `navigator`/`window`; vi.unstubAllGlobals() only undoes
// vi.stubGlobal(), so those own-property overrides otherwise survive into
// the next test — a later describe block with no clipboard/location stub of
// its own would see whatever the previous test last defined.
const ORIGINAL_CLIPBOARD_DESCRIPTOR = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const ORIGINAL_LOCATION_DESCRIPTOR = Object.getOwnPropertyDescriptor(window, 'location');

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  if (ORIGINAL_CLIPBOARD_DESCRIPTOR) {
    Object.defineProperty(navigator, 'clipboard', ORIGINAL_CLIPBOARD_DESCRIPTOR);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  if (ORIGINAL_LOCATION_DESCRIPTOR) {
    Object.defineProperty(window, 'location', ORIGINAL_LOCATION_DESCRIPTOR);
  } else {
    Reflect.deleteProperty(window, 'location');
  }
});

describe('DeliveryRequestAction — the primary Outlook path', () => {
  it('renders a button that says what it does without claiming a ticket', () => {
    render(<DeliveryRequestAction input={makeInput()} />);
    const btn = screen.getByRole('button', { name: /Email delivery request/i });
    expect(btn).toBeInTheDocument();
    expect(btn.textContent?.toLowerCase()).not.toContain('ticket');
    expect(btn.textContent?.toLowerCase()).not.toContain('send');
  });

  it('opens the Outlook compose URL with BOTH recipients on click', async () => {
    const user = userEvent.setup();
    const open = stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    expect(open).toHaveBeenCalledTimes(1);
    const url = new URL(open.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://outlook.office.com/mail/deeplink/compose');
    expect(url.searchParams.get('to')).toBe('dc4@learn4life.org');
    expect(url.searchParams.get('cc')).toBe('arosas@cvwest.org');
    expect(url.searchParams.get('subject')).toContain('SO-000049');
    expect(url.searchParams.get('body')).toContain('CVW Clovis');
  });

  it('opens in a new tab with NO features string, and severs the opener itself', async () => {
    // Per the HTML spec, window.open(url, '_blank', 'noopener,noreferrer')
    // returns null EVEN ON SUCCESS — the opener relationship is severed
    // before the handle is returned, which is indistinguishable from a
    // blocked popup. So the features string must be absent (locking that
    // nobody reintroduces 'noopener' there), and the opener-severing must
    // happen on the handle the component itself gets back.
    const user = userEvent.setup();
    const handle: { focus: () => void; opener: unknown } = { focus: vi.fn(), opener: {} };
    const open = stubOpen(handle);

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    expect(open.mock.calls[0]![1]).toBe('_blank');
    expect(open.mock.calls[0]![2]).toBeUndefined();
    expect(handle.opener).toBeNull();
  });

  it('does not show the fallback panel or navigate to mailto on a successful open', async () => {
    const user = userEvent.setup();
    stubOpen();
    const assign = stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('delivery-request-fallback')).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('confirms a DRAFT was opened, never that anything was sent', async () => {
    const user = userEvent.setup();
    stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    const msg = String(toastSuccess.mock.calls[0]![0]).toLowerCase();
    expect(msg).toContain('draft');
    expect(msg).not.toContain('sent');
    expect(msg).not.toContain('ticket');
  });

  it('R3: nothing side-effecting runs before window.open itself', async () => {
    // The assertion lives INSIDE the open() implementation, so it runs at
    // the exact moment the click handler calls window.open — pinning that
    // the success toast (the handler's only other observable side effect on
    // this path) cannot have fired yet, no matter how the handler is
    // reordered later.
    const user = userEvent.setup();
    const open = vi.fn(() => {
      expect(toastSuccess).not.toHaveBeenCalled();
      return { focus: vi.fn() };
    });
    vi.stubGlobal('open', open);

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    expect(open).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
  });
});

describe('DeliveryRequestAction — popup blocked', () => {
  it('falls back to mailto when window.open returns null', async () => {
    const user = userEvent.setup();
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const assign = stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    const mailto = String(assign.mock.calls[0]![0]);
    expect(mailto.startsWith('mailto:dc4@learn4life.org?')).toBe(true);
    const params = new URLSearchParams(mailto.slice(mailto.indexOf('?') + 1));
    expect(params.get('cc')).toBe('arosas@cvwest.org');
  });

  it('surfaces the copy fallback and NAMES BOTH recipients in the instructions', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    const fallback = await screen.findByTestId('delivery-request-fallback');
    expect(fallback).toHaveTextContent('dc4@learn4life.org');
    expect(fallback).toHaveTextContent('arosas@cvwest.org');
    expect(fallback).toHaveTextContent(
      'Outlook did not open — your browser may have blocked the popup.',
    );
    // The blocked-open path never measured link length, so it must not
    // blame that — that copy belongs only to the oversized-draft branch.
    expect(fallback).not.toHaveTextContent(/too long to prefill/i);
    expect(screen.getByRole('button', { name: /Copy the details/i })).toBeInTheDocument();
  });

  it('also falls back when window.open throws', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => {
      throw new Error('blocked');
    }));
    const assign = stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(String(assign.mock.calls[0]![0]).startsWith('mailto:')).toBe(true);
  });

  it('only navigates to mailto ONCE across repeated blocked clicks, though the panel stays up', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    const assign = stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    const btn = screen.getByRole('button', { name: /Email delivery request/i });
    await user.click(btn);
    await user.click(btn);

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('delivery-request-fallback')).toBeInTheDocument();
  });

  it('does not count a second blocked click as a draft — only the click that actually navigates counts', async () => {
    // Finding 2: after the first blocked click, mailtoAttemptedRef suppresses
    // the navigation, so a second blocked click cannot produce a draft. Only
    // one countable draft means the repeat warning must not appear yet.
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    const assign = stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    const btn = screen.getByRole('button', { name: /Email delivery request/i });
    await user.click(btn);
    await user.click(btn);

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('delivery-request-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('delivery-request-repeat')).toBeNull();
  });

  it('clears the stale failure panel and fires the success toast when a blocked click is followed by a successful one', async () => {
    const user = userEvent.setup();
    const open = vi.fn((..._args: unknown[]): Window | null => null);
    vi.stubGlobal('open', open);
    stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    const btn = screen.getByRole('button', { name: /Email delivery request/i });
    await user.click(btn);
    expect(await screen.findByTestId('delivery-request-fallback')).toBeInTheDocument();

    open.mockImplementation(() => ({ focus: vi.fn() }) as unknown as Window);
    await user.click(btn);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('delivery-request-fallback')).not.toBeInTheDocument();
  });

  it('counts a blocked click followed by a successful open as two countable drafts, and shows the repeat warning', async () => {
    // Finding 2: the blocked click that actually navigates to mailto: counts
    // as one draft; the subsequent successful open counts as a second. Two
    // countable drafts should surface the repeat warning.
    const user = userEvent.setup();
    const open = vi.fn((..._args: unknown[]): Window | null => null);
    vi.stubGlobal('open', open);
    stubLocationAssign();

    render(<DeliveryRequestAction input={makeInput()} />);
    const btn = screen.getByRole('button', { name: /Email delivery request/i });
    await user.click(btn);
    expect(await screen.findByTestId('delivery-request-fallback')).toBeInTheDocument();

    open.mockImplementation(() => ({ focus: vi.fn() }) as unknown as Window);
    await user.click(btn);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('delivery-request-repeat')).toBeInTheDocument();
  });
});

describe('DeliveryRequestAction — clipboard fallback', () => {
  it('copies TO, CC, SUBJECT and MESSAGE blocks', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();
    const writeText = stubClipboard();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(await screen.findByRole('button', { name: /Copy the details/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]![0]);
    expect(copied).toContain('TO: dc4@learn4life.org');
    expect(copied).toContain('CC: arosas@cvwest.org');
    expect(copied).toContain('SUBJECT: Delivery Request — StockPilot Order SO-000049');
    expect(copied).toContain('MESSAGE:');
  });

  it('post-copy instructions name BOTH recipients', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();
    stubClipboard();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(await screen.findByRole('button', { name: /Copy the details/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const msg = String(toastSuccess.mock.calls.at(-1)![0]);
    expect(msg).toBe(
      'Delivery request copied. Create a new email to dc4@learn4life.org, CC arosas@cvwest.org, and paste the copied details.',
    );
  });

  it('shows a SELECTABLE textarea carrying both recipients when the clipboard is denied', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(await screen.findByRole('button', { name: /Copy the details/i }));

    const box = await screen.findByLabelText(/Delivery request text to copy manually/i);
    expect((box as HTMLTextAreaElement).value).toContain('TO: dc4@learn4life.org');
    expect((box as HTMLTextAreaElement).value).toContain('CC: arosas@cvwest.org');
    expect(toastError).toHaveBeenCalled();
  });

  it('handles a browser with no navigator.clipboard at all', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn(() => null));
    stubLocationAssign();
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(await screen.findByRole('button', { name: /Copy the details/i }));

    expect(await screen.findByLabelText(/Delivery request text to copy manually/i)).toBeInTheDocument();
  });
});

describe('DeliveryRequestAction — link too long even condensed (linkFits=false)', () => {
  it('opens nothing at all and goes straight to the fallback when even the condensed link exceeds the URL limit', async () => {
    const user = userEvent.setup();
    const open = stubOpen();
    const assign = stubLocationAssign();

    render(
      <DeliveryRequestAction
        input={makeInput({ warehouseName: 'W'.repeat(3000), destination: null })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    expect(open).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    const fallback = await screen.findByTestId('delivery-request-fallback');
    expect(fallback).toHaveTextContent('dc4@learn4life.org');
    expect(fallback).toHaveTextContent('arosas@cvwest.org');
    // The oversized-draft path never touched a popup, so it must not blame
    // one — that copy belongs only to the blocked-open branch.
    expect(fallback).toHaveTextContent(
      "This order's details are too long to prefill into a mail link safely.",
    );
    expect(fallback).not.toHaveTextContent(/blocked the popup/i);
    // Nothing "succeeded" here — the draft was never opened, so the success
    // toast (reserved for an actual Outlook open) must not fire.
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('DeliveryRequestAction — pickup orders (owner decision D1)', () => {
  it('renders for pickup orders too', () => {
    render(<DeliveryRequestAction input={makeInput({ fulfillmentType: 'pickup', destination: null })} />);
    expect(screen.getByRole('button', { name: /Email delivery request/i })).toBeInTheDocument();
  });

  it('opens a body with the pickup handoff and NO destination block', async () => {
    const user = userEvent.setup();
    const open = stubOpen();

    render(<DeliveryRequestAction input={makeInput({ fulfillmentType: 'pickup', destination: null })} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    const body = new URL(open.mock.calls[0]![0] as string).searchParams.get('body') ?? '';
    expect(body).toContain('Pickup / will-call');
    expect(body).toContain('PICKUP FROM');
    expect(body).toContain('COLLECTED BY');
    expect(body).not.toContain('DELIVERY DESTINATION');
  });
});

describe('DeliveryRequestAction — no duplicate order, ever', () => {
  it('never calls a create action — the order is already persisted', async () => {
    const user = userEvent.setup();
    stubOpen();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<DeliveryRequestAction input={makeInput()} />);
    const btn = screen.getByRole('button', { name: /Email delivery request/i });
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('DeliveryRequestAction — test isolation (no stub leakage across describes)', () => {
  it('does not leak a previous test\'s navigator.clipboard/window.location stub into a fresh test', () => {
    // Deliberately does NOT call stubClipboard()/stubLocationAssign(). Many
    // earlier tests in this file replace both with Object.defineProperty,
    // which vi.unstubAllGlobals() (used in beforeEach) does NOT undo — only
    // vi.stubGlobal() stubs are undone by it. If beforeEach doesn't also
    // restore these two own-property overrides, whichever test ran last
    // leaves its stub installed for every test after it, this one included.
    expect(Object.getOwnPropertyDescriptor(navigator, 'clipboard')).toEqual(
      ORIGINAL_CLIPBOARD_DESCRIPTOR,
    );
    expect(Object.getOwnPropertyDescriptor(window, 'location')).toEqual(
      ORIGINAL_LOCATION_DESCRIPTOR,
    );
  });
});

describe('DeliveryRequestAction — preview dialog', () => {
  it('opens from a Preview control and shows the subject and body', async () => {
    const user = userEvent.setup();
    render(<DeliveryRequestAction input={makeInput()} />);

    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delivery Request — StockPilot Order SO-000049');
    expect(dialog).toHaveTextContent('CVW Clovis');
    expect(dialog).toHaveTextContent('1295 Shaw Ave');
  });

  it('shows BOTH recipients under an EMAIL RECIPIENTS heading', async () => {
    const user = userEvent.setup();
    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('EMAIL RECIPIENTS');
    expect(dialog).toHaveTextContent('dc4@learn4life.org');
    expect(dialog).toHaveTextContent('arosas@cvwest.org');
  });

  it('carries the exact CC helper text and never claims assignment', async () => {
    const user = userEvent.setup();
    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      'The DC4 address creates the delivery-request ticket. A copy will also be sent to arosas@cvwest.org.',
    );
    expect(dialog.textContent?.toLowerCase()).not.toContain('assigned to');
  });

  it('renders the recipients as TEXT — no input, no editable field, no way to change them', async () => {
    const user = userEvent.setup();
    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    // The only form control in the dialog is the read-only body preview.
    const editable = Array.from(dialog.querySelectorAll('input, select, [contenteditable="true"]'));
    expect(editable).toHaveLength(0);
    for (const ta of Array.from(dialog.querySelectorAll('textarea'))) {
      expect(ta).toHaveAttribute('readonly');
    }
  });

  it('opens Outlook from inside the dialog, with both recipients intact', async () => {
    const user = userEvent.setup();
    const open = stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /Open in Outlook/i }));

    const url = new URL(open.mock.calls[0]![0] as string);
    expect(url.searchParams.get('to')).toBe('dc4@learn4life.org');
    expect(url.searchParams.get('cc')).toBe('arosas@cvwest.org');
  });

  it('offers copy from inside the dialog, copying both recipients', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /Copy the details/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]![0])).toContain('CC: arosas@cvwest.org');
  });

  it('shows the pickup body for a pickup order, with no destination', async () => {
    const user = userEvent.setup();
    render(<DeliveryRequestAction input={makeInput({ fulfillmentType: 'pickup', destination: null })} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('PICKUP FROM');
    expect(dialog).not.toHaveTextContent('DELIVERY DESTINATION');
  });

  it('discloses condensation in the preview when the order is large', async () => {
    const user = userEvent.setup();
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `b-${i}`, quantity: 4 }));
    const itemMap = new Map(
      lines.map((l, i) => [
        l.itemId,
        { ...makeInput().itemMap.get('i-1')!, id: l.itemId, sku: `SKU-${i}`, name: `Bulk Item ${i}` },
      ]),
    );

    render(<DeliveryRequestAction input={makeInput({ lines, itemMap })} />);
    await user.click(screen.getByRole('button', { name: /Preview/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This message was shortened');
  });
});

describe('DeliveryRequestAction — honesty', () => {
  it('states plainly that this does not create a ticket, before any click', () => {
    render(<DeliveryRequestAction input={makeInput()} />);
    const notice = screen.getByTestId('delivery-request-notice');
    expect(notice).toHaveTextContent(
      'This opens a draft email. StockPilot does not send it and does not create a ticket. Review the message and press Send in your mail app.',
    );
  });

  it('never uses ticket-created language anywhere in the rendered surface', () => {
    const { container } = render(<DeliveryRequestAction input={makeInput()} />);
    const text = (container.textContent ?? '').toLowerCase();
    for (const claim of [
      'ticket created',
      'ticket submitted',
      'ticket has been',
      'request submitted to dc4',
      'assigned to',
      'we have sent',
      'email sent',
    ]) {
      expect(text).not.toContain(claim);
    }
  });

  it('warns on a REPEATED draft without blocking it', async () => {
    const user = userEvent.setup();
    stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    const btn = screen.getByRole('button', { name: /Email delivery request/i });

    await user.click(btn);
    expect(screen.queryByTestId('delivery-request-repeat')).toBeNull();

    await user.click(btn);
    const repeat = await screen.findByTestId('delivery-request-repeat');
    expect(repeat).toHaveTextContent(
      'You have already opened a draft for this order. Sending more than one creates duplicate requests for DC4.',
    );
    // Still allowed — the first draft may have been closed by accident.
    expect(btn).toBeEnabled();
  });

  it('counts every draft, including ones opened from the preview dialog', async () => {
    const user = userEvent.setup();
    stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(screen.getByRole('button', { name: /Preview/i }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /Open in Outlook/i }));

    expect(await screen.findByTestId('delivery-request-repeat')).toBeInTheDocument();
  });

  it('DISCLOSES truncation on the surface when the order was too large for a link', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `b-${i}`, quantity: 4 }));
    const base = makeInput().itemMap.get('i-1')!;
    const itemMap = new Map(
      lines.map((l, i) => [l.itemId, { ...base, id: l.itemId, sku: `SKU-${i}`, name: `Bulk Item ${i}` }]),
    );

    render(<DeliveryRequestAction input={makeInput({ lines, itemMap })} />);
    expect(screen.getByTestId('delivery-request-condensed')).toHaveTextContent(
      'This order is too large to fit in a compose link, so the draft carries a summary and a link to the full order. Copy the details instead to include every line.',
    );
  });

  it('shows no truncation disclosure for a normal order', () => {
    render(<DeliveryRequestAction input={makeInput()} />);
    expect(screen.queryByTestId('delivery-request-condensed')).toBeNull();
  });

  it('the repeat warning survives a re-render and does not reset the count', async () => {
    const user = userEvent.setup();
    stubOpen();

    const { rerender } = render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    rerender(<DeliveryRequestAction input={makeInput()} />);

    expect(await screen.findByTestId('delivery-request-repeat')).toBeInTheDocument();
  });
});

describe('DeliveryRequestAction — preview honesty (Task 7 review rider)', () => {
  it('an oversized draft opened from the PREVIEW dialog never calls window.open or location.assign, closes the dialog, and shows the too-long panel, not the popup-blocked one', async () => {
    const user = userEvent.setup();
    const open = stubOpen();
    const assign = stubLocationAssign();

    render(
      <DeliveryRequestAction
        input={makeInput({ warehouseName: 'W'.repeat(3000), destination: null })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Preview/i }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /Open in Outlook/i }));

    expect(open).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const fallback = await screen.findByTestId('delivery-request-fallback');
    expect(fallback).toHaveTextContent(
      "This order's details are too long to prefill into a mail link safely.",
    );
    expect(fallback).not.toHaveTextContent(/blocked the popup/i);
  });

  it('shows the linkFits-aware disclosure — never the "carries a summary and a link" claim — both before the click and while the oversized panel is visible', async () => {
    // Finding 1: when even the condensed links don't fit, the static
    // disclosure must not contradict the oversized panel that appears after
    // a click. Both must agree that nothing can be prefilled safely.
    const user = userEvent.setup();
    stubOpen();
    stubLocationAssign();

    render(
      <DeliveryRequestAction
        input={makeInput({ warehouseName: 'W'.repeat(3000), destination: null })}
      />,
    );

    const before = screen.getByTestId('delivery-request-condensed');
    expect(before).toHaveTextContent(
      'This order is too large for a prefilled email link. Use Copy the details to include every line.',
    );
    expect(before).not.toHaveTextContent(/carries a summary and a link/i);

    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));
    await screen.findByTestId('delivery-request-fallback');

    const after = screen.getByTestId('delivery-request-condensed');
    expect(after).toHaveTextContent(
      'This order is too large for a prefilled email link. Use Copy the details to include every line.',
    );
    expect(after).not.toHaveTextContent(/carries a summary and a link/i);
  });
});
