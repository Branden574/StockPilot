import type { ReactElement, ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * The dashboard layout when the organization row cannot be read.
 *
 * The row holds the organization's authenticator policy and its settings.
 * When its read does not answer, the layout renders nothing with default
 * settings: defaults could send a member of an organization that does not
 * require an authenticator to authenticator setup during a short outage. It
 * reaches the error card instead, and the error carries the "could not check
 * your access" digest, so the card is the plain state ("This page couldn't be
 * loaded" / "We couldn't check your access just now") with Try again, not
 * "Something went wrong".
 *
 * A row that was read renders the shell as before.
 *
 * The readers of lib/dashboard/request-cache are real here; only the network
 * is a stub.
 */

const holder = vi.hoisted(() => ({ stub: null as SupabaseStub | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ 'x-pathname': '/dashboard' }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock('@/components/dashboard/dashboard-shell', () => ({
  DashboardShell: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/dashboard/mfa-required-banner', () => ({ MfaRequiredBanner: () => null }));
vi.mock('@/components/platform/impersonation-banner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/components/realtime/inventory-realtime', () => ({ InventoryRealtime: () => null }));
vi.mock('@/components/activity-beacon', () => ({ ActivityBeacon: () => null }));

vi.mock('@/lib/auth/platform-admin', () => ({
  currentUserIsPlatformAdminFromRequestHeader: async () => false,
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: async () => ({
    organizationId: 'org-1',
    organizationName: 'Org One',
    userId: 'u1',
    email: 'a@b.com',
    fullName: 'Ann Example',
    avatarUrl: null,
    role: 'staff',
    permissions: new Set<string>(),
  }),
  getSessionMemberships: async () => [
    { organizationId: 'org-1', name: 'Org One', logoUrl: null, role: 'staff' },
  ],
}));
// The one-round-trip context read gave no usable answer: the readers take
// their own reads.
vi.mock('@/lib/auth/request-context-bundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/request-context-bundle')>()),
  loadRequestContextBundle: vi.fn(async () => null),
}));
// A member with no authenticator: the case a default policy would mishandle.
vi.mock('@/lib/dashboard/request-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dashboard/request-cache')>()),
  getMfaFactorsForRequest: async () => ({ userId: 'u1', factors: [] }),
  getWarehousesForRequest: async () => [{ id: 'wh-1', name: 'Main' }],
}));
vi.mock('@/lib/auth/verified-claims', () => ({
  getVerifiedSessionClaimsForRequest: async () => ({ userId: 'u1', aal: 'aal1' }),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: async () => ({ hasAllAccess: true, readableIds: ['wh-1'] }),
}));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: async () => null }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => holder.stub!.client),
}));

import { knownErrorState } from '@/lib/known-error-states';

import GlobalError from '../error';
import DashboardLayout from './layout';

type AnyElement = ReactElement<Record<string, unknown>>;

function findByTypeName(node: unknown, name: string): AnyElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByTypeName(child, name);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as AnyElement;
  const type = el.type as { name?: string } | string | undefined;
  if (typeof type === 'function' && (type as { name?: string }).name === name) return el;
  return findByTypeName(el.props?.children, name);
}

const ORG_ROW = {
  terminology: null,
  mfa_policy: 'optional',
  logo_url: null,
  timezone: 'America/Los_Angeles',
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
  all_modules_comp: false,
};

function organizationRow(answer: { data: unknown; error: unknown }) {
  holder.stub = makeSupabaseStub({
    'organization_modules.select': { data: [{ module_id: 'orders' }], error: null } as never,
    'organizations.select': answer as never,
  });
}

async function layoutRejection(): Promise<unknown> {
  try {
    await DashboardLayout({ children: null });
  } catch (e) {
    return e;
  }
  throw new Error('expected the layout to throw');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true } as Response)),
  );
});

describe('(dashboard) layout: an organization row that could not be read', () => {
  beforeEach(() => {
    organizationRow({
      data: null,
      error: { message: 'permission denied for table organizations', code: '42501' },
    });
  });

  it('throws the could-not-check state, which the error card knows by its digest', async () => {
    const e = await layoutRejection();
    expect(knownErrorState(e)?.key).toBe('access-unchecked');
  });

  it('renders nothing with default settings: no redirect to authenticator setup, no shell', async () => {
    const e = await layoutRejection();
    expect(redirect).not.toHaveBeenCalled();
    expect(String((e as Error).message)).not.toMatch(/^redirect:/);
  });

  it('the error card it reaches is the plain state with Try again, not "Something went wrong"', async () => {
    const e = await layoutRejection();
    // In a production build only the digest crosses to the browser.
    const standIn = Object.assign(new Error('An error occurred in the Server Components render.'), {
      digest: (e as { digest?: string }).digest,
    });
    const { container } = render(<GlobalError error={standIn} retry={() => {}} reset={() => {}} />);
    expect(
      screen.getByRole('heading', { level: 1, name: "This page couldn't be loaded" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("We couldn't check your access just now. This is usually temporary."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('Something went wrong');
  });
});

describe('(dashboard) layout: an organization row that was read', () => {
  it('renders the shell as before', async () => {
    organizationRow({ data: [ORG_ROW], error: null });
    const tree = await DashboardLayout({ children: null });
    expect(findByTypeName(tree, 'DashboardShell')).not.toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });
});
