import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { textActionTouchMarginTop, touchTargetClass } from '@/components/patterns/touch-target';
import { INTENT_DWELL_MS } from '@/components/ui/intent-link';
import { hydrateAcrossClockShift } from '@/test/hydration';

/**
 * A busy day on the team calendar (B46). A day cell draws its first three
 * events and then "+N more". That was a link to
 * /dashboard/schedule?m=YYYY-MM&day=YYYY-MM-DD, and the schedule page reads
 * only ?m=, so it drew the same month again: the fourth and later events of a
 * busy day could not be opened from the calendar. Its name was "+2 more" in
 * every busy cell, with no date.
 *
 * "+N more" is now a button that opens a list of every event that starts that
 * day (the events the page already passed, in its start order), each row
 * opening its event. The list is a Radix popover: Radix focuses its Close
 * button on open (the first tabbable that is not a link) and, when it closes,
 * returns focus to the button in a setTimeout(0), so every focus return below
 * is awaited (waitFor).
 *
 * No mock of the zone helpers here: the words are the real ones, in Los
 * Angeles (schedule-calendar.org-zone.test.tsx does the same), so the
 * hydration case can run in this file too.
 */

const { router, markNavigationIntent } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  markNavigationIntent: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/dashboard/schedule',
  useSearchParams: () => new URLSearchParams(),
}));
// The list's rows warm their route on intent (IntentLink -> useWarmRoute),
// which marks the intent before it prefetches.
vi.mock('@/lib/perf/marks', () => ({ markNavigationIntent }));

import { ScheduleCalendar } from './schedule-calendar';

const LOS_ANGELES = 'America/Los_Angeles';

type Status = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

const event = (id: string, title: string, startsAt: string, status: Status = 'scheduled') => ({
  id,
  title,
  startsAt,
  endsAt: null,
  allDay: false,
  status,
  locationText: null,
});

// July 2026's grid runs from Sun Jun 28 to Sat Aug 8. The events come in the
// page's order: listInRange reads them by start.
// Tue Jul 14, 8 AM to noon in Los Angeles: three chips and "+2 more".
const BUSY_DAY = [
  event('ev-1', 'Delivery 1', '2026-07-14T15:00:00Z', 'scheduled'),
  event('ev-2', 'Delivery 2', '2026-07-14T16:00:00Z', 'in_progress'),
  event('ev-3', 'Delivery 3', '2026-07-14T17:00:00Z', 'completed'),
  event('ev-4', 'Delivery 4', '2026-07-14T18:00:00Z', 'cancelled'),
  event('ev-5', 'Delivery 5', '2026-07-14T19:00:00Z', 'scheduled'),
];
/** What each Jul 14 row and chip says, in order: time, title, status word. */
const BUSY_DAY_WORDS = [
  '8:00 AM Delivery 1, Scheduled',
  '9:00 AM Delivery 2, In progress',
  '10:00 AM Delivery 3, Completed',
  '11:00 AM Delivery 4, Cancelled',
  '12:00 PM Delivery 5, Scheduled',
];
/**
 * The accessible name of a chip or a row that says `words`. happy-dom gives a
 * span no computed display, so the name computation (dom-accessibility-api)
 * takes each span for a block and puts a space around it ("Delivery 1 ,
 * Scheduled"), where a browser reads the inline spans as one line: that one
 * space is optional here. The exact words are pinned by textContent below.
 */
const nameOf = (words: string) => {
  const literal = words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${literal.replace(', ', '\\s?, ')}$`);
};
// Sat Aug 8: the grid's last cell (the Saturday column, the last row),
// outside the month. Three chips and "+1 more".
const LAST_DAY = [
  event('ev-6', 'Pickup 1', '2026-08-08T16:00:00Z'),
  event('ev-7', 'Pickup 2', '2026-08-08T17:00:00Z'),
  event('ev-8', 'Pickup 3', '2026-08-08T18:00:00Z'),
  event('ev-9', 'Pickup 4', '2026-08-08T19:00:00Z'),
];
// Mon Jul 20: exactly three, so no "more".
const THREE = [
  event('ev-10', 'Drop 1', '2026-07-20T16:00:00Z'),
  event('ev-11', 'Drop 2', '2026-07-20T17:00:00Z'),
  event('ev-12', 'Drop 3', '2026-07-20T18:00:00Z'),
];
const JULY = [...BUSY_DAY, ...THREE, ...LAST_DAY];

const BUSY_MORE = '2 more events on Tuesday, July 14';

function renderJuly(events = JULY) {
  const user = userEvent.setup();
  const view = render(
    <ScheduleCalendar
      year={2026}
      month={7}
      events={events}
      canManage
      timeZone={LOS_ANGELES}
      todayYmd={null}
    />,
  );
  return { user, ...view };
}

const cellOf = (ymd: string) =>
  screen.getByLabelText(`Add event on ${ymd}`).closest('.group') as HTMLElement;

const chipsOf = (ymd: string) =>
  Array.from(cellOf(ymd).querySelectorAll<HTMLAnchorElement>('a[data-status]'));

describe('"+N more" on a busy day of the team calendar', () => {
  it('is a button that names the day and how many more, and says it opens a dialog', () => {
    renderJuly();
    const more = screen.getByRole('button', { name: BUSY_MORE });
    expect(more).toHaveTextContent(/^\+2 more$/);
    expect(more).toHaveAttribute('type', 'button');
    expect(more).toHaveAttribute('aria-haspopup', 'dialog');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    // Only while open: the server HTML carries no id (see the hydration case).
    expect(more).not.toHaveAttribute('aria-controls');
  });

  it('says "event" for one more, on a day outside the month, and opens that day\'s own list', async () => {
    const { user } = renderJuly();
    const more = screen.getByRole('button', { name: '1 more event on Saturday, August 8' });
    expect(more).toHaveTextContent(/^\+1 more$/);
    await user.click(more);
    const dialog = await screen.findByRole('dialog', { name: 'Saturday, August 8' });
    expect(
      within(dialog)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(LAST_DAY.map((e) => `/dashboard/schedule/${e.id}`));
  });

  it('no link on the calendar sends ?day=, which no page reads', () => {
    const { container } = renderJuly();
    expect(container.querySelector('a[href*="day="]')).toBeNull();
  });

  it("opens a list of every event that starts that day, in start order, the cell's three chips first", async () => {
    const { user, container } = renderJuly();
    const more = screen.getByRole('button', { name: BUSY_MORE });
    await user.click(more);
    const dialog = await screen.findByRole('dialog', { name: 'Tuesday, July 14' });
    expect(within(dialog).getByText('5 events')).toBeInTheDocument();
    const list = within(dialog).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    const rows = within(list).getAllByRole('link');
    expect(rows.map((a) => a.getAttribute('href'))).toEqual(
      BUSY_DAY.map((e) => `/dashboard/schedule/${e.id}`),
    );
    rows.forEach((row, i) => expect(row).toHaveAccessibleName(nameOf(BUSY_DAY_WORDS[i]!)));
    const chips = chipsOf('2026-07-14');
    expect(chips).toHaveLength(3);
    chips.forEach((chip, i) => expect(chip).toHaveAccessibleName(nameOf(BUSY_DAY_WORDS[i]!)));
    // Open, the button points at the list.
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(dialog.id).not.toBe('');
    expect(more).toHaveAttribute('aria-controls', dialog.id);
    // Drawn outside the grid's sideways scroller, which would clip it.
    expect(cellOf('2026-07-14').contains(dialog)).toBe(false);
    expect(container.querySelector('.overflow-x-auto')!.contains(dialog)).toBe(false);
  });

  it('works from the keyboard: Enter opens it on Close, Tab reaches the events, Escape closes it and focus returns', async () => {
    const { user } = renderJuly();
    const more = screen.getByRole('button', { name: BUSY_MORE });
    act(() => more.focus());
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Tuesday, July 14' });
    // Radix 1.3.1 focuses the first tabbable that is not a link.
    const close = within(dialog).getByRole('button', { name: 'Close' });
    await waitFor(() => expect(close).toHaveFocus());
    await user.tab();
    expect(within(dialog).getAllByRole('link')[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(more).toHaveFocus());
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).not.toHaveAttribute('aria-controls');
  });

  it('Close closes the list and returns focus to "+2 more"', async () => {
    const { user } = renderJuly();
    const more = screen.getByRole('button', { name: BUSY_MORE });
    await user.click(more);
    const dialog = await screen.findByRole('dialog', { name: 'Tuesday, July 14' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(more).toHaveFocus());
  });

  it('lists all 30 events of a 30-event day in a list that scrolls inside a box held to the room on screen', async () => {
    const start = Date.parse('2026-07-14T14:00:00Z');
    const many = Array.from({ length: 30 }, (_, i) =>
      event(`ev-m${i + 1}`, `Delivery ${i + 1}`, new Date(start + i * 10 * 60_000).toISOString()),
    );
    const { user } = renderJuly(many);
    await user.click(screen.getByRole('button', { name: '27 more events on Tuesday, July 14' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tuesday, July 14' });
    expect(within(dialog).getByText('30 events')).toBeInTheDocument();
    const list = within(dialog).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
    expect(
      within(list)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(many.map((e) => `/dashboard/schedule/${e.id}`));
    expect(list).toHaveClass('min-h-0', 'overflow-y-auto');
    expect(dialog).toHaveClass('max-h-[min(24rem,var(--radix-popover-content-available-height))]');
  });

  // One set of words and tones for the cell's chip and the list's row
  // (recurring pattern 26): each keeps its own layout (the chip truncates to
  // one line with its title as a tooltip, the row wraps).
  it('each row says what its chip says, with plain spaces, in the same status tone', async () => {
    // Newer ICU (and Hermes) put a narrow no-break space before AM/PM; this
    // Node's ICU prints a plain one. Print times the newer way here, so the
    // plain-space checks below can fail.
    const toLocaleTimeString = Date.prototype.toLocaleTimeString;
    vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (
      this: Date,
      ...args: Parameters<Date['toLocaleTimeString']>
    ) {
      return toLocaleTimeString.apply(this, args).replace(/ ([AP]M)$/, '\u202f$1');
    });
    expect(new Date('2026-07-14T15:00:00Z').toLocaleTimeString('en-US')).toMatch(/\u202f[AP]M$/);
    const { user } = renderJuly();
    await user.click(screen.getByRole('button', { name: BUSY_MORE }));
    const dialog = await screen.findByRole('dialog', { name: 'Tuesday, July 14' });
    const rows = within(dialog).getAllByRole('link');
    const chips = chipsOf('2026-07-14');
    const tones: string[][] = [
      ['border-line-strong', 'bg-card', 'text-foreground'],
      ['bg-warning-wash', 'text-warning'],
      ['bg-success-wash', 'text-success', 'line-through'],
    ];
    tones.forEach((tone, i) => {
      const row = rows[i]!;
      const chip = chips[i]!;
      expect(row.dataset.status).toBe(BUSY_DAY[i]!.status);
      expect(chip.dataset.status).toBe(BUSY_DAY[i]!.status);
      expect(row.textContent).toBe(BUSY_DAY_WORDS[i]);
      expect(chip.textContent).toBe(BUSY_DAY_WORDS[i]);
      expect(row.textContent).not.toMatch(/[\u202f\u00a0]/);
      expect(chip.textContent).not.toMatch(/[\u202f\u00a0]/);
      expect(row).toHaveClass(...tone);
      expect(chip).toHaveClass(...tone);
    });
    expect(chips[0]).not.toHaveClass('line-through');
    expect(rows[0]).not.toHaveClass('line-through');
    // The fourth event has no chip; its row is in the cancelled tone.
    expect(rows[3]!.dataset.status).toBe('cancelled');
    expect(rows[3]).toHaveTextContent(BUSY_DAY_WORDS[3]!);
    expect(rows[3]).toHaveClass('bg-destructive-wash', 'text-destructive', 'line-through');
  });

  // The rows are one of many links on the page: warmed on intent, never on
  // sight (components/ui/intent-link.tsx).
  it('opening the list warms no event page; pressing a row warms that one', async () => {
    const { user } = renderJuly();
    await user.click(screen.getByRole('button', { name: BUSY_MORE }));
    const dialog = await screen.findByRole('dialog', { name: 'Tuesday, July 14' });
    // Focus is on Close, not on a row: past a keyboard dwell, nothing warms.
    await new Promise((resolve) => setTimeout(resolve, INTENT_DWELL_MS * 2));
    expect(router.prefetch).not.toHaveBeenCalled();
    fireEvent.pointerDown(within(dialog).getAllByRole('link')[1]!);
    expect(router.prefetch).toHaveBeenCalledTimes(1);
    expect(router.prefetch).toHaveBeenCalledWith('/dashboard/schedule/ev-2');
    expect(markNavigationIntent).toHaveBeenCalledWith('/dashboard/schedule/ev-2');
  });

  it("keeps the link's look across its cell, with a phone-size touch target, and phone-size rows", async () => {
    const { user, container } = renderJuly();
    const more = screen.getByRole('button', { name: BUSY_MORE });
    expect(more).toHaveClass(
      'text-muted-foreground',
      'hover:text-foreground',
      'block',
      // A button shrinks to its text without it: the hit area and the focus
      // ring would stop at "+2 more".
      'w-full',
      'text-left',
      'px-1.5',
      'text-[11px]',
      'leading-4',
      'cursor-pointer',
      'rounded-[4px]',
      'focus-visible:ring-ring',
      'focus-visible:outline-none',
      'focus-visible:ring-2',
      ...touchTargetClass.split(' '),
      ...textActionTouchMarginTop.split(' '),
    );
    // The calendar's tests find today's mark by bg-foreground.
    expect(more.className).not.toMatch(/\bbg-foreground\b/);
    // Inside its own day (the one that holds the day's number).
    const cell = more.closest<HTMLElement>('.group')!;
    expect(cell).toBe(cellOf('2026-07-14'));
    expect(within(cell).getByText('14')).toBeInTheDocument();
    // A last-row target reaches below the grid: the scroller clips it
    // instead of scrolling a few pixels up and down on touch screens.
    expect(container.querySelector('.overflow-x-auto')).toHaveClass('overflow-y-hidden');
    await user.click(more);
    const dialog = await screen.findByRole('dialog', { name: 'Tuesday, July 14' });
    for (const row of within(dialog).getAllByRole('link')) {
      expect(row).toHaveClass('min-h-8', 'max-sm:min-h-11', 'pointer-coarse:min-h-11');
    }
  });

  it('a day with exactly three events shows its three chips and no "more"', () => {
    renderJuly();
    const cell = cellOf('2026-07-20');
    expect(chipsOf('2026-07-20')).toHaveLength(3);
    expect(within(cell).queryAllByRole('button')).toHaveLength(0);
    expect(within(cell).queryByText(/more/)).toBeNull();
  });
});

// The button is drawn by the server too, and its name holds a date: the same
// words on both sides, with no id while closed, or React discards the server
// HTML (error #418, which this calendar has had before: #331).
describe('"+N more" hydrates with the server in UTC and the browser elsewhere', () => {
  for (const browserZone of [LOS_ANGELES, 'Australia/Sydney']) {
    it(`with no hydration error for a browser in ${browserZone}`, async () => {
      // 1 PM on Jul 14 in Los Angeles; 6 AM on Jul 15 in Sydney.
      const t0 = Date.parse('2026-07-14T20:00:00.000Z');
      const run = await hydrateAcrossClockShift(
        () => (
          <ScheduleCalendar
            year={2026}
            month={7}
            events={JULY}
            canManage
            timeZone={LOS_ANGELES}
            todayYmd="2026-07-14"
          />
        ),
        { serverNow: t0, browserNow: t0 + 60_000, browserZone },
      );
      try {
        expect(run.errors).toEqual([]);
        expect(run.html).toContain('aria-haspopup="dialog"');
        expect(run.html).toContain(`aria-label="${BUSY_MORE}"`);
        expect(run.html).not.toContain('aria-controls');
        const more = within(run.container).getByRole('button', { name: BUSY_MORE });
        expect(more).toHaveAttribute('aria-expanded', 'false');
        // Today's mark is still the one bg-foreground, on the busy day.
        expect(run.container.querySelectorAll('.bg-foreground')).toHaveLength(1);
        expect(more.closest('.group')!.querySelector('.bg-foreground')).not.toBeNull();
      } finally {
        run.unmount();
      }
    });
  }
});
