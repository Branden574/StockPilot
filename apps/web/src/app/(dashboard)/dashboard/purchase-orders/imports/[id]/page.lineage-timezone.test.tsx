// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The review's lineage notice dates a later import of the same file as a
 * calendar day in the ORGANIZATION's zone (it said "2 weeks ago"). The page
 * resolves that zone from the request-cached org row, the same read the imports
 * list makes for its Uploaded column. A row that cannot be read falls back to
 * the documented default zone and is reported; it never takes the review down.
 */

const { svc, org, reportError, noticeProps } = vi.hoisted(() => ({
  reportError: vi.fn(async () => {}),
  svc: {
    get: vi.fn(),
    resolveLineResults: vi.fn(),
    uploaderProfiles: vi.fn(),
  },
  org: {
    row: { timezone: 'America/New_York' } as { timezone: string | null } | null,
    throws: false,
  },
  noticeProps: { current: null as Record<string, unknown> | null },
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
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
vi.mock('@/server/services/context', () => ({
  ServiceError: class ServiceError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('@/server/services/po-imports', () => ({
  PoImportsService: { forCurrentUser: vi.fn(async () => svc) },
}));
vi.mock('@/server/services/suppliers', () => ({
  SuppliersService: { forCurrentUser: vi.fn(async () => ({ listForLookups: async () => [] })) },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: { forCurrentUser: vi.fn(async () => ({ listNames: async () => [] })) },
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ listForMatching: async () => [] })) },
}));
vi.mock('@/server/services/charters', () => ({
  ChartersService: { forCurrentUser: vi.fn(async () => ({ list: async () => [] })) },
}));
vi.mock('@/server/services/locations', () => ({
  LocationsService: { forCurrentUser: vi.fn(async () => ({ list: async () => [] })) },
}));
vi.mock('@/server/services/categories', () => ({
  CategoriesService: { forCurrentUser: vi.fn(async () => ({ list: async () => [] })) },
}));
vi.mock('@/components/po-imports/po-import-detail', () => ({
  PoImportDetail: () => <p>import review</p>,
}));
vi.mock('@/components/po-imports/po-import-lineage-notice', () => ({
  PoImportLineageNotice: (props: Record<string, unknown>) => {
    noticeProps.current = props;
    return null;
  },
}));
vi.mock('@/components/po-imports/po-import-rename-button', () => ({
  PoImportRenameButton: () => null,
}));

import PoImportDetailPage from './page';

const header = {
  id: 'imp-1',
  display_name: null,
  file_name: 'fall.pdf',
  uploaded_by: null,
  source_type: 'pdf',
  status: 'approved',
  superseded_at: '2026-09-10T02:30:00Z',
  reimported_from_id: null,
  parsed_json: null,
  created_at: '2026-09-01T18:00:00Z',
};

async function renderDetail() {
  render(await PoImportDetailPage({ params: Promise.resolve({ id: 'imp-1' }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  noticeProps.current = null;
  org.row = { timezone: 'America/New_York' };
  org.throws = false;
  svc.get.mockResolvedValue({ header, lines: [], lineage: { predecessor: null, successors: [] } });
  svc.resolveLineResults.mockResolvedValue({});
  svc.uploaderProfiles.mockResolvedValue(new Map());
});

describe('PO import review: the lineage notice is dated in the organization zone', () => {
  it("hands the notice the organization's own zone", async () => {
    await renderDetail();
    expect(noticeProps.current).toMatchObject({ timeZone: 'America/New_York' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('falls back to the default zone when the stored zone is not one the runtime knows', async () => {
    org.row = { timezone: 'Mars/Olympus_Mons' };
    await renderDetail();
    expect(noticeProps.current).toMatchObject({ timeZone: 'America/Los_Angeles' });
  });

  it('falls back to the default zone, reports it and still renders the review when the org row cannot be read', async () => {
    org.throws = true;
    await renderDetail();
    expect(noticeProps.current).toMatchObject({ timeZone: 'America/Los_Angeles' });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'po_imports.detail.org_timezone_failed',
      level: 'warning',
    });
    expect(screen.getByText('import review')).toBeInTheDocument();
  });
});
