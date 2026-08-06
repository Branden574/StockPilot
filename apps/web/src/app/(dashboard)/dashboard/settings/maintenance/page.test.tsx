import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

// Binding constraint 1: maintenance_requests:configure is owner-only (C2).
// This page's own load-time gate must refuse an admin who lacks an explicit
// per-user override — pinned below alongside the symmetric action gate in
// maintenance-settings.test.ts.
const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: undefined as Set<string> | undefined,
  },
}));

function setCtx(role: typeof ctxHolder.current.role, permissions?: string[]) {
  ctxHolder.current = { role, permissions: permissions ? new Set(permissions) : undefined };
}

const orgModulesResult = vi.hoisted(() => ({
  current: { data: null as { settings: unknown } | null },
}));
const memberRowsResult = vi.hoisted(() => ({
  current: { data: [] as Array<{ user_id: string; user: { full_name?: string; email?: string } | null }> },
}));

function makeSupabase() {
  return {
    from: (table: string) => {
      if (table === 'organization_modules') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => orgModulesResult.current,
              }),
            }),
          }),
        };
      }
      if (table === 'organization_members') {
        return {
          select: () => ({
            eq: () => ({
              not: async () => memberRowsResult.current,
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: ctxHolder.current.role,
    permissions: ctxHolder.current.permissions,
    supabase: makeSupabase(),
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['maintenance_requests']),
  })),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

const panelProps = vi.fn();
vi.mock('@/components/maintenance/maintenance-settings-panel', () => ({
  MaintenanceSettingsPanel: (props: Record<string, unknown>) => {
    panelProps(props);
    return <div data-testid="maintenance-settings-panel" />;
  },
}));

import MaintenanceSettingsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  setCtx('owner');
  orgModulesResult.current = { data: null };
  memberRowsResult.current = { data: [] };
});

describe('configure gate (C2 — mutation self-check 1: admin without the grant cannot load)', () => {
  it('redirects an admin with no explicit override to /dashboard/settings', async () => {
    setCtx('admin');
    await expect(MaintenanceSettingsPage()).rejects.toThrow('redirect:/dashboard/settings');
    expect(panelProps).not.toHaveBeenCalled();
  });

  it('redirects manager, staff, and viewer too', async () => {
    for (const role of ['manager', 'staff', 'viewer'] as const) {
      setCtx(role);
      await expect(MaintenanceSettingsPage()).rejects.toThrow('redirect:/dashboard/settings');
    }
  });

  it('the owner loads the page', async () => {
    setCtx('owner');
    render(await MaintenanceSettingsPage());
    expect(screen.getByTestId('maintenance-settings-panel')).toBeInTheDocument();
  });

  it('an admin WITH an explicit configure override (the real Andrew grant path, in reverse) also loads the page', async () => {
    setCtx('admin', [
      'maintenance_requests:submit',
      'maintenance_requests:read_all',
      'maintenance_requests:manage',
      'maintenance_requests:configure',
    ]);
    render(await MaintenanceSettingsPage());
    expect(screen.getByTestId('maintenance-settings-panel')).toBeInTheDocument();
  });
});

describe('settings load', () => {
  it('falls back to MAINTENANCE_CATEGORIES when no settings row exists', async () => {
    orgModulesResult.current = { data: null };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as { initialCategories: string[] };
    expect(props.initialCategories).toContain('Facilities');
    expect(props.initialCategories.length).toBeGreaterThan(1);
  });

  it('uses configured categories when present', async () => {
    orgModulesResult.current = { data: { settings: { categories: ['Custom A', 'Custom B'] } } };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as { initialCategories: string[] };
    expect(props.initialCategories).toEqual(['Custom A', 'Custom B']);
  });

  it('defaults includeShareLinksInEmail to true when absent', async () => {
    orgModulesResult.current = { data: null };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as { initialIncludeShareLinksInEmail: boolean };
    expect(props.initialIncludeShareLinksInEmail).toBe(true);
  });

  it('respects includeShareLinksInEmail: false when configured', async () => {
    orgModulesResult.current = { data: { settings: { includeShareLinksInEmail: false } } };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as { initialIncludeShareLinksInEmail: boolean };
    expect(props.initialIncludeShareLinksInEmail).toBe(false);
  });

  it('loads the configured notifyAudience map', async () => {
    orgModulesResult.current = {
      data: { settings: { notifyAudience: { 'u-1': 'urgent_only' } } },
    };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as { initialNotifyAudience: Record<string, string> };
    expect(props.initialNotifyAudience).toEqual({ 'u-1': 'urgent_only' });
  });

  it('maps accepted members for the audience rows, falling back to email when no full_name', async () => {
    memberRowsResult.current = {
      data: [
        { user_id: 'u-1', user: { full_name: 'Jane Smith', email: 'jane@example.com' } },
        { user_id: 'u-2', user: { full_name: undefined, email: 'andrew@example.com' } },
      ],
    };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as {
      members: Array<{ userId: string; name: string }>;
    };
    expect(props.members).toEqual([
      { userId: 'u-1', name: 'Jane Smith' },
      { userId: 'u-2', name: 'andrew@example.com' },
    ]);
  });
});
