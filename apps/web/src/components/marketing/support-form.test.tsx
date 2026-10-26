import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFailedMessage } from '@/lib/request-failure';
import { offline } from '@/test/rejected-request';

/**
 * B40: the public support form set `busy`, awaited the action with no catch
 * and cleared `busy` only when it answered. A ticket that got no answer
 * (offline, a server error, a deploy) left the button on "Sending…" for good,
 * with nothing said.
 */

const { createTicket, toast } = vi.hoisted(() => ({
  createTicket: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/server/actions/support-tickets', () => ({ createSupportTicketAction: createTicket }));

import { SupportForm } from './support-form';

beforeEach(() => {
  vi.clearAllMocks();
});

function fillAndSend() {
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'person@example.com' } });
  fireEvent.change(screen.getByLabelText(/^Subject/), { target: { value: 'Scanner question' } });
  fireEvent.change(screen.getByLabelText(/^Details/), {
    target: { value: 'It stops after a scan.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send ticket' }));
}

describe('SupportForm when the ticket gets no answer', () => {
  it('says the ticket was not sent, keeps what was typed, and Send ticket works again', async () => {
    createTicket.mockRejectedValueOnce(offline());
    render(<SupportForm />);
    await act(async () => {
      fillAndSend();
    });
    expect(toast.error).toHaveBeenCalledWith(requestFailedMessage('send your ticket'));
    expect(screen.getByRole('button', { name: 'Send ticket' })).toBeEnabled();
    expect(screen.getByLabelText(/^Details/)).toHaveValue('It stops after a scan.');
    expect(screen.queryByText('Ticket received')).not.toBeInTheDocument();
  });

  it('still says Ticket received when the ticket is saved', async () => {
    createTicket.mockResolvedValueOnce({ ok: true, data: { id: 't-1' } });
    render(<SupportForm />);
    await act(async () => {
      fillAndSend();
    });
    expect(screen.getByText('Ticket received')).toBeInTheDocument();
  });
});
