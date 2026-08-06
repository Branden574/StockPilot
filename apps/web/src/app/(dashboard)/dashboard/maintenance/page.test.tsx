import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';
import { MAINTENANCE_STATUS_LABELS } from '@stockpilot/core';

// This page is the first surface an ordinary employee sees for maintenance
// requests, so these tests pin the product rules that matter most: (1) the
// server — not the URL — decides scope (a plain-submit member asking for
// ?scope=all must still get their own list); (2) the module gate refuses the
// page, not just hides the nav entry; (3) the brief section 22 informational
// note renders VERBATIM and the section 20 forbidden vocabulary never does.

const ctxHolder = vi.hoisted(() => ({
  current: {
    role: 'staff' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
    permissions: undefined as Set<string> | undefined,
  },
}));

function setCtx(role: typeof ctxHolder.current.role, permissions?: string[]) {
  ctxHolder.current = { role, permissions: permissions ? new Set(permissions) : undefined };
}

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: ctxHolder.current.role,
    permissions: ctxHolder.current.permissions,
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['maintenance_requests']),
  })),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  // Client hooks used by embedded client components (MaintenanceSearch,
  // Pagination) — same stub shape as auditor-read-gates.test.tsx.
  usePathname: () => '/dashboard/maintenance',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const moduleAccess = vi.hoisted(() => ({ current: { enabled: true, canManage: false } }));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => moduleAccess.current),
}));
const moduleNotEnabledProps = vi.fn();
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: (props: Record<string, unknown>) => {
    moduleNotEnabledProps(props);
    return <div data-testid="module-not-enabled" />;
  },
}));

const list = vi.fn();
vi.mock('@/server/services/maintenance-requests', () => ({ MaintenanceRequestsService: vi.fn() }));

import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

import MaintenancePage from './page';

const NOTE =
  'Ticket updates and replies are handled through the Outlook/Zendesk email conversation and are not synchronized into StockPilot.';

const FORBIDDEN = [
  'Ticket created',
  'Request submitted to Zendesk',
  'DC4 notified',
  'Andrew notified',
  'Ticket assigned',
  'Email sent',
];

/** One row per MaintenanceRequestListRow (server/services/maintenance-requests.ts). */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'r-1',
    requestNumber: 42,
    createdAt: '2026-08-01T12:00:00Z',
    subject: 'AC not working in Room 204',
    status: 'saved',
    priority: 'high',
    category: 'Heating or air conditioning',
    siteName: 'Fresno Warehouse DC4',
    requesterName: 'Jane Smith',
    requesterUserId: 'u-1',
    photoCount: 0,
    draftOpened: false,
    localOwnerUserId: null,
    ...overrides,
  };
}

function args(sp: Record<string, string | undefined> = {}) {
  return { searchParams: Promise.resolve(sp) };
}

beforeEach(() => {
  vi.clearAllMocks();
  setCtx('staff');
  moduleAccess.current = { enabled: true, canManage: false };
  list.mockReset();
  list.mockResolvedValue([]);
  vi.mocked(MaintenanceRequestsService).mockImplementation(
    () => ({ list }) as unknown as InstanceType<typeof MaintenanceRequestsService>,
  );
});

describe('module gate', () => {
  it('refuses the page (not just hides nav) when the module is disabled', async () => {
    moduleAccess.current = { enabled: false, canManage: true };
    render(await MaintenancePage(args()));
    expect(screen.getByTestId('module-not-enabled')).toBeInTheDocument();
    expect(moduleNotEnabledProps).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'maintenance_requests', canManage: true }),
    );
    expect(list).not.toHaveBeenCalled();
  });
});

describe('permission gate', () => {
  it('redirects a caller with none of submit/read_all/manage', async () => {
    setCtx('viewer', []);
    await expect(MaintenancePage(args())).rejects.toThrow('redirect:/dashboard');
    expect(list).not.toHaveBeenCalled();
  });
});

describe('scope — server decides, not the URL (mutation target: dropping this must fail a test)', () => {
  it('staff (submit-only) always gets scope=mine, even when the URL asks for scope=all', async () => {
    setCtx('staff');
    render(await MaintenancePage(args({ scope: 'all' })));
    expect(screen.getByRole('heading', { name: 'My maintenance requests' })).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ scope: 'mine' }));
    // No "All requests" link at all — not just an inactive one.
    expect(screen.queryByRole('link', { name: 'All requests' })).not.toBeInTheDocument();
  });

  it('manager (read_all) sees the All requests link and can switch to it', async () => {
    setCtx('manager');
    render(await MaintenancePage(args({ scope: 'all' })));
    expect(screen.getByRole('heading', { name: 'All maintenance requests' })).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ scope: 'all' }));
    expect(screen.getByRole('link', { name: 'All requests' })).toHaveAttribute('aria-current', 'page');
  });

  it('manager defaults to scope=mine with no query param', async () => {
    setCtx('manager');
    render(await MaintenancePage(args()));
    expect(screen.getByRole('heading', { name: 'My maintenance requests' })).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ scope: 'mine' }));
  });
});

describe('accurate status language (brief sections 20 + 22)', () => {
  it('renders the section 22 note verbatim', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([row()]);
    render(await MaintenancePage(args()));
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it('never renders forbidden vocabulary anywhere on the page', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([
      row({ status: 'draft_opened' }),
      row({ id: 'r-2', status: 'saved' }),
      row({ id: 'r-3', status: 'archived' }),
      row({ id: 'r-4', status: 'cancelled' }),
    ]);
    const { container } = render(await MaintenancePage(args()));
    const text = container.textContent ?? '';
    for (const banned of FORBIDDEN) {
      expect(text).not.toContain(banned);
    }
  });
});

describe('rows + table shape', () => {
  it('renders the request as a link using the MR-YYYY-###### handle', async () => {
    setCtx('staff');
    list.mockResolvedValueOnce([row()]);
    render(await MaintenancePage(args()));
    expect(screen.getByRole('link', { name: 'MR-2026-000042' })).toHaveAttribute(
      'href',
      '/dashboard/maintenance/r-1',
    );
  });

  it('shows the Requester column only in the all-scope view', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([row()]);
    render(await MaintenancePage(args({ scope: 'mine' })));
    expect(screen.queryByRole('columnheader', { name: 'Requester' })).not.toBeInTheDocument();

    list.mockResolvedValueOnce([row()]);
    render(await MaintenancePage(args({ scope: 'all' })));
    expect(screen.getByRole('columnheader', { name: 'Requester' })).toBeInTheDocument();
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
  });

  it('renders the status badge with the sanctioned label', async () => {
    setCtx('staff');
    list.mockResolvedValueOnce([row({ status: 'draft_opened' })]);
    render(await MaintenancePage(args()));
    // Scoped to the table: the same label also appears as a status-filter
    // pill in the toolbar (that's a separate, deliberate occurrence).
    const table = screen.getByRole('table');
    expect(within(table).getByText('Email draft opened')).toBeInTheDocument();
  });
});

describe('search — read_all/manage affordance only (brief section 22)', () => {
  it('does not render a search box on the mine scope', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([row()]);
    render(await MaintenancePage(args({ scope: 'mine' })));
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
  });

  it('renders a search box on the all scope for a read_all/manage caller', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([row()]);
    render(await MaintenancePage(args({ scope: 'all' })));
    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('forwards q to the service, trimmed', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([]);
    render(await MaintenancePage(args({ scope: 'all', q: '  broken light  ' })));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: 'broken light' }));
  });

  it('server-side gate: submit-only caller with ?q=sneaky does NOT pass q to the service (FIX 1)', async () => {
    setCtx('staff');
    list.mockResolvedValueOnce([]);
    render(await MaintenancePage(args({ q: 'sneaky' })));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: undefined }));
  });
});

describe('status filter', () => {
  it('forwards a recognized status to the service', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([]);
    render(await MaintenancePage(args({ scope: 'all', status: 'archived' })));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ status: 'archived' }));
    expect(screen.getByRole('link', { name: 'Archived' })).toHaveAttribute('aria-current', 'page');
  });

  it('drops a garbage status param rather than forwarding it', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([]);
    render(await MaintenancePage(args({ scope: 'all', status: 'deleted-forever' })));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ status: undefined }));
  });

  it('derives pill labels from MAINTENANCE_STATUS_LABELS to prevent drift (FIX 2)', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([]);
    render(await MaintenancePage(args({ scope: 'all' })));
    // Assert that the rendered pill label for 'archived' matches MAINTENANCE_STATUS_LABELS,
    // and also literal-pin the expected string so both a constant change and a derivation
    // break are caught by this test.
    const archivedPill = screen.getByRole('link', { name: 'Archived' });
    expect(archivedPill).toHaveTextContent(MAINTENANCE_STATUS_LABELS.archived);
    expect(MAINTENANCE_STATUS_LABELS.archived).toBe('Archived');
  });
});

describe('pagination (list() has no count() sibling — hasNext via one extra fetched row)', () => {
  it('requests limit=PAGE_SIZE+1 at offset 0 on page 1', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([]);
    render(await MaintenancePage(args({ scope: 'all' })));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 26, offset: 0 }));
  });

  it('a full extra row enables Next and trims the visible rows to PAGE_SIZE', async () => {
    setCtx('manager');
    const rows = Array.from({ length: 26 }, (_, i) => row({ id: `r-${i}`, requestNumber: i + 1 }));
    list.mockResolvedValueOnce(rows);
    render(await MaintenancePage(args({ scope: 'all' })));
    // 25 rows rendered (26th was the over-fetch sentinel), Next enabled.
    expect(screen.getAllByRole('row')).toHaveLength(1 + 25); // header + 25 body rows
    const next = screen.getByRole('link', { name: /Next/ });
    expect(next).toHaveAttribute('href', expect.stringContaining('page=2'));
  });

  it('page=2 computes offset=PAGE_SIZE', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([]);
    render(await MaintenancePage(args({ scope: 'all', page: '2' })));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 26, offset: 25 }));
  });

  it('a non-numeric page param clamps to page 1', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([]);
    render(await MaintenancePage(args({ scope: 'all', page: 'nope' })));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
  });

  it('page-2 link href contains active status and q params (FIX 3)', async () => {
    setCtx('manager');
    const rows = Array.from({ length: 26 }, (_, i) => row({ id: `r-${i}`, requestNumber: i + 1 }));
    list.mockResolvedValueOnce(rows);
    render(await MaintenancePage(args({ scope: 'all', status: 'saved', q: 'broken light' })));
    const next = screen.getByRole('link', { name: /Next/ });
    const href = next.getAttribute('href') ?? '';
    expect(href).toContain('page=2');
    expect(href).toContain('status=saved');
    expect(href).toContain('q=broken');
  });
});

describe('empty states', () => {
  it('genuinely empty (no filters, page 1): CTA shown for a submitter', async () => {
    setCtx('staff');
    list.mockResolvedValueOnce([]);
    render(await MaintenancePage(args()));
    expect(screen.getByText('No maintenance requests')).toBeInTheDocument();
    // Header CTA + the empty-state's own (differently worded) CTA — both
    // are submit affordances, never the same accessible name twice.
    expect(screen.getByRole('link', { name: 'New maintenance request' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create your first maintenance request' })).toBeInTheDocument();
  });

  it('active filters + zero rows: "No matches" with a Clear filters link, not the genuine-empty copy', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([]);
    render(await MaintenancePage(args({ scope: 'all', q: 'nonexistent thing' })));
    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toBeInTheDocument();
    expect(screen.queryByText('No maintenance requests')).not.toBeInTheDocument();
  });
});

describe('New maintenance request CTA — gated on submit, matching the auditor-visibility precedent of hiding write CTAs from read-only holders', () => {
  it('a read_all-only caller (no submit) does not see the CTA', async () => {
    setCtx('manager', ['maintenance_requests:read_all']);
    list.mockResolvedValueOnce([row()]);
    render(await MaintenancePage(args({ scope: 'all' })));
    expect(screen.queryByRole('link', { name: 'New maintenance request' })).not.toBeInTheDocument();
  });

  it('a submit holder sees the CTA', async () => {
    setCtx('staff');
    list.mockResolvedValueOnce([row()]);
    render(await MaintenancePage(args()));
    expect(screen.getByRole('link', { name: 'New maintenance request' })).toBeInTheDocument();
  });
});

/**
 * Task 25 fix wave — BUG 1 regression guard. The 2026-08-05 authed browser
 * walk found that this SERVER component passed an inline function
 * (`hrefForPage={(n) => buildMaintenanceHref(...)}`) into the 'use client'
 * Pagination. RSC cannot serialize function props, so ANY non-empty list
 * crashed to the error boundary (digest 3969804129) — while every JSDOM test
 * in this file kept passing, because @testing-library renders the awaited
 * element tree directly and never crosses a real server/client serialization
 * boundary. So this guard is a source-text pin (the repo's wiring-pin idiom,
 * see maintenance-onboarding.test.ts): it asserts the page never spells the
 * function-prop flavor (`hrefForPage=`) and does wire the serializable
 * basePath/baseParams flavor.
 *
 * HONEST LIMITS: a source-text assertion proves what the file SAYS, not what
 * React does — RSC serialization of the props this page passes is only truly
 * proven by an authed browser walk over a NON-EMPTY list (the pager block is
 * gated on rows, which is exactly why empty-list tests, typecheck, and
 * `next build` all missed the original bug).
 */
describe('RSC serialization guard — the pager gets serializable props only (Task 25 walk, BUG 1)', () => {
  const src = readFileSync(path.resolve(__dirname, 'page.tsx'), 'utf8');

  it('never passes the function-prop flavor (hrefForPage=) from this server component', () => {
    expect(src).not.toMatch(/hrefForPage=/);
  });

  it('wires the pager via serializable basePath + baseParams derived from the shared query-contract helper', () => {
    expect(src).toMatch(/basePath="\/dashboard\/maintenance"/);
    expect(src).toMatch(/baseParams=\{maintenanceListParams\(\{ scope, status, q \}\)\}/);
  });
});

describe('within-row sanity (guards against a titular-only requester-column test)', () => {
  it('the requester cell actually holds the row requesterName, not just present anywhere', async () => {
    setCtx('manager');
    list.mockResolvedValueOnce([row({ requesterName: 'Distinctive Name Q7' })]);
    render(await MaintenancePage(args({ scope: 'all' })));
    const table = screen.getByRole('table');
    expect(within(table).getByText('Distinctive Name Q7')).toBeInTheDocument();
  });
});
