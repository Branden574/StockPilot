import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Audit-surface consolidation (Unit 2): /dashboard/audit is THE one
// grantable audit console — gated on the EFFECTIVE activity_logs:read —
// and both legacy routes (/dashboard/admin/audit, /dashboard/settings/audit)
// redirect onto it with their filters preserved.

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'viewer' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: undefined as ReadonlySet<string> | undefined,
  },
}));

function setCtx(
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  permissions?: string[],
) {
  ctxHolder.current = {
    role,
    permissions: permissions ? new Set(permissions) : undefined,
  };
}

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: ctxHolder.current.role,
    ...(ctxHolder.current.permissions
      ? { permissions: ctxHolder.current.permissions }
      : {}),
  })),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('notFound');
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

const auditList = vi.fn(async () => ({ rows: [], total: 0 }));
vi.mock('@/server/services/audit-log', () => ({
  AuditLogService: {
    forCurrentUser: vi.fn(async () => ({ list: auditList })),
  },
}));

vi.mock('@/components/audit/metadata-diff', () => ({
  MetadataDiff: () => null,
  diffMetadataFields: () => [],
}));

import AuditLogPage from './page';
import LegacyAdminAuditRedirect from '../admin/audit/page';
import LegacySettingsAuditRedirect from '../settings/audit/page';

beforeEach(() => {
  vi.clearAllMocks();
  setCtx('viewer');
});

describe('/dashboard/audit (consolidated console)', () => {
  it('viewer without the grant is redirected', async () => {
    setCtx('viewer', ['items:read']);
    await expect(
      AuditLogPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('redirect:/dashboard');
    expect(auditList).not.toHaveBeenCalled();
  });

  it('viewer WITH activity_logs:read renders the console', async () => {
    setCtx('viewer', ['activity_logs:read']);
    render(await AuditLogPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    expect(auditList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, offset: 0 }),
    );
  });

  it('manager (static defaults carry activity_logs:read) renders', async () => {
    setCtx('manager');
    render(await AuditLogPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
  });

  it('?category=stock maps onto the eventPrefix filter (admin-console chips parity)', async () => {
    setCtx('manager');
    render(
      await AuditLogPage({ searchParams: Promise.resolve({ category: 'stock' }) }),
    );
    expect(auditList).toHaveBeenCalledWith(
      expect.objectContaining({ eventPrefix: 'stock.' }),
    );
  });

  it('settings-era filters (entityType/entityId/page) still drive the query', async () => {
    setCtx('manager');
    render(
      await AuditLogPage({
        searchParams: Promise.resolve({
          entityType: 'inventory_item',
          entityId: 'row-1',
          page: '2',
        }),
      }),
    );
    expect(auditList).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'inventory_item',
        entityId: 'row-1',
        offset: 50,
      }),
    );
  });
});

describe('legacy audit routes redirect onto /dashboard/audit', () => {
  it('/dashboard/admin/audit forwards event + category', async () => {
    await expect(
      LegacyAdminAuditRedirect({
        searchParams: Promise.resolve({ category: 'stock', event: 'stock.adjusted' }),
      }),
    ).rejects.toThrow('redirect:/dashboard/audit?category=stock&event=stock.adjusted');
  });

  it('/dashboard/admin/audit with no filters redirects bare', async () => {
    await expect(
      LegacyAdminAuditRedirect({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('redirect:/dashboard/audit');
  });

  it('/dashboard/settings/audit forwards the full query (Recovery deep-links)', async () => {
    await expect(
      LegacySettingsAuditRedirect({
        searchParams: Promise.resolve({ entityType: 'inventory_item', entityId: 'abc' }),
      }),
    ).rejects.toThrow(
      'redirect:/dashboard/audit?entityType=inventory_item&entityId=abc',
    );
  });
});
