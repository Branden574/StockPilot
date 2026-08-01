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

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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

  it('opens in a new tab with noopener', async () => {
    const user = userEvent.setup();
    const open = stubOpen();

    render(<DeliveryRequestAction input={makeInput()} />);
    await user.click(screen.getByRole('button', { name: /Email delivery request/i }));

    expect(open.mock.calls[0]![1]).toBe('_blank');
    expect(String(open.mock.calls[0]![2])).toContain('noopener');
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
