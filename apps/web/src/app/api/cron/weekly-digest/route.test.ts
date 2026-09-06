import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

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

vi.mock('@/server/services/digest', () => ({
  getDigestData: vi.fn(async () => ({ lowStock: [], openPos: [], cycleCounts: [] })),
  isDigestEmpty: vi.fn(() => false),
  applySectionOptIns: vi.fn((payload: unknown) => payload),
}));

import { GET } from './route';

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
        organizations: { id: 'org-1', name: 'Acme' },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    // later insert for the same week comes back 23505.
    let claims = 0;
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
      'idempotency_keys.insert': () =>
        claims++ === 0
          ? { data: { id: 'claim-1' }, error: null }
          : {
              data: null,
              error: {
                message: 'duplicate key value violates unique constraint "idempotency_keys_..."',
                code: '23505',
              },
            },
    });
    adminHolder.client = stub.client;

    const first = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await first.json()).toMatchObject({ ok: true, sent: 1 });

    const second = await GET(buildRequest('Bearer test-cron-secret'));
    expect(await second.json()).toMatchObject({ ok: true, sent: 0, skipped: 1 });

    // The digest went out exactly once across both invocations.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

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
