import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LOCAL-STACK PROOF (opt-in) of the God Admin Order items access path against
 * a real database with migration 0413: allow, deny, reset, conflict and the
 * step-up refusal.
 *
 * What is real: setOrderItemsAccessAction, checkPlatformAdmin (the server
 * client and auth-js verifying ES256-signed session tokens through the
 * auth-session fixture's fake Auth server, so aal and the step-up age come from
 * verified claims), PermissionExceptionsService, and
 * public.platform_set_permission_exception with its grants, guard trigger,
 * compare-and-set and audit rows. What stands in: the admin client's transport.
 * Instead of supabase-js -> PostgREST with the service key, each call runs in
 * psql inside the local database container as `set local role service_role`
 * (what PostgREST does for a service-role request), and GoTrue's
 * getUserById reads auth.users. No key or secret is read; nothing leaves the
 * machine.
 *
 * Run (local scratch stack only, holding its slot):
 *   ORDVIS_LOCAL_DB_CONTAINER=supabase_db_spmig npx vitest run \
 *     src/server/actions/platform/permission-exceptions.local-stack.test.ts
 * Skipped otherwise. Synthetic data only (*.test addresses, random ids).
 */

const CONTAINER = process.env.ORDVIS_LOCAL_DB_CONTAINER ?? '';
const ENABLED = /^supabase_db_[A-Za-z0-9_-]+$/.test(CONTAINER);

const KEY = 'orders:manage_catalog_visibility';

const envState = vi.hoisted(() => ({ admins: '' }));
let jar = new Map<string, string>();
vi.mock('next/headers', async () => {
  const { cookieStoreOver } = await import('@/test/auth-session-fixture');
  return { cookies: async () => cookieStoreOver(jar), headers: async () => new Headers() };
});
vi.mock('@/lib/env', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: f.FIXTURE_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: f.FIXTURE_ANON_KEY,
      get STOCKPILOT_PLATFORM_ADMIN_EMAILS() {
        return envState.admins;
      },
    },
  };
});
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', async () => {
  const f = await import('@/test/auth-session-fixture');
  return {
    requireSession: vi.fn(async () => ({
      userId: f.FIXTURE_USER_ID,
      email: f.FIXTURE_EMAIL,
      fullName: null,
      avatarUrl: null,
      defaultOrganizationId: null,
    })),
  };
});
const broadcasts = vi.hoisted(() => [] as unknown[][]);
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastPermissionsChanged: vi.fn(async (...a: unknown[]) => {
    broadcasts.push(a);
  }),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => localAdminClient }));

import {
  FIXTURE_EMAIL,
  FIXTURE_USER_ID,
  fakeAuthServer,
  makeSigningKey,
  sessionClaims,
  sessionCookies,
  signAccessToken,
  type SigningKey,
} from '@/test/auth-session-fixture';
import { PermissionExceptionsService } from '@/server/services/platform/permission-exceptions';

import { setOrderItemsAccessAction } from './permission-exceptions';

// ── psql in the local database container ────────────────────────────────────

type Psql = { ok: true; out: string } | { ok: false; err: string };

function psql(sql: string, vars: Record<string, string> = {}): Psql {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const r = spawnSync('docker', args, { input: `\\set VERBOSITY verbose\n${sql}`, encoding: 'utf8' });
  return r.status === 0 ? { ok: true, out: r.stdout.trim() } : { ok: false, err: r.stderr || String(r.error) };
}

function must(sql: string, vars: Record<string, string> = {}): string {
  const r = psql(sql, vars);
  if (!r.ok) throw new Error(r.err);
  return r.out;
}

/** The error as PostgREST would put it in its JSON body. */
function pgError(stderr: string) {
  const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(stderr);
  return {
    code: m?.[1] ?? 'XX000',
    message: m?.[2] ?? stderr.trim(),
    details: /DETAIL:\s+(.*)/.exec(stderr)?.[1] ?? null,
    hint: /HINT:\s+(.*)/.exec(stderr)?.[1] ?? null,
  };
}

const localAdminClient = {
  auth: {
    admin: {
      async getUserById(id: string) {
        const r = psql(`select coalesce(email, '<null>') from auth.users where id = :'id'::uuid;`, { id });
        if (!r.ok || r.out === '') return { data: { user: null }, error: { message: 'User not found' } };
        return { data: { user: { id, email: r.out === '<null>' ? null : r.out } }, error: null };
      },
    },
  },
  async rpc(fn: string, args: Record<string, string>) {
    if (fn !== 'platform_set_permission_exception') throw new Error(`unexpected rpc ${fn}`);
    const r = psql(
      `begin;
       set local role service_role;
       select public.platform_set_permission_exception(:'org'::uuid, :'usr'::uuid, :'perm', :'st', :'exp', :'act'::uuid, :'em')::text;
       commit;`,
      {
        org: args.p_organization_id!,
        usr: args.p_user_id!,
        perm: args.p_permission!,
        st: args.p_state!,
        exp: args.p_expected_state!,
        act: args.p_actor_user_id!,
        em: args.p_actor_email!,
      },
    );
    return r.ok ? { data: JSON.parse(r.out), error: null } : { data: null, error: pgError(r.err) };
  },
};

// ── the synthetic organization ──────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const ORG = randomUUID();
const OWN = randomUUID();
const MGR = randomUUID();
const STF = randomUUID();
const NOT_ADMIN = randomUUID();

function exceptionOf(user: string): string {
  return must(
    `select coalesce((select case when granted then 'allow' else 'deny' end
                        from public.user_permission_overrides
                       where organization_id = :'org'::uuid and user_id = :'usr'::uuid and permission = :'key'), 'default');`,
    { org: ORG, usr: user, key: KEY },
  );
}

function updatedByOf(user: string): string {
  return must(
    `select coalesce(updated_by::text, '') from public.user_permission_overrides
      where organization_id = :'org'::uuid and user_id = :'usr'::uuid and permission = :'key';`,
    { org: ORG, usr: user, key: KEY },
  );
}

function auditCounts(user: string): { platform: number; org: number } {
  const [platform, org] = must(
    `select (select count(*) from public.platform_admin_audit
              where target_organization_id = :'org'::uuid and target_user_id = :'usr'::uuid
                and action = 'permission_exception_changed')
         || '|' ||
           (select count(*) from public.audit_logs
             where organization_id = :'org'::uuid and event = 'permissions.platform_exception_changed'
               and metadata->>'entity_id' = :'usr');`,
    { org: ORG, usr: user },
  ).split('|');
  return { platform: Number(platform), org: Number(org) };
}

function lastPlatformAudit(user: string): { actor: string; email: string; detail: Record<string, unknown> } {
  const row = must(
    `select json_build_object('actor', actor_user_id, 'email', actor_email, 'detail', detail)::text
       from public.platform_admin_audit
      where target_organization_id = :'org'::uuid and target_user_id = :'usr'::uuid
      order by created_at desc limit 1;`,
    { org: ORG, usr: user },
  );
  return JSON.parse(row);
}

function lastOrgAudit(user: string): { actor: string; metadata: Record<string, unknown> } {
  const row = must(
    `select json_build_object('actor', user_id, 'metadata', metadata)::text
       from public.audit_logs
      where organization_id = :'org'::uuid and event = 'permissions.platform_exception_changed'
        and metadata->>'entity_id' = :'usr'
      order by created_at desc limit 1;`,
    { org: ORG, usr: user },
  );
  return JSON.parse(row);
}

/** can_manage_order_catalog as that member, the way an API request asks it. */
function canManage(user: string): boolean {
  return (
    must(
      `begin;
       set local role authenticated;
       select set_config('request.jwt.claims', json_build_object('sub', :'usr', 'role', 'authenticated')::text, true);
       select public.can_manage_order_catalog(:'org'::uuid);
       commit;`,
      { org: ORG, usr: user },
    )
      .split('\n')
      .pop() === 't'
  );
}

// ── the session ─────────────────────────────────────────────────────────────

let projectKey: SigningKey;

async function signIn(claims: Record<string, unknown>) {
  jar = sessionCookies(await signAccessToken(projectKey, claims), claims);
}
const freshStepUp = () => signIn(sessionClaims({ aal: 'aal2', totpAgeSeconds: 60 }));

describe.skipIf(!ENABLED)('Order items access on the local stack (0413)', () => {
  beforeAll(async () => {
    projectKey = await makeSigningKey('project-kid-1');
    expect(
      must(`select to_regprocedure('public.platform_set_permission_exception(uuid,uuid,text,text,text,uuid,text)') is not null;`),
      'migration 0413 is not applied to this database (migtest.sh <worktree> reset)',
    ).toBe('t');
    // The platform admin: the fixture's signed-in user, with the same verified
    // email in auth.users (reused across runs: the email is unique there).
    must(
      `insert into auth.users (id, email, raw_user_meta_data)
       select :'act'::uuid, :'act_email', '{}'::jsonb
        where not exists (select 1 from auth.users where id = :'act'::uuid or email = :'act_email');`,
      { act: FIXTURE_USER_ID, act_email: FIXTURE_EMAIL },
    );
    expect(must(`select id from auth.users where email = :'e';`, { e: FIXTURE_EMAIL })).toBe(FIXTURE_USER_ID);
    must(
      `insert into auth.users (id, email, raw_user_meta_data) values
         (:'own', 'ordvis-' || :'run' || '-own@ordvis.test', '{}'::jsonb),
         (:'mgr', 'ordvis-' || :'run' || '-mgr@ordvis.test', '{}'::jsonb),
         (:'stf', 'ordvis-' || :'run' || '-stf@ordvis.test', '{}'::jsonb),
         (:'na',  'ordvis-' || :'run' || '-support@ordvis.test', '{}'::jsonb);
       insert into public.organizations (id, name, slug)
       values (:'org', 'Ordvis proof ' || :'run', 'ordvis-proof-' || :'run');
       insert into public.organization_members (organization_id, user_id, role, accepted_at) values
         (:'org', :'own', 'owner', now()), (:'org', :'mgr', 'manager', now()), (:'org', :'stf', 'staff', now());`,
      { own: OWN, mgr: MGR, stf: STF, na: NOT_ADMIN, org: ORG, run: RUN },
    );
  });

  beforeEach(() => {
    envState.admins = FIXTURE_EMAIL;
    broadcasts.length = 0;
    const server = fakeAuthServer(projectKey);
    vi.stubGlobal('fetch', server.fetch);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts from the role defaults: the manager and the owner can manage, the staff member cannot', () => {
    expect([exceptionOf(MGR), exceptionOf(STF), exceptionOf(OWN)]).toEqual(['default', 'default', 'default']);
    expect([canManage(MGR), canManage(OWN), canManage(STF)]).toEqual([true, true, false]);
  });

  it('STEP-UP REFUSAL: an AAL1 session and a 20-minute-old step-up are refused with aal2_required; nothing is written', async () => {
    for (const claims of [
      sessionClaims({ aal: 'aal1' }),
      sessionClaims({ aal: 'aal2', totpAgeSeconds: 20 * 60 }),
    ]) {
      await signIn(claims);
      for (const state of ['deny', 'allow', 'default'] as const) {
        const res = await setOrderItemsAccessAction({
          organizationId: ORG,
          targetUserId: MGR,
          state,
          expectedState: 'default',
        });
        expect(res).toEqual({
          ok: false,
          error: { code: 'forbidden', message: 'Not authorized.', details: { reason: 'aal2_required' } },
        });
      }
    }
    expect(exceptionOf(MGR)).toBe('default');
    expect(auditCounts(MGR)).toEqual({ platform: 0, org: 0 });
    expect(broadcasts).toEqual([]);
  });

  it('a session whose verified email is not on the allowlist is refused, even with a fresh step-up', async () => {
    envState.admins = 'someone-else@ordvis.test';
    await freshStepUp();
    const res = await setOrderItemsAccessAction({ organizationId: ORG, targetUserId: MGR, state: 'deny', expectedState: 'default' });
    expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: 'Not authorized.' } });
    expect(exceptionOf(MGR)).toBe('default');
  });

  it('the service re-verifies the actor itself: a non-admin actor id is refused before the database', async () => {
    const res = await PermissionExceptionsService.set({
      organizationId: ORG,
      targetUserId: MGR,
      state: 'deny',
      expectedState: 'default',
      actorUserId: NOT_ADMIN,
    });
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(exceptionOf(MGR)).toBe('default');
    expect(auditCounts(MGR)).toEqual({ platform: 0, org: 0 });
  });

  it('DENY: the manager loses the capability; both audit rows carry the GoTrue-verified email', async () => {
    await freshStepUp();
    const res = await setOrderItemsAccessAction({ organizationId: ORG, targetUserId: MGR, state: 'deny', expectedState: 'default' });
    expect(res).toEqual({ ok: true, data: { before: 'default', after: 'deny', targetRole: 'manager', changed: true } });
    expect(exceptionOf(MGR)).toBe('deny');
    expect(updatedByOf(MGR)).toBe(FIXTURE_USER_ID);
    expect(canManage(MGR)).toBe(false);
    expect(auditCounts(MGR)).toEqual({ platform: 1, org: 1 });
    expect(lastPlatformAudit(MGR)).toEqual({
      actor: FIXTURE_USER_ID,
      email: FIXTURE_EMAIL,
      detail: { permission: KEY, before: 'default', after: 'deny', target_role: 'manager' },
    });
    expect(lastOrgAudit(MGR)).toEqual({
      actor: FIXTURE_USER_ID,
      metadata: {
        entity_type: 'user',
        entity_id: MGR,
        permission: KEY,
        before: 'default',
        after: 'deny',
        target_role: 'manager',
        platform_admin_email: FIXTURE_EMAIL,
      },
    });
    expect(broadcasts).toEqual([[ORG, { userId: MGR, permission: KEY, granted: false }]]);
  });

  it('CONFLICT: a console row that still shows "default" is refused as stale, with the current state; nothing is written', async () => {
    await freshStepUp();
    const res = await setOrderItemsAccessAction({ organizationId: ORG, targetUserId: MGR, state: 'allow', expectedState: 'default' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: "This member's order items access changed while you were working. Reload the page and try again.",
        details: { reason: 'permission_exception_changed', current: 'deny' },
      },
    });
    expect(exceptionOf(MGR)).toBe('deny');
    expect(auditCounts(MGR)).toEqual({ platform: 1, org: 1 });
    expect(broadcasts).toEqual([]);
  });

  it('RESET: Follow role default removes the exception and the manager has their default access again', async () => {
    await freshStepUp();
    const res = await setOrderItemsAccessAction({ organizationId: ORG, targetUserId: MGR, state: 'default', expectedState: 'deny' });
    expect(res).toEqual({ ok: true, data: { before: 'deny', after: 'default', targetRole: 'manager', changed: true } });
    expect(exceptionOf(MGR)).toBe('default');
    expect(canManage(MGR)).toBe(true);
    expect(auditCounts(MGR)).toEqual({ platform: 2, org: 2 });
    expect(lastPlatformAudit(MGR).detail).toEqual({ permission: KEY, before: 'deny', after: 'default', target_role: 'manager' });
    expect(broadcasts).toEqual([[ORG, { userId: MGR, permission: KEY, granted: null }]]);
  });

  it('a repeat of the current state writes nothing and pings nobody', async () => {
    await freshStepUp();
    const res = await setOrderItemsAccessAction({ organizationId: ORG, targetUserId: MGR, state: 'default', expectedState: 'default' });
    expect(res).toEqual({ ok: true, data: { before: 'default', after: 'default', targetRole: 'manager', changed: false } });
    expect(auditCounts(MGR)).toEqual({ platform: 2, org: 2 });
    expect(broadcasts).toEqual([]);
  });

  it('ALLOW: a staff member gains the capability', async () => {
    await freshStepUp();
    const res = await setOrderItemsAccessAction({ organizationId: ORG, targetUserId: STF, state: 'allow', expectedState: 'default' });
    expect(res).toEqual({ ok: true, data: { before: 'default', after: 'allow', targetRole: 'staff', changed: true } });
    expect(exceptionOf(STF)).toBe('allow');
    expect(canManage(STF)).toBe(true);
    expect(auditCounts(STF)).toEqual({ platform: 1, org: 1 });
    expect(broadcasts).toEqual([[ORG, { userId: STF, permission: KEY, granted: true }]]);
  });

  it('DENY holds for the owner too', async () => {
    await freshStepUp();
    const res = await setOrderItemsAccessAction({ organizationId: ORG, targetUserId: OWN, state: 'deny', expectedState: 'default' });
    expect(res).toEqual({ ok: true, data: { before: 'default', after: 'deny', targetRole: 'owner', changed: true } });
    expect(canManage(OWN)).toBe(false);
  });

  it('a person who is not a member is not_found, and nothing is written', async () => {
    await freshStepUp();
    const res = await setOrderItemsAccessAction({ organizationId: ORG, targetUserId: NOT_ADMIN, state: 'allow', expectedState: 'default' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'not_found',
        message: 'That person is not a member of this organization anymore. Reload the page.',
        details: { reason: 'member_not_found' },
      },
    });
    expect(exceptionOf(NOT_ADMIN)).toBe('default');
  });

  it('only the service role may execute the function: authenticated and anon are refused (42501)', () => {
    for (const role of ['authenticated', 'anon']) {
      const r = psql(
        `begin;
         set local role ${role};
         select public.platform_set_permission_exception(:'org'::uuid, :'usr'::uuid, :'key', 'allow', 'default', :'act'::uuid, :'em');
         commit;`,
        { org: ORG, usr: STF, key: KEY, act: FIXTURE_USER_ID, em: FIXTURE_EMAIL },
      );
      expect(r.ok).toBe(false);
      expect(pgError((r as { err: string }).err).code).toBe('42501');
    }
    expect(exceptionOf(STF)).toBe('allow');
  });
});
