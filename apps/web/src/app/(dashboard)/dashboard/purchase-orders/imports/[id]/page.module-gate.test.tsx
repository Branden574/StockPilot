// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PO import review keeps the imports list's module gate (P4.C1 fix). With
 * PO imports switched off the service refuses every read (assertModuleEnabled
 * throws a ServiceError that is not not_found), so an old link or notification
 * used to land on the error screen. The page now shows the list's module-off
 * panel and reads nothing; with the module on it reads and renders the review
 * as before.
 */

const { access, svc } = vi.hoisted(() => ({
  access: { current: { enabled: true, canManage: true } },
  svc: {
    get: vi.fn(),
    resolveLineResults: vi.fn(),
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
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => access.current),
}));
// The page reads the organization's zone for the lineage notice
// (page.lineage-timezone.test.tsx covers it).
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-1' })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: vi.fn(async () => ({ timezone: 'America/Los_Angeles' })),
}));
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
  PoImportLineageNotice: () => null,
}));
vi.mock('@/components/po-imports/po-import-rename-button', () => ({
  PoImportRenameButton: () => null,
}));

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { PoImportsService } from '@/server/services/po-imports';

import PoImportDetailPage from './page';

const header = {
  id: 'imp-1',
  display_name: 'Fall order',
  file_name: 'fall.pdf',
  uploaded_by: null,
  source_type: 'pdf',
  status: 'needs_review',
  superseded_at: null,
  reimported_from_id: null,
  parsed_json: null,
  created_at: '2026-09-10T18:00:00Z',
};

async function renderDetail() {
  render(await PoImportDetailPage({ params: Promise.resolve({ id: 'imp-1' }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  access.current = { enabled: true, canManage: true };
  svc.get.mockResolvedValue({
    header,
    lines: [],
    lineage: { predecessor: null, successors: [] },
  });
  svc.resolveLineResults.mockResolvedValue({});
  svc.uploaderProfiles.mockResolvedValue(new Map());
});

describe('PO import review: the po_imports module gate', () => {
  it('shows the module-off panel and reads nothing when PO imports is off', async () => {
    access.current = { enabled: false, canManage: true };
    await renderDetail();

    expect(checkModuleAccess).toHaveBeenCalledWith('po_imports');
    expect(
      screen.getByRole('heading', { level: 1, name: "PO imports isn't enabled" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Enable in Settings → Modules' })).toHaveAttribute(
      'href',
      '/dashboard/settings/modules',
    );
    expect(PoImportsService.forCurrentUser).not.toHaveBeenCalled();
    expect(svc.get).not.toHaveBeenCalled();
    expect(screen.queryByText('import review')).toBeNull();
  });

  it('tells someone who cannot enable modules whom to ask', async () => {
    access.current = { enabled: false, canManage: false };
    await renderDetail();

    expect(screen.getByText('Ask an owner or admin to enable it.')).toBeInTheDocument();
    expect(svc.get).not.toHaveBeenCalled();
  });

  it('reads the import and renders the review when the module is on', async () => {
    await renderDetail();

    expect(svc.get).toHaveBeenCalledWith('imp-1');
    expect(screen.getByRole('heading', { level: 1, name: 'Fall order' })).toBeInTheDocument();
    expect(screen.getByText('import review')).toBeInTheDocument();
  });
});
