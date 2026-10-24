/**
 * The Purchase orders list is server-rendered, and its Placed and Expected
 * columns printed a day with no fixed time zone: the server's (UTC on Vercel)
 * while it renders, the viewer's while the browser hydrates.
 *
 * Placed is an instant. A purchase order placed at 7:30 PM in Los Angeles is
 * Oct 6 to the server and Oct 5 to the viewer, so React threw error #418.
 * #331 printed the viewer's day once hydrated. Since small fixes slice 8
 * (item H) it is the ORGANIZATION's day, in a fixed zone the page passes, as
 * the server-paged list prints it and as every instant in the app prints
 * (core org-timezone): the same text on the server and in the browser, so it
 * needs no hydration gate, and a viewer outside the organization's zone sees
 * the organization's day.
 *
 * Expected is a DAY the buyer picked, stored as its UTC midnight (po-form and
 * both PO imports). Read in the viewer's zone it was the day before (Oct 9
 * for Oct 10) on every render; read in UTC it is the picked day on the server
 * and in the browser alike, as on the PO's page and PDF.
 */
import { within } from '@testing-library/react';
import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});

import { PoInstantTable, type PoInstantRow } from './po-instant-table';

const T0 = Date.parse('2026-10-06T03:00:00.000Z');

const ROWS: PoInstantRow[] = [
  {
    id: 'po-1',
    po_number: 'PO-DEMO-002',
    supplier_id: 'sup-1',
    status: 'ordered',
    // 7:30 PM on Oct 5 in Los Angeles; Oct 6 in UTC.
    ordered_at: '2026-10-06T02:30:00.000Z',
    created_at: '2026-10-01T17:00:00.000Z',
    // Picked as Oct 10 (the PO form stores the picked day's UTC midnight).
    expected_at: '2026-10-10T00:00:00.000Z',
    line_count: 6,
    total: 100,
  },
  {
    id: 'po-2',
    po_number: 'PO-DEMO-003',
    supplier_id: null,
    status: 'draft',
    ordered_at: null,
    created_at: '2026-10-02T17:00:00.000Z',
    expected_at: null,
    line_count: 1,
    total: 5,
  },
];

function render(timeZone = 'America/Los_Angeles') {
  return (
    <PoInstantTable rows={ROWS} supplierNames={{ 'sup-1': 'TechSource Distributors' }} timeZone={timeZone} />
  );
}

describe('PoInstantTable hydrates with the server in UTC and the browser in Los Angeles', () => {
  it("prints Placed as the organization's day on the server and in the browser, and Expected as the picked day, with no hydration error", async () => {
    const run = await hydrateAcrossClockShift(() => render(), { serverNow: T0, browserNow: T0 + 60_000 });
    try {
      expect(run.errors).toEqual([]);
      // The server prints the organization's Placed day (Los Angeles), never
      // its own UTC day, the picked Expected day, and a dash for a missing date.
      expect(run.html).not.toContain('Oct 6');
      expect(run.html).toContain('Oct 5');
      expect(run.html).toContain('Oct 10');
      const row = within(run.container).getByText('PO-DEMO-002').closest('tr') as HTMLElement;
      expect(within(row).getByText('Oct 5')).toBeInTheDocument();
      expect(within(row).getByText('Oct 10')).toBeInTheDocument();
      expect(within(row).queryByText('Oct 9')).toBeNull();
      const draft = within(run.container).getByText('PO-DEMO-003').closest('tr') as HTMLElement;
      expect(within(draft).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    } finally {
      run.unmount();
    }
  });
});

describe("PoInstantTable prints the organization's day, whoever views it", () => {
  it('a viewer in New York sees the Los Angeles organization\'s day, as the server-paged list prints it', async () => {
    // 11:30 PM on Oct 5 in Los Angeles; 2:30 AM on Oct 6 in New York.
    const late: PoInstantRow = { ...ROWS[0]!, ordered_at: '2026-10-06T06:30:00.000Z' };
    const run = await hydrateAcrossClockShift(
      () => <PoInstantTable rows={[late]} supplierNames={{}} timeZone="America/Los_Angeles" />,
      { serverNow: T0, browserNow: T0 + 60_000, browserZone: 'America/New_York' },
    );
    try {
      expect(run.errors).toEqual([]);
      const row = within(run.container).getByText('PO-DEMO-002').closest('tr') as HTMLElement;
      expect(within(row).getByText('Oct 5')).toBeInTheDocument();
      expect(within(row).queryByText('Oct 6')).toBeNull();
    } finally {
      run.unmount();
    }
  });

  it('an organization in Sydney: its own day', async () => {
    const run = await hydrateAcrossClockShift(() => render('Australia/Sydney'), {
      serverNow: T0,
      browserNow: T0 + 60_000,
    });
    try {
      expect(run.errors).toEqual([]);
      // 1:30 PM on Oct 6 in Sydney.
      const row = within(run.container).getByText('PO-DEMO-002').closest('tr') as HTMLElement;
      expect(within(row).getByText('Oct 6')).toBeInTheDocument();
    } finally {
      run.unmount();
    }
  });
});
