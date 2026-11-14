import { createHash, createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type MockCall, type QueryResult } from '@/test/supabase-mock';

/**
 * Weekly inventory digest — a disabled account must not receive it.
 *
 * The disable program (migs 0308-0311) blocks READS via RLS, but this cron
 * runs as service-role and previously built its recipient set purely from
 * `email_digest_optin` + `accepted_at`, with no `disabled_at` check anywhere
 * in the pipeline. A user disabled for suspected compromise kept getting the
 * weekly digest email — low-stock SKUs, open PO counts, cycle-count status —
 * for as long as the disable stood.
 *
 * The immediate-before-send recheck (already present for membership + the
 * opt-in flag, guarding the gap between "recipient set assembled" and "this
 * particular send") is the natural place to add the disabled check too: it
 * reuses that EXISTING per-recipient round trip rather than adding a new
 * one, and it is exactly the right semantics — re-verify status as close to
 * the send as possible.
 */

vi.mock('@/lib/env', () => ({
  env: {
    CRON_SECRET: 'test-cron-secret',
    NEXT_PUBLIC_APP_URL: 'https://stockpilotusa.com',
  },
}));

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  headers?: Record<string, string>;
}
const sendEmailMock = vi.fn(async (_args: SendEmailArgs) => ({ ok: true }));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (args: SendEmailArgs) => sendEmailMock(args),
}));

vi.mock('@/lib/email/es/families/digest', () => ({
  DIGEST_FROM: 'StockPilot <digest@stockpilotusa.com>',
  renderWeeklyDigestHtml: vi.fn(() => '<html>digest</html>'),
  weeklyDigestSubject: vi.fn(() => 'Your weekly inventory digest'),
  weeklyDigestText: vi.fn(() => 'digest text'),
}));

// What each recipient may read is covered by route.scope.test.ts, which runs
// the real digest service; here it is a pass-through.
vi.mock('@/server/services/digest', () => ({
  getDigestSource: vi.fn(async () => ({ lowStock: [], openPos: [], openCycleCounts: [] })),
  loadDigestReaderData: vi.fn(async () => ({})),
  digestReaderFor: vi.fn(() => ({})),
  buildDigestPayload: vi.fn(() => ({ lowStock: [], openPos: [], openCycleCounts: [] })),
  isDigestEmpty: vi.fn(() => false),
  applySectionOptIns: vi.fn((payload: unknown) => payload),
}));

import { GET } from './route';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { mintMemberUnsubscribeToken } from '@/lib/email/member-unsubscribe';

function buildRequest(authHeader?: string) {
  return new Request('https://test.local/api/cron/weekly-digest', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

/** One row as returned by the bulk `user_profiles` pull (RecipientRow). */
function recipientRow(id: string, email: string) {
  return {
    id,
    email,
    full_name: 'Test User',
    digest_section_low_stock: true,
    digest_section_open_pos: true,
    digest_section_cycle_counts: true,
    organization_members: [
      {
        organization_id: 'org-1',
        accepted_at: '2026-01-01T00:00:00Z',
        organizations: { id: 'org-1', name: 'Acme', timezone: 'America/Los_Angeles' },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/cron/weekly-digest — CRON_SECRET', () => {
  it('answers 401 and reads nothing without the secret, or with a wrong one', async () => {
    const stub = makeSupabaseStub({});
    adminHolder.client = stub.client;

    for (const header of [undefined, 'Bearer wrong-secret', 'test-cron-secret']) {
      const res = await GET(buildRequest(header));
      expect(res.status).toBe(401);
    }
    expect(stub.fromCalls).toEqual([]);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/weekly-digest — disabled accounts', () => {
  it('sends no digest to a disabled recipient, but still sends to an active one in the same org', async () => {
    // The pre-send recheck reads user_profiles per recipient, IN THE ORDER
    // the bulk pull assembled them — recipient A (disabled) first, then B
    // (active). A function result lets each successive call answer for the
    // next recipient, same idiom as a stateful DB read.
    const profileChecks = [
      { email_digest_optin: true, disabled_at: '2026-07-30T00:00:00Z' }, // A: disabled
      { email_digest_optin: true, disabled_at: null }, // B: active
    ];
    let profileCallIndex = 0;

    const stub = makeSupabaseStub({
      'user_profiles.select': {
        data: [recipientRow('user-a-disabled', 'a@acme.test'), recipientRow('user-b-active', 'b@acme.test')],
        error: null,
      },
      'user_profiles.select.maybeSingle': () => ({
        data: profileChecks[profileCallIndex++] ?? null,
        error: null,
      }),
      'organization_members.select.maybeSingle': {
        data: { user_id: 'whichever', accepted_at: '2026-01-01T00:00:00Z' },
        error: null,
      },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, sent: 1, skipped: 1 });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('b@acme.test');

    // The bulk recipient pull (the FIRST user_profiles.select chain — later
    // entries are the per-recipient rechecks) must filter on disabled_at at
    // the query level, not rely solely on the recheck.
    const bulkChain = stub.chainsAll.get('user_profiles.select')?.[0] ?? [];
    const bulkArgs = stub.chainArgsAll.get('user_profiles.select')?.[0] ?? [];
    const isIndex = bulkChain.indexOf('is');
    expect(isIndex).toBeGreaterThanOrEqual(0);
    expect(bulkArgs[isIndex]).toEqual(['disabled_at', null]);
  });
});

describe('GET /api/cron/weekly-digest — recipient address follows the profile projection', () => {
  it('addresses the digest to the CURRENT user_profiles.email, read at run time', async () => {
    // After a verified email change, auth.users.email is the identity and the
    // 0345 trigger writes it into user_profiles.email in the same transaction
    // (proven in supabase/tests/0345_verified_email_change.test.sql). This
    // test pins the other half: the digest takes its recipient from THAT row
    // at send time and carries no address of its own — so the run after a
    // change goes to the new inbox and never to the abandoned one.
    const stub = makeSupabaseStub({
      'user_profiles.select': {
        data: [recipientRow('user-a', 'new@acme.test')],
        error: null,
      },
      'user_profiles.select.maybeSingle': {
        data: { email_digest_optin: true, disabled_at: null },
        error: null,
      },
      'organization_members.select.maybeSingle': {
        data: { user_id: 'user-a', accepted_at: '2026-01-01T00:00:00Z' },
        error: null,
      },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('new@acme.test');
    expect(sendEmailMock.mock.calls[0]![0].to).not.toBe('old@acme.test');
  });
});

describe('GET /api/cron/weekly-digest — at-most-once per (org, user, week)', () => {
  it('does not re-send when the same week is run twice', async () => {
    // The claim row is the at-most-once key. The stub models the UNIQUE
    // (organization_id, scope, key) index: the first insert wins, every
    // later insert for the same week comes back 23505, and a read of the key
    // answers the row the first insert stored.
    let claims = 0;
    let stored: Record<string, unknown> | null = null;
    const stub = makeSupabaseStub({
      'user_profiles.select': {
        data: [recipientRow('user-a', 'a@acme.test')],
        error: null,
      },
      'user_profiles.select.maybeSingle': {
        data: { email_digest_optin: true, disabled_at: null },
        error: null,
      },
      'organization_members.select.maybeSingle': {
        data: { user_id: 'user-a', accepted_at: '2026-01-01T00:00:00Z' },
        error: null,
      },
      'idempotency_keys.insert': (call) => {
        if (claims++ === 0) {
          stored = { id: 'claim-1', ...(call.args[call.methods.indexOf('insert')]?.[0] as object) };
          return { data: { id: 'claim-1' }, error: null };
        }
        return {
          data: null,
          error: {
            message: 'duplicate key value violates unique constraint "idempotency_keys_..."',
            code: '23505',
          },
        };
      },
      'idempotency_keys.select': () => ({ data: stored, error: null }),
    });
    adminHolder.client = stub.client;

    const first = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await first.json()).toMatchObject({ ok: true, sent: 1 });

    const second = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await second.json()).toMatchObject({ ok: true, sent: 0, skipped: 1 });

    // The digest went out exactly once across both invocations, and the
    // cron's own claim was left as it was.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(stub.chainsAll.has('idempotency_keys.update')).toBe(false);

    // And the claim is scoped per (org, user, week) — not per user, so a
    // user in two orgs still gets both orgs' digests in the same week.
    const insertArgs = stub.chainArgsAll.get('idempotency_keys.insert')?.[0]?.[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(insertArgs).toBeTruthy();
    expect(insertArgs!.organization_id).toBe('org-1');
    expect(insertArgs!.scope).toBe('weekly_digest');
    expect(String(insertArgs!.key)).toContain('user-a');
  });

  it('still sends when the claim write itself errors (deploy-before-migrate)', async () => {
    // Fail OPEN on the marker, never on the send: if the claim table is
    // unreachable the worst case must be a possible duplicate, not a
    // fleet-wide digest outage.
    const stub = makeSupabaseStub({
      'user_profiles.select': {
        data: [recipientRow('user-a', 'a@acme.test')],
        error: null,
      },
      'user_profiles.select.maybeSingle': {
        data: { email_digest_optin: true, disabled_at: null },
        error: null,
      },
      'organization_members.select.maybeSingle': {
        data: { user_id: 'user-a', accepted_at: '2026-01-01T00:00:00Z' },
        error: null,
      },
      'idempotency_keys.insert': {
        data: null,
        error: { message: 'relation "idempotency_keys" does not exist', code: '42P01' },
      },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ ok: true, sent: 1 });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/cron/weekly-digest — a week is marked sent only by a signed claim', () => {
  // With UNSUBSCRIBE_SECRET at least 32 characters long, the claim's
  // request_hash is an HMAC over (organization, key) under a key derived from
  // it with a fixed label. A row under the key is honoured as "already sent"
  // only when it carries that value (or, for the weeks up to the last one
  // claimed before claims were signed, the unsigned form those weeks used);
  // any other row is taken over (compare-and-set on the hash it was read
  // with, up to three tries) and the digest is sent. Without such a value the
  // run reports once and claims unsigned: any row under the key means sent.
  const signable = env as Record<string, string | undefined>;
  // A dull value under a neutral name (secret-shaped-fixtures guard).
  const CLAIM_SIGNING_VALUE = 'claim-sign-' + 'k'.repeat(24);

  beforeEach(() => {
    signable.UNSUBSCRIBE_SECRET = CLAIM_SIGNING_VALUE;
  });
  afterEach(() => {
    delete signable.UNSUBSCRIBE_SECRET;
    signable.CRON_SECRET = 'test-cron-secret';
    vi.useRealTimers();
  });

  const DUPLICATE = {
    data: null,
    error: { message: 'duplicate key value violates unique constraint "idempotency_keys_..."', code: '23505' },
  };

  type Answer = QueryResult | ((call: MockCall) => QueryResult);

  function stubWithClaim(
    answers: { insert?: Answer; select?: Answer; update?: Answer },
    recipients = [recipientRow('user-a', 'a@acme.test')],
  ) {
    return makeSupabaseStub({
      'user_profiles.select': { data: recipients, error: null },
      'user_profiles.select.maybeSingle': {
        data: { email_digest_optin: true, disabled_at: null },
        error: null,
      },
      'organization_members.select.maybeSingle': {
        data: { user_id: 'user-a', accepted_at: '2026-01-01T00:00:00Z', role: 'staff' },
        error: null,
      },
      ...(answers.insert ? { 'idempotency_keys.insert': answers.insert } : {}),
      ...(answers.select ? { 'idempotency_keys.select': answers.select } : {}),
      ...(answers.update ? { 'idempotency_keys.update': answers.update } : {}),
    });
  }

  /** The row the cron inserted, as the n-th insert's argument. */
  function insertedClaim(stub: ReturnType<typeof makeSupabaseStub>, n = 0): Record<string, unknown> {
    return stub.chainArgsAll.get('idempotency_keys.insert')?.[n]?.[0]?.[0] as Record<string, unknown>;
  }

  function eqFilters(stub: ReturnType<typeof makeSupabaseStub>, key: string, n = 0): unknown[][] {
    const chain = stub.chainsAll.get(key)?.[n] ?? [];
    const args = stub.chainArgsAll.get(key)?.[n] ?? [];
    return chain.flatMap((m, i) => (m === 'eq' ? [args[i]!] : []));
  }

  /** The form a claim took before claims were signed. */
  function unsignedForm(orgId: string, key: string): string {
    return createHash('sha256').update(`${orgId}:${key}`).digest('hex');
  }

  function reportsTagged(tag: string): unknown[][] {
    return vi.mocked(reportError).mock.calls.filter(
      ([, context]) => (context as { tag?: string } | undefined)?.tag === tag,
    );
  }

  it('sends the digest when the row under the key is not signed', async () => {
    const stub = stubWithClaim({
      insert: DUPLICATE,
      select: { data: { id: 'row-1', request_hash: 'f'.repeat(64) }, error: null },
      update: { data: [{ id: 'row-1' }], error: null },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(await res.json()).toMatchObject({ ok: true, sent: 1, skipped: 0 });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // The key is read in this organization and scope...
    const key = String(insertedClaim(stub).key);
    expect(eqFilters(stub, 'idempotency_keys.select')).toEqual(
      expect.arrayContaining([
        ['organization_id', 'org-1'],
        ['scope', 'weekly_digest'],
        ['key', key],
      ]),
    );
    // ...and taken over only as it was read: by its id and its old hash.
    expect(eqFilters(stub, 'idempotency_keys.update')).toEqual(
      expect.arrayContaining([
        ['id', 'row-1'],
        ['request_hash', 'f'.repeat(64)],
      ]),
    );
    const update = stub.chainArgsAll.get('idempotency_keys.update')?.[0]?.[0]?.[0] as Record<string, unknown>;
    expect(update).toMatchObject({ status: 'completed', request_hash: insertedClaim(stub).request_hash });
  });

  it('signs the claim with a key derived from UNSUBSCRIBE_SECRET, never with the cron secret', async () => {
    const hashes: string[] = [];
    const runs: Array<[string, string]> = [
      ['test-cron-secret', CLAIM_SIGNING_VALUE],
      ['another-cron-secret', CLAIM_SIGNING_VALUE],
      ['test-cron-secret', 'claim-sign-' + 'm'.repeat(24)],
    ];
    let key = '';
    for (const [cronSecret, signingValue] of runs) {
      signable.CRON_SECRET = cronSecret;
      signable.UNSUBSCRIBE_SECRET = signingValue;
      const stub = stubWithClaim({ insert: { data: { id: 'claim-1' }, error: null } });
      adminHolder.client = stub.client;
      await GET(buildRequest(`Bearer ${cronSecret}`));
      const claim = insertedClaim(stub);
      expect(claim).toMatchObject({ organization_id: 'org-1', scope: 'weekly_digest', status: 'completed' });
      key = String(claim.key);
      hashes.push(String(claim.request_hash));
    }
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    // Another cron secret, the same hash; another signing value, another hash.
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).not.toBe(hashes[0]);
    // Not the value the cron secret would sign, nor the unsigned form.
    const underCronSecret = createHmac('sha256', 'test-cron-secret')
      .update(`weekly_digest_claim:v1|org-1|${key}`)
      .digest('hex');
    expect(hashes[0]).not.toBe(underCronSecret);
    expect(hashes[0]).not.toBe(unsignedForm('org-1', key));
    expect(reportsTagged('cron.weekly-digest.claim_unsigned')).toHaveLength(0);
  });

  it('claims unsigned and reports once per run when UNSUBSCRIBE_SECRET is shorter than 32 characters', async () => {
    signable.UNSUBSCRIBE_SECRET = 'k'.repeat(31);
    const stub = stubWithClaim({ insert: DUPLICATE }, [
      recipientRow('user-a', 'a@acme.test'),
      recipientRow('user-b', 'b@acme.test'),
    ]);
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    // Any row under the key means sent: nothing is read or taken over.
    expect(await res.json()).toMatchObject({ ok: true, sent: 0, skipped: 2 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(stub.chainsAll.has('idempotency_keys.select')).toBe(false);
    expect(stub.chainsAll.has('idempotency_keys.update')).toBe(false);
    const claim = insertedClaim(stub);
    expect(claim.request_hash).toBe(unsignedForm('org-1', String(claim.key)));
    const reports = reportsTagged('cron.weekly-digest.claim_unsigned');
    expect(reports).toHaveLength(1);
    // The report names the condition only; no secret material.
    expect(String((reports[0]![0] as Error).message)).not.toContain('k'.repeat(8));
  });

  it('claims unsigned, and reports, when UNSUBSCRIBE_SECRET is unset', async () => {
    delete signable.UNSUBSCRIBE_SECRET;
    const stub = stubWithClaim({ insert: { data: { id: 'claim-1' }, error: null } });
    adminHolder.client = stub.client;

    await GET(buildRequest('Bearer test-cron-secret'));

    const claim = insertedClaim(stub);
    expect(claim.request_hash).toBe(unsignedForm('org-1', String(claim.key)));
    expect(reportsTagged('cron.weekly-digest.claim_unsigned')).toHaveLength(1);
  });

  it('honours an unsigned claim of the week of 2026-11-09 as sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'));
    const key = 'user-a:2026-11-09';
    const stub = stubWithClaim({
      insert: DUPLICATE,
      select: { data: { id: 'row-1', request_hash: unsignedForm('org-1', key) }, error: null },
      update: { data: [{ id: 'row-1' }], error: null },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(String(insertedClaim(stub).key)).toBe(key);
    expect(await res.json()).toMatchObject({ ok: true, sent: 0, skipped: 1 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(stub.chainsAll.has('idempotency_keys.update')).toBe(false);
  });

  it('does not honour the unsigned form for the week of 2026-11-16', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T14:00:00.000Z'));
    const key = 'user-a:2026-11-16';
    const stub = stubWithClaim({
      insert: DUPLICATE,
      select: { data: { id: 'row-1', request_hash: unsignedForm('org-1', key) }, error: null },
      update: { data: [{ id: 'row-1' }], error: null },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(String(insertedClaim(stub).key)).toBe(key);
    expect(await res.json()).toMatchObject({ ok: true, sent: 1, skipped: 0 });
    expect(eqFilters(stub, 'idempotency_keys.update')).toContainEqual([
      'request_hash',
      unsignedForm('org-1', key),
    ]);
  });

  it('tries the take-over again when the row changes between tries, and sends holding the claim', async () => {
    let reads = 0;
    let updates = 0;
    const stub = stubWithClaim({
      insert: DUPLICATE,
      // Each read answers an unsigned row with another hash.
      select: () => ({ data: { id: 'row-1', request_hash: String(++reads).repeat(64) }, error: null }),
      // The first two compare-and-sets miss (the row changed first); the third holds.
      update: () => (++updates < 3 ? { data: [], error: null } : { data: [{ id: 'row-1' }], error: null }),
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(await res.json()).toMatchObject({ ok: true, sent: 1, skipped: 0 });
    expect(updates).toBe(3);
    // Each try names the hash that try read.
    for (const [n, digit] of [[0, '1'], [1, '2'], [2, '3']] as const) {
      expect(eqFilters(stub, 'idempotency_keys.update', n)).toContainEqual(['request_hash', digit.repeat(64)]);
    }
    expect(reportsTagged('cron.weekly-digest.claim')).toHaveLength(0);
  });

  it('sends, and reports, after three tries that each find the row changed', async () => {
    let reads = 0;
    const stub = stubWithClaim({
      insert: DUPLICATE,
      select: () => ({ data: { id: 'row-1', request_hash: String(++reads % 10).repeat(64) }, error: null }),
      update: { data: [], error: null },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(await res.json()).toMatchObject({ ok: true, sent: 1, skipped: 0 });
    expect(stub.chainsAll.get('idempotency_keys.update')).toHaveLength(3);
    expect(reportsTagged('cron.weekly-digest.claim')).toHaveLength(1);
  });

  it('claims again when the row under the key is gone, and sends holding the claim', async () => {
    let inserts = 0;
    const stub = stubWithClaim({
      insert: () => (++inserts === 1 ? DUPLICATE : { data: { id: 'claim-2' }, error: null }),
      select: { data: null, error: null },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(await res.json()).toMatchObject({ ok: true, sent: 1, skipped: 0 });
    expect(inserts).toBe(2);
    expect(insertedClaim(stub, 1)).toMatchObject({
      key: insertedClaim(stub, 0).key,
      request_hash: insertedClaim(stub, 0).request_hash,
    });
    expect(reportsTagged('cron.weekly-digest.claim')).toHaveLength(0);
  });

  it("leaves the week marked sent when another run's claim replaced the row first", async () => {
    let signature: unknown;
    let reads = 0;
    const stub = stubWithClaim({
      insert: (call: MockCall) => {
        signature = (call.args[call.methods.indexOf('insert')]?.[0] as { request_hash?: unknown })
          ?.request_hash;
        return DUPLICATE;
      },
      // First read: an unsigned row. After the take-over missed, the read
      // answers the row the other run left: a signed claim.
      select: () =>
        reads++ === 0
          ? { data: { id: 'row-1', request_hash: '0'.repeat(64) }, error: null }
          : { data: { id: 'row-1', request_hash: signature }, error: null },
      update: { data: [], error: null },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(await res.json()).toMatchObject({ ok: true, sent: 0, skipped: 1 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('leaves the week marked sent, and reports, when the row under the key cannot be read', async () => {
    const stub = stubWithClaim({
      insert: DUPLICATE,
      select: { data: null, error: { message: 'read failed' } },
    });
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(await res.json()).toMatchObject({ ok: true, sent: 0, skipped: 1 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(reportsTagged('cron.weekly-digest.claim')).toHaveLength(1);
  });
});

describe('GET /api/cron/weekly-digest — a platform admin acting as an org is not a member of it', () => {
  // "Act as" (platform console) writes an accepted 'owner' membership with a
  // 45-minute impersonation_expires_at (services/platform/impersonation.ts).
  // Every other cron leaves those rows out; the digest counted them, so an
  // opted-in platform admin acting as a customer at Monday 14:00 UTC got that
  // customer's digest and a weekly_digest claim landed in the customer's
  // idempotency_keys.
  const GRANT = {
    organization_id: 'org-cust',
    accepted_at: '2026-10-05T13:50:00Z',
    impersonation_expires_at: '2026-10-05T14:35:00Z',
    organizations: { id: 'org-cust', name: 'Customer Co' },
  };
  const REAL = {
    organization_id: 'org-1',
    accepted_at: '2026-01-01T00:00:00Z',
    impersonation_expires_at: null,
    organizations: { id: 'org-1', name: 'Acme' },
  };

  /** True when the chain filters `column` IS NULL. */
  function filtersNull(call: { methods: string[]; args: unknown[][] }, column: string): boolean {
    return call.methods.some(
      (m, i) => m === 'is' && call.args[i]?.[0] === column && call.args[i]?.[1] === null,
    );
  }

  function stubWithGrant() {
    return makeSupabaseStub({
      // Like PostgREST: the embedded filter drops the grant from the
      // membership list; without it both memberships come back.
      'user_profiles.select': (call) => {
        const memberships = filtersNull(call, 'organization_members.impersonation_expires_at')
          ? [REAL]
          : [REAL, GRANT];
        return {
          data: [{ ...recipientRow('platform-admin', 'admin@platform.test'), organization_members: memberships }],
          error: null,
        };
      },
      'user_profiles.select.maybeSingle': {
        data: { email_digest_optin: true, disabled_at: null },
        error: null,
      },
      // The per-recipient check reads (org, user): the grant row for the
      // customer org unless the check leaves grants out.
      'organization_members.select.maybeSingle': (call) => {
        const org = call.args[call.methods.indexOf('eq')]?.[1];
        if (org === 'org-cust') {
          return {
            data: filtersNull(call, 'impersonation_expires_at')
              ? null
              : { user_id: 'platform-admin', accepted_at: GRANT.accepted_at, role: 'owner' },
            error: null,
          };
        }
        return {
          data: { user_id: 'platform-admin', accepted_at: REAL.accepted_at, role: 'owner' },
          error: null,
        };
      },
    });
  }

  it("sends only the admin's own org digest and claims nothing in the org they act as", async () => {
    const stub = stubWithGrant();
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await res.json()).toMatchObject({ ok: true, sent: 1, failed: 0 });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const claims = (stub.chainArgsAll.get('idempotency_keys.insert') ?? []).map(
      (args) => (args[0]?.[0] as { organization_id?: string } | undefined)?.organization_id,
    );
    expect(claims).toEqual(['org-1']);
  });

  it('leaves grants out of the recipient pull and out of the check before each send', async () => {
    const stub = stubWithGrant();
    adminHolder.client = stub.client;

    await GET(buildRequest('Bearer test-cron-secret'));

    const pull = stub.chainsAll.get('user_profiles.select')?.[0] ?? [];
    const pullArgs = stub.chainArgsAll.get('user_profiles.select')?.[0] ?? [];
    expect(
      filtersNull({ methods: pull, args: pullArgs }, 'organization_members.impersonation_expires_at'),
    ).toBe(true);
    const checks = stub.chainsAll.get('organization_members.select') ?? [];
    const checkArgs = stub.chainArgsAll.get('organization_members.select') ?? [];
    const recheck = checks.findIndex((methods) => methods.includes('maybeSingle') || methods.includes('eq'));
    expect(recheck).toBeGreaterThanOrEqual(0);
    expect(
      filtersNull({ methods: checks[recheck]!, args: checkArgs[recheck]! }, 'impersonation_expires_at'),
    ).toBe(true);
  });
});

describe('GET /api/cron/weekly-digest — the recipient pull names its membership relationship', () => {
  // organization_members has TWO foreign keys to user_profiles (user_id, and
  // invited_by since 0001). PostgREST answers an embed of organization_members
  // from user_profiles that names neither with HTTP 300, code PGRST201, and no
  // rows. The recipient pull did exactly that: the cron answered 500 every
  // Monday (seen 2026-09-21, 09-28, 10-05) and no digest was ever sent.
  // The recipient's memberships are the rows whose user_id is the recipient,
  // so the embed must go through organization_members_user_id_fkey.
  const MEMBERSHIP_EMBED = /organization_members\s*(?:![a-z_]+\s*)*\(/;
  const NAMED_MEMBERSHIP_EMBED =
    /organization_members!organization_members_user_id_fkey!inner\s*\(/;

  /** The select string of the bulk recipient pull (its first select chain). */
  function bulkSelect(stub: ReturnType<typeof makeSupabaseStub>): string {
    const chain = stub.chainsAll.get('user_profiles.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('user_profiles.select')?.[0] ?? [];
    return String(args[chain.indexOf('select')]?.[0] ?? '');
  }

  function stubAnsweringLikePostgrest() {
    return makeSupabaseStub({
      // Like PostgREST: an embed of organization_members that does not name
      // its relationship is refused before any row is read.
      'user_profiles.select': (call) => {
        const select = String(call.args[call.methods.indexOf('select')]?.[0] ?? '');
        if (MEMBERSHIP_EMBED.test(select) && !NAMED_MEMBERSHIP_EMBED.test(select)) {
          return {
            data: null,
            error: {
              code: 'PGRST201',
              message:
                "Could not embed because more than one relationship was found for 'user_profiles' and 'organization_members'",
            },
          };
        }
        return { data: [recipientRow('user-a', 'a@acme.test')], error: null };
      },
      'user_profiles.select.maybeSingle': {
        data: { email_digest_optin: true, disabled_at: null },
        error: null,
      },
      'organization_members.select.maybeSingle': {
        data: { user_id: 'user-a', accepted_at: '2026-01-01T00:00:00Z' },
        error: null,
      },
    });
  }

  it("renders each email with its org's time zone, for the send time the footer states", async () => {
    const stub = stubAnsweringLikePostgrest();
    adminHolder.client = stub.client;
    const { renderWeeklyDigestHtml } = await import('@/lib/email/es/families/digest');

    await GET(buildRequest('Bearer test-cron-secret'));

    expect(renderWeeklyDigestHtml).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeZone: 'America/Los_Angeles', orgName: 'Acme' }),
    );
  });

  it('sends the digest when PostgREST refuses an embed that does not name its relationship', async () => {
    const stub = stubAnsweringLikePostgrest();
    adminHolder.client = stub.client;

    const res = await GET(buildRequest('Bearer test-cron-secret'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sent: 1, failed: 0 });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('a@acme.test');
  });

  it('pins the recipient select: memberships through organization_members_user_id_fkey, accepted only', async () => {
    const stub = stubAnsweringLikePostgrest();
    adminHolder.client = stub.client;

    await GET(buildRequest('Bearer test-cron-secret'));

    // supabase-js drops whitespace outside quotes before sending.
    expect(bulkSelect(stub).replace(/\s+/g, '')).toBe(
      'id,email,full_name,digest_section_low_stock,digest_section_open_pos,digest_section_cycle_counts,' +
        'organization_members!organization_members_user_id_fkey!inner(organization_id,accepted_at,organizations:organization_id(id,name,timezone))',
    );
    // The accepted-membership filter still names the embed by its table name
    // (a hint does not rename it).
    const chain = stub.chainsAll.get('user_profiles.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('user_profiles.select')?.[0] ?? [];
    expect(args[chain.indexOf('not')]).toEqual(['organization_members.accepted_at', 'is', null]);
    // ...and so does the filter that leaves "act as" grants out.
    const isFilters = chain.flatMap((m, i) => (m === 'is' ? [args[i]] : []));
    expect(isFilters).toContainEqual(['organization_members.impersonation_expires_at', null]);
  });
});

describe('GET /api/cron/weekly-digest — overdue in the organization zone', () => {
  // The OVERDUE flag is decided per organization when its purchase orders are
  // read (services/digest.ts, core isPastExpectedDay): a purchase order is
  // overdue once the ORGANIZATION's date is after its expected day. So each
  // org is read with its own zone and the run's start, never the server's day.
  // On main the read took no zone, and the Monday run (7 AM in Los Angeles)
  // flagged every purchase order expected that Monday as overdue.
  it("reads each organization's open purchase orders in that organization's zone, as of the run's start", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-12T14:00:00.000Z'));
      const sydneyRow = {
        ...recipientRow('user-b', 'b@harbour.test'),
        organization_members: [
          {
            organization_id: 'org-2',
            accepted_at: '2026-01-01T00:00:00Z',
            organizations: { id: 'org-2', name: 'Harbour', timezone: 'Australia/Sydney' },
          },
        ],
      };
      const noZoneRow = {
        ...recipientRow('user-c', 'c@nozone.test'),
        organization_members: [
          {
            organization_id: 'org-3',
            accepted_at: '2026-01-01T00:00:00Z',
            organizations: { id: 'org-3', name: 'No Zone', timezone: null },
          },
        ],
      };
      const stub = makeSupabaseStub({
        'user_profiles.select': {
          data: [recipientRow('user-a', 'a@acme.test'), sydneyRow, noZoneRow],
          error: null,
        },
        'user_profiles.select.maybeSingle': {
          data: { email_digest_optin: true, disabled_at: null },
          error: null,
        },
        'organization_members.select.maybeSingle': {
          data: { user_id: 'whichever', accepted_at: '2026-01-01T00:00:00Z', role: 'owner' },
          error: null,
        },
      });
      adminHolder.client = stub.client;
      const { getDigestSource } = await import('@/server/services/digest');

      await GET(buildRequest('Bearer test-cron-secret'));

      const calls = vi.mocked(getDigestSource).mock.calls as unknown as Array<
        [unknown, string, { timeZone: string | null; now: Date }]
      >;
      expect(calls.map(([client, orgId, clock]) => [client === stub.client, orgId, clock?.timeZone])).toEqual([
        [true, 'org-1', 'America/Los_Angeles'],
        [true, 'org-2', 'Australia/Sydney'],
        // The documented default is applied where the rule is (core).
        [true, 'org-3', null],
      ]);
      for (const [, , clock] of calls) {
        expect(clock.now).toBeInstanceOf(Date);
        expect(clock.now.toISOString()).toBe('2026-10-12T14:00:00.000Z');
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /api/cron/weekly-digest — each organization's own date (small fixes slice 8)", () => {
  // The subject was built ONCE per run, in the server's zone (UTC on Vercel):
  // the Monday 14:00 UTC run is already Tuesday from UTC+10 east, so such an
  // organization's digest arrived dated the day before. Now each
  // organization's subject, HTML and text carry its own date, as of the run's
  // start.
  it("dates each organization's subject and text in that organization's zone, as of the run's start", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-12T14:00:00.000Z'));
      const sydneyRow = {
        ...recipientRow('user-b', 'b@harbour.test'),
        organization_members: [
          {
            organization_id: 'org-2',
            accepted_at: '2026-01-01T00:00:00Z',
            organizations: { id: 'org-2', name: 'Harbour', timezone: 'Australia/Sydney' },
          },
        ],
      };
      const stub = makeSupabaseStub({
        'user_profiles.select': { data: [recipientRow('user-a', 'a@acme.test'), sydneyRow], error: null },
        'user_profiles.select.maybeSingle': { data: { email_digest_optin: true, disabled_at: null }, error: null },
        'organization_members.select.maybeSingle': {
          data: { user_id: 'whichever', accepted_at: '2026-01-01T00:00:00Z', role: 'owner' },
          error: null,
        },
      });
      adminHolder.client = stub.client;
      const digest = await import('@/lib/email/es/families/digest');
      vi.mocked(digest.weeklyDigestSubject).mockImplementation(
        (_now?: Date, timeZone?: string | null) => `digest for ${timeZone}`,
      );

      await GET(buildRequest('Bearer test-cron-secret'));

      const at = new Date('2026-10-12T14:00:00.000Z');
      expect(vi.mocked(digest.weeklyDigestSubject).mock.calls).toEqual([
        [at, 'America/Los_Angeles'],
        [at, 'Australia/Sydney'],
      ]);
      const sent = sendEmailMock.mock.calls.map(([args]) => [args.to, args.subject]);
      expect(sent).toEqual([
        ['a@acme.test', 'digest for America/Los_Angeles'],
        ['b@harbour.test', 'digest for Australia/Sydney'],
      ]);
      expect(digest.weeklyDigestText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orgName: 'Harbour', now: at, timeZone: 'Australia/Sydney' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * B15: each digest carries the recipient's own signed one-click link for the
 * organization it is about, dated with the run's UTC day (it works for 90
 * days), in List-Unsubscribe (with List-Unsubscribe-Post) and as the footer's
 * and the text part's Unsubscribe. The signing value is a dull one under a
 * neutral name (src/test/secret-shaped-fixtures.guard.test.ts); without one
 * the digest keeps the settings page.
 */
describe('GET /api/cron/weekly-digest — one-click unsubscribe', () => {
  // Monday 7 AM in Los Angeles; the run's UTC day is Oct 26.
  const RUN_AT = new Date('2026-10-26T14:00:00.000Z');
  const DIGEST_SIGNING_VALUE = 'digest-cron-' + 'v'.repeat(22);
  const ORG_ID = '00000000-0000-4000-8000-00000000c0c0';
  const USER_ID = '00000000-0000-4000-8000-0000000000a1';
  const SETTINGS = 'https://stockpilotusa.com/dashboard/settings/notifications';
  const signable = env as Record<string, string | undefined>;

  function stubOneRecipient() {
    const row = recipientRow(USER_ID, 'a@acme.test');
    row.organization_members[0]!.organization_id = ORG_ID;
    row.organization_members[0]!.organizations = {
      id: ORG_ID,
      name: 'Acme',
      timezone: 'America/Los_Angeles',
    };
    return makeSupabaseStub({
      'user_profiles.select': { data: [row], error: null },
      'user_profiles.select.maybeSingle': {
        data: { email_digest_optin: true, disabled_at: null },
        error: null,
      },
      'organization_members.select.maybeSingle': {
        data: { user_id: USER_ID, accepted_at: '2026-01-01T00:00:00Z', role: 'staff' },
        error: null,
      },
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(RUN_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete signable.UNSUBSCRIBE_SECRET;
  });

  it("names the recipient and the digest's organization, dated the run's day, with one-click", async () => {
    signable.UNSUBSCRIBE_SECRET = DIGEST_SIGNING_VALUE;
    adminHolder.client = stubOneRecipient().client;
    const digest = await import('@/lib/email/es/families/digest');

    await GET(buildRequest('Bearer test-cron-secret'));

    const link = mintMemberUnsubscribeToken(
      { userId: USER_ID, organizationId: ORG_ID, kind: 'weekly_digest' },
      RUN_AT,
    );
    expect(link).toContain(`.${ORG_ID}.20261026.`);
    const url = `https://stockpilotusa.com/unsubscribe?m=${link}`;
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0].headers).toEqual({
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(digest.renderWeeklyDigestHtml).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ settingsUrl: SETTINGS, unsubscribeUrl: url }),
    );
    expect(digest.weeklyDigestText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ unsubscribeUrl: url }),
    );
  });

  it('keeps the settings page, with no one-click header, when no link can be signed', async () => {
    adminHolder.client = stubOneRecipient().client;

    await GET(buildRequest('Bearer test-cron-secret'));

    expect(sendEmailMock.mock.calls[0]![0].headers).toEqual({
      'List-Unsubscribe': `<${SETTINGS}>`,
    });
  });

  it("gives the HTML and the text part the one-click link and the organization's date together", async () => {
    // Merged with small fixes slice 8: both parts take the run's moment and
    // the organization's zone with the recipient's link, so neither is lost.
    signable.UNSUBSCRIBE_SECRET = DIGEST_SIGNING_VALUE;
    adminHolder.client = stubOneRecipient().client;
    const digest = await import('@/lib/email/es/families/digest');

    await GET(buildRequest('Bearer test-cron-secret'));

    const link = mintMemberUnsubscribeToken(
      { userId: USER_ID, organizationId: ORG_ID, kind: 'weekly_digest' },
      RUN_AT,
    );
    const url = `https://stockpilotusa.com/unsubscribe?m=${link}`;
    expect(digest.weeklyDigestSubject).toHaveBeenCalledWith(RUN_AT, 'America/Los_Angeles');
    for (const rendered of [digest.renderWeeklyDigestHtml, digest.weeklyDigestText]) {
      expect(rendered).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          settingsUrl: SETTINGS,
          unsubscribeUrl: url,
          now: RUN_AT,
          timeZone: 'America/Los_Angeles',
        }),
      );
    }
  });
});
