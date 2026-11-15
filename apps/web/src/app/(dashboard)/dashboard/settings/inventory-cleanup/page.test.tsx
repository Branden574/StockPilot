import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Inventory cleanup page reads the inventory module's settings row and
 * seeds both panels from it. Each panel saves its whole setting (on or off and
 * its number of days), so panels seeded from defaults while the row could not
 * be read would write those defaults over what is stored. An unreadable row
 * shows the failed-read state and no panel.
 */

const ctxHolder = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'manager' }));

const modResult = vi.hoisted(() => ({
  current: {
    data: null as { settings: unknown } | null,
    error: null as { code: string; message: string } | null,
  },
}));
const READ_ERROR = { code: '08006', message: 'connection reset' };

/** Tables the page asked for, in order: a failed settings read reads nothing else. */
const tablesRead = vi.hoisted(() => [] as string[]);

function countQuery() {
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'not', 'lte']) q[m] = () => q;
  q.then = (resolve: (v: { count: number; error: null }) => unknown) =>
    resolve({ count: 3, error: null });
  return q;
}

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'user-1',
    role: ctxHolder.role,
    permissions: undefined,
    supabase: {
      from: (table: string) => {
        tablesRead.push(table);
        if (table === 'organization_modules') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => modResult.current,
                }),
              }),
            }),
          };
        }
        if (table === 'inventory_items') return { select: () => countQuery() };
        throw new Error(`unexpected table ${table}`);
      },
    },
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  })),
}));

const countEligible = vi.hoisted(() => vi.fn(async () => 2));
vi.mock('@/server/services/auto-archive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/auto-archive')>();
  return { ...actual, countEligibleForAutoArchive: countEligible };
});

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  useRouter: () => ({ refresh }),
  usePathname: () => '/dashboard/settings/inventory-cleanup',
}));

const reportError = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

const panelProps = vi.hoisted(() => ({ archive: vi.fn(), cleanup: vi.fn() }));
vi.mock('@/components/settings/auto-archive-panel', () => ({
  AutoArchivePanel: (p: Record<string, unknown>) => {
    panelProps.archive(p);
    return <div data-testid="auto-archive-panel" />;
  },
}));
vi.mock('@/components/settings/archive-cleanup-panel', () => ({
  ArchiveCleanupPanel: (p: Record<string, unknown>) => {
    panelProps.cleanup(p);
    return <div data-testid="archive-cleanup-panel" />;
  },
}));

import InventoryCleanupSettingsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  tablesRead.length = 0;
  ctxHolder.role = 'owner';
  modResult.current = { data: null, error: null };
});

describe('inventory cleanup settings read', () => {
  it('an unreadable settings row shows the failed-read state with Try again, never a panel', async () => {
    modResult.current = { data: null, error: READ_ERROR };
    render(await InventoryCleanupSettingsPage());
    expect(screen.getByText("We couldn't load this settings page")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByTestId('auto-archive-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('archive-cleanup-panel')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(panelProps.archive).not.toHaveBeenCalled();
    expect(panelProps.cleanup).not.toHaveBeenCalled();
    expect(countEligible).not.toHaveBeenCalled();
    expect(tablesRead).toEqual(['organization_modules']);
  });

  it('reports the failed read with its code', async () => {
    modResult.current = { data: null, error: READ_ERROR };
    render(await InventoryCleanupSettingsPage());
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, context] = reportError.mock.calls[0] as unknown as [
      unknown,
      { tag: string; extra?: Record<string, unknown> },
    ];
    expect(context.tag).toBe('settings.inventory_cleanup.read_failed');
    expect(context.extra?.code).toBe('08006');
  });

  it('Try again asks the server for the page again', async () => {
    modResult.current = { data: null, error: READ_ERROR };
    render(await InventoryCleanupSettingsPage());
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('no row (never configured) opens both panels with the defaults', async () => {
    modResult.current = { data: null, error: null };
    render(await InventoryCleanupSettingsPage());
    expect(screen.getByTestId('auto-archive-panel')).toBeInTheDocument();
    expect(screen.getByTestId('archive-cleanup-panel')).toBeInTheDocument();
    expect(screen.queryByText("We couldn't load this settings page")).not.toBeInTheDocument();
    expect(panelProps.archive.mock.calls[0]?.[0]).toMatchObject({
      initial: { enabled: false, dwellDays: 7 },
      eligibleCount: 2,
    });
    expect(panelProps.cleanup.mock.calls[0]?.[0]).toMatchObject({
      initial: { enabled: false, days: 90 },
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a stored row opens both panels with its own values', async () => {
    modResult.current = {
      data: {
        settings: {
          autoArchiveOnZeroStock: { enabled: true, dwellDays: 30 },
          autoDeleteArchived: { enabled: true, days: 180 },
        },
      },
      error: null,
    };
    render(await InventoryCleanupSettingsPage());
    expect(panelProps.archive.mock.calls[0]?.[0]).toMatchObject({
      initial: { enabled: true, dwellDays: 30 },
    });
    expect(panelProps.cleanup.mock.calls[0]?.[0]).toMatchObject({
      initial: { enabled: true, days: 180 },
    });
    expect(countEligible).toHaveBeenCalledWith(expect.anything(), 30);
  });

  it('a manager (no delete permission) sees only the auto-archive panel', async () => {
    ctxHolder.role = 'manager';
    render(await InventoryCleanupSettingsPage());
    expect(screen.getByTestId('auto-archive-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('archive-cleanup-panel')).not.toBeInTheDocument();
  });
});
