import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Orders placed calendar popover on a short or narrow screen (the
// production check of 2026-09-29: at 390 x 844 Cancel and Apply fell below
// the screen; at 390 x 664 it flipped above the fields and its top, the typed
// dates and the month, was cut off). The popover is held to the room Radix
// measures on its side, its dates and calendar scroll inside it, and the
// zone, Cancel and Apply sit outside the scrolling part, always in view.
// Layout itself is measured in Chromium (the calendar-fix harness); these
// pin the structure that layout depends on.

import {
  BOOK_REPORT_UI,
  DEFAULT_BOOK_REPORT_QUERY,
  type BookReportQuery,
  type BookReportRangeEcho,
} from '@stockpilot/core';

// collisionPadding is used by Floating UI and never reaches the DOM, so the
// props the control gives the popover content are captured on the way in.
const content = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/popover')>();
  const { createElement, forwardRef } = await import('react');
  const PopoverContent = forwardRef<
    HTMLDivElement,
    React.ComponentPropsWithoutRef<typeof actual.PopoverContent>
  >(function CapturedPopoverContent(props, ref) {
    content.props = props as Record<string, unknown>;
    return createElement(actual.PopoverContent, { ...props, ref });
  });
  return { ...actual, PopoverContent };
});

import { OrdersPlacedControl } from './orders-placed-control';

const QUERY: BookReportQuery = {
  ...DEFAULT_BOOK_REPORT_QUERY,
  statusGroups: [...DEFAULT_BOOK_REPORT_QUERY.statusGroups],
  warehouse: 'all',
};
const ALL_TIME: BookReportRangeEcho = {
  key: 'all',
  from: null,
  to: null,
  timeZone: 'America/Los_Angeles',
  timeZoneFallback: false,
};

async function openCalendar() {
  render(
    <OrdersPlacedControl
      query={QUERY}
      rangeEcho={ALL_TIME}
      today="2026-09-29"
      onChange={vi.fn()}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Start date' }));
  const dialog = await screen.findByRole('dialog', { name: 'Orders placed' });
  const form = dialog.querySelector<HTMLFormElement>('[data-custom-range]')!;
  const body = dialog.querySelector<HTMLDivElement>('[data-custom-range-body]')!;
  const footer = dialog.querySelector<HTMLDivElement>('[data-custom-range-footer]')!;
  return { dialog, form, body, footer };
}

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 300,
    width: 300,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  content.props = null;
  vi.unstubAllGlobals();
});

describe('Orders placed calendar popover: always on screen', () => {
  it('is held to the height Radix measures on its side, inside a margin from the screen edges', async () => {
    const { dialog } = await openCalendar();
    expect(dialog).toHaveClass(
      'flex',
      'flex-col',
      'max-h-[var(--radix-popover-content-available-height)]',
      'max-w-[calc(100vw-2rem)]',
      'p-0',
    );
    // A margin, so Radix measures (and flips and shifts) short of the edges.
    const padding = content.props?.collisionPadding;
    expect(typeof padding).toBe('number');
    expect(padding as number).toBeGreaterThan(0);
  });

  it('scrolls the typed dates and the calendar inside it, and keeps the zone, Cancel and Apply outside the scrolling part', async () => {
    const { form, body, footer } = await openCalendar();
    // The form can shrink to the popover's height, and only the body scrolls,
    // without handing its scroll on to the page.
    expect(form).toHaveClass('flex', 'min-h-0', 'flex-col');
    expect(body).toHaveClass('min-h-0', 'overflow-y-auto', 'overscroll-contain');
    expect(footer).toHaveClass('shrink-0');
    expect(body.parentElement).toBe(form);
    expect(footer.parentElement).toBe(form);
    expect(body.nextElementSibling).toBe(footer);

    // What scrolls: the typed dates, the month and its arrows, the days.
    expect(within(body).getByLabelText('Start date')).toBeInTheDocument();
    expect(within(body).getByLabelText('End date')).toBeInTheDocument();
    expect(within(body).getByRole('grid', { name: 'September 2026' })).toBeInTheDocument();
    expect(within(body).getByRole('button', { name: 'Previous month' })).toBeInTheDocument();
    expect(
      within(body).getByRole('button', { name: 'Tuesday, September 29, 2026' }),
    ).toBeInTheDocument();

    // What never scrolls away: the zone, Cancel and Apply.
    const cancel = within(footer).getByRole('button', { name: 'Cancel' });
    const apply = within(footer).getByRole('button', { name: 'Apply' });
    expect(within(footer).getByText('Times are in America/Los_Angeles.')).toBeInTheDocument();
    expect(body).not.toContainElement(cancel);
    expect(body).not.toContainElement(apply);
  });

  it('keeps the desktop spacing: the body and the footer carry the old p-3 and space-y-3 between them', async () => {
    const { body, footer } = await openCalendar();
    expect(body).toHaveClass('space-y-3', 'p-3', 'pb-0');
    expect(footer).toHaveClass('mx-3', 'mb-3', 'mt-3', 'border-t', 'pt-3');
  });

  it('a refused Apply says why outside the scrolling part, just above the footer, so it shows however far the body is scrolled', async () => {
    const { dialog, form, body, footer } = await openCalendar();
    await userEvent.type(within(body).getByLabelText('Start date'), '2026-09-28');
    await userEvent.type(within(body).getByLabelText('End date'), '2026-09-01');
    await userEvent.click(within(footer).getByRole('button', { name: 'Apply' }));
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent(BOOK_REPORT_UI.customRangeInvalid);
    expect(body).not.toContainElement(alert);
    expect(alert.parentElement).toBe(form);
    expect(alert.nextElementSibling).toBe(footer);
    expect(alert).toHaveClass('mx-3', 'mt-3', 'shrink-0');
    // Still the typed fields' description.
    expect(within(body).getByLabelText('Start date')).toHaveAttribute('aria-describedby', alert.id);
  });
});

describe('Orders placed calendar popover: a visible focus stays in view when the body is held short', () => {
  /** A ResizeObserver whose callbacks the test runs by hand. */
  function captureResizeObservers() {
    const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
    class CapturingResizeObserver {
      private entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    }
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver);
    return (target: Element) => {
      for (const o of observers) {
        if (o.targets.includes(target)) o.callback([], {} as ResizeObserver);
      }
    };
  }

  /** The calendar's focused day, sat below a body held to 0..200. */
  function hideFocusedDayBelow(body: HTMLDivElement, focusVisible: boolean, scale = 1) {
    const day = within(body).getByRole('button', { name: 'Tuesday, September 29, 2026' });
    day.focus();
    expect(day).toHaveFocus();
    const matches = Element.prototype.matches;
    vi.spyOn(day, 'matches').mockImplementation((selector: string) =>
      selector === ':focus-visible' ? focusVisible : matches.call(day, selector),
    );
    // Rectangles as the screen shows them (scaled while the popover zooms
    // in); offsetHeight is the body's own, unscaled height.
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(rect(0, 200 * scale));
    Object.defineProperty(body, 'offsetHeight', { configurable: true, value: 200 });
    vi.spyOn(day, 'getBoundingClientRect').mockReturnValue(rect(210 * scale, 246 * scale));
    body.scrollTop = 0;
    return day;
  }

  it('the keyboard opened it (the focus ring shows): the body scrolls just far enough to show the day and its ring, and the page never moves', async () => {
    const resized = captureResizeObservers();
    const { body } = await openCalendar();
    hideFocusedDayBelow(body, true);
    resized(body);
    // 246 + 4 px for the ring - 200.
    expect(body.scrollTop).toBeCloseTo(50, 0);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("while the popover zooms in (scaled 95%), the distance is scaled back to the body's own pixels", async () => {
    const resized = captureResizeObservers();
    const { body } = await openCalendar();
    hideFocusedDayBelow(body, true, 0.95);
    resized(body);
    expect(body.scrollTop).toBeCloseTo(50, 0);
  });

  it('a click or tap opened it (no ring shows): the body stays at its top, the typed dates and the month', async () => {
    const resized = captureResizeObservers();
    const { body } = await openCalendar();
    hideFocusedDayBelow(body, false);
    resized(body);
    expect(body.scrollTop).toBe(0);
  });
});

describe('Orders placed calendar popover: keyboard focus that moves into the body is shown whole', () => {
  // Chrome brings a date field into view by its focused part (the year, on
  // Shift+Tab), not the whole field, and Radix's Tab wrap focuses with
  // preventScroll. Measured in the calendar-fix harness (2026-09-29): 2 to 9
  // px of the field, its ring and its label were left under the top edge of
  // the scrolling body. The body is held here to 171..312 and scrolled 41 px.
  const BODY_TOP = 171;
  const BODY_BOTTOM = 312;
  const SCROLLED = 41;

  /** A typed date field (label 142..162, input 162..198) 9 px above the top edge. */
  function placeFieldAboveTop(body: HTMLDivElement, input: HTMLElement, focusVisible = true) {
    // The field: its label above the input.
    const field = input.parentElement!;
    expect(field.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    const matches = Element.prototype.matches;
    vi.spyOn(input, 'matches').mockImplementation((selector: string) =>
      selector === ':focus-visible' ? focusVisible : matches.call(input, selector),
    );
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(rect(BODY_TOP, BODY_BOTTOM));
    Object.defineProperty(body, 'offsetHeight', {
      configurable: true,
      value: BODY_BOTTOM - BODY_TOP,
    });
    vi.spyOn(field, 'getBoundingClientRect').mockReturnValue(rect(142, 198));
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(162, 198));
    body.scrollTop = SCROLLED;
  }

  it('Shift+Tab back into End date: the body scrolls up just far enough to show the whole field, its ring and its label', async () => {
    const { body } = await openCalendar();
    within(body).getByRole('button', { name: 'Previous month' }).focus();
    const end = within(body).getByLabelText('End date');
    placeFieldAboveTop(body, end);
    await userEvent.tab({ shift: true });
    expect(end).toHaveFocus();
    // The label's top (142) less 4 px for the ring, at the body's top (171):
    // 41 - (171 - 138).
    expect(body.scrollTop).toBeCloseTo(8, 0);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it('Tab past Apply wraps to Start date (Radix focuses it without scrolling): the body scrolls up to show the whole field and its label', async () => {
    const { body, footer } = await openCalendar();
    const start = within(body).getByLabelText('Start date');
    await userEvent.type(start, '2026-09-01');
    await userEvent.type(within(body).getByLabelText('End date'), '2026-09-28');
    const apply = within(footer).getByRole('button', { name: 'Apply' });
    expect(apply).toBeEnabled();
    apply.focus();
    placeFieldAboveTop(body, start);
    await userEvent.tab();
    expect(start).toHaveFocus();
    expect(body.scrollTop).toBeCloseTo(8, 0);
  });

  it('an arrow key moves focus to a day below the bottom edge: the body scrolls to show the day and its ring', async () => {
    // Chrome scrolls such a day flush with the edge, which hides its ring.
    const { body } = await openCalendar();
    within(body).getByRole('button', { name: 'Tuesday, September 22, 2026' }).focus();
    const day = within(body).getByRole('button', { name: 'Tuesday, September 29, 2026' });
    const matches = Element.prototype.matches;
    vi.spyOn(day, 'matches').mockImplementation((selector: string) =>
      selector === ':focus-visible' ? true : matches.call(day, selector),
    );
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(rect(0, 200));
    Object.defineProperty(body, 'offsetHeight', { configurable: true, value: 200 });
    vi.spyOn(day, 'getBoundingClientRect').mockReturnValue(rect(210, 246));
    body.scrollTop = 0;
    await userEvent.keyboard('{ArrowDown}');
    expect(day).toHaveFocus();
    // 246 + 4 px for the ring - 200.
    expect(body.scrollTop).toBeCloseTo(50, 0);
  });

  it('a click or tap that focuses without a ring leaves the body where it is', async () => {
    const { body } = await openCalendar();
    within(body).getByRole('button', { name: 'Previous month' }).focus();
    const end = within(body).getByLabelText('End date');
    placeFieldAboveTop(body, end, false);
    end.focus();
    expect(end).toHaveFocus();
    expect(body.scrollTop).toBe(SCROLLED);
  });
});
