// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Uploaded column shows the date an import was uploaded, not "2 weeks ago"
 * (owner request 2026-09-24), and the date is the ORGANIZATION's calendar day.
 * On a server in UTC an upload at 10:30 PM in California is already the next
 * day, so a date printed in the server's zone would be off by one for every
 * evening upload.
 */

const { svc, org, reportError } = vi.hoisted(() => ({
  reportError: vi.fn(async () => {}),
  svc: {
    list: vi.fn(),
    count: vi.fn(),
    searchCapped: vi.fn(),
    uploaderProfiles: vi.fn(),
  },
  org: {
    row: { timezone: 'America/Los_Angeles' } as { timezone: string | null } | null,
    throws: false,
  },
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1' })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => {
    if (org.throws) throw new Error('getOrgRowForRequest: upstream timeout');
    return org.row;
  }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/server/services/po-imports', () => ({
  PoImportsService: { forCurrentUser: vi.fn(async () => svc) },
}));
vi.mock('@/components/po-imports/po-import-search', () => ({ PoImportSearch: () => null }));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/ui/pagination', () => ({ Pagination: () => null }));

import PoImportsPage from './page';

// 05:30 UTC on Sep 10 is 10:30 PM on Sep 9 in Los Angeles (PDT, UTC-7).
const UPLOADED_AT = '2026-09-10T05:30:00Z';

const row = {
  id: 'imp-1',
  display_name: 'Fall order',
  file_name: 'fall.pdf',
  source_type: 'pdf',
  status: 'approved',
  superseded_at: null,
  reimported_from_id: null,
  created_at: UPLOADED_AT,
};

function uploadedCell() {
  const cell = document.querySelector(`time[datetime="${UPLOADED_AT}"]`);
  if (!cell) throw new Error('no <time> for the upload');
  return cell;
}

beforeEach(() => {
  vi.clearAllMocks();
  org.row = { timezone: 'America/Los_Angeles' };
  org.throws = false;
  svc.list.mockResolvedValue([row]);
  svc.count.mockResolvedValue(1);
  svc.uploaderProfiles.mockResolvedValue(new Map());
  svc.searchCapped.mockResolvedValue(false);
});

describe('PO imports list: the Uploaded column', () => {
  it('shows the calendar date in the org timezone, not the UTC one', async () => {
    render(await PoImportsPage({ searchParams: Promise.resolve({ status: 'approved' }) }));
    const cell = uploadedCell();
    expect(cell).toHaveTextContent(/^Sep 9, 2026$/);
    // The hover carries the time too, in the same zone.
    expect(cell.getAttribute('title')).toMatch(/^Sep 9, 2026, 10:30\sPM$/);
  });

  it('follows the org timezone: a UTC org sees the same upload on Sep 10', async () => {
    org.row = { timezone: 'UTC' };
    render(await PoImportsPage({ searchParams: Promise.resolve({ status: 'approved' }) }));
    expect(uploadedCell()).toHaveTextContent(/^Sep 10, 2026$/);
    expect(uploadedCell().getAttribute('title')).toMatch(/^Sep 10, 2026, 5:30\sAM$/);
  });

  it('never shows relative text', async () => {
    render(await PoImportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText(/\bago\b|last (week|month|year)|yesterday/i)).toBeNull();
  });

  it('keeps the list up when the org row is unreadable, dated in the default zone', async () => {
    org.throws = true;
    render(await PoImportsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('link', { name: 'Fall order' })).toBeInTheDocument();
    // resolveOrgTimezone's fallback is America/Los_Angeles.
    expect(uploadedCell()).toHaveTextContent(/^Sep 9, 2026$/);
    // Reported, not swallowed.
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'po_imports.list.org_timezone_failed',
      level: 'warning',
    });
  });
});
