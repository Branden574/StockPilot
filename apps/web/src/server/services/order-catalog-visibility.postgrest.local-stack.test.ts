import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, effectivePermissions, ORDER_CATALOG_MANAGE_PAGE_SIZE } from '@stockpilot/core';

import { isbnVariants } from '@/lib/books/isbn-variants';

/**
 * REAL POSTGREST (opt-in; 0413 review fix round, findings 6 and 9).
 *
 * Manage order items pages 25 records at a time with an exact total. The
 * earlier proofs were a mock (a count of 61) and an in-process SQL transport,
 * so PostgREST's own max_rows (1000, supabase/config.toml) and its
 * Content-Range count were never in the path. Here the service's real query
 * goes through supabase-js to a real PostgREST of the local stack's image,
 * configured as config.toml configures it (schemas, extra search path,
 * max_rows 1000), as the caller (a manager's signed token, so row level
 * security decides every row):
 *
 *   PAGING: 1,600 manageable records (and four that are not: deleted, rental,
 *   kit, archived): page 1, pages 61 to 64 (rows 1,501 to 1,600, past the
 *   1,000-row cap), page 65 empty, the exact total on every page; an ISBN-10
 *   search finds the book stored under its ISBN-13 and the reverse; the
 *   Hidden and Shown filters total 40 and 1,560.
 *
 *   TIMINGS (design 11.2 items 1, 2 and 4, through this transport): a 20,000
 *   record organization's page 1, name search, ISBN search and page 60 with
 *   the exact count; Show or Hide of 1, 25, 100 and 500 ids through the
 *   service and set_order_catalog_visibility; the requester catalog's miss
 *   (the cached loader's uncached read, every page of the warehouse through
 *   the admin client) and the freshness overlay. Reported, not asserted
 *   beyond sanity. Photos are not signed (the image service is stubbed): the
 *   storage API is not part of this transport.
 *
 * What stands in: nothing in the query path. The PostgREST container is
 * started by the runner with a throwaway JWT secret it generates (never the
 * stack's), so tokens are minted here for synthetic users only. No key or
 * secret of the stack is read; nothing leaves the machine.
 *
 * Run (local scratch stack only, holding its slot):
 *   ORDVIS_LOCAL_DB_CONTAINER=supabase_db_spmig \
 *   ORDVIS_POSTGREST_URL=http://127.0.0.1:3719 \
 *   ORDVIS_POSTGREST_ENV_FILE=<the runner's env file holding PGRST_JWT_SECRET> \
 *     npx vitest run src/server/services/order-catalog-visibility.postgrest.local-stack.test.ts
 * Skipped otherwise. Synthetic data only (*.test addresses, random ids).
 */

const CONTAINER = process.env.ORDVIS_LOCAL_DB_CONTAINER ?? '';
const REST_URL = process.env.ORDVIS_POSTGREST_URL ?? '';
const ENV_FILE = process.env.ORDVIS_POSTGREST_ENV_FILE ?? '';
/** Where the timings are written as JSON (optional). */
const TIMINGS_OUT = process.env.ORDVIS_TIMINGS_OUT ?? '';
const ENABLED =
  /^supabase_db_[A-Za-z0-9_-]+$/.test(CONTAINER) &&
  /^http:\/\/127\.0\.0\.1:\d+$/.test(REST_URL) &&
  ENV_FILE !== '';

const hoisted = vi.hoisted(() => ({ admin: null as unknown }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  // Pass-through: every catalog load below is a MISS (the uncached read).
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    primaryImagesWithThumbsForItems = vi.fn(async () => new Map());
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => hoisted.admin }));

import { loadOrderableCatalog } from '@/server/loaders/orders-new-catalog';

import { OrderCatalogVisibilityService } from './order-catalog-visibility';

// ── psql for the fixtures ───────────────────────────────────────────────────

function must(sql: string): string {
  const r = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(r.stderr || String(r.error));
  return r.stdout.trim();
}
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

// ── tokens signed with the runner's throwaway secret ────────────────────────

function jwtSecret(): string {
  const line = readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('PGRST_JWT_SECRET='));
  if (!line) throw new Error('the runner env file has no PGRST_JWT_SECRET');
  return line.slice('PGRST_JWT_SECRET='.length).trim();
}

function sign(claims: Record<string, unknown>, secret: string): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iat: now, exp: now + 3600, ...claims })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** supabase-js against the bare PostgREST: /rest/v1 is dropped on the way. */
function restClient(token: string) {
  const target = REST_URL;
  return createClient('http://postgrest.probe.test', token, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(url.replace('http://postgrest.probe.test/rest/v1', target), init);
      },
    },
  });
}

// ── the synthetic organizations ─────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const ORG = randomUUID(); // 1,600 manageable records
const PERF = randomUUID(); // 20,000 records
const MGR = randomUUID();
const PERF_MGR = randomUUID();
const WH = randomUUID();
const PERF_WH = randomUUID();
const PAGE = ORDER_CATALOG_MANAGE_PAGE_SIZE;

/** Two books with made-up ISBNs (valid check digits, no real title):
 *  one stored under its ISBN-13, the other under its ISBN-10. */
const ISBN_A13 = isbnVariants('0000042010').find((v) => v.length === 13)!;
const ISBN_A10 = isbnVariants(ISBN_A13).find((v) => v.length === 10)!;
const ISBN_B13 = isbnVariants('0000042020').find((v) => v.length === 13)!;
const ISBN_B10 = isbnVariants(ISBN_B13).find((v) => v.length === 10)!;

const name = (n: number) => `PG ${RUN} ${String(n).padStart(5, '0')}`;

function ctxFor(supabase: unknown, org: string, user: string) {
  return {
    supabase,
    organizationId: org,
    userId: user,
    role: 'manager' as const,
    permissions: effectivePermissions('manager'),
    enabledModules: new Set(DEFAULT_MODULE_IDS),
    mfaRequired: false,
    mfaSatisfied: true,
    mfaEnrolled: false,
  };
}

function percentiles(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
  return { n: s.length, p50: at(50), p95: at(95), p99: at(99), max: s[s.length - 1]! };
}

async function timed(runs: number, warm: number, fn: () => Promise<unknown>) {
  for (let i = 0; i < warm; i++) await fn();
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    out.push(Math.round((performance.now() - t) * 10) / 10);
  }
  return percentiles(out);
}

const report: Record<string, unknown> = {};

describe.skipIf(!ENABLED)('Manage order items through a real PostgREST (0413 review fix round)', () => {
  let secret = '';

  beforeAll(() => {
    secret = jwtSecret();
    expect(
      must(`select to_regprocedure('public.set_order_catalog_visibility(uuid,uuid[],boolean,uuid,text)') is not null;`),
    ).toBe('t');
    must(`
      insert into auth.users (id, email, raw_user_meta_data) values
        (${lit(MGR)}, ${lit(`ordvis-pg-${RUN}-mgr@ordvis.test`)}, '{}'::jsonb),
        (${lit(PERF_MGR)}, ${lit(`ordvis-pg-${RUN}-perf@ordvis.test`)}, '{}'::jsonb);
      insert into public.organizations (id, name, slug) values
        (${lit(ORG)}, ${lit(`Ordvis paging ${RUN}`)}, ${lit(`ordvis-paging-${RUN}`)}),
        (${lit(PERF)}, ${lit(`Ordvis perf ${RUN}`)}, ${lit(`ordvis-perf-${RUN}`)});
      insert into public.organization_members (organization_id, user_id, role, accepted_at) values
        (${lit(ORG)}, ${lit(MGR)}, 'manager', now()), (${lit(PERF)}, ${lit(PERF_MGR)}, 'manager', now());
      insert into public.warehouses (id, organization_id, name, code, status) values
        (${lit(WH)}, ${lit(ORG)}, 'Paging Main', ${lit(`PM-${RUN}`)}, 'active'),
        (${lit(PERF_WH)}, ${lit(PERF)}, 'Perf Main', ${lit(`PF-${RUN}`)}, 'active');
      -- 1,600 manageable records, names in order; 40 of them hidden (every
      -- 40th); two are books with ISBN barcodes.
      insert into public.inventory_items
        (id, organization_id, warehouse_id, sku, name, item_type, barcode, quantity_on_hand, status,
         is_rental, awaiting_first_receipt, is_bundle, order_catalog_visible, created_at, updated_at)
      select gen_random_uuid(), ${lit(ORG)}, ${lit(WH)}, 'PG-' || ${lit(RUN)} || '-' || lpad(n::text, 5, '0'),
             'PG ' || ${lit(RUN)} || ' ' || lpad(n::text, 5, '0'),
             case when n in (777, 1555) then 'book' else 'product' end,
             case n when 777 then ${lit(ISBN_A13)} when 1555 then ${lit(ISBN_B10)} else null end,
             5, 'active', false, false, false, (n % 40 <> 0), '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'
        from generate_series(1, 1600) as n;
      -- Four that are never manageable.
      insert into public.inventory_items
        (id, organization_id, warehouse_id, sku, name, item_type, quantity_on_hand, status,
         is_rental, awaiting_first_receipt, is_bundle, deleted_at, created_at, updated_at) values
        (gen_random_uuid(), ${lit(ORG)}, ${lit(WH)}, ${lit(`PGX-DEL-${RUN}`)}, ${lit(`PG ${RUN} 00000 deleted`)}, 'product', 0, 'active', false, false, false, now(), now(), now()),
        (gen_random_uuid(), ${lit(ORG)}, ${lit(WH)}, ${lit(`PGX-RNT-${RUN}`)}, ${lit(`PG ${RUN} 00000 rental`)}, 'product', 1, 'active', true, false, false, null, now(), now()),
        (gen_random_uuid(), ${lit(ORG)}, ${lit(WH)}, ${lit(`PGX-KIT-${RUN}`)}, ${lit(`PG ${RUN} 00000 kit`)}, 'product', 1, 'active', false, false, true, null, now(), now()),
        (gen_random_uuid(), ${lit(ORG)}, ${lit(WH)}, ${lit(`PGX-ARC-${RUN}`)}, ${lit(`PG ${RUN} 00000 archived`)}, 'product', 1, 'archived', false, false, false, null, now(), now());
      -- 20,000 records for the timings.
      insert into public.inventory_items
        (id, organization_id, warehouse_id, sku, name, item_type, barcode, quantity_on_hand, status,
         is_rental, awaiting_first_receipt, is_bundle, created_at, updated_at)
      select gen_random_uuid(), ${lit(PERF)}, ${lit(PERF_WH)}, 'PF-' || ${lit(RUN)} || '-' || lpad(n::text, 5, '0'),
             'Perf ' || ${lit(RUN)} || ' item ' || lpad(n::text, 5, '0'),
             case when n = 4242 then 'book' else 'product' end,
             case when n = 4242 then ${lit(ISBN_A13)} else null end,
             5, 'active', false, false, false, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'
        from generate_series(1, 20000) as n;
      analyze public.inventory_items;
    `);
  }, 300_000);

  beforeEach(() => {
    vi.stubEnv('ORDER_ITEMS_MANAGE_ORGS', `${ORG},${PERF}`);
  });

  afterAll(() => {
    // The numbers this run measured, for the progress log and the PR body.
    if (TIMINGS_OUT && Object.keys(report).length > 0) {
      writeFileSync(TIMINGS_OUT, `${JSON.stringify(report, null, 1)}\n`);
    }
  });

  const service = (org: string, user: string) =>
    new OrderCatalogVisibilityService(
      ctxFor(restClient(sign({ sub: user, role: 'authenticated', aal: 'aal1' }, secret)), org, user) as never,
    );
  const query = (over: Record<string, unknown> = {}) =>
    ({ page: 1, q: '', visibility: 'all', type: 'all', warehouseId: null, categoryId: null, ...over }) as never;

  it('control: this PostgREST caps a response at 1,000 rows, whatever is asked for', async () => {
    const client = restClient(sign({ sub: MGR, role: 'authenticated', aal: 'aal1' }, secret));
    const { data, error } = await client
      .from('inventory_items')
      .select('id', { count: 'exact' })
      .eq('organization_id', ORG)
      .range(0, 1599);
    expect(error).toBeNull();
    expect(data).toHaveLength(1000);
  });

  it('PAGING: page 1, pages 61 to 64 past the 1,000-row cap and an empty page 65, each with the exact total', async () => {
    const svc = service(ORG, MGR);
    const first = await svc.list(query());
    expect(first.total).toBe(1600);
    expect(first.rows.map((r) => r.name)).toEqual(Array.from({ length: PAGE }, (_, i) => name(i + 1)));

    for (const page of [61, 62, 63, 64]) {
      const answer = await svc.list(query({ page }));
      expect(answer.total).toBe(1600);
      const start = (page - 1) * PAGE + 1;
      expect(answer.rows.map((r) => r.name)).toEqual(Array.from({ length: PAGE }, (_, i) => name(start + i)));
    }
    const past = await svc.list(query({ page: 65 }));
    expect(past.total).toBe(1600);
    expect(past.rows).toEqual([]);
  });

  it('PAGING: an ISBN-10 search finds the book stored under its ISBN-13, and the reverse', async () => {
    const svc = service(ORG, MGR);
    const byTen = await svc.list(query({ q: `${ISBN_A10.slice(0, 1)}-${ISBN_A10.slice(1, 4)}-${ISBN_A10.slice(4, 9)}-${ISBN_A10.slice(9)}` }));
    expect(byTen.total).toBe(1);
    expect(byTen.rows.map((r) => r.name)).toEqual([name(777)]);
    const byThirteen = await svc.list(query({ q: ISBN_B13 }));
    expect(byThirteen.total).toBe(1);
    expect(byThirteen.rows.map((r) => r.name)).toEqual([name(1555)]);
  });

  it('PAGING: the Hidden and Shown filters total 40 and 1,560, and Hidden pages in name order', async () => {
    const svc = service(ORG, MGR);
    const hidden = await svc.list(query({ visibility: 'hidden' }));
    expect(hidden.total).toBe(40);
    expect(hidden.rows.map((r) => r.name)).toEqual(Array.from({ length: PAGE }, (_, i) => name((i + 1) * 40)));
    expect(hidden.rows.every((r) => r.visible === false)).toBe(true);
    const hidden2 = await svc.list(query({ visibility: 'hidden', page: 2 }));
    expect(hidden2.rows.map((r) => r.name)).toEqual(Array.from({ length: 15 }, (_, i) => name((i + 26) * 40)));
    const shown = await svc.list(query({ visibility: 'shown' }));
    expect(shown.total).toBe(1560);
  });

  it('TIMINGS: the management list of a 20,000-record organization (page 1, name search, ISBN search, page 60)', async () => {
    const svc = service(PERF, PERF_MGR);
    const page1 = await timed(20, 3, () => svc.list(query()));
    const search = await timed(20, 3, () => svc.list(query({ q: 'item 1234' })));
    const isbn = await timed(20, 3, () => svc.list(query({ q: ISBN_A10 })));
    const page60 = await timed(20, 3, () => svc.list(query({ page: 60 })));
    const check = await svc.list(query({ page: 60 }));
    expect(check.total).toBe(20000);
    expect(check.rows).toHaveLength(PAGE);
    expect((await svc.list(query({ q: ISBN_A10 }))).total).toBe(1);
    report.manageList20k = { page1, nameSearch: search, isbnSearch: isbn, page60 };
  }, 300_000);

  it('TIMINGS: Show or Hide of 1, 25, 100 and 500 records through the service and the write function', async () => {
    const svc = service(PERF, PERF_MGR);
    const ids = must(
      `select string_agg(id::text, ',' order by name) from (select id, name from public.inventory_items
        where organization_id = ${lit(PERF)} order by name limit 1000) s;`,
    ).split(',');
    const out: Record<string, unknown> = {};
    let offset = 0;
    for (const size of [1, 25, 100, 500]) {
      const batch = ids.slice(offset, offset + size);
      offset += size;
      const hide: number[] = [];
      const show: number[] = [];
      for (let i = 0; i < 5; i++) {
        let t = performance.now();
        const h = await svc.setVisibility({ itemIds: batch, visible: false, operationId: randomUUID(), surface: 'web' });
        hide.push(Math.round((performance.now() - t) * 10) / 10);
        expect(h.changed).toHaveLength(size);
        t = performance.now();
        const s = await svc.setVisibility({ itemIds: batch, visible: true, operationId: randomUUID(), surface: 'web' });
        show.push(Math.round((performance.now() - t) * 10) / 10);
        expect(s.changed).toHaveLength(size);
      }
      out[`ids${size}`] = { hide: percentiles(hide), show: percentiles(show) };
    }
    report.bulkWrite = out;
  }, 300_000);

  it('TIMINGS: the requester catalog miss (every page of the 20,000-record warehouse) and the overlay', async () => {
    hoisted.admin = restClient(sign({ role: 'service_role' }, secret));
    const neverHid = await timed(10, 2, () => loadOrderableCatalog(PERF, PERF_WH, 'ALL', null));
    const rows = await loadOrderableCatalog(PERF, PERF_WH, 'ALL', null);
    expect(rows.length).toBeGreaterThan(9000);
    // A hide a moment ago: the early overlay read runs with the miss.
    const recent = new Date().toISOString();
    const withOverlay = await timed(10, 2, () => loadOrderableCatalog(PERF, PERF_WH, 'ALL', recent));
    report.catalogMiss20k = { rows: rows.length, neverHid, recentHide: withOverlay };
  }, 300_000);
});
