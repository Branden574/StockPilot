import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

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
 * The real fix is one shared module imported by all 25 call sites; that
 * sweep spans routes this change does not own, so the guard below stands in
 * the meantime and keeps the divergence loud rather than silent.
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
vi.mock('@/server/services/insights', () => ({
  gatherInsightsForCtx: (ctx: CapturedCtx) => gatherMock(ctx),
  summarizeInsights: vi.fn(async () => null),
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
    // .limit). Assert the whole predicate, arguments included.
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
  return body
    .replace(/\.select\((['"`])[^'"`]*\1\)/g, '.select(<projection>)')
    .replace(/as\s*\{[^}]*\}/g, 'as <row>')
    .replace(/\s+/g, ' ')
    .trim();
}

function copiesOf(name: string): Array<{ file: string; signature: string }> {
  const found: Array<{ file: string; signature: string }> = [];
  for (const file of routeFiles()) {
    const body = extractFunction(readFileSync(file, 'utf8'), name);
    if (body) found.push({ file: relative(API_ROOT, file), signature: behaviouralSignature(body) });
  }
  return found;
}

describe('duplicated cron helpers must not diverge', () => {
  it('every private buildSystemContext picks the system actor the same way', () => {
    const copies = copiesOf('buildSystemContext');
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
    const copies = copiesOf('secretsEqual');
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
    // An INCREASE means a 26th copy was pasted in; extract instead.
    expect(copiesOf('buildSystemContext').length).toBeLessThanOrEqual(6);
    expect(copiesOf('secretsEqual').length).toBeLessThanOrEqual(19);
  });
});
