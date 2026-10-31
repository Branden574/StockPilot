import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The platform audit, redesigned as a ledger table (P5.3). Pinned: the gate
 * runs before the read, the newest-200 read and its ?org= filter (only a
 * UUID), the filter note with Show all, the six columns, the action labels
 * with "(superseded)", the target and reason fallbacks, the empty words, and
 * the table living in a keyboard-reachable scroll region.
 */

const h = vi.hoisted(() => ({ order: [] as string[], list: vi.fn() }));

vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: vi.fn(async () => {
    h.order.push('gate');
  }),
}));
vi.mock('@/server/services/platform/audit', async (orig) => {
  const real = await orig<typeof import('@/server/services/platform/audit')>();
  return {
    auditDetailReason: real.auditDetailReason,
    auditDetailSuperseded: real.auditDetailSuperseded,
    listPlatformAudit: (...a: unknown[]) => {
      h.order.push('read');
      return h.list(...a);
    },
  };
});

import PlatformAuditPage from './page';

const ORG = '5eed0000-0001-4000-8000-000000000001';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    createdAt: '2026-09-18T12:00:00Z',
    actorEmail: 'god@stockpilotusa.com',
    actorDeleted: false,
    action: 'user_disabled',
    targetUserId: 'u-1',
    targetUserEmail: 'ada@acme.test',
    targetDeleted: false,
    targetOrganizationId: ORG,
    detail: { reason: 'Security investigation' },
    ...over,
  };
}

async function renderPage(org?: string) {
  const tree = await PlatformAuditPage({ searchParams: Promise.resolve(org ? { org } : {}) });
  return render(tree);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.list.mockResolvedValue([row()]);
});

describe('platform audit', () => {
  it('gates before reading, and reads the newest 200', async () => {
    await renderPage();
    expect(h.order).toEqual(['gate', 'read']);
    expect(h.list).toHaveBeenCalledWith({ limit: 200, organizationId: undefined });
    expect(screen.getByRole('heading', { level: 1, name: 'Platform audit' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Every god-mode action — who, what, against whom, which org, why, when. Append-only, newest first.',
      ),
    ).toBeInTheDocument();
  });

  it('filters to one org only for a UUID, says so, and offers Show all', async () => {
    const { unmount } = await renderPage(ORG);
    expect(h.list).toHaveBeenLastCalledWith({ limit: 200, organizationId: ORG });
    expect(screen.getByText('Filtered to one organization.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Show all' })).toHaveAttribute(
      'href',
      '/platform/audit',
    );
    unmount();

    await renderPage('not-a-uuid');
    expect(h.list).toHaveBeenLastCalledWith({ limit: 200, organizationId: undefined });
    expect(screen.queryByText('Filtered to one organization.')).toBeNull();
  });

  it('keeps the six columns in a keyboard-reachable scroll region', async () => {
    await renderPage();
    const region = screen.getByRole('region', { name: 'Platform audit' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(
      within(region)
        .getAllByRole('columnheader')
        .map((n) => n.textContent),
    ).toEqual(['When', 'Actor', 'Action', 'Target user', 'Reason', 'Target org']);
  });

  it('labels actions, marks a superseded press, and keeps the fallbacks', async () => {
    h.list.mockResolvedValue([
      row({ id: 'a', detail: { reason: 'Security investigation', superseded: true } }),
      row({
        id: 'b',
        action: 'viewed_org',
        actorDeleted: true,
        targetUserEmail: null,
        targetUserId: 'u-9',
        detail: {},
      }),
      row({
        id: 'c',
        action: 'something_new',
        targetUserEmail: null,
        targetUserId: null,
        targetOrganizationId: null,
      }),
    ]);
    await renderPage();
    const region = screen.getByRole('region', { name: 'Platform audit' });
    const [, r0, r1, r2] = within(region).getAllByRole('row') as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    const rows = [r0, r1, r2] as const;
    expect(rows[0]).toHaveTextContent('Disabled account(superseded)');
    expect(within(rows[0]).getByText('Security investigation')).toHaveAttribute(
      'title',
      'Security investigation',
    );
    expect(rows[1]).toHaveTextContent('Viewed org');
    expect(rows[1]).toHaveTextContent('Deleted user · god@stockpilotusa.com');
    expect(within(rows[1]).getByText('u-9')).toHaveAttribute('title', 'u-9');
    expect(rows[2]).toHaveTextContent('something_new');
    expect(within(rows[2]).getAllByText('—').length).toBe(2);
  });

  /**
   * God Admin's Order items access changes (migration 0413) are written by
   * platform_set_permission_exception itself with detail {permission, before,
   * after, target_role}. The row names the action and the change, so a review
   * can see who was moved from what to what without opening the raw detail.
   */
  it('labels an Order items access change and shows what it changed from and to', async () => {
    h.list.mockResolvedValue([
      row({
        id: 'p1',
        action: 'permission_exception_changed',
        detail: {
          permission: 'orders:manage_catalog_visibility',
          before: 'default',
          after: 'deny',
          target_role: 'manager',
        },
      }),
      row({
        id: 'p2',
        action: 'permission_exception_changed',
        detail: { permission: 'orders:manage_catalog_visibility', before: 'odd', after: 1 },
      }),
    ]);
    await renderPage();
    const region = screen.getByRole('region', { name: 'Platform audit' });
    const [, first, second] = within(region).getAllByRole('row') as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(within(first).getByText('Order items access changed')).toBeInTheDocument();
    expect(within(first).getByText('Follow role default → Deny')).toBeInTheDocument();
    expect(first).toHaveTextContent('ada@acme.test');
    // A detail this build cannot read prints the label alone, never a guess.
    expect(within(second).getByText('Order items access changed')).toBeInTheDocument();
    expect(second).not.toHaveTextContent('→');
  });

  it('keeps the empty words', async () => {
    h.list.mockResolvedValue([]);
    await renderPage();
    expect(screen.getByText('No platform-admin actions recorded yet.')).toBeInTheDocument();
  });

  it('prints When in UTC and says so, whatever the server or the row (B9)', async () => {
    // A bare toLocaleString() on the server named no zone, so a 6:30 PM
    // Pacific action read "10/25/2026, 1:30:00 AM" with nothing to say whose
    // clock that was. The trail spans organizations, so it states UTC.
    const original = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      h.list.mockResolvedValue([row({ createdAt: '2026-10-25T01:30:00Z' })]);
      await renderPage();
      const region = screen.getByRole('region', { name: 'Platform audit' });
      const [, first] = within(region).getAllByRole('row') as [HTMLElement, HTMLElement];
      expect(first.firstElementChild).toHaveTextContent(/^25 Oct 2026, 01:30 UTC$/);
      expect(within(region).getByRole('columnheader', { name: 'When' })).toHaveAttribute(
        'title',
        'In UTC.',
      );
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
