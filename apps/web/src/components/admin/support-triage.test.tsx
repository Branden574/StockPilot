/**
 * Support triage (Admin and the platform console) is server-rendered, and
 * each ticket prints the day it came in with toLocaleDateString(): the
 * server's zone (UTC on Vercel) while it renders, the viewer's while the
 * browser hydrates. An evening ticket in Los Angeles is the next day in UTC,
 * so React threw error #418. The day is printed once the page has hydrated.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift, inZone, BROWSER_ZONE } from '@/test/hydration';

import type { SupportTicketRow } from '@/server/services/support-tickets';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/support-tickets', () => ({ updateSupportTicketAction: vi.fn() }));

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

  it('names each filter chip with its count, marks the pressed one, and says "No tickets here." without an emoji', () => {
    render(<SupportTriage tickets={[TICKET]} />);
    expect(screen.getByRole('button', { name: 'Open 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All 1' })).toHaveAttribute('aria-pressed', 'false');
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
