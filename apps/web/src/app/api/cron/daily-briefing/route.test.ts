import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { reportError } from '@/lib/error-reporter';
import { makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

import { ROLE_PERMISSIONS, type Permission, type Role } from '@stockpilot/core';

/**
 * Daily briefing cron — first tests for this route.
 *
 * Two things are pinned here, and they are pinned together on purpose:
 *
 *  1. The SYSTEM ACTOR predicate. `buildSystemContext` picks the org member
 *     that every service call in this cron is attributed to (`created_by`,
 *     audit rows). Its filters — accepted invite, not an active
 *     impersonation, owner/admin — had ZERO test coverage in any of the six
 *     crons that carry a copy of it.
 *
 *  2. That the six copies of `buildSystemContext`, and the nineteen copies
 *     of `secretsEqual`, have not DIVERGED. Both helpers are defined
 *     privately in every route that needs them; no shared export exists.
 *     The predicted failure (recurring bug pattern #26 — "a fix applied to
 *     ONE copy of a duplicated function is not a fix") is that someone
 *     tightens the actor selection in the cron they happen to be fixing —
 *     e.g. also skipping accounts disabled by mig 0308 — and silently not
 *     in the other five, so daily briefings run as a disabled admin while
 *     auto-reorder does not. Nothing in the tree would notice.
 *
 * The shared module now exists: server/services/lib/system-context.ts
 * exports both helpers, and new code imports them from there (the exception
 * occurrences cron was the first). Moving the existing routes onto it spans
 * routes that change did not own, so the guard below still compares every
 * route copy, now WITH the shared module, and keeps the divergence loud
 * rather than silent. The shared buildSystemContext differs from the route
 * copies only in branding its result (SystemServiceContext), which the
 * signature below normalises away and nothing else.
 */

const envHolder = {
  env: { CRON_SECRET: 'test-cron-secret' } as { CRON_SECRET?: string },
};
vi.mock('@/lib/env', () => ({
  get env() {
    return envHolder.env;
  },
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

const createNotificationMock = vi.fn(async (_args: unknown) => 'notification-1');
vi.mock('@/server/services/notifications', () => ({
  createNotification: (args: unknown) => createNotificationMock(args),
}));

interface CapturedCtx {
  organizationId: string;
  userId: string;
  role: string;
  mfaRequired: boolean;
  mfaSatisfied: boolean;
  enabledModules: Set<string>;
}
const gatherMock = vi.fn(async (_ctx: CapturedCtx) => ({
  signals: [
    { key: 'low_stock', label: 'items at or under their reorder point', count: 4 },
  ],
}));
const summarizeMock = vi.fn(async (_insights: unknown): Promise<string | null> => null);
vi.mock('@/server/services/insights', () => ({
  gatherInsightsForCtx: (ctx: CapturedCtx) => gatherMock(ctx),
  summarizeInsights: (insights: unknown) => summarizeMock(insights),
}));

// Each recipient's own permission set (overrides applied). The loader has its
// own suite; here it answers by role unless a test says otherwise.
const loadPermissionsMock = vi.fn(
  async (_client: unknown, _orgId: string, _userId: string, role: Role) =>
    new Set<Permission>(ROLE_PERMISSIONS[role]),
);
vi.mock('@/lib/auth/effective-permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/effective-permissions')>()),
  loadEffectivePermissions: (client: unknown, orgId: string, userId: string, role: Role) =>
    loadPermissionsMock(client, orgId, userId, role),
}));

import { GET } from './route';

/** The handler is typed `NextRequest` but only ever reads
 *  `req.headers.get('authorization')`, so a plain Request is a faithful
 *  stand-in; the cast keeps the test off NextRequest's constructor. */
function buildRequest(authHeader?: string): NextRequest {
  return new Request('https://test.local/api/cron/daily-briefing', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  }) as unknown as NextRequest;
}

/** Rows carrying BOTH projected columns: the route queries
 *  organization_modules twice (the org scan selects organization_id, the
 *  per-org module set selects module_id) and the stub answers both from one
 *  key. */
const MODULE_ROWS = [{ organization_id: 'org-1', module_id: 'ai' }];

beforeEach(() => {
  vi.clearAllMocks();
  envHolder.env = { CRON_SECRET: 'test-cron-secret' };
  gatherMock.mockResolvedValue({
    signals: [
      { key: 'low_stock', label: 'items at or under their reorder point', count: 4 },
    ],
  });
  summarizeMock.mockResolvedValue(null);
  loadPermissionsMock.mockImplementation(
    async (_client, _orgId, _userId, role) => new Set<Permission>(ROLE_PERMISSIONS[role]),
  );
});

describe('GET /api/cron/daily-briefing — cron secret gate', () => {
  it('refuses a request with no authorization header', async () => {
    adminHolder.client = makeSupabaseStub().client;
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
  });

  it('refuses a wrong secret of the SAME length (timing-safe compare, not a prefix match)', async () => {
    adminHolder.client = makeSupabaseStub().client;
    const res = await GET(buildRequest('Bearer test-cron-secreT'));
    expect(res.status).toBe(401);
  });

  it('fails closed with 503 when CRON_SECRET is not configured', async () => {
    envHolder.env = {};
    adminHolder.client = makeSupabaseStub().client;
    const res = await GET(buildRequest('Bearer '));
    expect(res.status).toBe(503);
  });
});

describe('GET /api/cron/daily-briefing — system actor predicate', () => {
  it('attributes the run to an accepted, non-impersonating owner/admin and carries the real module set', async () => {
    const stub = makeSupabaseStub({
      'organization_modules.select': { data: MODULE_ROWS, error: null },
      'organization_members.select': {
        data: [{ user_id: 'user-owner', role: 'admin' }],
        error: null,
      },
      'notifications.select.maybeSingle': { data: null, error: null },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);

    // The FIRST organization_members chain is buildSystemContext's actor
    // pick (the second is the notification recipient list, which has no
    // .limit, and is pinned under "who is told" below). Assert the whole
    // predicate, arguments included.
    const chain = stub.chainsAll.get('organization_members.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('organization_members.select')?.[0] ?? [];
    const at = (method: string) => args[chain.indexOf(method)];

    expect(chain).toContain('eq');
    expect(at('eq')).toEqual(['organization_id', 'org-1']);
    // Only owners/admins may stand in as the system actor.
    expect(at('in')).toEqual(['role', ['owner', 'admin']]);
    // A pending invitee is not a real member yet.
    expect(at('not')).toEqual(['accepted_at', 'is', null]);
    // An impersonation seat is a support session, never an attribution target.
    expect(at('is')).toEqual(['impersonation_expires_at', null]);
    expect(chain).toContain('limit');

    // The context handed to every service call in this cron.
    const ctx = gatherMock.mock.calls[0]![0];
    expect(ctx.organizationId).toBe('org-1');
    expect(ctx.userId).toBe('user-owner');
    // Hard-coded 'owner' regardless of the member's real role: this is a
    // service-role client, so the role is a capability label for the
    // service layer, not an access decision.
    expect(ctx.role).toBe('owner');
    expect(ctx.mfaRequired).toBe(false);
    expect(ctx.mfaSatisfied).toBe(true);
    expect(ctx.enabledModules).toBeInstanceOf(Set);
    expect([...ctx.enabledModules]).toEqual(['ai']);
  });

  it('skips the org entirely when it has no eligible actor', async () => {
    const stub = makeSupabaseStub({
      'organization_modules.select': { data: MODULE_ROWS, error: null },
      'organization_members.select': { data: [], error: null },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orgsProcessed: 0, briefingsSent: 0 });
    expect(gatherMock).not.toHaveBeenCalled();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('says nothing on a quiet day — zero signals sends zero notifications', async () => {
    gatherMock.mockResolvedValue({ signals: [] });
    const stub = makeSupabaseStub({
      'organization_modules.select': { data: MODULE_ROWS, error: null },
      'organization_members.select': {
        data: [{ user_id: 'user-owner', role: 'owner' }],
        error: null,
      },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ briefingsSent: 0 });
    expect(createNotificationMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Who is told, and what each recipient reads (docket S36 part a, B72 part 3)
// ---------------------------------------------------------------------------

/** Two organization_members reads: buildSystemContext's actor pick (it has
 *  .limit) and the recipient list. `recipients` answers the second. */
function membersAnswer(recipients: QueryResult) {
  return (call: MockCall): QueryResult =>
    call.methods.includes('limit')
      ? { data: [{ user_id: 'user-owner', role: 'owner' }], error: null }
      : recipients;
}

const OWNER_AND_ADMIN: QueryResult = {
  data: [
    { user_id: 'user-owner', role: 'owner' },
    { user_id: 'user-admin', role: 'admin' },
  ],
  error: null,
};

const APPROVALS_AND_LOW_STOCK = {
  signals: [
    { key: 'pending_approvals', label: 'orders awaiting approval', count: 3 },
    { key: 'low_stock', label: 'items at or under their reorder point', count: 4 },
  ],
};

/** The org scan (.eq('module_id', 'ai')) finds org-1; its module set is `moduleIds`. */
function modulesAnswer(moduleIds: string[]) {
  return (call: MockCall): QueryResult =>
    call.methods.some((m, i) => m === 'eq' && call.args[i]?.[0] === 'module_id')
      ? { data: [{ organization_id: 'org-1' }], error: null }
      : { data: moduleIds.map((module_id) => ({ module_id })), error: null };
}

const ALL_LINES_MODULES = ['ai', 'orders', 'purchase_orders', 'cycle_counts'];

function briefingStub(recipients: QueryResult = OWNER_AND_ADMIN, moduleIds = ALL_LINES_MODULES) {
  return makeSupabaseStub({
    'organization_modules.select': modulesAnswer(moduleIds),
    'organization_members.select': membersAnswer(recipients),
    'notifications.select.maybeSingle': { data: null, error: null },
  });
}

type NotificationArgs = {
  userId: string;
  title: string;
  body: string;
  metadata: { signalKeys: string[]; counts: Record<string, number> };
};
const sentTo = (userId: string) =>
  createNotificationMock.mock.calls
    .map((c) => c[0] as NotificationArgs)
    .filter((a) => a.userId === userId);

function adminSet(...remove: Permission[]) {
  return new Set<Permission>(ROLE_PERMISSIONS.admin.filter((k) => !remove.includes(k)));
}

describe('GET /api/cron/daily-briefing — who is told, and what', () => {
  it('reads the recipients as accepted owners and admins, never an Act-as seat, with their role', async () => {
    const stub = briefingStub();
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);

    const chain = stub.chainsAll.get('organization_members.select')?.[1] ?? [];
    const args = stub.chainArgsAll.get('organization_members.select')?.[1] ?? [];
    const at = (method: string) => args[chain.indexOf(method)];
    expect(at('select')).toEqual(['user_id, role']);
    expect(at('eq')).toEqual(['organization_id', 'org-1']);
    expect(at('in')).toEqual(['role', ['owner', 'admin']]);
    expect(at('not')).toEqual(['accepted_at', 'is', null]);
    expect(at('is')).toEqual(['impersonation_expires_at', null]);
    expect(chain).not.toContain('limit');
    // Each recipient's own set, read with the service role.
    expect(loadPermissionsMock.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      ['org-1', 'user-owner', 'owner'],
      ['org-1', 'user-admin', 'admin'],
    ]);
  });

  it('an admin whose orders:approve was revoked gets no approvals line, and a title, lines and metadata of their own', async () => {
    gatherMock.mockResolvedValue(APPROVALS_AND_LOW_STOCK);
    loadPermissionsMock.mockImplementation(async (_c, _o, _u, role) =>
      role === 'admin' ? adminSet('orders:approve') : new Set<Permission>(ROLE_PERMISSIONS.owner),
    );
    adminHolder.client = briefingStub().client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ briefingsSent: 2 });

    const [owner] = sentTo('user-owner');
    expect(owner).toMatchObject({
      title: 'Morning briefing: 2 things need attention',
      body: '3 orders awaiting approval · 4 items at or under their reorder point',
      metadata: {
        signalKeys: ['pending_approvals', 'low_stock'],
        counts: { pending_approvals: 3, low_stock: 4 },
      },
    });
    const [admin] = sentTo('user-admin');
    expect(admin).toMatchObject({
      title: 'Morning briefing: 1 thing needs attention',
      body: '4 items at or under their reorder point',
    });
    // Exactly their own lines: no approvals key, no approvals count.
    expect(admin!.metadata).toEqual({ signalKeys: ['low_stock'], counts: { low_stock: 4 } });
  });

  it('an admin without items:update (the page they would land on) gets nothing', async () => {
    loadPermissionsMock.mockImplementation(async (_c, _o, _u, role) =>
      role === 'admin' ? adminSet('items:update') : new Set<Permission>(ROLE_PERMISSIONS.owner),
    );
    adminHolder.client = briefingStub().client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ briefingsSent: 1 });
    expect(sentTo('user-admin')).toEqual([]);
    expect(sentTo('user-owner')).toHaveLength(1);
  });

  it('an admin whose permissions could not be read is skipped and reported once; the owner is still told', async () => {
    loadPermissionsMock.mockImplementation(async (_c, _o, _u, role) => {
      if (role === 'admin') throw new PermissionsUnavailableError();
      return new Set<Permission>(ROLE_PERMISSIONS.owner);
    });
    adminHolder.client = briefingStub({
      data: [
        { user_id: 'user-owner', role: 'owner' },
        { user_id: 'user-admin', role: 'admin' },
        { user_id: 'user-admin-2', role: 'admin' },
      ],
      error: null,
    }).client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ briefingsSent: 1 });
    expect(sentTo('user-owner')).toHaveLength(1);
    expect(sentTo('user-admin')).toEqual([]);
    expect(sentTo('user-admin-2')).toEqual([]);
    const reports = vi
      .mocked(reportError)
      .mock.calls.filter(([, c]) => c.tag === 'cron.daily-briefing.overrides');
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      level: 'warning',
      organizationId: 'org-1',
      extra: { skipped: 2 },
    });
  });

  it('a failed recipients read is reported and tells no one (never read as "nobody")', async () => {
    for (const recipients of [
      {
        data: null,
        error: { message: 'canceling statement due to statement timeout', code: '57014' },
      },
      { data: null, error: null },
    ] as QueryResult[]) {
      vi.clearAllMocks();
      adminHolder.client = briefingStub(recipients).client;

      const res = await GET(buildRequest('Bearer test-cron-secret'));
      expect(res.status).toBe(200);
      expect(createNotificationMock).not.toHaveBeenCalled();
      const reports = vi
        .mocked(reportError)
        .mock.calls.filter(([, c]) => c.tag === 'cron.daily-briefing.recipients');
      expect(reports).toHaveLength(1);
      expect(reports[0]![1]).toMatchObject({ organizationId: 'org-1' });
    }
  });

  it('the AI narrative is used only for a recipient who sees every line, and written once', async () => {
    gatherMock.mockResolvedValue(APPROVALS_AND_LOW_STOCK);
    summarizeMock.mockResolvedValue('Three orders wait for approval and four items are low.');
    loadPermissionsMock.mockImplementation(async (_c, _o, _u, role) =>
      role === 'admin' ? adminSet('orders:approve') : new Set<Permission>(ROLE_PERMISSIONS.owner),
    );
    adminHolder.client = briefingStub().client;

    await GET(buildRequest('Bearer test-cron-secret'));
    expect(sentTo('user-owner')[0]!.body).toBe(
      'Three orders wait for approval and four items are low.',
    );
    // The narrative speaks of approvals this admin cannot act on.
    expect(sentTo('user-admin')[0]!.body).toBe('4 items at or under their reorder point');
    expect(summarizeMock).toHaveBeenCalledTimes(1);
  });

  it('two readers who see every line share one narrative, written once', async () => {
    gatherMock.mockResolvedValue(APPROVALS_AND_LOW_STOCK);
    summarizeMock.mockResolvedValue('Three orders wait for approval and four items are low.');
    // The owner and an admin with the admin defaults: both read both lines.
    adminHolder.client = briefingStub().client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ briefingsSent: 2 });
    for (const userId of ['user-owner', 'user-admin']) {
      expect(sentTo(userId)[0]!.body).toBe(
        'Three orders wait for approval and four items are low.',
      );
    }
    expect(summarizeMock).toHaveBeenCalledTimes(1);
  });

  it('an admin with no line they can open is sent nothing, while the owner still is', async () => {
    gatherMock.mockResolvedValue({
      signals: [{ key: 'pending_approvals', label: 'orders awaiting approval', count: 3 }],
    });
    // The only line is approvals, and this admin cannot approve. They can
    // still open the briefing (items:update), so only the empty-lines rule
    // keeps "Morning briefing: 0 things need attention" from them.
    loadPermissionsMock.mockImplementation(async (_c, _o, _u, role) =>
      role === 'admin' ? adminSet('orders:approve') : new Set<Permission>(ROLE_PERMISSIONS.owner),
    );
    adminHolder.client = briefingStub().client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ briefingsSent: 1 });
    expect(sentTo('user-admin')).toEqual([]);
    expect(sentTo('user-owner')).toEqual([
      expect.objectContaining({ title: 'Morning briefing: 1 thing needs attention' }),
    ]);
  });

  it('a line no reader can open (its module is off) does not stop the narrative for the readers who see every other line', async () => {
    // Open purchase orders are still counted with the module off (the counts
    // ask no module), and no reader is shown them.
    gatherMock.mockResolvedValue({
      signals: [
        { key: 'pending_approvals', label: 'orders awaiting approval', count: 3 },
        { key: 'open_pos', label: 'open purchase orders', count: 2 },
      ],
    });
    summarizeMock.mockResolvedValue('Three orders wait for approval.');
    adminHolder.client = briefingStub(OWNER_AND_ADMIN, ['ai', 'orders', 'cycle_counts']).client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ briefingsSent: 2 });
    for (const userId of ['user-owner', 'user-admin']) {
      expect(sentTo(userId)[0]).toMatchObject({
        title: 'Morning briefing: 1 thing needs attention',
        body: 'Three orders wait for approval.',
        metadata: { signalKeys: ['pending_approvals'] },
      });
    }
    // Written once, and only from the lines the organization can open: the
    // purchase order line never reaches the narrative.
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    const told = summarizeMock.mock.calls[0]![0] as { signals: Array<{ key: string }> };
    expect(told.signals.map((s) => s.key)).toEqual(['pending_approvals']);
  });

  it('an organization whose module set cannot be read is skipped for the day and reported, never sent a trimmed briefing', async () => {
    gatherMock.mockResolvedValue(APPROVALS_AND_LOW_STOCK);
    for (const perOrgModules of [
      // The read failed: buildSystemContext keeps every copy's shape and
      // drops the error, so the set arrives empty.
      {
        data: null,
        error: { message: 'canceling statement due to statement timeout', code: '57014' },
      },
      // Or ai was turned off between the scan and this read.
      { data: [{ module_id: 'orders' }], error: null },
    ] as QueryResult[]) {
      vi.clearAllMocks();
      adminHolder.client = makeSupabaseStub({
        'organization_modules.select': (call: MockCall): QueryResult =>
          call.methods.some((m, i) => m === 'eq' && call.args[i]?.[0] === 'module_id')
            ? { data: [{ organization_id: 'org-1' }], error: null }
            : perOrgModules,
        'organization_members.select': membersAnswer(OWNER_AND_ADMIN),
        'notifications.select.maybeSingle': { data: null, error: null },
      }).client;

      const res = await GET(buildRequest('Bearer test-cron-secret'));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ orgsProcessed: 0, briefingsSent: 0 });
      expect(createNotificationMock).not.toHaveBeenCalled();
      expect(gatherMock).not.toHaveBeenCalled();
      const reports = vi
        .mocked(reportError)
        .mock.calls.filter(([, c]) => c.tag === 'cron.daily-briefing.modules');
      expect(reports).toHaveLength(1);
      expect(reports[0]![1]).toMatchObject({ organizationId: 'org-1' });
    }
  });

  it('a purchase order line is dropped when the Purchase orders module is off', async () => {
    gatherMock.mockResolvedValue({
      signals: [
        { key: 'overdue_pos', label: 'overdue inbound POs', count: 2 },
        { key: 'low_stock', label: 'items at or under their reorder point', count: 4 },
      ],
    });
    // Purchase orders is off for this organization.
    adminHolder.client = briefingStub(OWNER_AND_ADMIN, ['ai', 'orders', 'cycle_counts']).client;

    await GET(buildRequest('Bearer test-cron-secret'));
    for (const userId of ['user-owner', 'user-admin']) {
      expect(sentTo(userId)[0]).toMatchObject({
        title: 'Morning briefing: 1 thing needs attention',
        metadata: { signalKeys: ['low_stock'] },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-copy divergence guard
// ---------------------------------------------------------------------------

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function routeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(API_ROOT);
  return out.sort();
}

/** Return the source text of `function <name>(...) { ... }`, brace-matched,
 *  or null when the file does not define it. */
function extractFunction(source: string, name: string): string | null {
  const header = new RegExp(String.raw`(?:async\s+)?function\s+${name}\s*\(`).exec(source);
  if (!header) return null;
  const open = source.indexOf('{', header.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(header.index, i + 1);
    }
  }
  return null;
}

/**
 * Normalize away the differences that are NOT behaviour:
 *  - the projected column list (`.select('user_id, role')` vs
 *    `.select('user_id')` — restore-points projects one fewer column and is
 *    otherwise the same predicate),
 *  - the matching TypeScript cast on the destructured row,
 *  - whitespace and blank lines.
 * What survives is the query FILTER chain and the returned context fields —
 * exactly the parts a "tightening" would change.
 */
function behaviouralSignature(body: string): string {
  return (
    body
      .replace(/\.select\((['"`])[^'"`]*\1\)/g, '.select(<projection>)')
      .replace(/as\s*\{[^}]*\}/g, 'as <row>')
      .replace(/\s+/g, ' ')
      .trim()
      // The shared module's ONLY difference (see the header): its result is
      // branded. The return type names the branded type and the returned
      // literal passes through brandSystemContext(); both are types and
      // identity, not the actor predicate, so they normalise to the route
      // copies' spelling. Anything else that differs still splits the group.
      .replace(/Promise<SystemServiceContext \| null>/g, 'Promise<ServiceContext | null>')
      .replace(/return brandSystemContext\((\{.*\})\);/, 'return $1;')
  );
}

/** The shared module every new call site imports (see the header). Compared
 *  with the route copies, never counted among them. */
const SHARED_MODULE = join(API_ROOT, '..', '..', 'server', 'services', 'lib', 'system-context.ts');
const SHARED_MODULE_LABEL = relative(API_ROOT, SHARED_MODULE);

function copiesOf(
  name: string,
  opts: { includeShared?: boolean } = {},
): Array<{ file: string; signature: string }> {
  const found: Array<{ file: string; signature: string }> = [];
  const files = opts.includeShared ? [...routeFiles(), SHARED_MODULE] : routeFiles();
  for (const file of files) {
    const body = extractFunction(readFileSync(file, 'utf8'), name);
    if (body) found.push({ file: relative(API_ROOT, file), signature: behaviouralSignature(body) });
  }
  return found;
}

describe('duplicated cron helpers must not diverge', () => {
  it('every private buildSystemContext picks the system actor the same way', () => {
    const copies = copiesOf('buildSystemContext', { includeShared: true });
    // The shared module is compared too; a guard that silently stopped
    // finding it would let it drift from every route copy.
    expect(copies.map((c) => c.file)).toContain(SHARED_MODULE_LABEL);
    // Guard the guard: if the extraction lands and every copy disappears,
    // this must fail loudly rather than pass vacuously.
    expect(copies.length).toBeGreaterThan(0);

    const bySignature = new Map<string, string[]>();
    for (const c of copies) {
      bySignature.set(c.signature, [...(bySignature.get(c.signature) ?? []), c.file]);
    }
    // A single group == every copy agrees. On failure the message names the
    // files on each side of the split.
    expect([...bySignature.values()]).toEqual([copies.map((c) => c.file)]);
  });

  it('every private secretsEqual compares the cron secret the same way', () => {
    const copies = copiesOf('secretsEqual', { includeShared: true });
    expect(copies.map((c) => c.file)).toContain(SHARED_MODULE_LABEL);
    expect(copies.length).toBeGreaterThan(0);

    const bySignature = new Map<string, string[]>();
    for (const c of copies) {
      bySignature.set(c.signature, [...(bySignature.get(c.signature) ?? []), c.file]);
    }
    expect([...bySignature.values()]).toEqual([copies.map((c) => c.file)]);
  });

  it('no NEW copy of either helper appears (the count only ever ratchets down)', () => {
    // Pinned at the counts measured when this guard was written. Migrating a
    // route to a shared import LOWERS these — update them downward freely.
    // An INCREASE means a 26th copy was pasted in; import the shared module
    // (server/services/lib/system-context.ts) instead. These count ROUTE
    // copies only; the shared module is never one of them.
    expect(copiesOf('buildSystemContext').length).toBeLessThanOrEqual(6);
    expect(copiesOf('secretsEqual').length).toBeLessThanOrEqual(19);
    expect(copiesOf('buildSystemContext').map((c) => c.file)).not.toContain(SHARED_MODULE_LABEL);
  });

  it('every copy says the system is acting (isSystem), so the audit rows it writes are marked', () => {
    // B9: the user id these contexts carry is BORROWED from an owner or admin.
    // isSystem is how audit() knows to stamp metadata.is_system on the rows,
    // so Last active and the anomaly monitor never count a job as that person.
    const copies = copiesOf('buildSystemContext', { includeShared: true });
    expect(copies.length).toBeGreaterThan(1);
    for (const c of copies) expect(c.signature, c.file).toContain(' isSystem: true,');
  });

  it('the shared module brands exactly what the route copies build, and nothing more', () => {
    // Negative pin on the normalisation above: it must erase ONLY the brand.
    // A shared body that also changed the actor predicate (here: dropping the
    // impersonation filter) must still split from the route copies.
    const shared = extractFunction(readFileSync(SHARED_MODULE, 'utf8'), 'buildSystemContext');
    expect(shared).not.toBeNull();
    const tampered = shared!.replace(".is('impersonation_expires_at', null)", '');
    expect(tampered).not.toBe(shared);
    const routeSignature = copiesOf('buildSystemContext')[0]!.signature;
    expect(behaviouralSignature(shared!)).toBe(routeSignature);
    expect(behaviouralSignature(tampered)).not.toBe(routeSignature);
  });
});
