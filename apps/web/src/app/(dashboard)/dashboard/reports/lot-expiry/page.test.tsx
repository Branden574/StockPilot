import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Aging & expiry after the redesign: the shared page header, a count chip per
 * bucket that has lots (Expired, ≤ 7 days, ...), every column, and the
 * expired and within-7-days rows still marked (now on the danger and caution
 * washes), with the bucket words kept in the Status column.
 */

vi.mock('@/lib/reports/report-page-gate', () => ({ reportPageGate: vi.fn(async () => null) }));
const agingReport = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/lots', () => ({
  LotsService: { forCurrentUser: vi.fn(async () => ({ agingReport })) },
}));

import LotExpiryReportPage from './page';

function lot(over: Record<string, unknown>) {
  return {
    itemId: 'i1',
    itemName: 'Hand Sanitizer',
    sku: 'SAN-8OZ-01',
    lotNumber: 'L1',
    effectiveExpiry: '2026-10-01T00:00:00Z',
    remaining: 4,
    bucket: 'ok',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Aging & expiry', () => {
  it('keeps the heading, the explanation and the columns', async () => {
    agingReport.mockResolvedValue([lot({})]);
    render(await LotExpiryReportPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Aging & expiry' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Lots with remaining quantity, earliest expiry first. Remaining nets recorded FEFO picks out of received quantity.',
      ),
    ).toBeInTheDocument();
    for (const col of ['Item', 'Lot #', 'Expiry', 'Status', 'Remaining']) {
      expect(screen.getByRole('columnheader', { name: col })).toBeInTheDocument();
    }
  });

  it('counts each bucket that has lots, in bucket order', async () => {
    agingReport.mockResolvedValue([
      lot({ lotNumber: 'A', bucket: 'ok' }),
      lot({ lotNumber: 'B', bucket: 'expired' }),
      lot({ lotNumber: 'C', bucket: 'expired' }),
      lot({ lotNumber: 'D', bucket: 'le7', effectiveExpiry: null }),
    ]);
    const { container } = render(await LotExpiryReportPage());
    const chips = Array.from(container.querySelectorAll('[data-bucket]')).filter(
      (el) => el.tagName !== 'TR',
    );
    expect(chips.map((c) => c.textContent)).toEqual(['Expired: 2', '≤ 7 days: 1', '> 90 days: 1']);
  });

  it('marks expired and near-expiry rows and keeps the bucket words', async () => {
    agingReport.mockResolvedValue([
      lot({ lotNumber: 'EXP', bucket: 'expired' }),
      lot({ lotNumber: 'SOON', bucket: 'le7' }),
      lot({ lotNumber: 'LATER', bucket: 'le90' }),
    ]);
    render(await LotExpiryReportPage());
    const expired = screen.getByRole('row', { name: /EXP/ });
    expect(expired).toHaveAttribute('data-bucket', 'expired');
    expect(expired.className).toContain('bg-destructive-wash');
    expect(within(expired).getByRole('cell', { name: 'Expired' })).toBeInTheDocument();
    const soon = screen.getByRole('row', { name: /SOON/ });
    expect(soon.className).toContain('bg-warning-wash');
    expect(within(soon).getByRole('cell', { name: '≤ 7 days' })).toBeInTheDocument();
    const later = screen.getByRole('row', { name: /LATER/ });
    expect(later).toHaveAttribute('data-bucket', 'le90');
    expect(later.className).not.toMatch(/(^|\s)bg-(destructive|warning)-wash/);
  });

  it('keeps the empty sentence', async () => {
    agingReport.mockResolvedValue([]);
    render(await LotExpiryReportPage());
    expect(screen.getByText('No lots on hand.')).toBeInTheDocument();
  });
});
