import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * New and Edit event take their date and time in the ORGANIZATION's zone, the
 * zone the team calendar draws in (small fixes slice 8 review).
 *
 * THE DEFECT. Since slice 8 the calendar puts each event in the cell of its
 * start day in the organization's zone, and a cell's "+ Add" opens this form
 * on that date at 9:00. The form read and saved that wall clock in the
 * VIEWER's zone (new Date(local)), so a viewer in Manila adding an event on
 * Nov 7 for a Los Angeles organization saved Nov 7 9:00 AM Manila time, which
 * is Nov 6 in Los Angeles: the calendar drew the new event a day early, and
 * the event's page (organization's zone) disagreed with its Edit form
 * (viewer's zone). The overlap warning also printed times in Pacific whatever
 * the organization's zone.
 */

const runtimeZone = process.env.TZ;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
const actions = vi.hoisted(() => ({
  create: vi.fn(async (_payload: Record<string, unknown>) => ({ ok: true as const, data: { id: 'ev-new' } })),
  update: vi.fn(async (_id: string, _payload: Record<string, unknown>) => ({ ok: true as const, data: { id: 'ev-1' } })),
}));
vi.mock('@/server/actions/schedule', () => ({
  createScheduleEventAction: (payload: Record<string, unknown>) => actions.create(payload),
  updateScheduleEventAction: (id: string, payload: Record<string, unknown>) => actions.update(id, payload),
  deleteScheduleEventAction: vi.fn(),
}));

import { ScheduleEventForm } from './schedule-event-form';

const WAREHOUSES = [{ id: 'wh-1', name: 'Fresno HQ' }];

beforeEach(() => {
  // The viewer is in Manila; the organization is in Los Angeles.
  process.env.TZ = 'Asia/Manila';
  vi.clearAllMocks();
});
afterEach(() => {
  if (runtimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = runtimeZone;
});

const starts = () => screen.getByLabelText(/^Starts/) as HTMLInputElement;
const ends = () => screen.getByLabelText(/^Ends/) as HTMLInputElement;

function fillTitle() {
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Donation drop' } });
}

describe("ScheduleEventForm: dates and times in the organization's zone", () => {
  it('"+ Add" on Nov 7 opens at 9:00 AM that day there and saves it, so the calendar draws it on Nov 7', async () => {
    render(
      <ScheduleEventForm warehouses={WAREHOUSES} bundles={[]} initialDate="2026-11-07" timeZone="America/Los_Angeles" />,
    );
    expect(starts().value).toBe('2026-11-07T09:00');
    fillTitle();
    fireEvent.click(screen.getByRole('button', { name: 'Create event' }));

    await waitFor(() => expect(actions.create).toHaveBeenCalledTimes(1));
    // 9:00 AM Pacific standard time on Nov 7 (not 9:00 AM in Manila, Nov 6 in Los Angeles).
    expect(actions.create.mock.calls[0]![0]).toMatchObject({
      startsAt: '2026-11-07T17:00:00.000Z',
      endsAt: null,
    });
  });

  it('Edit opens on the wall clock the event page prints, and an unchanged save keeps the instant', async () => {
    render(
      <ScheduleEventForm
        warehouses={WAREHOUSES}
        bundles={[]}
        timeZone="America/Los_Angeles"
        defaults={{
          id: 'ev-1',
          title: 'Evening delivery',
          // 8:00 PM Nov 7 in Los Angeles; Nov 8 noon in Manila.
          startsAt: '2026-11-08T04:00:00.000Z',
          endsAt: '2026-11-08T05:30:00.000Z',
          warehouseId: 'wh-1',
        }}
      />,
    );
    expect(starts().value).toBe('2026-11-07T20:00');
    expect(ends().value).toBe('2026-11-07T21:30');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(actions.update).toHaveBeenCalledTimes(1));
    expect(actions.update.mock.calls[0]![1]).toMatchObject({
      startsAt: '2026-11-08T04:00:00.000Z',
      endsAt: '2026-11-08T05:30:00.000Z',
    });
  });

  it('keeps an event\'s seconds across an unchanged save', async () => {
    render(
      <ScheduleEventForm
        warehouses={WAREHOUSES}
        bundles={[]}
        timeZone="America/Los_Angeles"
        defaults={{ id: 'ev-1', title: 'Pickup', startsAt: '2026-11-08T04:00:30.000Z', warehouseId: 'wh-1' }}
      />,
    );
    expect(starts().value).toBe('2026-11-07T20:00:30');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(actions.update).toHaveBeenCalledTimes(1));
    expect(actions.update.mock.calls[0]![1]).toMatchObject({ startsAt: '2026-11-08T04:00:30.000Z' });
  });

  it('names the zone the times are in', () => {
    render(<ScheduleEventForm warehouses={WAREHOUSES} bundles={[]} timeZone="America/New_York" />);
    expect(screen.getByText('Times are in America/New_York.')).toBeInTheDocument();
  });

  it('a time that does not happen there (the spring-forward hour) is refused with a field error, and nothing is saved', async () => {
    render(
      <ScheduleEventForm warehouses={WAREHOUSES} bundles={[]} initialDate="2027-03-14" timeZone="America/Los_Angeles" />,
    );
    fillTitle();
    fireEvent.change(starts(), { target: { value: '2027-03-14T02:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create event' }));

    expect(
      await screen.findByText("That start time doesn't exist in America/Los_Angeles (the clocks change). Pick another time."),
    ).toBeInTheDocument();
    expect(starts()).toHaveAttribute('aria-invalid', 'true');
    expect(actions.create).not.toHaveBeenCalled();
  });

  it("the overlap warning reads the form's times and prints the other event's time in the organization's zone", () => {
    render(
      <ScheduleEventForm
        warehouses={WAREHOUSES}
        bundles={[]}
        initialDate="2026-11-07"
        timeZone="America/New_York"
        conflictCandidates={[
          {
            id: 'ev-9',
            title: 'Truck unload',
            // 8:30 AM to 10:30 AM in New York on Nov 7 (EST, UTC-5).
            startsAt: '2026-11-07T13:30:00.000Z',
            endsAt: '2026-11-07T15:30:00.000Z',
            warehouseId: 'wh-1',
            requesterName: null,
          },
        ]}
      />,
    );
    // The form opens at 9:00 AM New York time, inside that event.
    expect(screen.getByText('Truck unload')).toBeInTheDocument();
    expect(screen.getByText(/Nov 7, 8:30 AM/)).toBeInTheDocument();
  });
});
