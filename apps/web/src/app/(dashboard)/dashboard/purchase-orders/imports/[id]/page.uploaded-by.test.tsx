// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The import detail page says who uploaded the import, beside the source file
 * (owner request 2026-09-24), with the same labels as the list: full name,
 * else email, "Former member" when the profile is no longer readable, "—"
 * when the lookup failed. A failed lookup never takes the page down.
 */

const UPLOADER = '11111111-0000-4000-8000-000000000001';

const { svc, detailProps } = vi.hoisted(() => ({
  svc: {
    get: vi.fn(),
    resolveLineResults: vi.fn(),
    uploaderProfiles: vi.fn(),
  },
  detailProps: { current: null as Record<string, unknown> | null },
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
  PoImportDetail: (props: Record<string, unknown>) => {
    detailProps.current = props;
    return null;
  },
}));
vi.mock('@/components/po-imports/po-import-lineage-notice', () => ({
  PoImportLineageNotice: () => null,
}));
vi.mock('@/components/po-imports/po-import-rename-button', () => ({
  PoImportRenameButton: () => null,
}));

import PoImportDetailPage from './page';

const header = {
  id: 'imp-1',
  display_name: 'Fall order',
  file_name: 'fall.pdf',
  uploaded_by: UPLOADER,
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
  detailProps.current = null;
  svc.get.mockResolvedValue({
    header,
    lines: [],
    lineage: { predecessor: null, successors: [] },
  });
  svc.resolveLineResults.mockResolvedValue({});
  svc.uploaderProfiles.mockResolvedValue(
    new Map([[UPLOADER, { full_name: 'Marissa Lopez', email: 'marissa@cvwest.org' }]]),
  );
});

/** The metadata line under the title. */
const sourceLine = () => screen.getByText(/^Source file: fall\.pdf/);

describe('PO import detail: who uploaded it', () => {
  it('says "Uploaded by <full name>" beside the source file', async () => {
    await renderDetail();
    expect(sourceLine()).toHaveTextContent('Source file: fall.pdf · Uploaded by Marissa Lopez');
    expect(svc.uploaderProfiles).toHaveBeenCalledWith([UPLOADER]);
  });

  it('falls back to the email', async () => {
    svc.uploaderProfiles.mockResolvedValue(
      new Map([[UPLOADER, { full_name: null, email: 'marissa@cvwest.org' }]]),
    );
    await renderDetail();
    expect(sourceLine()).toHaveTextContent('Uploaded by marissa@cvwest.org');
  });

  it('says "Former member" when the profile is no longer readable', async () => {
    svc.uploaderProfiles.mockResolvedValue(new Map());
    await renderDetail();
    expect(sourceLine()).toHaveTextContent('Uploaded by Former member');
    expect(sourceLine()).not.toHaveTextContent(UPLOADER);
  });

  it('shows "—" and still renders the review when the lookup failed', async () => {
    // The service reports the failure and answers null (see the service test).
    svc.uploaderProfiles.mockResolvedValue(null);
    await renderDetail();
    expect(sourceLine()).toHaveTextContent('Uploaded by —');
    expect(screen.getByRole('heading', { name: 'Fall order' })).toBeInTheDocument();
    expect(detailProps.current).not.toBeNull();
  });
});
