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

function setCtx(role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer', permissions?: string[]) {
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
    ...(ctxHolder.current.permissions ? { permissions: ctxHolder.current.permissions } : {}),
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

// The heading reads the org's sidebar rename (Settings > Navigation); with no
// rename it is the page's own title.
const navLabel = vi.hoisted(() => ({ override: null as string | null }));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(
    async (_href: string, fallback: string) => navLabel.override ?? fallback,
  ),
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
  navLabel.override = null;
});

describe('/dashboard/audit (consolidated console)', () => {
  it('viewer without the grant is redirected', async () => {
    setCtx('viewer', ['items:read']);
    await expect(AuditLogPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/dashboard',
    );
    expect(auditList).not.toHaveBeenCalled();
  });

  it('viewer WITH activity_logs:read renders the console', async () => {
    setCtx('viewer', ['activity_logs:read']);
    render(await AuditLogPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    expect(auditList).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 0 }));
  });

  it('manager (static defaults carry activity_logs:read) renders', async () => {
    setCtx('manager');
    render(await AuditLogPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
  });

  it('?category=stock maps onto the eventPrefix filter (admin-console chips parity)', async () => {
    setCtx('manager');
    render(await AuditLogPage({ searchParams: Promise.resolve({ category: 'stock' }) }));
    expect(auditList).toHaveBeenCalledWith(expect.objectContaining({ eventPrefix: 'stock.' }));
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

describe('/dashboard/audit redesign (P5.2): same console, the redesign look', () => {
  const ROW = {
    id: 'a1',
    createdAt: '2026-10-06T02:30:00.000Z',
    event: 'inventory.item.created',
    ip: '10.0.0.1',
    actor: { fullName: 'Dana Lee', email: 'dana@example.com', avatarUrl: null },
    metadata: { entity_type: 'inventory_item', entity_id: '11111111-2222-3333-4444-555555555555' },
  };

  it('a Settings > Navigation rename of Audit log reaches the heading', async () => {
    setCtx('manager');
    navLabel.override = 'Change history';
    render(await AuditLogPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Change history' })).toBeInTheDocument();
  });

  it('marks the active category chip as the current page and keeps every other filter on each chip', async () => {
    setCtx('manager');
    render(
      await AuditLogPage({
        searchParams: Promise.resolve({ category: 'stock', userId: 'u-9', entityId: 'row-1' }),
      }),
    );
    const stock = screen.getByRole('link', { name: 'Stock' });
    expect(stock).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'All events' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Team' })).toHaveAttribute(
      'href',
      '/dashboard/audit?category=user&userId=u-9&entityId=row-1',
    );
  });

  it('is always a table of events with no Export control, and the GET filter form keeps its fields', async () => {
    setCtx('manager');
    auditList.mockResolvedValueOnce({ rows: [ROW], total: 1 } as never);
    const { container } = render(await AuditLogPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Time',
      'Actor',
      'Event',
      'Entity',
      'IP',
    ]);
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /export/i })).toBeNull();
    const form = container.querySelector('form')!;
    expect(form).toHaveAttribute('method', 'GET');
    for (const label of ['Event', 'Actor (user id)', 'Entity type', 'Since', 'Until']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reset' })).toHaveAttribute('href', '/dashboard/audit');
    expect(screen.getByText('1 event · page 1 of 1')).toBeInTheDocument();
    expect(screen.getByText('Dana Lee')).toBeInTheDocument();
  });

  it('keeps the pager words and disables an end with aria-disabled', async () => {
    setCtx('manager');
    auditList.mockResolvedValueOnce({ rows: [ROW], total: 120 } as never);
    render(await AuditLogPage({ searchParams: Promise.resolve({ page: '2' }) }));
    const newer = screen.getAllByRole('link', { name: '← Newer' });
    const older = screen.getAllByRole('link', { name: 'Older →' });
    expect(newer).toHaveLength(2);
    expect(newer[0]).toHaveAttribute('href', '/dashboard/audit');
    expect(newer[0]).toHaveAttribute('aria-disabled', 'false');
    expect(older[0]).toHaveAttribute('href', '/dashboard/audit?page=3');
  });

  it('shows the filtered empty state when filters match nothing', async () => {
    setCtx('manager');
    render(await AuditLogPage({ searchParams: Promise.resolve({ event: 'nope' }) }));
    expect(screen.getByText('No events match these filters')).toBeInTheDocument();
    expect(screen.getByText('No events')).toBeInTheDocument();
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
    await expect(LegacyAdminAuditRedirect({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/dashboard/audit',
    );
  });

  it('/dashboard/settings/audit forwards the full query (Recovery deep-links)', async () => {
    await expect(
      LegacySettingsAuditRedirect({
        searchParams: Promise.resolve({ entityType: 'inventory_item', entityId: 'abc' }),
      }),
    ).rejects.toThrow('redirect:/dashboard/audit?entityType=inventory_item&entityId=abc');
  });
});
