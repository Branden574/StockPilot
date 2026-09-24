// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The imports search resolves a term to matching suppliers and POs, and one
 * request can carry only so many of their ids (they share one URL budget).
 * A short term can match more; the list then covers the most recent of them.
 * PoImportsService.searchCapped says when, and the page must say so rather
 * than present a partial list as every match.
 */

const { svc } = vi.hoisted(() => ({
  svc: {
    list: vi.fn(),
    count: vi.fn(),
    searchCapped: vi.fn(),
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

const row = {
  id: 'imp-1',
  display_name: 'Spring order',
  file_name: 'spring.pdf',
  source_type: 'pdf',
  status: 'needs_review',
  superseded_at: null,
  reimported_from_id: null,
  created_at: '2026-09-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  svc.list.mockResolvedValue([row]);
  svc.count.mockResolvedValue(1);
});

describe('PO imports page search', () => {
  it('says when the search covers only the most recent suppliers and POs', async () => {
    svc.searchCapped.mockResolvedValue(true);
    render(await PoImportsPage({ searchParams: Promise.resolve({ q: 'a' }) }));
    expect(svc.searchCapped).toHaveBeenCalledWith('a');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing matches for the most recent suppliers and POs only.',
    );
  });

  it('says nothing when every match fit', async () => {
    svc.searchCapped.mockResolvedValue(false);
    render(await PoImportsPage({ searchParams: Promise.resolve({ q: 'acme' }) }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('asks nothing without a search term', async () => {
    render(await PoImportsPage({ searchParams: Promise.resolve({}) }));
    expect(svc.searchCapped).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
