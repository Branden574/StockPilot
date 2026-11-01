import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage, requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline, outOfDate, signInRedirect } from '@/test/rejected-request';

// ---------------------------------------------------------------------------
// B40: the schedule. Saving an event, deleting one and changing its status
// cleared the busy flag in `finally` with no catch, so a call that got no
// answer (offline, a server error, a deploy) said nothing: a new event
// looked as if it was saved. Now a create says to look before trying again
// (a hand-made event has no rule that stops a second copy), an update or a
// delete says it did not happen, the delete inside its confirm; a redirect
// to sign-in says nothing.
// ---------------------------------------------------------------------------

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
// The real unstable_rethrow stays, so isControlFlow recognises the redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push, refresh }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/schedule', () => ({
  createScheduleEventAction: vi.fn(),
  updateScheduleEventAction: vi.fn(),
  deleteScheduleEventAction: vi.fn(),
}));
vi.mock('@/lib/timezone', () => ({ formatOrgDateTime: () => 'Oct 20, 9:00 AM' }));

import { toast } from 'sonner';

import {
  createScheduleEventAction,
  deleteScheduleEventAction,
  updateScheduleEventAction,
} from '@/server/actions/schedule';

import { ScheduleEventForm } from './schedule-event-form';
import { ScheduleStatusActions } from './schedule-status-actions';

const WAREHOUSES = [{ id: 'wh-1', name: 'Main' }];
const SAVED = {
  id: 'ev-1',
  title: 'Dock pickup',
  startsAt: '2026-10-20T16:00:00.000Z',
  endsAt: null,
  allDay: false,
  warehouseId: 'wh-1',
  status: 'scheduled' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the schedule event form when the save gets no answer', () => {
  it('Create event keeps the form and says to look at the schedule before trying again', async () => {
    vi.mocked(createScheduleEventAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<ScheduleEventForm warehouses={WAREHOUSES} bundles={[]} initialDate="2026-10-20" />);
    await user.type(screen.getByLabelText('Title'), 'Dock pickup');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestUnconfirmedMessage(offline(), 'the event was created', 'the schedule'),
      ),
    );
    expect(screen.getByLabelText('Title')).toHaveValue('Dock pickup');
    expect(screen.getByRole('button', { name: 'Create event' })).toBeEnabled();
    expect(push).not.toHaveBeenCalled();
  });

  it('Create event from a page older than the server says nothing was changed', async () => {
    vi.mocked(createScheduleEventAction).mockRejectedValueOnce(outOfDate());
    const user = userEvent.setup();
    render(<ScheduleEventForm warehouses={WAREHOUSES} bundles={[]} initialDate="2026-10-20" />);
    await user.type(screen.getByLabelText('Title'), 'Dock pickup');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'StockPilot was updated since this page was opened, so nothing was changed. Reload the page, then try again.',
      ),
    );
  });

  it('Save changes says the event was not saved', async () => {
    vi.mocked(updateScheduleEventAction).mockRejectedValueOnce(offline());
    render(<ScheduleEventForm warehouses={WAREHOUSES} bundles={[]} defaults={SAVED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(requestFailedMessage(offline(), 'save the event')),
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('Delete event says why inside the confirm, which stays open and can be closed', async () => {
    vi.mocked(deleteScheduleEventAction).mockRejectedValueOnce(offline());
    const user = userEvent.setup();
    render(<ScheduleEventForm warehouses={WAREHOUSES} bundles={[]} defaults={SAVED} />);
    await user.click(screen.getByRole('button', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete event' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      requestFailedMessage(offline(), 'delete the event'),
    );
    expect(push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(updateScheduleEventAction).mockRejectedValueOnce(signInRedirect());
    render(<ScheduleEventForm warehouses={WAREHOUSES} bundles={[]} defaults={SAVED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateScheduleEventAction).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('the event status buttons when the change gets no answer', () => {
  it('Start says the status did not change and works again', async () => {
    vi.mocked(updateScheduleEventAction).mockRejectedValueOnce(offline());
    render(<ScheduleStatusActions eventId="ev-1" currentStatus="scheduled" />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        requestFailedMessage(offline(), 'change the event status'),
      ),
    );
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
