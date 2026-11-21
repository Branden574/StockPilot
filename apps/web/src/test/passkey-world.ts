import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { base32Decode, totpAt } from '@/lib/auth/totp';

/**
 * A made-up world for the passkey tests (server/security/passkeys*.test.ts):
 * a fake Supabase Auth reached by `fetch` (the member's calls, plan 2.1 rule
 * 2), a fake service-role client with the 0475 functions the server calls,
 * a fake cookie client, and a cookie jar and request headers for
 * `next/headers`. Only `@simplewebauthn/server` is real: the ceremonies are
 * checked by the library itself, fed by test/fixtures/soft-authenticator.ts.
 *
 * Supabase Auth and the database are fakes, so what they DO is assumed here,
 * from the proofs (spike/v2 B1 to B8) and 0475's pgTAP: a TOTP verify raises
 * the same session to aal2, enrol needs aal2 once a verified factor exists.
 * Those behaviours are the lab's to prove (the stage 4 report lists them).
 *
 * Every key, token, secret and address here is made up inside the test.
 */

export const SITE = 'localhost';
export const ORIGIN = 'http://localhost:3000';
export const SUPABASE_URL = 'http://127.0.0.1:54321';
export const CONSOLE_EMAIL = 'console@example.test';
const JWT_KEY = randomBytes(32);

const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export interface FakeSession {
  id: string;
  userId: string;
  aal: 'aal1' | 'aal2';
}
export interface FakeFactor {
  id: string;
  user_id: string;
  friendly_name: string | null;
  factor_type: 'totp';
  status: 'verified' | 'unverified';
  created_at: string;
  secret: string;
}
export interface FakePasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string[];
  backup_eligible: boolean;
  backed_up: boolean;
  rp_id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  removed_at: string | null;
  removed_reason: string | null;
}
export interface FakeBridge {
  user_id: string;
  factor_id: string;
  secret_ciphertext: string;
  key_version: number;
  created_at: string;
}
export interface FakeChallenge {
  id: string;
  user_id: string;
  session_id: string;
  purpose: string;
  challenge: string;
  binding_hash: string;
  rp_id: string;
  expires_at: number;
  used_at: number | null;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function newBase32Secret(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function makeWorld() {
  const w = {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sample-anon-value',
      SUPABASE_SERVICE_ROLE_KEY: 'sample-service-value',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      PASSKEY_BRIDGE_KEY_V1: randomBytes(32).toString('base64'),
      PASSKEY_BRIDGE_KEY_V2: '',
      PASSKEY_LOCAL_ORIGINS: '',
      STOCKPILOT_PLATFORM_ADMIN_EMAILS: CONSOLE_EMAIL,
      RESEND_API_KEY: '',
    } as Record<string, string>,
    emails: new Map<string, string>(),
    sessions: new Map<string, FakeSession>(),
    factors: [] as FakeFactor[],
    passkeys: [] as FakePasskeyRow[],
    bridges: new Map<string, FakeBridge>(),
    challenges: [] as FakeChallenge[],
    auditLogs: [] as Array<{
      id: string;
      user_id: string;
      event: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }>,
    memberships: [] as Array<{
      user_id: string;
      organization_id: string;
      role: string;
      accepted_at: string | null;
      impersonation_expires_at: string | null;
    }>,
    organizations: [] as Array<{ id: string; mfa_policy: string }>,
    /** passkey_add_allowed's word for every account (the switches and the organization rule). */
    addAllowed: 'ok' as string,
    accountStatus: 'active' as 'active' | 'disabled' | 'unreadable',
    limiterAllows: true,
    cookieToken: null as string | null,
    cookies: new Map<string, string>(),
    calls: {
      auth: [] as Array<{
        method: string;
        path: string;
        cache?: string;
        signal: boolean;
        token: string;
      }>,
      /** The database functions called, by name (a list: not a client). */
      fns: [] as Array<{ name: string; args: Record<string, unknown> }>,
      deleteFactor: [] as string[],
      setSession: 0,
      cookieSignOut: [] as string[],
      /** Every service-role table read, by table (finding 6 counts them). */
      reads: [] as string[],
      /** Every read of the cookie session (the page's own session read is not here). */
      sessionReads: 0,
    },
    /** Knobs for one test: what the fake answers differently. */
    knobs: {
      useWriteFails: false,
      verifyAnswersOtherSession: false,
      verifyAnswersTampered: false,
      verifyError: null as string | null,
      enrolError: null as string | null,
      takeRpId: null as string | null,
      authUserOtherAccount: false,
      /** Tables whose service-role reads answer an error (a timeout). */
      failReads: [] as string[],
      /** Database functions that answer an error (a timeout). */
      failFns: [] as string[],
      /** passkey_add_allowed's next answers, one per call, before addAllowed again. */
      addAllowedNext: [] as string[],
      /** The service role's factor deletes answer an error. */
      deleteFails: false,
      /** Auth's enrol answers an id with no secret (the factor is made all the same). */
      enrolNoSecret: false,
    },
  };

  // ── tokens ──────────────────────────────────────────────────────────
  function signToken(session: FakeSession, tamper = false): string {
    const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64u(
      JSON.stringify({
        sub: session.userId,
        session_id: session.id,
        aal: session.aal,
        amr: [{ method: 'password', timestamp: 1 }],
        email: w.emails.get(session.userId) ?? null,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const sig = createHmac('sha256', JWT_KEY).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${tamper ? sig.slice(0, -2) + 'AA' : sig}`;
  }
  function claimsOf(token: string): Record<string, unknown> | null {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const sig = createHmac('sha256', JWT_KEY).update(`${h}.${p}`).digest('base64url');
    if (sig !== s) return null;
    try {
      return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  function sessionOf(token: string): FakeSession | null {
    const c = claimsOf(token);
    if (!c || typeof c.session_id !== 'string') return null;
    return w.sessions.get(c.session_id) ?? null;
  }

  // ── accounts and sessions ───────────────────────────────────────────
  function addAccount(email: string): string {
    const id = randomUUID();
    w.emails.set(id, email);
    return id;
  }
  function signIn(userId: string, aal: 'aal1' | 'aal2' = 'aal1'): FakeSession {
    const s = { id: randomUUID(), userId, aal };
    w.sessions.set(s.id, s);
    w.cookieToken = signToken(s);
    return s;
  }
  function addApp(userId: string): FakeFactor {
    const f: FakeFactor = {
      id: randomUUID(),
      user_id: userId,
      friendly_name: 'StockPilot app',
      factor_type: 'totp',
      status: 'verified',
      created_at: new Date().toISOString(),
      secret: newBase32Secret(),
    };
    w.factors.push(f);
    return f;
  }

  // ── fake Auth (fetch) ───────────────────────────────────────────────
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const pendingChallenges = new Map<string, string>();

  async function fetchFake(
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (!url.href.startsWith(`${SUPABASE_URL}/auth/v1`))
      throw new Error(`unexpected fetch ${url.href}`);
    const path = url.pathname.replace(/^\/auth\/v1/, '');
    const headers = new Headers(init.headers);
    const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const method = (init.method ?? 'GET').toUpperCase();
    w.calls.auth.push({
      method,
      path: `${path}${url.search}`,
      cache: init.cache,
      signal: Boolean(init.signal),
      token,
    });
    const session = sessionOf(token);
    if (!session) return json(401, { error_code: 'bad_jwt' });
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const mine = () => w.factors.filter((f) => f.user_id === session.userId);

    if (method === 'GET' && path === '/user') {
      const id = w.knobs.authUserOtherAccount ? randomUUID() : session.userId;
      return json(200, {
        id,
        email: w.emails.get(session.userId) ?? null,
        factors: mine().map(({ secret: _s, user_id: _u, ...f }) => f),
      });
    }
    if (method === 'POST' && path === '/factors') {
      if (w.knobs.enrolError) return json(422, { error_code: w.knobs.enrolError });
      if (mine().some((f) => f.status === 'verified') && session.aal !== 'aal2') {
        return json(403, { error_code: 'insufficient_aal' });
      }
      const f: FakeFactor = {
        id: randomUUID(),
        user_id: session.userId,
        friendly_name: typeof body.friendly_name === 'string' ? body.friendly_name : null,
        factor_type: 'totp',
        status: 'unverified',
        created_at: new Date().toISOString(),
        secret: newBase32Secret(),
      };
      w.factors.push(f);
      if (w.knobs.enrolNoSecret) return json(200, { id: f.id, type: 'totp', totp: {} });
      return json(200, {
        id: f.id,
        type: 'totp',
        totp: { secret: f.secret, qr_code: '', uri: '' },
      });
    }
    const challengeMatch = /^\/factors\/([^/]+)\/challenge$/.exec(path);
    if (method === 'POST' && challengeMatch) {
      const f = mine().find((x) => x.id === decodeURIComponent(challengeMatch[1]!));
      if (!f) return json(404, { error_code: 'mfa_factor_not_found' });
      const id = randomUUID();
      pendingChallenges.set(id, f.id);
      return json(200, { id, type: 'totp', expires_at: 0 });
    }
    const verifyMatch = /^\/factors\/([^/]+)\/verify$/.exec(path);
    if (method === 'POST' && verifyMatch) {
      if (w.knobs.verifyError) return json(422, { error_code: w.knobs.verifyError });
      const f = mine().find((x) => x.id === decodeURIComponent(verifyMatch[1]!));
      if (!f || pendingChallenges.get(String(body.challenge_id)) !== f.id) {
        return json(422, { error_code: 'mfa_challenge_expired' });
      }
      const key = base32Decode(f.secret)!;
      const now = Date.now() / 1000;
      const good = [totpAt(key, now), totpAt(key, now + 30), totpAt(key, now - 30)];
      if (!good.includes(String(body.code)))
        return json(422, { error_code: 'mfa_verification_failed' });
      f.status = 'verified';
      session.aal = 'aal2';
      const raisedFor = w.knobs.verifyAnswersOtherSession
        ? { ...session, id: randomUUID() }
        : session;
      return json(200, {
        access_token: signToken(raisedFor, w.knobs.verifyAnswersTampered),
        refresh_token: 'sample-refresh',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
      });
    }
    const deleteMatch = /^\/factors\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && deleteMatch) {
      w.factors = w.factors.filter(
        (f) => !(f.id === deleteMatch[1] && f.user_id === session.userId),
      );
      return json(200, {});
    }
    if (method === 'POST' && path === '/logout') return new Response(null, { status: 204 });
    return json(404, { error_code: 'not_found' });
  }

  // ── fake database (service role) ────────────────────────────────────
  const reserved = (f: FakeFactor) => (f.friendly_name ?? '').startsWith('sp-passkey-bridge-');
  const err = (code: string, message = code) => ({ data: null, error: { code, message } });

  function rpc(name: string, args: Record<string, unknown>): { data: unknown; error: unknown } {
    w.calls.fns.push({ name, args });
    const user = String(args.p_user_id ?? '');
    if (w.knobs.failFns.includes(name)) return err('57014', 'canceling statement due to statement timeout');
    switch (name) {
      case 'passkey_add_allowed':
        return { data: w.knobs.addAllowedNext.shift() ?? w.addAllowed, error: null };
      case 'issue_passkey_challenge': {
        if (w.addAllowed === 'kill_switch_off') return err('42501');
        const c: FakeChallenge = {
          id: randomUUID(),
          user_id: user,
          session_id: String(args.p_session_id),
          purpose: String(args.p_purpose),
          challenge: String(args.p_challenge),
          binding_hash: String(args.p_binding_hash),
          rp_id: String(args.p_rp_id),
          expires_at: Date.now() + 120_000,
          used_at: null,
        };
        w.challenges.push(c);
        return { data: c.id, error: null };
      }
      case 'take_passkey_challenge': {
        if (w.addAllowed === 'kill_switch_off') return err('42501');
        const c = w.challenges.find(
          (x) =>
            x.id === args.p_id &&
            x.user_id === user &&
            x.session_id === args.p_session_id &&
            x.purpose === args.p_purpose &&
            x.binding_hash === args.p_binding_hash &&
            x.used_at === null &&
            x.expires_at > Date.now(),
        );
        if (!c) return { data: [], error: null };
        c.used_at = Date.now();
        return {
          data: [{ challenge: c.challenge, rp_id: w.knobs.takeRpId ?? c.rp_id }],
          error: null,
        };
      }
      case 'passkey_register': {
        const withBridge = args.p_factor_id !== null;
        if (withBridge && w.bridges.has(user)) return err('55000', 'passkey_bridge_exists');
        if (!withBridge && !w.bridges.has(user)) return err('55000', 'passkey_bridge_missing');
        if (withBridge) {
          const f = w.factors.find((x) => x.id === args.p_factor_id && x.user_id === user);
          if (!f || !reserved(f)) return err('22023', 'passkey_bridge_not_ours');
          w.bridges.set(user, {
            user_id: user,
            factor_id: String(args.p_factor_id),
            secret_ciphertext: String(args.p_secret_ciphertext),
            key_version: Number(args.p_key_version),
            created_at: new Date().toISOString(),
          });
        }
        const row: FakePasskeyRow = {
          id: randomUUID(),
          user_id: user,
          credential_id: String(args.p_credential_id),
          public_key: String(args.p_public_key),
          counter: Number(args.p_counter),
          transports: (args.p_transports as string[]) ?? [],
          backup_eligible: Boolean(args.p_backup_eligible),
          backed_up: Boolean(args.p_backed_up),
          rp_id: String(args.p_rp_id),
          name: String(args.p_name),
          created_at: new Date().toISOString(),
          last_used_at: null,
          removed_at: null,
          removed_reason: null,
        };
        w.passkeys.push(row);
        return { data: row.id, error: null };
      }
      case 'passkey_mark_removed': {
        const row = w.passkeys.find(
          (p) => p.id === args.p_passkey_id && p.user_id === user && p.removed_at === null,
        );
        const bridge = w.bridges.get(user);
        if (!row)
          return {
            data: [
              {
                removed: false,
                active_left: 0,
                bridge_factor_id: bridge?.factor_id ?? null,
                bridge_dropped: false,
              },
            ],
            error: null,
          };
        row.removed_at = new Date().toISOString();
        row.removed_reason = String(args.p_reason);
        const left = w.passkeys.filter((p) => p.user_id === user && p.removed_at === null).length;
        let dropped = false;
        if (left === 0 && bridge) {
          w.bridges.delete(user);
          dropped = true;
        }
        return {
          data: [
            {
              removed: true,
              active_left: left,
              bridge_factor_id: bridge?.factor_id ?? null,
              bridge_dropped: dropped,
            },
          ],
          error: null,
        };
      }
      case 'passkey_replace_bridge': {
        if (!w.passkeys.some((p) => p.user_id === user && p.removed_at === null))
          return err('55000', 'passkey_none_active');
        const current = w.bridges.get(user);
        if (args.p_old_factor_id === null) {
          if (current) return { data: false, error: null };
        } else if (!current || current.factor_id !== args.p_old_factor_id) {
          return { data: false, error: null };
        }
        w.bridges.set(user, {
          user_id: user,
          factor_id: String(args.p_new_factor_id),
          secret_ciphertext: String(args.p_secret_ciphertext),
          key_version: Number(args.p_key_version),
          created_at: new Date().toISOString(),
        });
        return { data: true, error: null };
      }
      case 'passkey_drop_bridge': {
        if (w.passkeys.some((p) => p.user_id === user && p.removed_at === null))
          return err('55000', 'passkey_still_active');
        const b = w.bridges.get(user);
        if (b && b.factor_id === args.p_factor_id) {
          w.bridges.delete(user);
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      case 'revoke_my_other_sessions':
        return { data: null, error: null };
      default:
        return err('PGRST202', `no fake for ${name}`);
    }
  }

  type Row = Record<string, unknown>;
  function tableRows(table: string): Row[] {
    switch (table) {
      case 'member_passkeys':
        return w.passkeys as unknown as Row[];
      case 'passkey_bridges':
        return [...w.bridges.values()] as unknown as Row[];
      case 'audit_logs':
        return w.auditLogs as unknown as Row[];
      case 'organization_members':
        return w.memberships as unknown as Row[];
      case 'organizations':
        return w.organizations as unknown as Row[];
      default:
        throw new Error(`no fake table ${table}`);
    }
  }

  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let update: Row | null = null;
    let single = false;
    let limit = Infinity;
    const orders: Array<{ col: string; ascending: boolean; nullsFirst: boolean }> = [];
    const valueOf = (r: Row, col: string) => {
      const m = /^metadata->>(.+)$/.exec(col);
      return m ? (r.metadata as Row | undefined)?.[m[1]!] : r[col];
    };
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => (
        filters.push((r) => String(valueOf(r, col)) === String(v)),
        q
      ),
      is: (col: string, v: null) => (filters.push((r) => (valueOf(r, col) ?? null) === v), q),
      neq: (col: string, v: unknown) => (
        filters.push((r) => String(valueOf(r, col)) !== String(v)),
        q
      ),
      not: (col: string, _op: string, _v: null) => (
        filters.push((r) => (valueOf(r, col) ?? null) !== null),
        q
      ),
      gte: (col: string, v: string) => (filters.push((r) => String(valueOf(r, col)) >= v), q),
      order: (col: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) => {
        const ascending = opts.ascending ?? true;
        // PostgREST's default: nulls last ascending, nulls first descending.
        orders.push({ col, ascending, nullsFirst: opts.nullsFirst ?? !ascending });
        return q;
      },
      limit: (n: number) => ((limit = n), q),
      update: (values: Row) => ((update = values), q),
      maybeSingle: () => ((single = true), q),
      then(
        resolve: (v: { data: unknown; error: unknown }) => unknown,
        reject?: (e: unknown) => unknown,
      ) {
        try {
          if (!update && w.knobs.failReads.includes(table)) {
            return Promise.resolve(err('57014', 'canceling statement due to statement timeout')).then(
              resolve,
              reject,
            );
          }
          if (!update) w.calls.reads.push(table);
          const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
          if (orders.length > 0) {
            rows.sort((a, b) => {
              for (const o of orders) {
                const x = valueOf(a, o.col) ?? null;
                const y = valueOf(b, o.col) ?? null;
                if (x === y) continue;
                if (x === null) return o.nullsFirst ? -1 : 1;
                if (y === null) return o.nullsFirst ? 1 : -1;
                const c = String(x) < String(y) ? -1 : 1;
                return o.ascending ? c : -c;
              }
              return 0;
            });
          }
          if (update) {
            if (table === 'member_passkeys' && w.knobs.useWriteFails && 'counter' in update) {
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            }
            for (const r of rows) Object.assign(r, update);
          }
          const out = rows.slice(0, limit).map((r) => ({ ...r }));
          return Promise.resolve({ data: single ? (out[0] ?? null) : out, error: null }).then(
            resolve,
            reject,
          );
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    return q;
  }

  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => rpc(name, args),
    from: (table: string) => query(table),
    auth: {
      admin: {
        mfa: {
          deleteFactor: async ({ id, userId }: { id: string; userId: string }) => {
            w.calls.deleteFactor.push(id);
            if (w.knobs.deleteFails)
              return { data: null, error: { status: 500, code: 'unexpected_failure' } };
            w.factors = w.factors.filter((f) => !(f.id === id && f.user_id === userId));
            return { data: { id }, error: null };
          },
        },
      },
    },
  };

  // ── fake cookie client (lib/supabase/server createClient) ───────────
  const cookieClient = {
    auth: {
      getSession: async () => {
        w.calls.sessionReads += 1;
        return {
          data: { session: w.cookieToken ? { access_token: w.cookieToken } : null },
          error: null,
        };
      },
      getClaims: async (token: string) => {
        const claims = claimsOf(token);
        return claims
          ? { data: { claims }, error: null }
          : { data: null, error: { name: 'AuthInvalidJwtError', message: 'invalid' } };
      },
      getUser: async () => ({ data: { user: null }, error: { name: 'AuthApiError', status: 401 } }),
      setSession: async ({ access_token }: { access_token: string; refresh_token: string }) => {
        w.calls.setSession += 1;
        w.cookieToken = access_token;
        return { data: {}, error: null };
      },
      signOut: async ({ scope }: { scope: string }) => {
        w.calls.cookieSignOut.push(scope);
        w.cookieToken = null;
        return { error: null };
      },
    },
  };

  // ── next/headers ────────────────────────────────────────────────────
  const cookieStore = {
    get: (name: string) =>
      w.cookies.has(name) ? { name, value: w.cookies.get(name)! } : undefined,
    set: (name: string, value: string, opts: { maxAge?: number } = {}) => {
      if (opts.maxAge === 0) w.cookies.delete(name);
      else w.cookies.set(name, value);
    },
    getAll: () => [...w.cookies.entries()].map(([name, value]) => ({ name, value })),
    delete: (name: string) => w.cookies.delete(name),
  };
  const requestHeaders = new Headers({
    'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140',
    'x-forwarded-for': '203.0.113.7',
  });

  function reset() {
    w.env.PASSKEY_BRIDGE_KEY_V1 = randomBytes(32).toString('base64');
    w.env.PASSKEY_BRIDGE_KEY_V2 = '';
    w.sessions.clear();
    w.emails.clear();
    w.factors = [];
    w.passkeys.length = 0;
    w.bridges.clear();
    w.challenges.length = 0;
    w.auditLogs.length = 0;
    w.memberships.length = 0;
    w.organizations.length = 0;
    w.addAllowed = 'ok';
    w.accountStatus = 'active';
    w.limiterAllows = true;
    w.cookieToken = null;
    w.cookies.clear();
    w.calls.auth.length = 0;
    w.calls.fns.length = 0;
    w.calls.deleteFactor.length = 0;
    w.calls.setSession = 0;
    w.calls.cookieSignOut.length = 0;
    w.calls.reads.length = 0;
    w.calls.sessionReads = 0;
    requestHeaders.delete('x-real-ip');
    w.knobs = {
      useWriteFails: false,
      verifyAnswersOtherSession: false,
      verifyAnswersTampered: false,
      verifyError: null,
      enrolError: null,
      takeRpId: null,
      authUserOtherAccount: false,
      failReads: [],
      failFns: [],
      addAllowedNext: [],
      deleteFails: false,
      enrolNoSecret: false,
    };
  }

  return Object.assign(w, {
    signToken,
    claimsOf,
    addAccount,
    signIn,
    addApp,
    fetch: fetchFake,
    admin,
    cookieClient,
    cookieStore,
    requestHeaders,
    reset,
    reserved,
  });
}

export type PasskeyWorld = ReturnType<typeof makeWorld>;

/** One world per test file (the mocks reach it through this module). */
export const world = makeWorld();
