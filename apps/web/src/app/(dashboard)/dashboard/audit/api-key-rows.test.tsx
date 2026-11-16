import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * API key rows on the Audit log: creating and revoking a key write
 * api_key.created (with the key's name and scopes) and api_key.revoked (with
 * its name), entity api_key (server/services/api-keys.ts). The page reads them
 * as "API key", lists them under the Team chip, and shows the stored name and
 * scopes as the row's details, through the real details renderer. Made-up
 * people and keys only.
 */

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'manager',
  })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
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
const auditList = vi.fn();
vi.mock('@/server/services/audit-log', () => ({
  AuditLogService: { forCurrentUser: vi.fn(async () => ({ list: auditList })) },
}));
vi.mock('@/lib/nav-labels', () => ({
  effectiveNavLabel: vi.fn(async (_href: string, fallback: string) => fallback),
}));

import AuditLogPage from './page';

const KEY_ID = '0a1b2c3d-0000-4000-8000-00000000000a';
const actor = { fullName: 'Dana Lee', email: 'dana@example.com', avatarUrl: null };

function row(id: string, event: string, extra: Record<string, unknown>) {
  return {
    id,
    createdAt: '2026-11-15T21:00:00.000Z',
    event,
    ip: null,
    actor,
    actorDeleted: false,
    metadata: {
      entity_type: 'api_key',
      entity_id: KEY_ID,
      warehouse_id: null,
      before: null,
      after: null,
      reason: null,
      ...extra,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auditList.mockResolvedValue({
    rows: [
      row('a1', 'api_key.created', {
        name: 'Warehouse sync',
        scopes: ['items:read', 'stock:read'],
      }),
      row('a2', 'api_key.revoked', { name: 'Warehouse sync' }),
    ],
    total: 2,
  });
});

describe('API key rows on the Audit log', () => {
  it('read API key in the Event and Entity columns, with the name and scopes as details', async () => {
    const { container } = render(
      await AuditLogPage({ searchParams: Promise.resolve({ category: 'user' }) }),
    );
    expect(auditList).toHaveBeenCalledWith(
      expect.objectContaining({ eventPrefixes: ['user.', 'api_key.'] }),
    );
    expect(screen.getByRole('link', { name: 'Team' })).toHaveAttribute('aria-current', 'page');

    const created = container.querySelector('[data-audit-row="a1"]')!;
    expect(within(created as HTMLElement).getByText('API key · Created')).toBeInTheDocument();
    expect(within(created as HTMLElement).getByText('API key')).toBeInTheDocument();
    expect(within(created as HTMLElement).getByText(KEY_ID.slice(0, 8))).toBeInTheDocument();

    const createdDetails = created.nextElementSibling as HTMLElement;
    expect(within(createdDetails).getByText('Show details')).toBeInTheDocument();
    expect(within(createdDetails).getByText('Warehouse sync')).toBeInTheDocument();
    expect(within(createdDetails).getByText('items:read, stock:read')).toBeInTheDocument();

    const revoked = container.querySelector('[data-audit-row="a2"]')!;
    expect(within(revoked as HTMLElement).getByText('API key · Revoked')).toBeInTheDocument();
    const revokedDetails = revoked.nextElementSibling as HTMLElement;
    expect(within(revokedDetails).getByText('Warehouse sync')).toBeInTheDocument();
    expect(within(revokedDetails).queryByText('Scopes:')).toBeNull();
  });

  it('a row with nothing to show gets no details row', async () => {
    auditList.mockResolvedValueOnce({
      rows: [row('a3', 'api_key.revoked', {})],
      total: 1,
    });
    const { container } = render(await AuditLogPage({ searchParams: Promise.resolve({}) }));
    const only = container.querySelector('[data-audit-row="a3"]')!;
    expect(only.nextElementSibling).toBeNull();
    expect(screen.queryByText('Show details')).toBeNull();
  });
});
