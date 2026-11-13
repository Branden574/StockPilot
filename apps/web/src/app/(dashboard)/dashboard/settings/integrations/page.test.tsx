import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

// Settings > Integrations hosts two cards: QuickBooks and Sage Intacct (the
// integrations module, Manage integrations) and EasyPost (the shipping module,
// Manage shipping). Whenever a card shows, the page loads the dead-letter view
// of failed exports (ConnectionsService.listFailedSyncs, run here for real).
// Its gate picked the key to assert by the STATIC role and asserted it on the
// effective set, so with both modules on it refused a manager given Manage
// shipping and an admin whose Manage integrations was taken away, and the page
// crashed for both instead of showing the EasyPost card (docket S27).

const ctxHolder = vi.hoisted(() => ({
  role: 'manager' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  permissions: new Set<string>(),
  modules: new Set<string>(['integrations', 'shipping']),
  client: null as unknown,
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: ctxHolder.role,
    permissions: ctxHolder.permissions,
  })),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async (moduleId: string) => ({
    enabled: ctxHolder.modules.has(moduleId),
    canManage: false,
  })),
}));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: ctxHolder.role,
      permissions: ctxHolder.permissions,
      supabase: ctxHolder.client,
      mfaRequired: false,
      mfaSatisfied: true,
      mfaEnrolled: false,
      enabledModules: new Set(ctxHolder.modules),
    })),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ctxHolder.client) }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ writableIds: [] })),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect ${to}`);
  }),
}));
vi.mock('@/server/services/integration-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/integration-events')>()),
  IntegrationEndpointsService: { forCurrentUser: async () => ({ list: async () => [] }) },
}));
vi.mock('@/server/services/api-keys', () => ({
  ApiKeysService: { forCurrentUser: async () => ({ list: async () => [] }) },
}));
vi.mock('@/components/settings/settings-nav', () => ({
  SettingsPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsPanel: ({ title }: { title: string }) => <section>{title}</section>,
}));
vi.mock('@/components/settings/integrations-panel', () => ({
  IntegrationsPanel: (props: {
    showQuickBooks: boolean;
    easyPost: object | null;
    failedSyncs: unknown[] | null;
  }) => (
    <div
      data-testid="integrations-panel"
      data-quickbooks={props.showQuickBooks ? 'shown' : 'hidden'}
      data-easypost={props.easyPost ? 'shown' : 'hidden'}
      data-failed-syncs={
        props.failedSyncs === null ? 'not loaded' : String(props.failedSyncs.length)
      }
    />
  ),
}));
vi.mock('@/components/settings/sage-intacct-card', () => ({
  SageIntacctCard: () => <div data-testid="sage-intacct-card" />,
}));
vi.mock('@/components/settings/webhooks-panel', () => ({
  WebhooksPanel: () => <div data-testid="webhooks-panel" />,
}));
vi.mock('@/components/settings/api-keys-panel', () => ({
  ApiKeysPanel: () => <div data-testid="api-keys-panel" />,
}));

import IntegrationsSettingsPage from './page';

/** The organization's rows, as the member's own client reads them. */
function database() {
  return makeSupabaseStub({
    'org_connections.select': {
      data: [
        { id: 'conn-qbo', provider_id: 'quickbooks', status: 'active', settings: {} },
        { id: 'conn-ep', provider_id: 'easypost', status: 'active', settings: { mode: 'test' } },
      ],
      error: null,
    },
    'connection_sync_log.select': {
      data: [
        {
          id: 'sync-1',
          topic: 'purchase_order.ordered',
          status: 'dead',
          attempts: 8,
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
      error: null,
    },
    'organization_modules.select': { data: [{ enabled: true }], error: null },
  }).client;
}

function as(role: typeof ctxHolder.role, permissions: string[]) {
  ctxHolder.role = role;
  ctxHolder.permissions = new Set(permissions);
}

const panel = () => screen.getByTestId('integrations-panel');

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.modules = new Set(['integrations', 'shipping']);
  ctxHolder.client = database();
});

describe('Settings > Integrations with both modules on', () => {
  it('a manager given only Manage shipping gets the EasyPost card and the dead-letter view', async () => {
    as('manager', ['shipping:manage']);
    render(await IntegrationsSettingsPage());
    expect(panel()).toHaveAttribute('data-easypost', 'shown');
    expect(panel()).toHaveAttribute('data-quickbooks', 'hidden');
    expect(panel()).toHaveAttribute('data-failed-syncs', '1');
    expect(screen.queryByTestId('webhooks-panel')).toBeNull();
  });

  it('an admin whose Manage integrations was taken away gets the EasyPost card; with both keys, both cards (unchanged)', async () => {
    as('admin', ['integrations:manage', 'shipping:manage']);
    const { unmount } = render(await IntegrationsSettingsPage());
    expect(panel()).toHaveAttribute('data-quickbooks', 'shown');
    expect(panel()).toHaveAttribute('data-easypost', 'shown');
    expect(panel()).toHaveAttribute('data-failed-syncs', '1');
    expect(screen.getByTestId('webhooks-panel')).toBeInTheDocument();
    unmount();

    as('admin', ['shipping:manage']);
    render(await IntegrationsSettingsPage());
    expect(panel()).toHaveAttribute('data-quickbooks', 'hidden');
    expect(panel()).toHaveAttribute('data-easypost', 'shown');
    expect(panel()).toHaveAttribute('data-failed-syncs', '1');
    expect(screen.queryByTestId('webhooks-panel')).toBeNull();
  });
});
