import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan 10.4 as decided on 2026-11-21 (and decision C): the hourly check of
 * sessions raised through a passkey bridge. A raise is explained only by its
 * own passkey.bridge_raise row near its raised_at (the ceremony writes it
 * before answering and refuses without it, passkeys.test.ts "10.4"). An
 * unexplained raise gets an error report, the end of THAT ONE session
 * (0475's passkey_end_bridge_session), the devices told, a security event,
 * and at most one email a day; never a factor deleted or a passkey removed.
 * Doubt of any kind acts on nothing; the caps hold. The session list is given
 * in the shape 0475's passkey_bridge_sessions returns; the audit rows are
 * filtered by a fake of the query builder.
 */

interface Row {
  id: number;
  user_id: string | null;
  event: string;
  metadata: { session_id?: string; raise_id?: string } | null;
  created_at: string;
}

const h = vi.hoisted(() => ({
  rp: { rpId: 'localhost', origins: ['http://localhost:3000'] } as {
    rpId: string;
    origins: string[];
  } | null,
  settings: { data: { passkeys_on: true }, error: null } as { data: unknown; error: unknown },
  sessions: { data: [], error: null } as { data: unknown; error: unknown },
  audit: [] as Row[],
  auditFails: false,
  tables: [] as string[],
  rpcNames: [] as string[],
  reports: [] as Array<{ tag: string; level?: string; extra?: Record<string, unknown> }>,
  events: [] as Array<{ reason: string; outcome: string; category: string }>,
  onEvent: null as null | (() => void),
  /** passkey_end_bridge_session's answer, and the ids it was asked to end. */
  endAnswer: { data: true, error: null } as { data: unknown; error: unknown },
  endAsked: [] as unknown[],
  broadcasts: [] as Array<{ userId: string; listed: unknown; stays: string }>,
  /** The pace of the email: keys asked, and the keys already used today. */
  paceKeys: [] as string[],
  paced: new Set<string>(),
  limiterDown: false,
  address: { data: { user: { email: 'member@example.test' } }, error: null } as {
    data: unknown;
    error: unknown;
  },
  emails: [] as string[],
}));

vi.mock('@/lib/auth/passkey-relying-party', () => ({ passkeyRelyingParty: () => h.rp }));
vi.mock('@/lib/error-reporter', () => ({
  reportError: async (
    _e: unknown,
    ctx: { tag: string; level?: string; extra?: Record<string, unknown> },
  ) => {
    h.reports.push(ctx);
  },
}));
vi.mock('@/server/services/auth-audit', () => ({
  resolveDefaultOrgAndRole: async () => ({ organizationId: null, role: null }),
}));
vi.mock('./events', () => ({
  recordSecurityEvent: async (e: { reason: string; outcome: string; category: string }) => {
    h.events.push(e);
    h.onEvent?.();
  },
}));
vi.mock('@/server/services/sessions', () => ({
  broadcastEndedSessions: async (userId: string, listed: unknown, stays: string) => {
    h.broadcasts.push({ userId, listed, stays });
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async (key: string, limit: number, windowMs: number, mode: string) => {
    h.paceKeys.push(key);
    expect([limit, windowMs, mode]).toEqual([1, 24 * 60 * 60_000, 'closed']);
    if (h.limiterDown || h.paced.has(key)) return { allowed: false };
    h.paced.add(key);
    return { allowed: true };
  },
}));
vi.mock('./passkey-emails', () => ({
  sendPasskeySignInEndedEmail: (to: string) => {
    h.emails.push(to);
  },
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { getUserById: async () => h.address } },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcNames.push(name);
      if (name === 'passkey_end_bridge_session') {
        h.endAsked.push(args.p_session_id);
        return h.endAnswer;
      }
      expect(name).toBe('passkey_bridge_sessions');
      return h.sessions;
    },
    from: (table: string) => {
      h.tables.push(table);
      const filters: Array<(r: Row) => boolean> = [];
      let range: [number, number] = [0, Infinity];
      const q = {
        select: () => q,
        limit: () => q,
        order: () => q,
        maybeSingle: async () => {
          expect(table).toBe('platform_settings');
          return h.settings;
        },
        in: (col: string, vs: string[]) => (
          filters.push((r) => vs.includes(String(r[col as keyof Row]))),
          q
        ),
        gte: (col: string, v: string) => (filters.push((r) => String(r[col as keyof Row]) >= v), q),
        range: (a: number, b: number) => ((range = [a, b]), q),
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          expect(table).toBe('audit_logs');
          if (h.auditFails)
            return Promise.resolve({ data: null, error: { code: '57014' } }).then(resolve);
          const rows = h.audit
            .filter((r) => filters.every((f) => f(r)))
            .slice(range[0], range[1] + 1);
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return q;
    },
  }),
}));

import { MAX_FINDINGS, MAX_SESSIONS, runPasskeyDetector } from './passkey-detector';

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const U = '11111111-1111-4111-8111-111111111111';
const S = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function session(extra: Partial<Record<string, unknown>> = {}) {
  return {
    session_id: S,
    user_id: U,
    factor_id: 'bridge-1',
    recorded: true,
    aal: 'aal2',
    created_at: ago(60 * MIN),
    updated_at: ago(20 * MIN),
    ...extra,
  };
}
let nextId = 1;
function row(event: string, at: string, sessionId = S, userId = U): Row {
  return {
    id: nextId++,
    user_id: userId,
    event,
    metadata: { session_id: sessionId, raise_id: `r-${nextId}` },
    created_at: at,
  };
}
const raiseRow = (at: string, sessionId = S, userId = U) =>
  row('passkey.bridge_raise', at, sessionId, userId);
const tags = () => h.reports.map((r) => r.tag);
const flagged = () => h.reports.filter((r) => r.tag === 'passkeys.bridge_session_unexplained');

beforeEach(() => {
  h.rp = { rpId: 'localhost', origins: ['http://localhost:3000'] };
  h.settings = { data: { passkeys_on: true }, error: null };
  h.sessions = { data: [], error: null };
  h.audit = [];
  h.auditFails = false;
  h.tables = [];
  h.rpcNames = [];
  h.reports = [];
  h.events = [];
  h.onEvent = null;
  h.endAnswer = { data: true, error: null };
  h.endAsked = [];
  h.broadcasts = [];
  h.paceKeys = [];
  h.paced = new Set();
  h.limiterDown = false;
  h.address = { data: { user: { email: 'member@example.test' } }, error: null };
  h.emails = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a raise is explained by its own row', () => {
  it('a legit raise: its raise row just before raised_at explains it; nothing is reported', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [raiseRow(ago(20 * MIN + 1500))];
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ ran: true, listed: 1, examined: 1, explained: 1, unexplained: 0 });
    expect(h.reports).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('a second raise on the same session needs its own row: the first raise row does not explain it', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [raiseRow(ago(50 * MIN))];
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ explained: 0, unexplained: 1 });
    expect(flagged()[0]?.extra).toMatchObject({ ending: 'ended' });
  });

  it('the bound is the raise: a row 2 minutes before it explains; a row 6 seconds after it, or 2 minutes and 1 second before, does not', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [raiseRow(ago(22 * MIN - 50))];
    expect(await runPasskeyDetector()).toMatchObject({ explained: 1, unexplained: 0 });
    for (const at of [ago(20 * MIN - 6_000), ago(22 * MIN + 1_000)]) {
      h.reports = [];
      h.audit = [raiseRow(at), row('passkey.used', ago(90 * MIN))];
      expect(await runPasskeyDetector()).toMatchObject({ explained: 0, unexplained: 1 });
    }
  });

  it('another kind of row, or the raise row of another session, explains nothing', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [
      row('passkey.used', ago(20 * MIN)),
      raiseRow(ago(20 * MIN + 1000), 'another-session'),
    ];
    expect((await runPasskeyDetector()).unexplained).toBe(1);
  });

  it('a session without a raise time is not settled: nothing is done', async () => {
    h.sessions = { data: [session()], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ examined: 0, unexplained: 0, notSettled: { times: 1 } });
    expect(h.endAsked).toEqual([]);
    expect(h.events).toEqual([]);
  });
});

describe('a raise with no row: that one session ended, a report, a security event, one email', () => {
  it('ends THAT session (and no other), tells the devices, reports with a hash, records a flagged event, emails once', async () => {
    h.sessions = {
      data: [
        session({ raised_at: ago(20 * MIN) }),
        { ...session({ raised_at: ago(25 * MIN) }), session_id: 'explained-1' },
      ],
      error: null,
    };
    h.audit = [row('passkey.used', ago(90 * MIN)), raiseRow(ago(25 * MIN + 1000), 'explained-1')];
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({
      unexplained: 1,
      explained: 1,
      ending: { ended: 1, alreadyGone: 0, refused: 0, failed: 0 },
      emailed: 1,
    });
    expect(h.endAsked).toEqual([S]);
    expect(h.broadcasts).toEqual([{ userId: U, listed: [S], stays: '' }]);
    expect(flagged()).toHaveLength(1);
    expect(flagged()[0]!.level).toBe('error');
    expect(flagged()[0]!.extra).toMatchObject({ ending: 'ended', recorded: true });
    expect(flagged()[0]!.extra!.userIdHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(h.reports)).not.toContain(U);
    expect(h.events).toEqual([
      expect.objectContaining({
        reason: 'passkey_unexplained_sign_in',
        outcome: 'flagged',
        category: 'password_guessing',
      }),
    ]);
    expect(h.paceKeys).toEqual([`passkey-detector-email:${U}`]);
    expect(h.emails).toEqual(['member@example.test']);
    // The switch, the list, the audit rows, and the one end: nothing else.
    expect(h.rpcNames).toEqual(['passkey_bridge_sessions', 'passkey_end_bridge_session']);
    expect([...new Set(h.tables)].sort()).toEqual(['audit_logs', 'platform_settings']);
    expect(tags()).not.toContain('passkeys.detector_failed');
  });

  it('one email a day: a second run the same day ends the new raise but sends no second email', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    await runPasskeyDetector();
    const again = await runPasskeyDetector();
    expect(again).toMatchObject({ ending: { ended: 1 }, emailed: 0 });
    expect(h.endAsked).toEqual([S, S]);
    expect(h.emails).toEqual(['member@example.test']);
  });

  it('a pace that cannot be counted sends no email (closed); an account with no address is reported', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    h.limiterDown = true;
    expect(await runPasskeyDetector()).toMatchObject({ ending: { ended: 1 }, emailed: 0 });
    expect(h.emails).toEqual([]);

    h.limiterDown = false;
    h.address = { data: { user: null }, error: { status: 404 } };
    expect(await runPasskeyDetector()).toMatchObject({ emailed: 0 });
    expect(h.emails).toEqual([]);
    expect(tags()).toContain('passkeys.detector_email_no_address');
  });

  it('the database refuses (not raised by a recorded bridge now): reported, the event recorded, nobody told, no email', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    h.endAnswer = { data: null, error: { code: '22023', message: 'passkey_session_not_bridge_raised' } };
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ unexplained: 1, ending: { ended: 0, refused: 1 }, emailed: 0 });
    expect(flagged()[0]!.extra).toMatchObject({ ending: 'refused' });
    expect(h.events).toHaveLength(1);
    expect(h.broadcasts).toEqual([]);
    expect(h.emails).toEqual([]);
  });

  it('a session already gone, or an end that failed: no broadcast, no email; the failure is in the report', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    h.endAnswer = { data: false, error: null };
    expect(await runPasskeyDetector()).toMatchObject({ ending: { alreadyGone: 1 }, emailed: 0 });
    h.reports = [];
    h.endAnswer = { data: null, error: { code: '55P03' } };
    expect(await runPasskeyDetector()).toMatchObject({ ending: { failed: 1 }, emailed: 0 });
    expect(flagged()[0]!.extra).toMatchObject({ ending: 'failed' });
    expect(h.broadcasts).toEqual([]);
    expect(h.emails).toEqual([]);
  });

  it('the module cannot delete a factor or remove a passkey, and ends sessions only through the one function', () => {
    const source = readFileSync(path.join(__dirname, 'passkey-detector.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      /deleteFactor/,
      /unenrol/i,
      /\bmfa\b/,
      /passkey_mark_removed|passkey_drop_bridge|passkey_remove|removePasskey/,
      /revoke|signOut|sign_out|logout/i,
      /\.(delete|update|insert|upsert)\(/,
      /\/factors/,
      /auth\.sessions|admin_revoke/,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      './events',
      './passkey-emails',
      './passkey-state',
      '@/lib/auth/passkey-bridge',
      '@/lib/auth/passkey-relying-party',
      '@/lib/error-reporter',
      '@/lib/rate-limit',
      '@/lib/supabase/admin',
      '@/server/services/auth-audit',
      '@/server/services/sessions',
    ]);
    const rpcs = [...code.matchAll(/\.rpc\('([^']+)'/g)].map((m) => m[1]);
    expect(rpcs).toEqual(['passkey_end_bridge_session', 'passkey_bridge_sessions']);
    // The one email it can send, and the one Auth admin call (the address).
    expect([...code.matchAll(/send[A-Za-z]*Email\(/g)].map((m) => m[0])).toEqual([
      'sendPasskeySignInEndedEmail(',
    ]);
    expect([...code.matchAll(/auth\.admin\.([A-Za-z]+)/g)].map((m) => m[1])).toEqual([
      'getUserById',
    ]);
  });
});

describe('it never acts on doubt', () => {
  const noAction = () => {
    expect(flagged()).toEqual([]);
    expect(h.events).toEqual([]);
  };

  it('a switch that cannot be read settles nothing (error); the sessions are not even read', async () => {
    h.settings = { data: null, error: { code: '57014' } };
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    expect((await runPasskeyDetector()).ran).toBe(false);
    expect(h.rpcNames).toEqual([]);
    expect(h.reports.find((r) => r.tag === 'passkeys.detector_settings_unreadable')?.level).toBe(
      'error',
    );
    noAction();

    h.reports = [];
    h.settings = { data: null, error: null };
    expect((await runPasskeyDetector()).ran).toBe(false);
    expect(tags()).toContain('passkeys.detector_settings_unreadable');
  });

  it('a switch that is off is a value, not doubt: the check still runs', async () => {
    h.settings = { data: { passkeys_on: false }, error: null };
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ switchOn: false, unexplained: 1 });
  });

  it('a session whose times cannot be read', async () => {
    h.sessions = {
      data: [
        session({ raised_at: null }),
        { ...session(), session_id: 'other', created_at: 'not a time' },
      ],
      error: null,
    };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    const s = await runPasskeyDetector();
    expect(s.notSettled.times).toBe(2);
    expect(tags()).toContain('passkeys.detector_times_unreadable');
    noAction();
  });

  it('an audit read that failed (error report)', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.auditFails = true;
    const s = await runPasskeyDetector();
    expect(s.notSettled.auditRead).toBe(1);
    expect(h.reports.find((r) => r.tag === 'passkeys.detector_audit_unreadable')?.level).toBe(
      'error',
    );
    noAction();
  });

  it('an account with no passkey audit row at all since the raise (reported with the hash)', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [row('passkey.used', ago(30 * MIN), S, 'someone-else')];
    const s = await runPasskeyDetector();
    expect(s.notSettled.noRows).toBe(1);
    const r = h.reports.find((x) => x.tag === 'passkeys.detector_no_passkey_rows');
    expect(r?.extra).toMatchObject({
      count: 1,
      accounts: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    noAction();
  });

  it('a raise in the last two minutes waits for the next run', async () => {
    h.sessions = { data: [session({ raised_at: ago(30_000) })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ waiting: 1, examined: 0 });
    noAction();
  });

  it('a session list that cannot be read is an error, never "all clear"; before 0475 it is quiet', async () => {
    h.sessions = { data: null, error: { code: '57014' } };
    expect((await runPasskeyDetector()).ran).toBe(false);
    expect(h.reports.find((r) => r.tag === 'passkeys.detector_unreadable')?.level).toBe('error');

    h.reports = [];
    h.sessions = { data: null, error: { code: 'PGRST202' } };
    expect((await runPasskeyDetector()).ran).toBe(false);
    expect(h.reports).toEqual([]);
  });

  it('without a site nothing is read', async () => {
    h.rp = null;
    await runPasskeyDetector();
    expect(h.tables).toEqual([]);
    expect(h.rpcNames).toEqual([]);
  });
});

describe('the bounds hold', () => {
  function unexplainedSessions(n: number) {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const user = `user-${i}`;
      out.push({ ...session({ raised_at: ago(20 * MIN) }), session_id: `s-${i}`, user_id: user });
      h.audit.push(row('passkey.used', ago(90 * MIN), `old-${i}`, user));
    }
    return out;
  }

  it(`at most ${MAX_FINDINGS} sessions flagged, and so ended, a run; then it stops and one error report says so`, async () => {
    h.sessions = { data: unexplainedSessions(MAX_FINDINGS + 2), error: null };
    const s = await runPasskeyDetector();
    expect(s.unexplained).toBe(MAX_FINDINGS);
    expect(s.ending.ended).toBe(MAX_FINDINGS);
    expect(h.endAsked).toHaveLength(MAX_FINDINGS);
    expect(h.events).toHaveLength(MAX_FINDINGS);
    expect(s.stop).toBe('finding_cap');
    const stop = h.reports.find((r) => r.tag === 'passkeys.detector_stopped');
    expect(stop).toMatchObject({
      level: 'error',
      extra: { stop: 'finding_cap', unexplained: MAX_FINDINGS },
    });
  });

  it(`at most ${MAX_SESSIONS} sessions examined a run; the early stop is reported with counts`, async () => {
    const many = Array.from({ length: MAX_SESSIONS + 3 }, (_, i) => ({
      ...session({ raised_at: ago(20 * MIN) }),
      session_id: `s-${i}`,
    }));
    for (const m of many) h.audit.push(raiseRow(ago(20 * MIN + 1000), m.session_id));
    h.sessions = { data: many, error: null };
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({
      listed: MAX_SESSIONS + 3,
      examined: MAX_SESSIONS,
      explained: MAX_SESSIONS,
      stop: 'session_cap',
    });
    expect(h.reports.find((r) => r.tag === 'passkeys.detector_stopped')).toMatchObject({
      level: 'warning',
      extra: { stop: 'session_cap', listed: MAX_SESSIONS + 3, examined: MAX_SESSIONS },
    });
  });

  it('no new session is started after the time budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    h.sessions = { data: unexplainedSessions(3), error: null };
    // Each flagged session takes 31 seconds of the run.
    h.onEvent = () => vi.setSystemTime(Date.now() + 31_000);
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ examined: 1, unexplained: 1, stop: 'time_limit' });
    expect(tags()).toContain('passkeys.detector_stopped');
  });
});

describe('the other way round (10.4 a)', () => {
  it('our passkey.used row whose session is not listed is a warning count', async () => {
    h.audit = [row('passkey.used', ago(30 * MIN), 'not-listed')];
    const s = await runPasskeyDetector();
    expect(s.usedButNotListed).toBe(1);
    expect(h.reports.find((r) => r.tag === 'passkeys.detector_used_not_listed')?.level).toBe(
      'warning',
    );
  });
});
