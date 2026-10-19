// The schedule event form in the redesign (P4.F2, rows W-WS-06 and 07): the
// "All day" box is the shared Checkbox and still flips the decorative flag
// that is sent with the event; every select is labelled by its visible
// label; the overlap warning keeps its words.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/schedule', () => ({
  createScheduleEventAction: h.create,
  updateScheduleEventAction: vi.fn(),
  deleteScheduleEventAction: vi.fn(),
}));
vi.mock('@/lib/timezone', () => ({ formatOrgDateTime: () => 'Oct 20, 9:00 AM' }));

import { ScheduleEventForm } from './schedule-event-form';

beforeEach(() => {
  vi.clearAllMocks();
  h.create.mockResolvedValue({ ok: true, data: { id: 'ev-new' } });
});

const WAREHOUSES = [{ id: 'wh-1', name: 'Main' }];

describe('ScheduleEventForm', () => {
  it('"All day" is one checkbox that flips the flag sent with the event', async () => {
    const user = userEvent.setup();
    render(<ScheduleEventForm warehouses={WAREHOUSES} bundles={[]} initialDate="2026-10-20" />);
    const allDay = screen.getByRole('checkbox', { name: 'All day' });
    expect(allDay).toHaveAttribute('aria-checked', 'false');
    await user.click(allDay);
    expect(allDay).toHaveAttribute('aria-checked', 'true');

    await user.type(screen.getByLabelText('Title'), 'Dock pickup');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    expect(h.create.mock.calls[0]![0]).toMatchObject({
      title: 'Dock pickup',
      allDay: true,
      warehouseId: 'wh-1',
    });
  });

  it('labels every select with its visible label', () => {
    render(<ScheduleEventForm warehouses={WAREHOUSES} bundles={[]} />);
    expect(screen.getByRole('combobox', { name: /^Warehouse/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Bundle' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Distribute from warehouse' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Quantity' })).toBeDisabled();
  });

  it('keeps the overlap warning and its words', () => {
    render(
      <ScheduleEventForm
        warehouses={WAREHOUSES}
        bundles={[]}
        initialDate="2026-10-20"
        conflictCandidates={[
          {
            id: 'ev-1',
            title: 'Morning delivery',
            startsAt: new Date('2026-10-20T08:30').toISOString(),
            endsAt: new Date('2026-10-20T10:00').toISOString(),
            warehouseId: 'wh-1',
            requesterName: 'Dana',
          },
        ]}
      />,
    );
    // The form opens at 9:00 on the chosen day, with no end: a point inside
    // the other event's window.
    expect(screen.getByText(/1 overlapping event/)).toBeInTheDocument();
    expect(screen.getByText('Morning delivery')).toBeInTheDocument();
    expect(
      screen.getByText('You can still save — overlaps are sometimes intentional.'),
    ).toBeInTheDocument();
  });

  // DESIGN-SPEC 2.4: the warning's words are the warning tone on its wash
  // (4.70:1 in light). opacity-80 on the date and requester and on "+N more"
  // dropped them to about 3.3:1 (axe color-contrast, serious), so the whole
  // list keeps the full tone; the title's weight still sets it apart.
  it('keeps the overlap list at full tone: the date and requester and "+N more" carry no opacity', () => {
    const conflict = (n: number) => ({
      id: `ev-${n}`,
      title: `Delivery ${n}`,
      startsAt: new Date('2026-10-20T08:30').toISOString(),
      endsAt: new Date('2026-10-20T10:00').toISOString(),
      warehouseId: 'wh-1',
      requesterName: 'Dana',
    });
    render(
      <ScheduleEventForm
        warehouses={WAREHOUSES}
        bundles={[]}
        initialDate="2026-10-20"
        conflictCandidates={[1, 2, 3, 4, 5, 6].map(conflict)}
      />,
    );
    expect(screen.getByText(/6 overlapping events/)).toBeInTheDocument();
    const dates = screen.getAllByText('(Oct 20, 9:00 AM · Dana)');
    expect(dates).toHaveLength(5);
    for (const date of dates) expect(date.className).not.toMatch(/opacity-/);
    expect(screen.getByText('Delivery 1')).toHaveClass('font-medium');
    const more = screen.getByText('+1 more');
    expect(more.tagName).toBe('LI');
    expect(more.className).not.toMatch(/opacity-/);
    const warning = more.closest('div')!;
    expect(warning).toHaveClass('bg-warning-wash', 'text-warning');
    expect(warning.querySelectorAll('[class*="opacity-"]')).toHaveLength(0);
  });
});
