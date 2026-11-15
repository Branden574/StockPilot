import { fireEvent, render, screen } from '@testing-library/react';
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

type ReadError = { code: string; message: string };
const orgModulesResult = vi.hoisted(() => ({
  current: {
    data: null as { settings: unknown } | null,
    error: null as { code: string; message: string } | null,
  },
}));
const memberRowsResult = vi.hoisted(() => ({
  current: {
    data: [] as Array<{
      user_id: string;
      user: { full_name?: string; email?: string } | null;
    }> | null,
    error: null as { code: string; message: string } | null,
  },
}));
// A generic transport-style error; nothing about how it arises.
const READ_ERROR: ReadError = { code: '08006', message: 'connection reset' };

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

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  useRouter: () => ({ refresh }),
}));

const reportError = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

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
  orgModulesResult.current = { data: null, error: null };
  memberRowsResult.current = { data: [], error: null };
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

  it('an admin WITH an explicit configure override (the real DC4-lead grant path, in reverse) also loads the page', async () => {
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
    orgModulesResult.current = { data: null, error: null };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as { initialCategories: string[] };
    expect(props.initialCategories).toContain('Facilities');
    expect(props.initialCategories.length).toBeGreaterThan(1);
  });

  it('uses configured categories when present', async () => {
    orgModulesResult.current = {
      data: { settings: { categories: ['Custom A', 'Custom B'] } },
      error: null,
    };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as { initialCategories: string[] };
    expect(props.initialCategories).toEqual(['Custom A', 'Custom B']);
  });

  it('defaults includeShareLinksInEmail to true when absent', async () => {
    orgModulesResult.current = { data: null, error: null };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as { initialIncludeShareLinksInEmail: boolean };
    expect(props.initialIncludeShareLinksInEmail).toBe(true);
  });

  it('respects includeShareLinksInEmail: false when configured', async () => {
    orgModulesResult.current = {
      data: { settings: { includeShareLinksInEmail: false } },
      error: null,
    };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as { initialIncludeShareLinksInEmail: boolean };
    expect(props.initialIncludeShareLinksInEmail).toBe(false);
  });

  it('loads the configured notifyAudience map', async () => {
    orgModulesResult.current = {
      data: { settings: { notifyAudience: { 'u-1': 'urgent_only' } } },
      error: null,
    };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as {
      initialNotifyAudience: Record<string, string>;
    };
    expect(props.initialNotifyAudience).toEqual({ 'u-1': 'urgent_only' });
  });

  it('maps accepted members for the audience rows, falling back to email when no full_name', async () => {
    memberRowsResult.current = {
      data: [
        { user_id: 'u-1', user: { full_name: 'Jane Smith', email: 'jane@example.com' } },
        { user_id: 'u-2', user: { full_name: undefined, email: 'jordan@example.com' } },
      ],
      error: null,
    };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as {
      members: Array<{ userId: string; name: string }>;
    };
    expect(props.members).toEqual([
      { userId: 'u-1', name: 'Jane Smith' },
      { userId: 'u-2', name: 'jordan@example.com' },
    ]);
  });
});

// The panel's Save sends every key at once, so a form seeded from defaults
// while the stored settings could not be read would write those defaults
// over them. An unreadable read shows the failed-read state and no form.
describe('settings read', () => {
  function expectFailedState() {
    expect(screen.getByText("We couldn't load this settings page")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByTestId('maintenance-settings-panel')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(panelProps).not.toHaveBeenCalled();
  }

  it('an unreadable settings row shows the failed-read state with Try again, never the form', async () => {
    orgModulesResult.current = { data: null, error: READ_ERROR };
    render(await MaintenanceSettingsPage());
    expectFailedState();
  });

  it('reports the failed read with its code and nothing from the settings', async () => {
    orgModulesResult.current = { data: null, error: READ_ERROR };
    render(await MaintenanceSettingsPage());
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, context] = reportError.mock.calls[0] as unknown as [
      unknown,
      { tag: string; extra?: Record<string, unknown> },
    ];
    expect(context.tag).toBe('settings.maintenance.read_failed');
    expect(context.extra?.code).toBe('08006');
    expect(JSON.stringify(reportError.mock.calls)).not.toContain('includeShareLinksInEmail');
  });

  it('an unreadable member list shows the failed-read state too', async () => {
    orgModulesResult.current = {
      data: { settings: { includeShareLinksInEmail: false } },
      error: null,
    };
    memberRowsResult.current = { data: null, error: READ_ERROR };
    render(await MaintenanceSettingsPage());
    expectFailedState();
  });

  it('Try again asks the server for the page again', async () => {
    orgModulesResult.current = { data: null, error: READ_ERROR };
    render(await MaintenanceSettingsPage());
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('no row (never configured) opens the form with the defaults', async () => {
    orgModulesResult.current = { data: null, error: null };
    render(await MaintenanceSettingsPage());
    expect(screen.getByTestId('maintenance-settings-panel')).toBeInTheDocument();
    expect(screen.queryByText("We couldn't load this settings page")).not.toBeInTheDocument();
    const props = panelProps.mock.calls[0]?.[0] as {
      initialCategories: string[];
      initialIncludeShareLinksInEmail: boolean;
      initialNotifyAudience: Record<string, string>;
    };
    expect(props.initialCategories.length).toBeGreaterThan(1);
    expect(props.initialIncludeShareLinksInEmail).toBe(true);
    expect(props.initialNotifyAudience).toEqual({});
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a stored row opens the form with its own values', async () => {
    orgModulesResult.current = {
      data: {
        settings: {
          categories: ['Example A', 'Example B'],
          includeShareLinksInEmail: false,
          notifyAudience: { 'u-1': 'none' },
        },
      },
      error: null,
    };
    render(await MaintenanceSettingsPage());
    const props = panelProps.mock.calls[0]?.[0] as {
      initialCategories: string[];
      initialIncludeShareLinksInEmail: boolean;
      initialNotifyAudience: Record<string, string>;
    };
    expect(props.initialCategories).toEqual(['Example A', 'Example B']);
    expect(props.initialIncludeShareLinksInEmail).toBe(false);
    expect(props.initialNotifyAudience).toEqual({ 'u-1': 'none' });
  });
});
