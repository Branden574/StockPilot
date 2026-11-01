import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestUnconfirmedMessage } from '@/lib/request-failure';
import { offline, outOfDate, signInRedirect } from '@/test/rejected-request';

const refresh = vi.hoisted(() => vi.fn());
// The real unstable_rethrow stays, so isControlFlow recognises a redirect.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({}),
}));

vi.mock('@/server/actions/support-tickets', () => ({
  submitDashboardTicketAction: vi.fn(),
}));

import { submitDashboardTicketAction } from '@/server/actions/support-tickets';

import { SupportTicketForm } from './support-ticket-form';

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:support-preview');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.clearAllMocks();
});

function pickPng(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('#support-screenshot');
  expect(input).not.toBeNull();
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  fireEvent.change(input!, { target: { files: [file] } });
}

describe('SupportTicketForm screenshot preview', () => {
  it('pins the Remove screenshot button over the preview corner (absolute wins over the touch target relative)', () => {
    const { container } = render(<SupportTicketForm userId="user-1" />);
    pickPng(container);

    expect(screen.getByAltText('Screenshot preview')).toHaveAttribute(
      'src',
      'blob:support-preview',
    );
    const remove = screen.getByRole('button', { name: 'Remove screenshot' });
    const classes = remove.className.split(/\s+/);
    expect(classes).toContain('absolute');
    expect(classes).not.toContain('relative');
    expect(classes).toEqual(expect.arrayContaining(['right-1.5', 'top-1.5']));
  });

  it('removes the preview and revokes its object URL when Remove screenshot is pressed', () => {
    const { container } = render(<SupportTicketForm userId="user-1" />);
    pickPng(container);

    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot' }));

    expect(screen.queryByAltText('Screenshot preview')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:support-preview');
  });
});

/**
 * B40: Send to StockPilot cleared its busy flag in a finally with no catch,
 * so a send that got no answer said nothing and the rejection went
 * unhandled. A request sent before the answer was lost is sent twice if it is
 * sent again, so the message says to look at My submissions first, and what
 * was typed stays.
 */
describe('SupportTicketForm when the send gets no answer', () => {
  function fillAndSend() {
    render(<SupportTicketForm userId="user-1" />);
    fireEvent.change(screen.getByLabelText('Subject'), {
      target: { value: 'Scanner beeps twice' },
    });
    fireEvent.change(screen.getByLabelText('Details'), {
      target: { value: 'Every scan on the receiving screen beeps twice.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to StockPilot' }));
  }

  it('keeps what was typed and says to look at My submissions before sending again', async () => {
    vi.mocked(submitDashboardTicketAction).mockRejectedValueOnce(offline());
    fillAndSend();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't confirm that your request was sent. Check My submissions before trying again.",
    );
    expect(screen.getByLabelText('Subject')).toHaveValue('Scanner beeps twice');
    expect(screen.getByLabelText('Details')).toHaveValue(
      'Every scan on the receiving screen beeps twice.',
    );
    expect(screen.getByRole('button', { name: 'Send to StockPilot' })).toBeEnabled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a page older than the server says nothing was changed and to reload first', async () => {
    vi.mocked(submitDashboardTicketAction).mockRejectedValueOnce(outOfDate());
    fillAndSend();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      requestUnconfirmedMessage(outOfDate(), 'your request was sent', 'My submissions'),
    );
  });

  it('says nothing on the way to sign-in', async () => {
    vi.mocked(submitDashboardTicketAction).mockRejectedValueOnce(signInRedirect());
    fillAndSend();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send to StockPilot' })).toBeEnabled(),
    );
    expect(submitDashboardTicketAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
