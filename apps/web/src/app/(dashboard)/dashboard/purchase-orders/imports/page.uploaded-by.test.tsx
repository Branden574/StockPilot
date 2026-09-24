// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Each import on the list says who uploaded it (owner request 2026-09-24),
 * under the upload date: the full name, else the email, "Former member" when
 * the profile is no longer readable, and "—" when the lookup failed. Never a
 * raw id, and a failed lookup never takes the list down.
 *
 * The lookup itself (batched, reported on failure) is pinned in
 * server/services/po-imports.uploader-names.test.ts; this pins what the page
 * does with its answer.
 */

const { svc } = vi.hoisted(() => ({
  svc: {
    list: vi.fn(),
    count: vi.fn(),
    searchCapped: vi.fn(),
    uploaderProfiles: vi.fn(),
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
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
vi.mock('@/server/services/po-imports', () => ({
  PoImportsService: { forCurrentUser: vi.fn(async () => svc) },
}));
vi.mock('@/components/po-imports/po-import-search', () => ({ PoImportSearch: () => null }));
vi.mock('@/components/onboarding/page-tour', () => ({ PageTour: () => null }));
vi.mock('@/components/ui/pagination', () => ({ Pagination: () => null }));

import PoImportsPage from './page';

const MARISSA = '11111111-0000-4000-8000-000000000001';
const CRYSTAL = '11111111-0000-4000-8000-000000000002';
const GONE = '11111111-0000-4000-8000-000000000003';

const row = (id: string, uploadedBy: string) => ({
  id,
  display_name: null,
  file_name: `${id}.pdf`,
  source_type: 'pdf',
  status: 'needs_review',
  superseded_at: null,
  reimported_from_id: null,
  uploaded_by: uploadedBy,
  created_at: '2026-09-10T18:00:00Z',
});

async function renderList() {
  render(await PoImportsPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  svc.list.mockResolvedValue([
    row('imp-1', MARISSA),
    row('imp-2', CRYSTAL),
    row('imp-3', GONE),
    row('imp-4', MARISSA),
  ]);
  svc.count.mockResolvedValue(4);
  svc.searchCapped.mockResolvedValue(false);
  svc.uploaderProfiles.mockResolvedValue(
    new Map([
      [MARISSA, { full_name: 'Marissa Lopez', email: 'marissa@cvwest.org' }],
      [CRYSTAL, { full_name: null, email: 'crystal@cvwest.org' }],
    ]),
  );
});

describe('PO imports list: who uploaded each import', () => {
  it('shows the uploader under the date: name, else email, else "Former member"', async () => {
    await renderList();
    expect(screen.getAllByText('by Marissa Lopez')).toHaveLength(2);
    expect(screen.getByText('by crystal@cvwest.org')).toBeInTheDocument();
    expect(screen.getByText('by Former member')).toBeInTheDocument();
    // The full label is on the hover as well, for a name the cell truncates.
    expect(screen.getByText('by crystal@cvwest.org')).toHaveAttribute(
      'title',
      'Uploaded by crystal@cvwest.org',
    );
  });

  it('looks up the uploaders of the rows on the page, once', async () => {
    await renderList();
    expect(svc.uploaderProfiles).toHaveBeenCalledTimes(1);
    expect(svc.uploaderProfiles).toHaveBeenCalledWith([MARISSA, CRYSTAL, GONE, MARISSA]);
  });

  it('keeps the list up and shows "—" when the lookup failed', async () => {
    // The service reports the failure and answers null (see the service test).
    svc.uploaderProfiles.mockResolvedValue(null);
    await renderList();
    expect(screen.getByRole('link', { name: 'imp-1.pdf' })).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load imports/i)).toBeNull();
    expect(screen.getAllByText('by —')).toHaveLength(4);
    expect(screen.queryByText(/Former member/)).toBeNull();
  });

  it('never prints a raw user id', async () => {
    await renderList();
    const text = document.body.textContent ?? '';
    for (const id of [MARISSA, CRYSTAL, GONE]) expect(text).not.toContain(id);
  });
});
