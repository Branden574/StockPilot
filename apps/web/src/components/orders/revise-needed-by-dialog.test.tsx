import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NEEDED_BY_IN_PAST_COPY,
  NEEDED_BY_NO_ANSWER_COPY,
  NEEDED_BY_REASON_REQUIRED_COPY,
  neededByRevisedCopy,
  type NeededByRevisionOutcome,
} from '@stockpilot/core';

import type { NeededByChangeView } from '@/lib/orders/needed-by-change';

/**
 * F2-4: the web dialog that changes an order's needed-by date. The server
 * action is a recording stub (its own mapping is pinned in
 * order-requests.needed-by.test.ts); what this file pins is what the dialog
 * SENDS (the wall clock as typed, the needed-by exactly as the page read it,
 * the reason) and what it SAYS (core's words, in the org's zone, never the
 * runtime's), and that a refusal keeps what was typed.
 */

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), prefetch: vi.fn() }),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
const reviseAction = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/order-requests', () => ({
  reviseOrderNeededByAction: (input: unknown) => reviseAction(input),
}));

import { ReviseNeededByDialog } from './revise-needed-by-dialog';

const ORDER = '11111111-1111-1111-1111-111111111111';
// 10:00 AM on Tue Sep 29 in Los Angeles; 1:00 PM in New York.
const NOW = Date.parse('2026-09-29T17:00:00Z');
// Exactly as PostgREST prints a timestamptz, microseconds included: 2:00 PM
// in New York on Thu Oct 1.
const ON_PAGE = '2026-10-01T18:00:00.123456+00:00';

function view(over: Partial<NeededByChangeView> = {}): NeededByChangeView {
  return {
    orderId: ORDER,
    neededBy: ON_PAGE,
    status: 'approved',
    timeZone: 'America/New_York',
    rowLabel: 'Needed by Thu, Oct 1, 2:00 PM',
    ...over,
  };
}

function outcome(over: Partial<NeededByRevisionOutcome> = {}): NeededByRevisionOutcome {
  return {
    changed: true,
    previous: '2026-10-01T18:00:00.123Z',
    neededBy: '2026-10-03T18:00:00.000Z',
    eventId: 'ev-1',
    eventUpdated: true,
    status: 'approved',
    schedule: 'moved',
    timeZone: 'America/New_York',
    ...over,
  };
}

const runtimeZone = process.env.TZ;
beforeEach(() => {
  // The runtime's zone is neither the org's nor UTC: every time the dialog
  // shows or reads must be the org's anyway.
  process.env.TZ = 'Asia/Tokyo';
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  routerRefresh.mockReset();
  reviseAction.mockReset();
  for (const f of Object.values(toastMock)) f.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (runtimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = runtimeZone;
});

function openDialog(v: NeededByChangeView = view()) {
  const utils = render(<ReviseNeededByDialog change={v} />);
  fireEvent.click(screen.getByRole('button', { name: 'Change needed-by date' }));
  const dialog = screen.getByRole('dialog');
  return { ...utils, dialog };
}

const field = () => screen.getByLabelText('New needed-by date and time') as HTMLInputElement;
const reasonBox = () => screen.getByLabelText('Reason') as HTMLTextAreaElement;
const typeDate = (value: string) => fireEvent.change(field(), { target: { value } });
const typeReason = (value: string) => fireEvent.change(reasonBox(), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save date' }));

describe('ReviseNeededByDialog: the entry', () => {
  it('is a "Change" button named for what it changes; nothing is asked of the server until Save', () => {
    render(<ReviseNeededByDialog change={view()} />);
    const button = screen.getByRole('button', { name: 'Change needed-by date' });
    expect(button).toHaveTextContent('Change');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(reviseAction).not.toHaveBeenCalled();
  });
});

describe('ReviseNeededByDialog: what it shows, in the org zone', () => {
  it("names the org's zone, the date being replaced, and starts the field at it as a wall clock there", () => {
    const { dialog } = openDialog();
    expect(within(dialog).getByRole('heading', { name: 'Change needed-by date' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('revise-needed-by-current')).toHaveTextContent(
      'Current needed-by: Thu, Oct 1, 2:00 PM',
    );
    expect(within(dialog).getByTestId('revise-needed-by-zone')).toHaveTextContent(
      'Times are in America/New_York.',
    );
    // 18:00Z read in New York, not in Tokyo (03:00 the next day) or UTC.
    expect(field().value).toBe('2026-10-01T14:00');
    expect(field()).toHaveAttribute('type', 'datetime-local');
    // The earliest offered is now, in New York.
    expect(field()).toHaveAttribute('min', '2026-09-29T13:00');
    expect(field()).toHaveAccessibleDescription(/Times are in America\/New_York\./);
  });

  it('previews the typed wall clock read in the org zone: "New needed-by: Sat, Oct 3, 2:00 PM"', () => {
    openDialog();
    typeDate('2026-10-03T14:00');
    expect(screen.getByTestId('revise-needed-by-preview')).toHaveTextContent('New needed-by: Sat, Oct 3, 2:00 PM');
  });

  it('an order with no date says so, and the field starts empty; so does one whose date has passed', () => {
    const { unmount } = openDialog(view({ neededBy: null, rowLabel: 'No needed-by date' }));
    expect(screen.getByTestId('revise-needed-by-current')).toHaveTextContent('This order has no needed-by date yet.');
    expect(field().value).toBe('');
    unmount();
    openDialog(view({ neededBy: '2026-09-20T18:00:00+00:00' }));
    expect(screen.getByTestId('revise-needed-by-current')).toHaveTextContent(
      'Current needed-by: Sun, Sep 20, 2:00 PM',
    );
    expect(field().value).toBe('');
  });

  it("says what saving does to the Schedule entry, by the order's status", () => {
    const { unmount } = openDialog(view({ status: 'approved' }));
    expect(screen.getByTestId('revise-needed-by-effect')).toHaveTextContent(
      "The order's Schedule entry follows the new date, and its reminders are set for the new time.",
    );
    unmount();
    openDialog(view({ status: 'pending_approval' }));
    expect(screen.getByTestId('revise-needed-by-effect')).toHaveTextContent(
      'Approving the order puts it on the Schedule at this date.',
    );
  });

  it('a time that does not exist in the org zone (the spring-forward hour) is said before saving, and never sent', async () => {
    openDialog(view({ timeZone: 'America/Los_Angeles' }));
    typeDate('2027-03-14T02:30');
    expect(screen.getByTestId('revise-needed-by-preview')).toHaveTextContent(
      "That date and time don't exist in America/Los_Angeles. Pick another time.",
    );
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    typeReason('Moved');
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That date and time don't exist in America/Los_Angeles. Pick another time.",
    );
    expect(reviseAction).not.toHaveBeenCalled();
  });

  it('a time already past, or no time, is said and never sent', async () => {
    openDialog();
    typeDate('2026-09-29T12:00'); // noon in New York, an hour ago
    expect(screen.getByTestId('revise-needed-by-preview')).toHaveTextContent(NEEDED_BY_IN_PAST_COPY);
    typeReason('Moved');
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(NEEDED_BY_IN_PAST_COPY);
    typeDate('');
    save();
    expect(screen.getByRole('alert')).toHaveTextContent(NEEDED_BY_IN_PAST_COPY);
    expect(reviseAction).not.toHaveBeenCalled();
  });

  it('a reason is required: said inline, and the typed date is kept', async () => {
    openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('   ');
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(NEEDED_BY_REASON_REQUIRED_COPY);
    expect(field().value).toBe('2026-10-03T14:00');
    expect(reviseAction).not.toHaveBeenCalled();
  });
});

describe('ReviseNeededByDialog: saving', () => {
  it('sends the wall clock as typed, the needed-by EXACTLY as the page read it, and the reason; says what the server did; reads the page again', async () => {
    reviseAction.mockResolvedValue({ ok: true, data: outcome() });
    openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('The school pushed the event back');
    save();

    await waitFor(() => expect(reviseAction).toHaveBeenCalledTimes(1));
    expect(reviseAction).toHaveBeenCalledWith({
      id: ORDER,
      // Zone-less: the server converts it in the org's zone.
      neededByLocal: '2026-10-03T14:00',
      // Microseconds kept: a JS Date round trip would drop them and the stale
      // check would refuse this order forever.
      expectedNeededBy: ON_PAGE,
      reason: 'The school pushed the event back',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toastMock.success).toHaveBeenCalledWith(neededByRevisedCopy(outcome()));
    expect(toastMock.success.mock.calls[0]![0]).toBe(
      'Needed-by changed to Sat, Oct 3, 2:00 PM. The Schedule entry moved too, and its reminders are set for the new time.',
    );
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('an order with no date sends null as the date it started from', async () => {
    reviseAction.mockResolvedValue({ ok: true, data: outcome({ previous: null, schedule: 'created' }) });
    openDialog(view({ neededBy: null, rowLabel: 'No needed-by date' }));
    typeDate('2026-10-03T14:00');
    typeReason('First date');
    save();
    await waitFor(() => expect(reviseAction).toHaveBeenCalledTimes(1));
    expect(reviseAction.mock.calls[0]![0]).toMatchObject({ expectedNeededBy: null });
  });

  it('a Schedule entry that could not be updated is a warning; an unchanged date is said as such', async () => {
    reviseAction.mockResolvedValueOnce({ ok: true, data: outcome({ schedule: 'not_moved', eventUpdated: false }) });
    const { unmount } = openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('Moved');
    save();
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    expect(toastMock.warning.mock.calls[0]![0]).toContain("The Schedule entry couldn't be updated");
    expect(toastMock.success).not.toHaveBeenCalled();
    unmount();

    reviseAction.mockResolvedValueOnce({
      ok: true,
      data: outcome({ changed: false, schedule: 'unchanged', eventUpdated: false }),
    });
    openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('Same');
    save();
    await waitFor(() => expect(toastMock.info).toHaveBeenCalledTimes(1));
    expect(toastMock.info.mock.calls[0]![0]).toContain('Nothing changed.');
  });

  it("a refusal stays in the dialog, in the server's words, with the date and the reason kept (pattern #20)", async () => {
    reviseAction.mockResolvedValue({
      ok: false,
      error: {
        code: 'forbidden',
        message: "Changing this order's needed-by date needs write access to its warehouse.",
        details: { reason: 'forbidden' },
      },
    });
    openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('Pushed back');
    save();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Changing this order's needed-by date needs write access to its warehouse.");
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(field().value).toBe('2026-10-03T14:00');
    expect(reasonBox().value).toBe('Pushed back');
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('someone saved another date first: the dialog loads it, says so, reads the page again, and the next save replaces THAT date', async () => {
    const theirs = '2026-10-05T16:00:00.000Z'; // Mon Oct 5, 12:00 PM in New York
    reviseAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: 'Someone changed this date to Mon, Oct 5, 12:00 PM while you were editing.',
        details: { reason: 'needed_by_changed', current: theirs },
      },
    });
    openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('Pushed back');
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone changed this date to Mon, Oct 5, 12:00 PM while you were editing.',
    );
    expect(screen.getByTestId('revise-needed-by-current')).toHaveTextContent(
      'Current needed-by: Mon, Oct 5, 12:00 PM',
    );
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    // What was typed stays: saving again is a deliberate choice.
    expect(field().value).toBe('2026-10-03T14:00');
    expect(reasonBox().value).toBe('Pushed back');

    // Saved again before the page was read again: the value the server said.
    reviseAction.mockResolvedValueOnce({ ok: true, data: outcome({ previous: theirs }) });
    save();
    await waitFor(() => expect(reviseAction).toHaveBeenCalledTimes(2));
    expect(reviseAction.mock.calls[1]![0]).toMatchObject({ expectedNeededBy: theirs });
  });

  it("after a stale refusal and the page read again, the page's exact text of that date is sent", async () => {
    const theirsIso = '2026-10-05T16:00:00.123Z';
    const theirsOnPage = '2026-10-05T16:00:00.123456+00:00';
    reviseAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'conflict',
        message: 'Someone changed this date to Mon, Oct 5, 12:00 PM while you were editing.',
        details: { reason: 'needed_by_changed', current: theirsIso },
      },
    });
    const { rerender } = openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('Pushed back');
    save();
    await screen.findByRole('alert');

    rerender(<ReviseNeededByDialog change={view({ neededBy: theirsOnPage })} />);
    reviseAction.mockResolvedValueOnce({ ok: true, data: outcome({ previous: theirsIso }) });
    save();
    await waitFor(() => expect(reviseAction).toHaveBeenCalledTimes(2));
    expect(reviseAction.mock.calls[1]![0]).toMatchObject({ expectedNeededBy: theirsOnPage });
  });

  it("a refresh behind the open dialog never makes someone else's date the one this save replaces", async () => {
    reviseAction.mockResolvedValue({ ok: true, data: outcome() });
    const { rerender } = openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('Pushed back');
    // Realtime: another approver saved Oct 5 while this dialog was open.
    rerender(<ReviseNeededByDialog change={view({ neededBy: '2026-10-05T16:00:00+00:00' })} />);
    save();
    await waitFor(() => expect(reviseAction).toHaveBeenCalledTimes(1));
    // The date this person saw: the server's stale check refuses the save.
    expect(reviseAction.mock.calls[0]![0]).toMatchObject({ expectedNeededBy: ON_PAGE });
  });

  it('no answer at all: it may or may not have saved, so it says so and reads the page again', async () => {
    reviseAction.mockRejectedValue(new Error('network'));
    openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('Pushed back');
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(NEEDED_BY_NO_ANSWER_COPY);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(reasonBox().value).toBe('Pushed back');
  });

  it('the order closed meanwhile: its words, and the page is read again', async () => {
    reviseAction.mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message:
          "This order is closed (completed, denied, cancelled or not yet confirmed), so its needed-by date can't change.",
        details: { reason: 'order_closed', status: 'cancelled' },
      },
    });
    openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('Pushed back');
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('This order is closed');
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('a second Save while the first is in flight sends nothing more, and the dialog cannot be dismissed', async () => {
    let answer!: (v: unknown) => void;
    reviseAction.mockImplementation(() => new Promise((r) => (answer = r)));
    openDialog();
    typeDate('2026-10-03T14:00');
    typeReason('Pushed back');
    save();
    await waitFor(() => expect(reviseAction).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Save date' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    answer({ ok: true, data: outcome() });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(reviseAction).toHaveBeenCalledTimes(1);
  });
});
