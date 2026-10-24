import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * An event chip's time is server-rendered text since small fixes slice 8 (it
 * was drawn only after hydration). Newer ICU and the phone's Hermes put a
 * narrow no-break space (U+202F) before AM/PM, and an engine that does so on
 * only one side of the render gives React error #418. The chip writes plain
 * spaces, as core's formatOrgDateTime already does (plainSpaces).
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/schedule',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/timezone', () => ({
  formatOrgDate: () => 'July 2026',
  // What newer ICU prints.
  formatOrgTime: () => '9:00 AM',
}));

import { ScheduleCalendar } from './schedule-calendar';

describe('ScheduleCalendar event chip time', () => {
  it('is written with plain spaces', () => {
    render(
      <ScheduleCalendar
        year={2026}
        month={7}
        timeZone="America/Los_Angeles"
        events={[
          {
            id: 'ev-1',
            title: 'Delivery run',
            startsAt: '2026-07-15T16:00:00Z',
            endsAt: null,
            allDay: false,
            status: 'scheduled',
            locationText: null,
          },
        ]}
      />,
    );
    const chip = screen.getByRole('link', { name: /Delivery run/ });
    // The redesigned chip reads its status after the title, for screen readers.
    expect(chip.textContent).toBe('9:00 AM Delivery run, Scheduled');
    expect(chip.textContent).not.toMatch(/[  ]/);
  });
});
