import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan 10.4 as decided on 2026-11-21 (decision C and review 4): the hourly
 * check of sessions raised through a passkey bridge. The rule: a raise is
 * explained only by its own passkey.bridge_raise row near its raised_at (the
 * ceremony writes it before answering and refuses without it,
 * passkeys.test.ts "10.4"); every raise without one gets an error report and
 * a security event, once (the check's own memory row). Ending is a setting
 * (review 3, A7): only while platform_settings.passkey_check_ends_sessions is
 * true does it also end THAT ONE session (0475's passkey_end_bridge_session),
 * tell the devices and send at most one email a day. Never a factor deleted
 * or a passkey removed. What cannot be read is reported and decides nothing;
 * the caps hold. The session list is given in the shape 0475's
 * passkey_bridge_sessions returns; the audit rows are filtered by a fake of
 * the query builder. Most blocks below run with ending ON (ENDS_ON), to pin
 * what an end does; the "report only" block pins the default.
 */

interface Row {
  id: number;
  user_id: string | null;
  event: string;
  metadata: {
    session_id?: string;
    raise_id?: string;
    raised_at?: string;
    ending?: string;
    tries?: number;
  } | null;
  created_at: string;
}

const h = vi.hoisted(() => ({
  rp: { rpId: 'localhost', origins: ['http://localhost:3000'] } as {
    rpId: string;
    origins: string[];
  } | null,
  settings: { data: { passkeys_on: true, passkey_check_ends_sessions: true }, error: null } as {
    data: unknown;
    error: unknown;
  },
  /** The columns the settings read asked for. */
  settingsColumns: [] as string[],
  sessions: { data: [], error: null } as { data: unknown; error: unknown },
  audit: [] as Row[],
  auditFails: false,
  /** The lower bound of every audit read (created_at >=), as asked. */
  auditFrom: [] as string[],
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
  /** The detector's own memory rows (review 4 finding 9), as written. */
  memory: [] as Array<Record<string, unknown>>,
  memoryFails: false,
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
// The memory row goes into the same audit rows the next run reads.
vi.mock('@/server/services/audit', () => ({
  insertAuditRowReported: async (r: Record<string, unknown>) => {
    h.memory.push(r);
    if (h.memoryFails) return false;
    h.audit.push({
      id: 900_000 + h.memory.length,
      user_id: r.user_id as string | null,
      event: r.event as string,
      metadata: r.metadata as Row['metadata'],
      created_at: new Date().toISOString(),
    });
    return true;
  },
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
    // The email and the missing settings row: each at most once a day.
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
        select: (columns: string) => {
          if (table === 'platform_settings') h.settingsColumns.push(columns);
          return q;
        },
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
        gte: (col: string, v: string) => {
          if (table === 'audit_logs' && col === 'created_at') h.auditFrom.push(v);
          filters.push((r) => String(r[col as keyof Row]) >= v);
          return q;
        },
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

import {
  AUTH_DB_CLOCK_SKEW_MS,
  EXAMINED_RAISES_MS,
  MAX_END_TRIES,
  MAX_FINDINGS,
  MAX_SESSIONS,
  runPasskeyDetector,
} from './passkey-detector';

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
const ENDS_ON = { passkeys_on: true, passkey_check_ends_sessions: true };
const tags = () => h.reports.map((r) => r.tag);
const flagged = () => h.reports.filter((r) => r.tag === 'passkeys.bridge_session_unexplained');

beforeEach(() => {
  h.rp = { rpId: 'localhost', origins: ['http://localhost:3000'] };
  h.settings = { data: { ...ENDS_ON }, error: null };
  h.settingsColumns = [];
  h.sessions = { data: [], error: null };
  h.audit = [];
  h.auditFails = false;
  h.auditFrom = [];
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
  h.memory = [];
  h.memoryFails = false;
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

  it('the clock skew allowed between Auth and the database is a named 5 seconds: a row up to it after the raise explains, past it does not', async () => {
    expect(AUTH_DB_CLOCK_SKEW_MS).toBe(5_000);
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [raiseRow(ago(20 * MIN - AUTH_DB_CLOCK_SKEW_MS + 100))];
    expect(await runPasskeyDetector()).toMatchObject({ explained: 1, unexplained: 0 });
    h.audit = [
      raiseRow(ago(20 * MIN - AUTH_DB_CLOCK_SKEW_MS - 1_000)),
      row('passkey.used', ago(90 * MIN)),
    ];
    expect(await runPasskeyDetector()).toMatchObject({ explained: 0, unexplained: 1 });
  });

  it('the two clocks are compared on every run: explained raises give the spread of row minus raise, an unexplained one its nearest raise row', async () => {
    h.sessions = {
      data: [
        session({ raised_at: ago(20 * MIN) }),
        { ...session({ raised_at: ago(30 * MIN) }), session_id: 'explained-2' },
        { ...session({ raised_at: ago(40 * MIN) }), session_id: 'late-row' },
      ],
      error: null,
    };
    h.audit = [
      raiseRow(ago(20 * MIN + 1_500)),
      raiseRow(ago(30 * MIN - 3_000), 'explained-2'),
      raiseRow(ago(40 * MIN - 9_000), 'late-row'),
    ];
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ explained: 2, unexplained: 1 });
    expect(s.rowMinusRaiseMs.min).toBeGreaterThanOrEqual(-1_600);
    expect(s.rowMinusRaiseMs.min).toBeLessThanOrEqual(-1_400);
    expect(s.rowMinusRaiseMs.max).toBeGreaterThanOrEqual(2_900);
    expect(s.rowMinusRaiseMs.max).toBeLessThanOrEqual(3_100);
    const late = flagged()[0]!.extra!.nearestRaiseRowMs as number;
    expect(late).toBeGreaterThanOrEqual(8_900);
    expect(late).toBeLessThanOrEqual(9_100);

    h.reports = [];
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    const none = await runPasskeyDetector();
    expect(none.rowMinusRaiseMs).toEqual({ min: null, max: null });
    expect(flagged()[0]!.extra!.nearestRaiseRowMs).toBeNull();
  });

  it('another kind of row, or the raise row of another session, explains nothing', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [
      row('passkey.used', ago(20 * MIN)),
      raiseRow(ago(20 * MIN + 1000), 'another-session'),
    ];
    expect((await runPasskeyDetector()).unexplained).toBe(1);
  });

  it('a session without a raise time is reported at error level and ends nothing, even with ending on', async () => {
    for (const missing of [session(), session({ raised_at: null })]) {
      h.reports = [];
      h.sessions = { data: [missing], error: null };
      h.audit = [row('passkey.used', ago(90 * MIN))];
      const s = await runPasskeyDetector();
      expect(s).toMatchObject({ examined: 0, unexplained: 0, notSettled: { times: 1 } });
      const r = h.reports.find((x) => x.tag === 'passkeys.detector_times_unreadable');
      expect(r?.level).toBe('error');
      expect(r?.extra).toMatchObject({
        count: 1,
        accounts: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
      expect(JSON.stringify(h.reports)).not.toContain(U);
    }
    expect(h.endAsked).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.emails).toEqual([]);
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
      mode: 'end',
      unexplained: 1,
      explained: 1,
      ending: { ended: 1, alreadyGone: 0, refused: 0, failed: 0, reportOnly: 0 },
      emailed: 1,
    });
    expect(h.endAsked).toEqual([S]);
    expect(h.broadcasts).toEqual([{ userId: U, listed: [S], stays: '' }]);
    expect(flagged()).toHaveLength(1);
    expect(flagged()[0]!.level).toBe('error');
    expect(flagged()[0]!.extra).toMatchObject({ ending: 'ended', ended: true, recorded: true });
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
    // A second raise of the same session (a new raise time), unexplained too.
    h.sessions = { data: [session({ raised_at: ago(10 * MIN) })], error: null };
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
    h.sessions = { data: [session({ raised_at: ago(10 * MIN) })], error: null };
    expect(await runPasskeyDetector()).toMatchObject({ emailed: 0 });
    expect(h.emails).toEqual([]);
    expect(tags()).toContain('passkeys.detector_email_no_address');
  });

  it('the database refuses (22023: a session on a reserved-name factor that is not the recorded bridge): report only, the event recorded, nobody told, no email', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN), recorded: false })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    h.endAnswer = {
      data: null,
      error: { code: '22023', message: 'passkey_session_not_bridge_raised' },
    };
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ unexplained: 1, ending: { ended: 0, refused: 1 }, emailed: 0 });
    expect(flagged()[0]!.level).toBe('error');
    expect(flagged()[0]!.extra).toMatchObject({ ending: 'refused', ended: false, recorded: false });
    expect(h.events).toHaveLength(1);
    expect(h.broadcasts).toEqual([]);
    expect(h.emails).toEqual([]);
  });

  it('a session already gone, or an end that failed: no broadcast, no email; the failure is in the report', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    h.endAnswer = { data: false, error: null };
    expect(await runPasskeyDetector()).toMatchObject({ ending: { alreadyGone: 1 }, emailed: 0 });
    expect(flagged()[0]!.extra).toMatchObject({ ending: 'already_gone', ended: false });
    h.reports = [];
    h.endAnswer = { data: null, error: { code: '55P03' } };
    h.sessions = { data: [session({ raised_at: ago(10 * MIN) })], error: null };
    expect(await runPasskeyDetector()).toMatchObject({ ending: { failed: 1 }, emailed: 0 });
    expect(flagged()[0]!.extra).toMatchObject({ ending: 'failed', ended: false });
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
      '@/server/services/audit',
      '@/server/services/auth-audit',
      '@/server/services/sessions',
    ]);
    // Its one write of its own: the memory row, through the audit writer.
    expect([...code.matchAll(/insertAuditRowReported\(/g)]).toHaveLength(1);
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

describe('report only first (review 3, A7): ending is a setting, off by default', () => {
  const reportOnly = () => {
    expect(h.endAsked).toEqual([]);
    expect(h.rpcNames).toEqual(['passkey_bridge_sessions']);
    expect(h.broadcasts).toEqual([]);
    expect(h.paceKeys).toEqual([]);
    expect(h.emails).toEqual([]);
  };

  it('the setting is read with the switch, in the one settings read', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    await runPasskeyDetector();
    expect(h.settingsColumns).toHaveLength(1);
    expect(
      h.settingsColumns[0]!.split(',')
        .map((c) => c.trim())
        .sort(),
    ).toEqual(['passkey_check_ends_sessions', 'passkeys_on']);
  });

  it('off (the column default): an unexplained raise is reported at error level and recorded, and nothing is ended, nobody told, no email', async () => {
    h.settings = { data: { passkeys_on: true, passkey_check_ends_sessions: false }, error: null };
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [row('passkey.used', ago(90 * MIN))];
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({
      mode: 'report_only',
      unexplained: 1,
      ending: { ended: 0, alreadyGone: 0, refused: 0, failed: 0, reportOnly: 1 },
      emailed: 0,
    });
    expect(flagged()).toHaveLength(1);
    expect(flagged()[0]!.level).toBe('error');
    expect(flagged()[0]!.extra).toMatchObject({ ending: 'report_only', ended: false });
    expect(h.events).toEqual([
      expect.objectContaining({ reason: 'passkey_unexplained_sign_in', outcome: 'flagged' }),
    ]);
    reportOnly();
  });

  it('missing or not a yes: report only, and a value that is not a yes or no is reported', async () => {
    for (const value of [undefined, null, 'true', 1]) {
      h.reports = [];
      h.rpcNames = [];
      h.settings = {
        data:
          value === undefined
            ? { passkeys_on: true }
            : { passkeys_on: true, passkey_check_ends_sessions: value },
        error: null,
      };
      h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
      h.audit = [row('passkey.used', ago(90 * MIN))];
      const s = await runPasskeyDetector();
      expect(s, String(value)).toMatchObject({
        mode: 'report_only',
        ending: { ended: 0, reportOnly: 1 },
      });
      expect(tags(), String(value)).toContain('passkeys.detector_end_setting_unreadable');
      reportOnly();
    }
  });

  it('the stop report counts only sessions really ended: none in report-only mode', async () => {
    h.settings = { data: { passkeys_on: true, passkey_check_ends_sessions: false }, error: null };
    const many = [];
    for (let i = 0; i < MAX_FINDINGS + 1; i += 1) {
      many.push({
        ...session({ raised_at: ago(20 * MIN) }),
        session_id: `s-${i}`,
        user_id: `user-${i}`,
      });
      h.audit.push(row('passkey.used', ago(90 * MIN), `old-${i}`, `user-${i}`));
    }
    h.sessions = { data: many, error: null };
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ stop: 'finding_cap', unexplained: MAX_FINDINGS });
    expect(s.ending).toMatchObject({ ended: 0, reportOnly: MAX_FINDINGS });
    expect(h.reports.find((r) => r.tag === 'passkeys.detector_stopped')).toMatchObject({
      extra: { ended: 0, mode: 'report_only' },
    });
    reportOnly();
  });
});

describe('what cannot be read decides nothing', () => {
  const noAction = () => {
    expect(flagged()).toEqual([]);
    expect(h.events).toEqual([]);
    // Decision C: nothing unread ends a session, tells a device or sends an email.
    expect(h.endAsked).toEqual([]);
    expect(h.broadcasts).toEqual([]);
    expect(h.emails).toEqual([]);
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
  });

  it('review 4 finding 7: no platform_settings row reads as off (as the database reads it): the run goes on, report only, and the missing row is said once a day (a warning)', async () => {
    h.settings = { data: null, error: null };
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({
      ran: true,
      switchOn: false,
      mode: 'report_only',
      unexplained: 1,
      ending: { ended: 0, reportOnly: 1 },
    });
    expect(h.endAsked).toEqual([]);
    const missing = h.reports.filter((r) => r.tag === 'passkeys.detector_settings_missing');
    expect(missing).toEqual([expect.objectContaining({ level: 'warning' })]);
    expect(tags()).not.toContain('passkeys.detector_settings_unreadable');
    expect(tags()).not.toContain('passkeys.detector_end_setting_unreadable');
    // The next run the same day: no second word about the row.
    h.reports = [];
    await runPasskeyDetector();
    expect(tags()).not.toContain('passkeys.detector_settings_missing');
    expect(
      h.paceKeys.filter((k) => k.startsWith('passkey-detector-settings-report:')),
    ).toHaveLength(2);
  });

  it('a row whose switch is not a yes or no settles nothing (error)', async () => {
    h.settings = { data: { passkeys_on: null }, error: null };
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    expect((await runPasskeyDetector()).ran).toBe(false);
    expect(h.reports.find((r) => r.tag === 'passkeys.detector_settings_unreadable')?.level).toBe(
      'error',
    );
    noAction();
  });

  it('a switch that is off is a value that was read: the check still runs', async () => {
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
    expect(h.reports.find((r) => r.tag === 'passkeys.detector_times_unreadable')?.level).toBe(
      'error',
    );
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

describe('review 4 finding 2: a bridge-raised session with no raise row of ours is always unexplained', () => {
  it('an account with no passkey audit row at all: an error report and a security event, like any unexplained raise', async () => {
    h.settings = { data: { passkeys_on: true, passkey_check_ends_sessions: false }, error: null };
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [];
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ unexplained: 1, ending: { reportOnly: 1, ended: 0 } });
    expect(s.notSettled).toEqual({ times: 0, auditRead: 0 });
    expect(flagged()).toEqual([
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({ userIdHash: expect.stringMatching(/^[0-9a-f]{16}$/) }),
      }),
    ]);
    expect(h.events).toEqual([
      expect.objectContaining({ reason: 'passkey_unexplained_sign_in', outcome: 'flagged' }),
    ]);
    // Ending stays behind the setting: none here.
    expect(h.endAsked).toEqual([]);
    expect(tags()).not.toContain('passkeys.detector_no_passkey_rows');
  });

  it('with ending on, that session is ended like any other unexplained raise', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.audit = [];
    expect(await runPasskeyDetector()).toMatchObject({ unexplained: 1, ending: { ended: 1 } });
    expect(h.endAsked).toEqual([S]);
  });
});

describe('review 4 finding 9: the detector remembers what it reported', () => {
  it('a raise reported once (session id and raise time) is not reported, counted, recorded or ended again', async () => {
    const raisedAt = ago(20 * MIN);
    h.sessions = { data: [session({ raised_at: raisedAt })], error: null };
    const first = await runPasskeyDetector();
    expect(first).toMatchObject({ unexplained: 1, alreadyReported: 0 });
    expect(h.memory).toEqual([
      expect.objectContaining({
        event: 'passkey.raise_flagged',
        user_id: U,
        organization_id: null,
        ip: null,
        user_agent: null,
        metadata: expect.objectContaining({ session_id: S, raised_at: raisedAt, ending: 'ended' }),
      }),
    ]);
    h.reports = [];
    h.events = [];
    const again = await runPasskeyDetector();
    expect(again).toMatchObject({ unexplained: 0, alreadyReported: 1, examined: 1 });
    expect(flagged()).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.endAsked).toEqual([S]);
    expect(h.memory).toHaveLength(1);
  });

  it('a new raise of the same session is a new finding', async () => {
    h.sessions = { data: [session({ raised_at: ago(30 * MIN) })], error: null };
    await runPasskeyDetector();
    h.sessions = { data: [session({ raised_at: ago(10 * MIN) })], error: null };
    expect(await runPasskeyDetector()).toMatchObject({ unexplained: 1, alreadyReported: 0 });
    expect(h.memory).toHaveLength(2);
  });

  it(`standing findings cannot stop a run: ${MAX_FINDINGS} remembered raises and a new one, the new one is flagged`, async () => {
    const old = Array.from({ length: MAX_FINDINGS }, (_, i) => ({
      ...session({ raised_at: ago(40 * MIN) }),
      session_id: `standing-${i}`,
      user_id: `user-${i}`,
    }));
    h.sessions = { data: old, error: null };
    expect(await runPasskeyDetector()).toMatchObject({ unexplained: MAX_FINDINGS });
    h.reports = [];
    h.sessions = {
      data: [...old, { ...session({ raised_at: ago(10 * MIN) }), session_id: 'new-one' }],
      error: null,
    };
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ alreadyReported: MAX_FINDINGS, unexplained: 1, stop: null });
    expect(flagged()).toHaveLength(1);
  });

  it(`the ${MAX_SESSIONS} cap takes the newest raises`, async () => {
    const old = Array.from({ length: MAX_SESSIONS }, (_, i) => ({
      ...session({ raised_at: ago(60 * MIN) }),
      session_id: `old-${i}`,
    }));
    for (const o of old) h.audit.push(raiseRow(ago(60 * MIN + 1000), o.session_id));
    const newest = Array.from({ length: 3 }, (_, i) => ({
      ...session({ raised_at: ago(10 * MIN) }),
      session_id: `newest-${i}`,
    }));
    h.sessions = { data: [...old, ...newest], error: null };
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ examined: MAX_SESSIONS, unexplained: 3, stop: 'session_cap' });
    expect(flagged()).toHaveLength(3);
  });

  it('a memory row that cannot be written is reported (a warning); the finding stands', async () => {
    h.memoryFails = true;
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    expect(await runPasskeyDetector()).toMatchObject({ unexplained: 1 });
    expect(h.reports.find((r) => r.tag === 'passkeys.detector_memory_unwritten')?.level).toBe(
      'warning',
    );
  });

  it('the memory is read with the passkey rows, in the same bounds', () => {
    const source = readFileSync(path.join(__dirname, 'passkey-detector.ts'), 'utf8');
    expect(source).toMatch(/const FLAGGED_EVENT = 'passkey\.raise_flagged';/);
    expect(source).toMatch(/PASSKEY_EVENTS = \[[^\]]*FLAGGED_EVENT/);
  });
});

describe('review B1: the memory keeps what became of each finding', () => {
  const FAILS = { data: null, error: { code: '55P03' } };
  const gaveUp = () => h.reports.filter((r) => r.tag === 'passkeys.detector_end_gave_up');
  const memoryOf = (sessionId: string) =>
    h.memory.filter((m) => (m.metadata as { session_id?: string }).session_id === sessionId);

  it(`a failed end is tried again on later runs, with no second report and no second security event; at most ${MAX_END_TRIES} tries in all, then one error report and no more`, async () => {
    expect(MAX_END_TRIES).toBe(3);
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.endAnswer = FAILS;
    expect(await runPasskeyDetector()).toMatchObject({ unexplained: 1, ending: { failed: 1 } });
    expect(memoryOf(S).map((m) => m.metadata)).toEqual([
      expect.objectContaining({ ending: 'failed', tries: 1 }),
    ]);
    const second = await runPasskeyDetector();
    expect(second).toMatchObject({
      unexplained: 0,
      alreadyReported: 1,
      retries: { tried: 1, failed: 1, ended: 0, gaveUp: 0, waiting: 0 },
    });
    expect(h.endAsked).toEqual([S, S]);
    expect(gaveUp()).toEqual([]);
    const third = await runPasskeyDetector();
    expect(third).toMatchObject({ retries: { tried: 1, failed: 1, gaveUp: 1 } });
    expect(h.endAsked).toEqual([S, S, S]);
    expect(gaveUp()).toEqual([
      expect.objectContaining({
        level: 'error',
        extra: expect.objectContaining({
          userIdHash: expect.stringMatching(/^[0-9a-f]{16}$/),
          tries: MAX_END_TRIES,
        }),
      }),
    ]);
    // No more: no fourth try, no second error report.
    expect(await runPasskeyDetector()).toMatchObject({ retries: { tried: 0 }, alreadyReported: 1 });
    expect(h.endAsked).toEqual([S, S, S]);
    expect(gaveUp()).toHaveLength(1);
    expect(flagged()).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(memoryOf(S).map((m) => (m.metadata as { tries?: number }).tries)).toEqual([1, 2, 3]);
  });

  it('a retried end that succeeds ends the session, tells the devices, emails once, and is final', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.endAnswer = FAILS;
    await runPasskeyDetector();
    h.endAnswer = { data: true, error: null };
    expect(await runPasskeyDetector()).toMatchObject({
      retries: { tried: 1, ended: 1 },
      emailed: 1,
    });
    expect(h.broadcasts).toEqual([{ userId: U, listed: [S], stays: '' }]);
    expect(h.emails).toEqual(['member@example.test']);
    expect(memoryOf(S).at(-1)?.metadata).toMatchObject({ ending: 'ended', tries: 2 });
    await runPasskeyDetector();
    expect(h.endAsked).toEqual([S, S]);
    expect(flagged()).toHaveLength(1);
  });

  it('a finding recorded while ending was off is not ended when ending is turned on: it affects raises found from then on', async () => {
    h.settings = { data: { passkeys_on: true, passkey_check_ends_sessions: false }, error: null };
    h.sessions = { data: [session({ raised_at: ago(30 * MIN) })], error: null };
    expect(await runPasskeyDetector()).toMatchObject({ ending: { reportOnly: 1 } });
    expect(memoryOf(S)[0]?.metadata).toMatchObject({ ending: 'report_only', tries: 0 });
    h.settings = { data: { ...ENDS_ON }, error: null };
    expect(await runPasskeyDetector()).toMatchObject({
      mode: 'end',
      alreadyReported: 1,
      retries: { tried: 0 },
    });
    expect(h.endAsked).toEqual([]);
    // A raise found from then on is ended.
    h.sessions = { data: [session({ raised_at: ago(10 * MIN) })], error: null };
    expect(await runPasskeyDetector()).toMatchObject({ unexplained: 1, ending: { ended: 1 } });
    expect(h.endAsked).toEqual([S]);
  });

  it('a failed end is not tried while ending is off', async () => {
    h.sessions = { data: [session({ raised_at: ago(20 * MIN) })], error: null };
    h.endAnswer = FAILS;
    await runPasskeyDetector();
    h.settings = { data: { passkeys_on: true, passkey_check_ends_sessions: false }, error: null };
    // Nothing is pending either: a retry exists only while ending is on.
    expect(await runPasskeyDetector()).toMatchObject({ retries: { tried: 0, waiting: 0 } });
    expect(h.endAsked).toEqual([S]);
  });

  it('no retry is started after the time budget: it waits for the next run and spends no try', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    h.sessions = { data: [session({ raised_at: ago(10 * MIN) })], error: null };
    h.endAnswer = FAILS;
    await runPasskeyDetector();
    // The next run: the remembered raise (newest) and a new finding whose
    // security event takes 31 seconds of the run.
    h.sessions = {
      data: [
        session({ raised_at: ago(10 * MIN) }),
        { ...session({ raised_at: ago(20 * MIN) }), session_id: 'slow-1', user_id: 'slow-user' },
      ],
      error: null,
    };
    h.onEvent = () => vi.setSystemTime(Date.now() + 31_000);
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ unexplained: 1, retries: { tried: 0, waiting: 1 } });
    expect(memoryOf(S).map((m) => (m.metadata as { tries?: number }).tries)).toEqual([1]);
  });

  it('an end the database refused, or a session already gone, is final', async () => {
    for (const [answer, sid] of [
      [{ data: null, error: { code: '22023' } }, 'refused-1'],
      [{ data: false, error: null }, 'gone-1'],
    ] as const) {
      h.endAnswer = answer;
      h.sessions = {
        data: [{ ...session({ raised_at: ago(20 * MIN) }), session_id: sid }],
        error: null,
      };
      await runPasskeyDetector();
      h.endAnswer = { data: true, error: null };
      expect(await runPasskeyDetector(), sid).toMatchObject({ retries: { tried: 0 } });
    }
    expect(h.endAsked).toEqual(['refused-1', 'gone-1']);
  });

  it(`retries share the run's bound on ends: at most ${MAX_FINDINGS} sessions ended a run, new findings first; a retry past it waits and spends no try`, async () => {
    const standing = Array.from({ length: MAX_FINDINGS }, (_, i) => ({
      ...session({ raised_at: ago(40 * MIN) }),
      session_id: `standing-${i}`,
      user_id: `user-${i}`,
    }));
    h.sessions = { data: standing, error: null };
    h.endAnswer = FAILS;
    expect(await runPasskeyDetector()).toMatchObject({ ending: { failed: MAX_FINDINGS } });
    const fresh = [0, 1].map((i) => ({
      ...session({ raised_at: ago(10 * MIN) }),
      session_id: `fresh-${i}`,
      user_id: `fresh-user-${i}`,
    }));
    h.sessions = { data: [...standing, ...fresh], error: null };
    h.endAsked = [];
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({
      unexplained: 2,
      retries: { tried: MAX_FINDINGS - 2, waiting: 2 },
    });
    expect(h.endAsked).toHaveLength(MAX_FINDINGS);
    expect(h.endAsked.slice(0, 2)).toEqual(['fresh-0', 'fresh-1']);
    const tries = standing.map(
      (st) => memoryOf(st.session_id).at(-1)?.metadata as { tries?: number } | undefined,
    );
    expect(tries.filter((t) => t?.tries === 2)).toHaveLength(MAX_FINDINGS - 2);
    expect(tries.filter((t) => t?.tries === 1)).toHaveLength(2);
  });

  it('a memory row written before the ending was kept reads as one try of a failed end', async () => {
    const raisedAt = ago(20 * MIN);
    h.sessions = { data: [session({ raised_at: raisedAt })], error: null };
    h.audit = [
      {
        ...row('passkey.raise_flagged', ago(19 * MIN)),
        metadata: { session_id: S, raised_at: raisedAt, ending: 'failed' },
      },
    ];
    expect(await runPasskeyDetector()).toMatchObject({ retries: { tried: 1 } });
    expect(h.memory.at(-1)?.metadata).toMatchObject({ tries: 2 });
  });
});

describe('review B4: only raises of the last 24 hours are examined, and the audit read is bounded to that day', () => {
  it('a session raised more than a day ago and still signed in is not examined: counted, nothing reported', async () => {
    expect(EXAMINED_RAISES_MS).toBe(24 * 60 * MIN);
    h.sessions = {
      data: [session({ raised_at: ago(25 * 60 * MIN), updated_at: ago(10 * MIN) })],
      error: null,
    };
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({ listed: 1, olderThanADay: 1, examined: 0, unexplained: 0 });
    expect(flagged()).toEqual([]);
    expect(h.endAsked).toEqual([]);
  });

  it('the audit read starts no earlier than a day (and the two minutes before a raise) ago, whatever the oldest listed session', async () => {
    h.sessions = {
      data: [
        { ...session({ raised_at: ago(21 * 24 * 60 * MIN) }), session_id: 'weeks-old' },
        session({ raised_at: ago(20 * MIN) }),
      ],
      error: null,
    };
    await runPasskeyDetector();
    expect(h.auditFrom.length).toBeGreaterThan(0);
    const earliest = Math.min(...h.auditFrom.map((t) => Date.parse(t)));
    expect(earliest).toBeGreaterThanOrEqual(Date.now() - (24 * 60 + 3) * MIN);
    expect(flagged()).toHaveLength(1);
  });

  it(`the ${MAX_SESSIONS} cap counts only raises of the day`, async () => {
    const old = Array.from({ length: MAX_SESSIONS }, (_, i) => ({
      ...session({ raised_at: ago(30 * 60 * MIN) }),
      session_id: `old-${i}`,
    }));
    h.sessions = {
      data: [...old, { ...session({ raised_at: ago(10 * MIN) }), session_id: 'new-one' }],
      error: null,
    };
    const s = await runPasskeyDetector();
    expect(s).toMatchObject({
      olderThanADay: MAX_SESSIONS,
      examined: 1,
      unexplained: 1,
      stop: null,
    });
  });
});
