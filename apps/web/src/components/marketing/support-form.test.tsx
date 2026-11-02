import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestUnconfirmedMessage } from '@/lib/request-failure';
import {
  offline,
  outOfDate,
  recordEscapedRejections,
  signInRedirect,
} from '@/test/rejected-request';

/**
 * B40: the public support form set `busy`, awaited the action with no catch
 * and cleared `busy` only when it answered. A ticket that got no answer
 * (offline, a server error, a deploy) left the button on "Sending…" for good,
 * with nothing said. A ticket has no rule against a second copy, so the
 * message says to look for the confirmation email before sending again.
 */

const { createTicket, toast } = vi.hoisted(() => ({
  createTicket: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/server/actions/support-tickets', () => ({ createSupportTicketAction: createTicket }));

import { SupportForm } from './support-form';

// A redirect handled by the page leaves nothing behind (see recordEscapedRejections).
const escaped = recordEscapedRejections();

beforeEach(() => {
  vi.clearAllMocks();
});

function fill() {
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'person@example.com' } });
  fireEvent.change(screen.getByLabelText(/^Subject/), { target: { value: 'Scanner question' } });
  fireEvent.change(screen.getByLabelText(/^Details/), {
    target: { value: 'It stops after a scan.' },
  });
}

async function send() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send ticket' }));
  });
}

describe('SupportForm when the ticket gets no answer', () => {
  it('says to look for the confirmation email before sending again, and keeps what was typed', async () => {
    createTicket.mockRejectedValueOnce(offline());
    render(<SupportForm />);
    fill();
    await send();
    expect(toast.error).toHaveBeenCalledWith(
      "We couldn't confirm that your ticket was sent. Check your inbox for our confirmation email before trying again.",
    );
    expect(toast.error).toHaveBeenCalledWith(
      requestUnconfirmedMessage(
        offline(),
        'your ticket was sent',
        'your inbox for our confirmation email',
      ),
    );
    expect(screen.getByLabelText(/^Details/)).toHaveValue('It stops after a scan.');
    expect(screen.queryByText('Ticket received')).not.toBeInTheDocument();
  });

  it('Send ticket works again, and a ticket saved on the next try says Ticket received', async () => {
    createTicket
      .mockRejectedValueOnce(offline())
      .mockResolvedValueOnce({ ok: true, data: { id: 't-1' } });
    render(<SupportForm />);
    fill();
    await send();
    expect(screen.getByRole('button', { name: 'Send ticket' })).toBeEnabled();

    await send();
    expect(createTicket).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Ticket received')).toBeInTheDocument();
  });

  it('a page older than the server says nothing was sent and to reload', async () => {
    createTicket.mockRejectedValueOnce(outOfDate());
    render(<SupportForm />);
    fill();
    await send();
    expect(toast.error).toHaveBeenCalledWith(
      'StockPilot was updated since this page was opened, so nothing was changed. Reload the page, then try again.',
    );
    expect(screen.getByRole('button', { name: 'Send ticket' })).toBeEnabled();
  });

  it('says nothing when the answer is a redirect', async () => {
    createTicket.mockRejectedValueOnce(signInRedirect());
    render(<SupportForm />);
    fill();
    await send();
    await new Promise((r) => setTimeout(r, 20));
    expect(escaped, 'the redirect is handled, never left to escape').toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
