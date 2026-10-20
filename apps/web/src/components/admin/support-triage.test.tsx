/**
 * Support triage (Admin and the platform console) is server-rendered, and
 * each ticket prints the day it came in with toLocaleDateString(): the
 * server's zone (UTC on Vercel) while it renders, the viewer's while the
 * browser hydrates. An evening ticket in Los Angeles is the next day in UTC,
 * so React threw error #418. The day is printed once the page has hydrated.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { filterChipClass } from '@/components/patterns/chip';
import { hydrateAcrossClockShift, inZone, BROWSER_ZONE } from '@/test/hydration';

import type { SupportTicketRow } from '@/server/services/support-tickets';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const updateTicket = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/support-tickets', () => ({ updateSupportTicketAction: updateTicket }));

import { SupportTriage } from './support-triage';

const T0 = Date.parse('2026-10-06T03:00:00.000Z');
// 7:30 PM on Oct 5 in Los Angeles; Oct 6 in UTC.
const CREATED_AT = '2026-10-06T02:30:00.000Z';

const TICKET: SupportTicketRow = {
  id: 't1',
  organizationId: 'org-1',
  submittedBy: 'u-1',
  name: 'Dana Lee',
  email: 'dana@example.com',
  category: 'bug',
  priority: 'normal',
  subject: 'Scanner stops after one scan',
  message: 'It stops.',
  status: 'open',
  pageUrl: null,
  adminNotes: null,
  attachmentPath: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  resolvedAt: null,
};

describe('SupportTriage hydrates with the server in UTC and the browser in Los Angeles', () => {
  it("prints the viewer's day once hydrated, never the server's, with no hydration error", async () => {
    const serverDay = inZone('UTC', () => new Date(CREATED_AT).toLocaleDateString());
    const viewerDay = inZone(BROWSER_ZONE, () => new Date(CREATED_AT).toLocaleDateString());
    const run = await hydrateAcrossClockShift(() => <SupportTriage tickets={[TICKET]} />, {
      serverNow: T0,
      browserNow: T0 + 60_000,
    });
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).toContain('Scanner stops after one scan');
      expect(run.html).not.toContain(serverDay);
      expect(within(run.container).getByText(viewerDay, { exact: false })).toBeInTheDocument();
    } finally {
      run.unmount();
    }
  });
});

describe('SupportTriage keeps each ticket card working in the redesign', () => {
  const RESOLVED: SupportTicketRow = {
    ...TICKET,
    id: 't2',
    subject: 'Old export question',
    status: 'resolved',
  };

  it('keeps a card’s typed notes and picked status when a filter change hides it and brings it back (CONFLICTS D31)', () => {
    render(<SupportTriage tickets={[TICKET, RESOLVED]} />);

    fireEvent.click(screen.getByRole('button', { name: /Scanner stops after one scan/ }));
    fireEvent.change(screen.getByLabelText('Internal notes'), {
      target: { value: 'Asked for a video of the scanner.' },
    });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'in_progress' } });

    // Resolved hides the open ticket (its card unmounts) ...
    fireEvent.click(screen.getByRole('button', { name: 'Resolved 1' }));
    expect(screen.queryByText('Scanner stops after one scan')).toBeNull();
    // ... and Open brings it back with the edits still there.
    fireEvent.click(screen.getByRole('button', { name: 'Open 1' }));
    // The card comes back still expanded (one open card is remembered across
    // filters, as before).
    expect(screen.getByRole('button', { name: /Scanner stops after one scan/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByLabelText('Internal notes')).toHaveValue(
      'Asked for a video of the scanner.',
    );
    expect(screen.getByLabelText('Status')).toHaveValue('in_progress');
  });

  it('after a successful save the server’s values replace the draft, so a later change elsewhere shows', async () => {
    refresh.mockClear();
    updateTicket.mockReset();
    updateTicket.mockResolvedValue({ ok: true, data: null });
    const { rerender } = render(<SupportTriage tickets={[TICKET]} />);

    fireEvent.click(screen.getByRole('button', { name: /Scanner stops after one scan/ }));
    fireEvent.change(screen.getByLabelText('Internal notes'), {
      target: { value: '  Asked for a video of the scanner.  ' },
    });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(updateTicket).toHaveBeenCalledWith({
      id: 't1',
      status: 'open',
      priority: 'high',
      adminNotes: '  Asked for a video of the scanner.  ',
    });

    // The refreshed ticket: the service trimmed the notes, and another
    // platform admin has since raised the priority on /platform/support.
    rerender(
      <SupportTriage
        tickets={[
          { ...TICKET, adminNotes: 'Asked for a video of the scanner.', priority: 'urgent' },
        ]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Internal notes')).toHaveValue(
        'Asked for a video of the scanner.',
      ),
    );
    expect(screen.getByLabelText('Priority')).toHaveValue('urgent');
    expect(screen.getByLabelText('Status')).toHaveValue('open');
  });

  it('keeps notes typed while the save is on its way: they were not sent, so they stay as the draft', async () => {
    refresh.mockClear();
    updateTicket.mockReset();
    let answer: (value: { ok: true; data: null }) => void = () => {};
    updateTicket.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { rerender } = render(<SupportTriage tickets={[TICKET]} />);

    fireEvent.click(screen.getByRole('button', { name: /Scanner stops after one scan/ }));
    const notes = screen.getByLabelText('Internal notes');
    fireEvent.change(notes, { target: { value: 'Asked for a video.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    fireEvent.change(notes, { target: { value: 'Asked for a video. It arrived.' } });

    answer({ ok: true, data: null });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(updateTicket).toHaveBeenCalledWith(
      expect.objectContaining({ adminNotes: 'Asked for a video.' }),
    );
    rerender(<SupportTriage tickets={[{ ...TICKET, adminNotes: 'Asked for a video.' }]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(screen.getByLabelText('Internal notes')).toHaveValue('Asked for a video. It arrived.');
  });

  it('names each filter chip with its count, marks the pressed one, and says "No tickets here." without an emoji', () => {
    render(<SupportTriage tickets={[TICKET]} />);
    expect(screen.getByRole('button', { name: 'Open 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All 1' })).toHaveAttribute('aria-pressed', 'false');
    // Look-only (review 1b): the 30 px movement-type chips (DESIGN-SPEC 6.6),
    // read from the chip pattern's export.
    expect(screen.getByRole('button', { name: 'Open 1' })).toHaveClass(
      ...filterChipClass({ active: true, size: 'md' }).split(/\s+/),
    );
    expect(screen.getByRole('button', { name: 'All 1' })).toHaveClass(
      ...filterChipClass({ size: 'md' }).split(/\s+/),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Closed 0' }));
    const empty = screen.getByText('No tickets here.');
    expect(empty).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('expands one ticket at a time and says so with aria-expanded; the reply link keeps its mailto', () => {
    render(<SupportTriage tickets={[TICKET]} />);
    const toggle = screen.getByRole('button', { name: /Scanner stops after one scan/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Reply by email' })).toHaveAttribute(
      'href',
      `mailto:dana@example.com?subject=Re: ${encodeURIComponent('Scanner stops after one scan')}`,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
