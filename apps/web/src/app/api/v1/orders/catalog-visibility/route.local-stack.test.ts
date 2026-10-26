import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { DEFAULT_MODULE_IDS, effectivePermissions, type Role } from '@stockpilot/core';

/**
 * LOCAL-STACK WALK (opt-in) of Manage order items against a real database with
 * migration 0413 (step 2b "Done when"): the list, a bulk hide and show, the
 * refusals (including a direct RPC call with an aal1 token in an
 * admins_required organization), the freshness overlay skipped and run, the
 * catalog tags of the touched warehouses expired with { expire: 0 }, and no
 * prewarm from the write.
 *
 * What is real: the route handlers (GET and POST /api/v1/orders/catalog-
 * visibility, GET .../family/[groupId]) called with HTTP requests, the
 * service, the http helper, loadOrderableCatalog's overlay, expireOrgPublic-
 * Catalogs, and public.set_order_catalog_visibility with its grants, row level
 * security, locks, audit rows and hide mark. What stands in: the transport.
 * Instead of supabase-js -> PostgREST, each query runs in psql inside the local
 * database container, as `set local role authenticated` with the caller's
 * request.jwt.claims (sub, role, aal) or as `service_role` for the admin
 * client, which is what PostgREST does for a request. The query builder below
 * translates the chains the service and the overlay send (select with
 * embeds and JSON paths, eq, is, in, gte, or, order, range, count) to SQL.
 * withApiContext is replaced by the context the real one would build (the
 * role's effective permissions, the MFA state). No key or secret is read;
 * nothing leaves the machine.
 *
 * Run (local scratch stack only, holding its slot):
 *   ORDVIS_LOCAL_DB_CONTAINER=supabase_db_spmig npx vitest run \
 *     'src/app/api/v1/orders/catalog-visibility/route.local-stack.test.ts'
 * Skipped otherwise. Synthetic data only (*.test addresses, random ids).
 */

const CONTAINER = process.env.ORDVIS_LOCAL_DB_CONTAINER ?? '';
const ENABLED = /^supabase_db_[A-Za-z0-9_-]+$/.test(CONTAINER);

const hoisted = vi.hoisted(() => ({
  ctx: null as unknown,
  revalidateTag: vi.fn(),
  afterCallbacks: [] as Array<() => unknown>,
  cacheEntry: null as null | { rows: Array<{ id: string }>; readStartedAt: number },
  adminQueries: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn(async () => hoisted.ctx) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({
  revalidateTag: hoisted.revalidateTag,
  // The catalog entry a requester's load is served: `cacheEntry`, standing in
  // for an entry stored before the hide.
  unstable_cache: vi.fn(() => async () => hoisted.cacheEntry),
}));
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (cb: () => unknown) => hoisted.afterCallbacks.push(cb) };
});
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    primaryImagesWithThumbsForItems = vi.fn(async () => new Map());
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => pgClient('service_role', null, 'aal1') }));

import { loadOrderableCatalog } from '@/server/loaders/orders-new-catalog';

import { GET as FAMILY } from './family/[groupId]/route';
import { GET, POST } from './route';

// ── psql in the local database container ────────────────────────────────────

type Psql = { ok: true; out: string } | { ok: false; err: string };

function psql(sql: string): Psql {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];
  const r = spawnSync('docker', args, { input: `\\set VERBOSITY verbose\n${sql}`, encoding: 'utf8' });
  return r.status === 0 ? { ok: true, out: r.stdout.trim() } : { ok: false, err: r.stderr || String(r.error) };
}

function must(sql: string): string {
  const r = psql(sql);
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

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
const ident = (c: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error(`walk transport: unsafe identifier ${c}`);
  return c;
};

/** One statement as the role PostgREST would take for this caller. */
function asCaller(role: 'authenticated' | 'service_role', sub: string | null, aal: string, statement: string): Psql {
  const claims = JSON.stringify({ sub, role, aal });
  return psql(
    `begin;
     set local role ${role};
     select set_config('request.jwt.claims', ${lit(claims)}, true) is null;
     select set_config('request.jwt.claim.sub', ${lit(sub ?? '')}, true) is null;
     ${statement};
     commit;`,
  );
}
const lastLine = (out: string) => out.split('\n').pop() ?? '';

// ── the PostgREST-shaped query builder over psql ────────────────────────────

function splitTop(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function selectList(cols: string): string {
  return splitTop(cols)
    .map((raw) => {
      const aliasMatch = /^([a-z_][a-z0-9_]*):(.*)$/s.exec(raw);
      const alias = aliasMatch?.[1];
      const expr = (aliasMatch?.[2] ?? raw).trim();
      const embed = /^([a-z_]+)!([a-z_]+)\s*\(([^)]*)\)$/.exec(expr);
      if (embed) {
        const [, table, fk, inner] = embed;
        const fields = inner!.split(',').map((f) => f.trim());
        const obj = fields.map((f) => `${lit(f)}, e.${ident(f)}`).join(', ');
        return `(select json_build_object(${obj}) from public.${ident(table!)} e where e.id = t.${ident(fk!)}) as ${ident(alias ?? table!)}`;
      }
      const path = /^([a-z_]+)->>([a-z_]+)$/.exec(expr);
      if (path) return `t.${ident(path[1]!)}->>${lit(path[2])} as ${ident(alias ?? path[2]!)}`;
      if (expr === '*') return 't.*';
      return `t.${ident(expr)}${alias ? ` as ${ident(alias)}` : ''}`;
    })
    .join(', ');
}

function orTerm(term: string): string {
  const [col, op, ...rest] = term.split('.');
  const value = rest.join('.');
  const c = `t.${ident(col!)}`;
  if (op === 'is' && value === 'null') return `${c} is null`;
  if (op === 'eq') return `${c}::text = ${lit(value)}`;
  if (op === 'neq') return `${c}::text <> ${lit(value)}`;
  if (op === 'ilike') return `${c}::text ilike ${lit(value.replace(/\*/g, '%'))}`;
  if (op === 'in') {
    const items = value.slice(1, -1).split(',').map((v) => v.replace(/^"|"$/g, ''));
    return `${c}::text in (${items.map(lit).join(', ')})`;
  }
  throw new Error(`walk transport: unsupported or-term ${term}`);
}

function pgClient(role: 'authenticated' | 'service_role', sub: string | null, aal: string) {
  return {
    from(table: string) {
      const state = {
        cols: '*',
        count: false,
        where: [] as string[],
        order: [] as string[],
        offset: 0,
        limit: null as number | null,
        single: false,
      };
      const run = () => {
        const where = state.where.length ? `where ${state.where.join(' and ')}` : '';
        const order = state.order.length ? `order by ${state.order.join(', ')}` : '';
        const page = `${state.limit === null ? '' : `limit ${state.limit}`} offset ${state.offset}`;
        const body = `select coalesce(json_agg(row_to_json(q)), '[]'::json)::text from (select ${selectList(state.cols)} from public.${ident(table)} t ${where} ${order} ${page}) q`;
        if (role === 'service_role') hoisted.adminQueries.push(`${table}: ${where}`);
        const r = asCaller(role, sub, aal, body);
        if (!r.ok) return { data: null, error: pgError(r.err), count: null };
        let data = JSON.parse(lastLine(r.out)) as unknown[];
        let count: number | null = null;
        if (state.count) {
          const c = asCaller(role, sub, aal, `select count(*) from public.${ident(table)} t ${where}`);
          if (!c.ok) return { data: null, error: pgError(c.err), count: null };
          count = Number(lastLine(c.out));
        }
        if (state.single) return { data: (data[0] as unknown) ?? null, error: null, count };
        data = data.slice(0, 1000);
        return { data, error: null, count };
      };
      const builder: Record<string, unknown> = {
        select(cols: string, opts?: { count?: string }) {
          state.cols = cols;
          state.count = opts?.count === 'exact';
          return builder;
        },
        eq(c: string, v: unknown) {
          state.where.push(`t.${ident(c)} = ${lit(v)}`);
          return builder;
        },
        neq(c: string, v: unknown) {
          state.where.push(`t.${ident(c)} <> ${lit(v)}`);
          return builder;
        },
        is(c: string, v: unknown) {
          state.where.push(`t.${ident(c)} is ${v === null ? 'null' : String(v)}`);
          return builder;
        },
        in(c: string, vs: unknown[]) {
          state.where.push(vs.length ? `t.${ident(c)} in (${vs.map(lit).join(', ')})` : 'false');
          return builder;
        },
        gte(c: string, v: unknown) {
          state.where.push(`t.${ident(c)} >= ${lit(v)}`);
          return builder;
        },
        or(expr: string) {
          state.where.push(`(${splitTop(expr).map(orTerm).join(' or ')})`);
          return builder;
        },
        order(c: string, o?: { ascending?: boolean }) {
          state.order.push(`t.${ident(c)} ${o?.ascending === false ? 'desc' : 'asc'}`);
          return builder;
        },
        range(a: number, b: number) {
          state.offset = a;
          state.limit = b - a + 1;
          return builder;
        },
        limit(n: number) {
          state.limit = n;
          return builder;
        },
        maybeSingle() {
          state.single = true;
          return Promise.resolve(run());
        },
        then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
          try {
            resolve(run());
          } catch (e) {
            if (reject) reject(e);
            else throw e;
          }
        },
      };
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== 'set_order_catalog_visibility') throw new Error(`walk transport: unexpected rpc ${fn}`);
      const ids = (args.p_item_ids as string[]).map((x) => `"${x}"`).join(',');
      const r = asCaller(
        role,
        sub,
        aal,
        `select public.set_order_catalog_visibility(
           p_organization_id => ${lit(args.p_organization_id)}::uuid,
           p_item_ids => ${lit(`{${ids}}`)}::uuid[],
           p_visible => ${lit(args.p_visible)},
           p_operation_id => ${lit(args.p_operation_id)}::uuid,
           p_surface => ${lit(args.p_surface)})::text`,
      );
      return r.ok ? { data: JSON.parse(lastLine(r.out)), error: null } : { data: null, error: pgError(r.err) };
    },
  };
}

// ── the synthetic organizations ─────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const ORG = randomUUID();
const ORG_B = randomUUID();
const OWN = randomUUID();
const MGR = randomUUID();
const STF = randomUUID();
const ADM = randomUUID(); // admin with a verified factor (admins_required)
const ADM_NOF = randomUUID(); // admin with no factor
const MGR_B = randomUUID();
const WH = randomUUID();
const WH2 = randomUUID();
const WH_B = randomUUID();
const GRP = randomUUID();
const LNK = randomUUID();
const I = {
  shirtS: randomUUID(),
  shirtM: randomUUID(),
  book: randomUUID(),
  annex: randomUUID(),
  expected: randomUUID(),
  deleted: randomUUID(),
  rental: randomUUID(),
  kit: randomUUID(),
  archived: randomUUID(),
  foreign: randomUUID(),
};
const MANAGEABLE = [I.shirtS, I.shirtM, I.book, I.annex, I.expected];

function ctxFor(user: string, role: Role, opts: { aal?: string; mfaRequired?: boolean; mfaSatisfied?: boolean; mfaEnrolled?: boolean } = {}) {
  return {
    supabase: pgClient('authenticated', user, opts.aal ?? 'aal1'),
    organizationId: ORG,
    userId: user,
    role,
    permissions: effectivePermissions(role),
    enabledModules: new Set(DEFAULT_MODULE_IDS),
    mfaRequired: opts.mfaRequired ?? false,
    mfaSatisfied: opts.mfaSatisfied ?? true,
    mfaEnrolled: opts.mfaEnrolled ?? false,
  };
}

const listReq = (qs = '') => new NextRequest(`http://localhost:3710/api/v1/orders/catalog-visibility${qs}`);
const postReq = (body: unknown) =>
  new NextRequest('http://localhost:3710/api/v1/orders/catalog-visibility', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function call(res: Promise<Response>) {
  const r = await res;
  return { status: r.status, cache: r.headers.get('cache-control'), body: (await r.json()) as Record<string, any> };
}

function visibleOf(id: string): string {
  return must(`select order_catalog_visible::text || '|' || updated_at::text from public.inventory_items where id = ${lit(id)};`);
}
function auditCount(id: string): number {
  return Number(
    must(
      `select count(*) from public.audit_logs where organization_id = ${lit(ORG)}
          and event = 'item.order_visibility_changed' and metadata->>'entity_id' = ${lit(id)};`,
    ),
  );
}
function hideMark(): string {
  return must(`select coalesce(order_catalog_last_hide_at::text, '<null>') from public.organizations where id = ${lit(ORG)};`);
}

describe.skipIf(!ENABLED)('Manage order items on the local stack (0413, step 2b walk)', () => {
  beforeAll(() => {
    expect(
      must(`select to_regprocedure('public.set_order_catalog_visibility(uuid,uuid[],boolean,uuid,text)') is not null;`),
      'migration 0413 is not applied to this database (migtest.sh <worktree> reset)',
    ).toBe('t');
    const users = [
      [OWN, 'own'],
      [MGR, 'mgr'],
      [STF, 'stf'],
      [ADM, 'adm'],
      [ADM_NOF, 'admnof'],
      [MGR_B, 'mgrb'],
    ]
      .map(([id, tag]) => `(${lit(id)}, ${lit(`ordvis-${RUN}-${tag}@ordvis.test`)}, '{}'::jsonb)`)
      .join(', ');
    const item = (id: string, org: string, wh: string, sku: string, name: string, extra: Partial<Record<string, string>> = {}) =>
      `(${lit(id)}, ${lit(org)}, ${lit(wh)}, ${lit(`${sku}-${RUN}`)}, ${lit(name)}, ${extra.type ?? "'product'"}, 10, ${extra.status ?? "'active'"},
        ${extra.rental ?? 'false'}, ${extra.expected ?? 'false'}, ${extra.kit ?? 'false'}, ${extra.deleted ?? 'null'},
        ${extra.group ?? 'null'}, ${extra.size ?? 'null'}, ${extra.size ?? 'null'}, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`;
    must(`
      insert into auth.users (id, email, raw_user_meta_data) values ${users};
      insert into public.organizations (id, name, slug) values
        (${lit(ORG)}, ${lit(`Ordvis walk ${RUN}`)}, ${lit(`ordvis-walk-${RUN}`)}),
        (${lit(ORG_B)}, ${lit(`Ordvis walk B ${RUN}`)}, ${lit(`ordvis-walk-b-${RUN}`)});
      update public.organizations set mfa_policy = 'admins_required' where id = ${lit(ORG)};
      insert into public.organization_members (organization_id, user_id, role, accepted_at) values
        (${lit(ORG)}, ${lit(OWN)}, 'owner', now()), (${lit(ORG)}, ${lit(MGR)}, 'manager', now()),
        (${lit(ORG)}, ${lit(STF)}, 'staff', now()), (${lit(ORG)}, ${lit(ADM)}, 'admin', now()),
        (${lit(ORG)}, ${lit(ADM_NOF)}, 'admin', now()), (${lit(ORG_B)}, ${lit(MGR_B)}, 'manager', now());
      insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
      values (gen_random_uuid(), ${lit(ADM)}, 'walk authenticator', 'totp', 'verified', now(), now());
      insert into public.warehouses (id, organization_id, name, code, status) values
        (${lit(WH)}, ${lit(ORG)}, 'Walk Main', ${lit(`WM-${RUN}`)}, 'active'),
        (${lit(WH2)}, ${lit(ORG)}, 'Walk Annex', ${lit(`WA-${RUN}`)}, 'active'),
        (${lit(WH_B)}, ${lit(ORG_B)}, 'Walk B', ${lit(`WB-${RUN}`)}, 'active');
      insert into public.product_groups (id, organization_id, name, group_key, status) values
        (${lit(GRP)}, ${lit(ORG)}, 'Walk Shirt', ${lit(`walk-shirt-${RUN}`)}, 'active');
      insert into public.inventory_items
        (id, organization_id, warehouse_id, sku, name, item_type, quantity_on_hand, status,
         is_rental, awaiting_first_receipt, is_bundle, deleted_at, group_id, variant_key, variant_size,
         created_at, updated_at) values
        ${[
          item(I.shirtS, ORG, WH, 'WS-S', 'Walk Shirt', { group: lit(GRP), size: "'S'" }),
          item(I.shirtM, ORG, WH, 'WS-M', 'Walk Shirt', { group: lit(GRP), size: "'M'" }),
          item(I.book, ORG, WH, 'WS-BOOK', 'Walk Field Guide', { type: "'book'" }),
          item(I.annex, ORG, WH2, 'WS-ANX', 'Walk Annex item'),
          item(I.expected, ORG, WH, 'WS-EXP', 'Walk Expected', { expected: 'true' }),
          item(I.deleted, ORG, WH, 'WS-DEL', 'Walk Deleted', { deleted: 'now()' }),
          item(I.rental, ORG, WH, 'WS-RNT', 'Walk Rental', { rental: 'true' }),
          item(I.kit, ORG, WH, 'WS-KIT', 'Walk Kit', { kit: 'true' }),
          item(I.archived, ORG, WH, 'WS-ARC', 'Walk Archived', { status: "'archived'" }),
          item(I.foreign, ORG_B, WH_B, 'WS-B', 'Walk Other Org'),
        ].join(',\n')};
      insert into public.public_request_links (id, organization_id, token_hash, name, active, include_public_pool,
                                               books_enabled, items_enabled, default_max_qty, created_by)
      values (${lit(LNK)}, ${lit(ORG)}, md5(${lit(`walk-${RUN}-a`)}) || md5(${lit(`walk-${RUN}-b`)}), 'Walk link', true, true, true, true, 5, ${lit(MGR)});
    `);
  });

  beforeEach(() => {
    vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', ORG);
    hoisted.revalidateTag.mockClear();
    hoisted.afterCallbacks.length = 0;
    hoisted.adminQueries.length = 0;
    hoisted.cacheEntry = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllEnvs());

  it('LIST: a manager sees the manageable records of this organization only, 25 a page, Expected included', async () => {
    hoisted.ctx = ctxFor(MGR, 'manager');
    const r = await call(GET(listReq()));
    expect(r.status).toBe(200);
    expect(r.cache).toBe('private, no-store');
    expect(r.body.organizationId).toBe(ORG);
    expect(r.body.total).toBe(5);
    expect(r.body.rows.map((x: { id: string }) => x.id).sort()).toEqual([...MANAGEABLE].sort());
    const shirt = r.body.rows.find((x: { id: string }) => x.id === I.shirtS);
    expect(shirt).toMatchObject({ sizeOrEdition: 'S', familyId: GRP, familyName: 'Walk Shirt', warehouseName: 'Walk Main', visible: true });
    expect(r.body.rows.find((x: { id: string }) => x.id === I.expected)).toMatchObject({ expected: true });
    expect(r.body.rows.find((x: { id: string }) => x.id === I.book)).toMatchObject({ itemType: 'book' });

    const books = await call(GET(listReq('?type=books')));
    expect(books.body.rows.map((x: { id: string }) => x.id)).toEqual([I.book]);
    const search = await call(GET(listReq(`?q=WS-ANX-${RUN}`)));
    expect(search.body.rows.map((x: { id: string }) => x.id)).toEqual([I.annex]);

    const fam = await call(FAMILY(new NextRequest(`http://localhost:3710/api/v1/orders/catalog-visibility/family/${GRP}`), { params: Promise.resolve({ groupId: GRP }) }));
    expect(fam.status).toBe(200);
    expect(fam.body.rows.map((x: { id: string }) => x.id).sort()).toEqual([I.shirtS, I.shirtM].sort());
  });

  it('REFUSAL: staff are refused by the route (403 forbidden) and by the function called directly (42501)', async () => {
    hoisted.ctx = ctxFor(STF, 'staff');
    const r = await call(GET(listReq()));
    expect(r.status).toBe(403);
    expect(r.body.details).toMatchObject({ reason: 'forbidden', organizationId: ORG });

    const direct = asCaller('authenticated', STF, 'aal1',
      `select public.set_order_catalog_visibility(${lit(ORG)}::uuid, array[${lit(I.shirtS)}]::uuid[], false, gen_random_uuid(), 'web')::text`);
    expect(direct.ok).toBe(false);
    expect(pgError((direct as { err: string }).err)).toMatchObject({ code: '42501', hint: 'order_catalog_forbidden' });
    expect(visibleOf(I.shirtS).startsWith('true|')).toBe(true);
  });

  it('REFUSAL: a direct RPC call with an aal1 token in an admins_required organization is refused (aal2_required; mfa_required without a factor); aal2 passes', async () => {
    const op = randomUUID();
    const sql = (id: string) =>
      `select public.set_order_catalog_visibility(${lit(ORG)}::uuid, array[${lit(id)}]::uuid[], false, ${lit(op)}::uuid, 'app')::text`;
    const aal1 = asCaller('authenticated', ADM, 'aal1', sql(I.annex));
    expect(aal1.ok).toBe(false);
    expect(pgError((aal1 as { err: string }).err)).toMatchObject({ code: '42501', hint: 'aal2_required' });
    const noFactor = asCaller('authenticated', ADM_NOF, 'aal2', sql(I.annex));
    expect(noFactor.ok).toBe(false);
    expect(pgError((noFactor as { err: string }).err)).toMatchObject({ code: '42501', hint: 'mfa_required' });
    expect(visibleOf(I.annex).startsWith('true|')).toBe(true);
    expect(auditCount(I.annex)).toBe(0);

    // Through the route: the app gate refuses an AAL1 admin first; a session
    // that lost AAL2 after the gate is refused by the database the same way.
    hoisted.ctx = ctxFor(ADM, 'admin', { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true });
    const gate = await call(POST(postReq({ itemIds: [I.annex], visible: false, operationId: op })));
    expect(gate.status).toBe(403);
    expect(gate.body.details).toMatchObject({ reason: 'aal2_required' });
    hoisted.ctx = ctxFor(ADM, 'admin', { aal: 'aal1', mfaRequired: true, mfaSatisfied: true, mfaEnrolled: true });
    const lost = await call(POST(postReq({ itemIds: [I.annex], visible: false, operationId: op })));
    expect(lost.status).toBe(403);
    expect(lost.body.details).toMatchObject({ reason: 'aal2_required' });
    expect(auditCount(I.annex)).toBe(0);

    const aal2 = asCaller('authenticated', ADM, 'aal2', sql(I.annex));
    expect(aal2.ok).toBe(true);
    expect(JSON.parse(lastLine((aal2 as { out: string }).out))).toMatchObject({ changed: [I.annex], unchanged: [] });
    // Put it back for the rest of the walk.
    const back = asCaller('authenticated', ADM, 'aal2',
      `select public.set_order_catalog_visibility(${lit(ORG)}::uuid, array[${lit(I.annex)}]::uuid[], true, gen_random_uuid(), 'app')::text`);
    expect(back.ok).toBe(true);
  });

  it('REFUSAL: an id of another organization refuses the whole call, naming only it; nothing changes', async () => {
    hoisted.ctx = ctxFor(MGR, 'manager');
    const r = await call(POST(postReq({ itemIds: [I.shirtS, I.foreign], visible: false, operationId: randomUUID() })));
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ reason: 'items_unavailable', itemIds: [I.foreign], organizationId: ORG });
    expect(visibleOf(I.shirtS).startsWith('true|')).toBe(true);
    expect(hoisted.revalidateTag).not.toHaveBeenCalled();
  });

  it('BULK: a manager hides three records in one call; updated_at kept, one audit row each, the hide mark stamped, tags expired with expire 0, no prewarm; a retry is a no-op', async () => {
    hoisted.ctx = ctxFor(MGR, 'manager');
    const before = [I.shirtS, I.shirtM, I.book].map(visibleOf);
    const markBefore = hideMark();
    const op = randomUUID();
    const ids = [I.book, I.shirtM, I.shirtS];
    const r = await call(POST(postReq({ itemIds: ids, visible: false, operationId: op })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ organizationId: ORG, operationId: op, visible: false, changed: [...ids].sort(), unchanged: [] });
    [I.shirtS, I.shirtM, I.book].forEach((id, k) => {
      const [vis, updatedAt] = visibleOf(id).split('|');
      expect(vis).toBe('false');
      expect(updatedAt).toBe(before[k]!.split('|')[1]);
      expect(auditCount(id)).toBe(1);
    });
    expect(hideMark()).not.toBe(markBefore);
    expect(hideMark()).not.toBe('<null>');
    // Only the warehouse the three records sit in (0413 review fix round F1).
    expect(hoisted.revalidateTag.mock.calls).toEqual([
      [`orders-new-v2-catalog:${ORG}:${WH}`, { expire: 0 }],
      [`public-catalog-${LNK}`, { expire: 0 }],
    ]);
    expect(hoisted.revalidateTag.mock.calls.flat()).not.toContain('max');
    expect(hoisted.afterCallbacks).toHaveLength(0);

    hoisted.revalidateTag.mockClear();
    const again = await call(POST(postReq({ itemIds: ids, visible: false, operationId: op })));
    expect(again.body).toMatchObject({ changed: [], unchanged: [...ids].sort() });
    ids.forEach((id) => expect(auditCount(id)).toBe(1));
    // A no-op still refreshes (repairs a failed refresh).
    expect(hoisted.revalidateTag).toHaveBeenCalledWith(`orders-new-v2-catalog:${ORG}:${WH}`, { expire: 0 });

    const hidden = await call(GET(listReq('?visibility=hidden')));
    expect(hidden.body.rows.map((x: { id: string }) => x.id).sort()).toEqual([...ids].sort());
    expect(hidden.body.rows.every((x: { hiddenSince: string | null }) => typeof x.hiddenSince === 'string')).toBe(true);
  });

  it('OVERLAY RUN: an entry read before the hide loses the hidden records, by one admin read', async () => {
    const mark = hideMark();
    const readBeforeHide = Date.parse(mark) - 5_000;
    hoisted.cacheEntry = { rows: [I.shirtS, I.shirtM, I.book, I.expected].map((id) => ({ id })), readStartedAt: readBeforeHide };
    const rows = await loadOrderableCatalog(ORG, WH, 'ALL', mark);
    expect(rows.map((r) => r.id)).toEqual([I.expected]);
    expect(hoisted.adminQueries).toHaveLength(1);
    expect(hoisted.adminQueries[0]).toContain('order_catalog_visible = false');
    expect(hoisted.adminQueries[0]).toContain('order_catalog_visibility_changed_at >=');
  });

  it('OVERLAY SKIPPED: an organization that never hid anything, and a hide older than the read less 30 s, make no read', async () => {
    // A hide three minutes ago (older than the early-read window of two),
    // and an entry read 31 s after it: no early read, no check.
    const oldMark = new Date(Date.now() - 180_000).toISOString();
    hoisted.cacheEntry = { rows: [I.shirtS, I.expected].map((id) => ({ id })), readStartedAt: Date.parse(oldMark) + 31_000 };
    const later = await loadOrderableCatalog(ORG, WH, 'ALL', oldMark);
    // The entry is returned as it is: a read 31 s after the last hide was
    // already filtered by its own query (here the stand-in keeps the row).
    expect(later.map((r) => r.id)).toEqual([I.shirtS, I.expected]);
    const never = await loadOrderableCatalog(ORG, WH, 'ALL', null);
    expect(never.map((r) => r.id)).toEqual([I.shirtS, I.expected]);
    expect(hoisted.adminQueries).toHaveLength(0);
  });

  it('OVERLAY EARLY (review F3): within two minutes of a hide the read starts with the cached one; an entry it does not need keeps its rows', async () => {
    const mark = hideMark();
    hoisted.cacheEntry = { rows: [I.shirtS, I.expected].map((id) => ({ id })), readStartedAt: Date.parse(mark) + 31_000 };
    const rows = await loadOrderableCatalog(ORG, WH, 'ALL', mark);
    expect(rows.map((r) => r.id)).toEqual([I.shirtS, I.expected]);
    // One read, started before the entry answered; never a second one.
    expect(hoisted.adminQueries).toHaveLength(1);
    expect(hoisted.adminQueries[0]).toContain('order_catalog_visibility_changed_at >=');
  });

  it('SHOW: showing them again changes them back without moving the hide mark', async () => {
    hoisted.ctx = ctxFor(MGR, 'manager');
    const mark = hideMark();
    const r = await call(POST(postReq({ itemIds: [I.shirtS, I.shirtM, I.book], visible: true, operationId: randomUUID() })));
    expect(r.status).toBe(200);
    expect(r.body.changed).toHaveLength(3);
    expect(hideMark()).toBe(mark);
    expect([I.shirtS, I.shirtM, I.book].map((id) => visibleOf(id).split('|')[0])).toEqual(['true', 'true', 'true']);
    expect([I.shirtS, I.shirtM, I.book].map(auditCount)).toEqual([2, 2, 2]);
  });
});
