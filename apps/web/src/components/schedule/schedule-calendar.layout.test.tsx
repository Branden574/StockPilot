import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { textActionTouchMarginTop, touchTargetClass } from '@/components/patterns/touch-target';

/**
 * B100: three layout faults of the month grid, measured in Chromium at 390 and
 * 1280 px. This test environment draws no layout, so each is pinned by the
 * markup that caused it; the PR records the measurement before and after.
 *
 * 1. A chip's screen-reader status word is `sr-only`, which is absolutely
 *    positioned. With no positioned chip its containing block was the day
 *    cell, so the chip's own clip (`truncate`) did not cut it: it sat at the
 *    end of the full, uncut title and widened the grid's scroller past
 *    Saturday (872 px of scroll for a 640 px grid at 390 px wide).
 * 2. The time was `{time} ` in JSX: two text nodes ("9:00 AM" and " "), which
 *    the server splits with a comment. Chrome drops a space-only text node at
 *    the end of an inline element when it names the link, so a chip was
 *    called "9:00 AMB46 lab 1".
 * 3. On a phone or a touch screen the "+N more" target is 44 px around a
 *    16 px line, so it reaches 14 px below the button; a last-row cell keeps
 *    only 6 px of padding, so the target hung 8 px past the grid and the
 *    scroller, which hides its vertical overflow, could still be scrolled 8 px
 *    by a script (scrollIntoView).
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/schedule',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/timezone', () => ({
  formatOrgDate: () => 'July 2026',
  formatOrgTime: () => '9:00 AM',
}));

import { ScheduleCalendar } from './schedule-calendar';

const ev = (id: string, title: string, startsAt: string) => ({
  id,
  title,
  startsAt,
  endsAt: null,
  allDay: false,
  status: 'scheduled' as const,
  locationText: null,
});

// July 2026's grid runs from Sunday June 28 to Saturday August 8; August 5 is
// in its last row.
const EVENTS = [
  ev('ev-sat', 'A long title that does not fit in its day on a Saturday', '2026-07-18T16:00:00Z'),
  ...[1, 2, 3, 4].map((n) => ev(`ev-last-${n}`, `Last row ${n}`, `2026-08-05T1${n}:00:00Z`)),
];

const calendar = () => <ScheduleCalendar year={2026} month={7} events={EVENTS} />;

describe('the month grid stays the width of its seven days (B100)', () => {
  it("positions each chip, so its clip cuts the hidden status word and the word's box stays inside it", () => {
    render(calendar());
    const chips = screen.getAllByRole('link', { name: /, Scheduled$/ });
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip).toHaveClass('relative', 'truncate');
      const word = chip.querySelector('.sr-only')!;
      expect(word.textContent).toBe(', Scheduled');
      // The status word's containing block is its nearest positioned ancestor.
      expect(word.parentElement!.closest('.relative')).toBe(chip);
    }
  });
});

describe("a chip's name keeps the space after its time (B100)", () => {
  it('writes the time and its space as one text node, in the browser and from the server', () => {
    render(calendar());
    const chip = screen.getByRole('link', { name: /Saturday/ });
    const time = chip.querySelector('.tabular-nums')!;
    expect([...time.childNodes].map((n) => n.textContent)).toEqual(['9:00 AM ']);

    // The server writes a comment between adjacent text pieces; none here.
    const html = renderToString(calendar());
    expect(html).toContain('<span class="tabular-nums">9:00 AM </span>');
    expect(html).not.toContain('9:00 AM<!-- -->');
  });
});

describe('the last row leaves room for the "+N more" touch target (B100)', () => {
  it('pads a last-row cell by the 14 px the target reaches below the button, only where the target is on', () => {
    // The target that reaches below "+N more" is the shared one, on below sm
    // and on coarse pointers; if either changes, this padding must follow.
    expect(touchTargetClass).toContain('before:min-h-11');
    expect(touchTargetClass).toContain("max-sm:before:content-['']");
    expect(touchTargetClass).toContain("pointer-coarse:before:content-['']");
    expect(textActionTouchMarginTop).toBe('max-sm:mt-3.5 pointer-coarse:mt-3.5');

    render(calendar());
    const more = screen.getByRole('button', { name: /more event/ });
    const cell = more.closest<HTMLElement>('.group')!;
    expect(cell).toHaveClass('p-1.5', 'max-sm:pb-3.5', 'pointer-coarse:pb-3.5');

    // Rows above the last are not padded: their target ends over the row
    // below, inside the grid.
    const firstRowCell = screen.getAllByText('28')[0]!.closest<HTMLElement>('.group')!;
    expect(firstRowCell).not.toHaveClass('max-sm:pb-3.5');
    expect(firstRowCell).not.toHaveClass('pointer-coarse:pb-3.5');
  });
});
