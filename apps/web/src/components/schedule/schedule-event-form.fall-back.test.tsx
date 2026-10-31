import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hour the clocks go back (small fixes slice 8 review: the integrator's
 * held finding and the reviewers'). On 2026-11-01 Los Angeles reads 1:00 to
 * 1:59 AM twice, first in PDT (08:00Z to 08:59Z), then in PST (09:00Z to
 * 09:59Z). Edit event shows an event's time as a wall clock, and a
 * datetime-local field cannot say which of the two it is.
 *
 * THE DEFECT. The save converted every field back from its wall clock, and
 * the conversion answers one occurrence only (the first, west of UTC). So
 * saving an event at the second 1:30 AM without changing it moved it an hour
 * earlier, with no word, and the service cleared its reminders as for a
 * moved event (ScheduleService.update compares the instants).
 *
 * THE RULE. A field the person did not change saves the instant it opened
 * on, as stored. A changed time in that hour is read as a new time always
 * was, except next to an unchanged time in the same repeated hour: the two
 * are read in the same occurrence, so the event keeps its length.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
const actions = vi.hoisted(() => ({
  create: vi.fn(async (_payload: Record<string, unknown>) => ({
    ok: true as const,
    data: { id: 'ev-new' },
  })),
  update: vi.fn(async (_id: string, _payload: Record<string, unknown>) => ({
    ok: true as const,
    data: { id: 'ev-1' },
  })),
}));
vi.mock('@/server/actions/schedule', () => ({
  createScheduleEventAction: (payload: Record<string, unknown>) => actions.create(payload),
  updateScheduleEventAction: (id: string, payload: Record<string, unknown>) =>
    actions.update(id, payload),
  deleteScheduleEventAction: vi.fn(),
}));

import { ScheduleEventForm } from './schedule-event-form';

const WAREHOUSES = [{ id: 'wh-1', name: 'Fresno HQ' }];
const LA = 'America/Los_Angeles';

beforeEach(() => {
  vi.clearAllMocks();
});

const starts = () => screen.getByLabelText(/^Starts/) as HTMLInputElement;
const ends = () => screen.getByLabelText(/^Ends/) as HTMLInputElement;

function renderEdit(
  timeZone: string,
  event: { startsAt: string; endsAt?: string | null },
  conflictCandidates?: ComponentProps<typeof ScheduleEventForm>['conflictCandidates'],
) {
  return render(
    <ScheduleEventForm
      warehouses={WAREHOUSES}
      bundles={[]}
      timeZone={timeZone}
      conflictCandidates={conflictCandidates}
      defaults={{
        id: 'ev-1',
        title: 'Night count',
        startsAt: event.startsAt,
        endsAt: event.endsAt ?? null,
        warehouseId: 'wh-1',
      }}
    />,
  );
}

async function saved(): Promise<{ startsAt: string; endsAt: string | null }> {
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(actions.update).toHaveBeenCalledTimes(1));
  return actions.update.mock.calls[0]![1] as { startsAt: string; endsAt: string | null };
}

describe('Edit event in the hour the clocks go back', () => {
  it('an unchanged save keeps an event at the second 1:30 AM (PST) where it is, as stored', async () => {
    // As PostgREST prints a timestamptz.
    renderEdit(LA, { startsAt: '2026-11-01T09:30:00+00:00', endsAt: '2026-11-01T09:50:00+00:00' });
    expect(starts().value).toBe('2026-11-01T01:30');
    expect(ends().value).toBe('2026-11-01T01:50');

    const payload = await saved();
    // Before: 08:30Z and 08:50Z, the first 1:30 and 1:50 (PDT), an hour early.
    expect(payload.startsAt).toBe('2026-11-01T09:30:00+00:00');
    expect(payload.endsAt).toBe('2026-11-01T09:50:00+00:00');
  });

  it('an unchanged save keeps an event at the first 1:30 AM (PDT) too', async () => {
    renderEdit(LA, { startsAt: '2026-11-01T08:30:00+00:00' });
    expect(starts().value).toBe('2026-11-01T01:30');
    const payload = await saved();
    expect(Date.parse(payload.startsAt)).toBe(Date.parse('2026-11-01T08:30:00Z'));
    expect(payload.endsAt).toBeNull();
  });

  it('keeps the second 1:30 AM in New York (EST) across an unchanged save', async () => {
    renderEdit('America/New_York', { startsAt: '2026-11-01T06:30:00+00:00' });
    expect(starts().value).toBe('2026-11-01T01:30');
    const payload = await saved();
    // Before: 05:30Z, the first 1:30 (EDT).
    expect(Date.parse(payload.startsAt)).toBe(Date.parse('2026-11-01T06:30:00Z'));
  });

  it('sends an unchanged time exactly as stored, microseconds included', async () => {
    renderEdit(LA, { startsAt: '2026-11-08T04:00:00.123456+00:00' });
    expect(starts().value).toBe('2026-11-07T20:00');
    const payload = await saved();
    expect(payload.startsAt).toBe('2026-11-08T04:00:00.123456+00:00');
  });

  it('a changed time in that hour still saves, read as a new time always was (the first 1:45 AM, PDT)', async () => {
    renderEdit(LA, { startsAt: '2026-11-01T09:30:00+00:00' });
    fireEvent.change(starts(), { target: { value: '2026-11-01T01:45' } });
    const payload = await saved();
    expect(payload.startsAt).toBe('2026-11-01T08:45:00.000Z');
  });

  it("a changed end in that hour is read in the unchanged start's occurrence, so the event keeps its length", async () => {
    renderEdit(LA, { startsAt: '2026-11-01T09:30:00+00:00', endsAt: '2026-11-01T09:50:00+00:00' });
    fireEvent.change(ends(), { target: { value: '2026-11-01T01:55' } });
    const payload = await saved();
    // 1:30 to 1:55 AM PST. Before, both fields moved to PDT (08:30Z to 08:55Z).
    // With the start kept and 1:55 read alone (the first one, 08:55Z), the end
    // would fall before the start and the save would be refused ("End time
    // must be on or after the start time").
    expect(payload.startsAt).toBe('2026-11-01T09:30:00+00:00');
    expect(payload.endsAt).toBe('2026-11-01T09:55:00.000Z');
  });

  it("a changed start in that hour is read in the unchanged end's occurrence", async () => {
    renderEdit(LA, { startsAt: '2026-11-01T09:30:00+00:00', endsAt: '2026-11-01T09:50:00+00:00' });
    fireEvent.change(starts(), { target: { value: '2026-11-01T01:40' } });
    const payload = await saved();
    // 1:40 to 1:50 AM PST, ten minutes, as the fields read.
    expect(payload.startsAt).toBe('2026-11-01T09:40:00.000Z');
    expect(payload.endsAt).toBe('2026-11-01T09:50:00+00:00');
  });

  it('a changed end after that hour is read as before', async () => {
    renderEdit(LA, { startsAt: '2026-11-01T09:30:00+00:00' });
    fireEvent.change(ends(), { target: { value: '2026-11-01T03:00' } });
    const payload = await saved();
    expect(payload.startsAt).toBe('2026-11-01T09:30:00+00:00');
    expect(payload.endsAt).toBe('2026-11-01T11:00:00.000Z');
  });

  it('the overlap warning reads the instant the save keeps', () => {
    renderEdit(LA, { startsAt: '2026-11-01T09:30:00+00:00' }, [
      {
        id: 'ev-9',
        title: 'Truck unload',
        // 1:15 to 1:45 AM PST, around the event's own 1:30 AM PST.
        startsAt: '2026-11-01T09:15:00.000Z',
        endsAt: '2026-11-01T09:45:00.000Z',
        warehouseId: 'wh-1',
        requesterName: null,
      },
    ]);
    expect(screen.getByText(/1 overlapping event/)).toBeInTheDocument();
    expect(screen.getByText('Truck unload')).toBeInTheDocument();
  });
});
