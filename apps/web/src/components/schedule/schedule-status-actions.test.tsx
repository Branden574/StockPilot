// The event page's one-click status buttons (P4.F2, row W-WS-05). The ink
// commit button (Start, Mark complete) comes after the secondary Cancel, so it
// is the rightmost button in the page header (DESIGN-SPEC 6.1; PageHeader puts
// its commit slot after the secondary actions). The words, the status each
// button sets, the toasts and the shared busy lock are unchanged.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  update: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push, refresh: h.refresh }),
}));
vi.mock('sonner', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('@/server/actions/schedule', () => ({ updateScheduleEventAction: h.update }));

import { ScheduleStatusActions } from './schedule-status-actions';

beforeEach(() => {
  vi.clearAllMocks();
  h.update.mockResolvedValue({ ok: true, data: { id: 'ev-1' } });
});

const names = () => screen.getAllByRole('button').map((b) => b.textContent?.trim());

describe('ScheduleStatusActions', () => {
  it('a scheduled event shows Cancel, then the ink Start last', () => {
    render(<ScheduleStatusActions eventId="ev-1" currentStatus="scheduled" />);
    expect(names()).toEqual(['Cancel', 'Start']);
    const [cancel, start] = screen.getAllByRole('button');
    expect(start).toHaveClass('bg-primary');
    expect(cancel).not.toHaveClass('bg-primary');
  });

  it('an event in progress shows Cancel, then the ink Mark complete last', () => {
    render(<ScheduleStatusActions eventId="ev-1" currentStatus="in_progress" />);
    expect(names()).toEqual(['Cancel', 'Mark complete']);
    const [cancel, complete] = screen.getAllByRole('button');
    expect(complete).toHaveClass('bg-primary');
    expect(cancel).not.toHaveClass('bg-primary');
  });

  it.each(['completed', 'cancelled'] as const)('a %s event shows Reopen alone', (status) => {
    render(<ScheduleStatusActions eventId="ev-1" currentStatus={status} />);
    expect(names()).toEqual(['Reopen']);
  });

  it.each([
    ['scheduled', 'Start', 'in_progress', 'Event started.'],
    ['scheduled', 'Cancel', 'cancelled', 'Event cancelled.'],
    ['in_progress', 'Mark complete', 'completed', 'Event marked complete.'],
    ['in_progress', 'Cancel', 'cancelled', 'Event cancelled.'],
    ['completed', 'Reopen', 'scheduled', 'Event reopened.'],
    ['cancelled', 'Reopen', 'scheduled', 'Event reopened.'],
  ] as const)('%s: %s sets the status to %s and says "%s"', async (from, button, to, toast) => {
    const user = userEvent.setup();
    render(<ScheduleStatusActions eventId="ev-1" currentStatus={from} />);
    await user.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(h.success).toHaveBeenCalledWith(toast));
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith('ev-1', { status: to });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('a refused change says why and does not refresh', async () => {
    h.update.mockResolvedValue({ ok: false, error: { message: 'Not allowed.' } });
    const user = userEvent.setup();
    render(<ScheduleStatusActions eventId="ev-1" currentStatus="scheduled" />);
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(h.error).toHaveBeenCalledWith('Not allowed.'));
    expect(h.success).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('while one change saves, both buttons are disabled', async () => {
    let finish: (v: unknown) => void = () => {};
    h.update.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<ScheduleStatusActions eventId="ev-1" currentStatus="scheduled" />);
    await user.click(screen.getByRole('button', { name: 'Start' }));
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    finish({ ok: true, data: { id: 'ev-1' } });
    await waitFor(() => {
      for (const b of screen.getAllByRole('button')) expect(b).toBeEnabled();
    });
  });

  it('a completion saved without its kit handed out links to the kit page from the toast', async () => {
    const kit = 'd4d4d4d4-0000-4000-8000-000000000401';
    const message =
      "Event marked complete, but the bundle could not be distributed. Hand it out from the kit's page.";
    h.update.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message, details: { kitId: kit } },
    });
    const user = userEvent.setup();
    render(<ScheduleStatusActions eventId="ev-1" currentStatus="in_progress" />);
    await user.click(screen.getByRole('button', { name: 'Mark complete' }));
    await waitFor(() => expect(h.error).toHaveBeenCalledTimes(1));
    const [said, options] = h.error.mock.calls[0]! as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(said).toBe(message);
    expect(options.action.label).toBe('Open kit');
    options.action.onClick();
    expect(h.push).toHaveBeenCalledWith(`/dashboard/bundles/${kit}`);
  });

  it('an answer that names no kit gets no link', async () => {
    const message =
      "Event marked complete, but the bundle could not be distributed. Ask a manager to hand it out from the kit's page.";
    h.update.mockResolvedValue({ ok: false, error: { code: 'conflict', message } });
    const user = userEvent.setup();
    render(<ScheduleStatusActions eventId="ev-1" currentStatus="in_progress" />);
    await user.click(screen.getByRole('button', { name: 'Mark complete' }));
    await waitFor(() => expect(h.error).toHaveBeenCalledWith(message));
    expect(h.error.mock.calls[0]).toHaveLength(1);
    expect(h.push).not.toHaveBeenCalled();
  });

  it('a kit id that is not an id gets no link', async () => {
    h.update.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message: 'Not handed out.', details: { kitId: '../settings' } },
    });
    const user = userEvent.setup();
    render(<ScheduleStatusActions eventId="ev-1" currentStatus="in_progress" />);
    await user.click(screen.getByRole('button', { name: 'Mark complete' }));
    await waitFor(() => expect(h.error).toHaveBeenCalledWith('Not handed out.'));
    expect(h.error.mock.calls[0]).toHaveLength(1);
  });
});
