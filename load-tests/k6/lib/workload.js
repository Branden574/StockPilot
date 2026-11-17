// The signed-in workload: what each role does, how often, and how the run
// decides it passed. Every scenario builds its options and its iteration from
// here, so they all share one set of safety rails, tags and thresholds.
//
// Model: each role is one k6 scenario with a constant ARRIVAL RATE (an open
// model: the offered load stays the same however slow the app gets, which is
// what a before/after comparison needs). One iteration is one action by one
// signed-in person followed by that person's think time: 3-8 s on the web,
// 1-3 s on the phone. The rate for `A` concurrent people of a role is
// A / (mean think + mean answer), so "100 actors" means about 100 people
// clicking at human speed.
//
// Every request carries the tags kind, role and action. The timed kinds, each
// with its own p95 target, are ssr (a page), api_read (a read through the API)
// and write (a write that changes data). Requests that are part of the run but
// would distort those numbers have kinds of their own, reported but not timed
// against a target: write_refused (a viewer's write, refused at once),
// write_replay (a resent submission, answered from the stored result) and
// probe (the warehouse-scope probes). The thresholds below fail the run on any
// sign-in or correctness fault, not only on slowness.
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';

import { assertRequestUrl, localTarget } from './safety.js';
import { mintSessions, proveSessions } from './auth.js';

/** Kinds with a p95 target. */
export const KINDS = ['ssr', 'api_read', 'write'];
/** Kinds reported apart and not held to a target. */
export const REPORTED_KINDS = ['write_refused', 'write_replay', 'probe'];
/**
 * The writes counted when sent and when answered, so the correctness check
 * can allow for the ones a run's end cut off (sent, never answered: the
 * server may or may not have committed them).
 */
export const COUNTED_WRITES = ['place_order', 'adjust_up', 'adjust_down', 'receive_line'];
export const ALL_ROLES = ['owner', 'admin', 'manager', 'staff', 'viewer', 'staff_one_warehouse'];

// ── Targets and manifest (init stage: refused here before any request) ──
export const TARGET = localTarget(__ENV);

const MANIFEST_PATH = __ENV.LOADTEST_MANIFEST;
if (!MANIFEST_PATH) {
  throw new Error(
    'LOADTEST_MANIFEST is not set: run the seeder first (load-tests/k6/tools/seed.mjs).',
  );
}
// The small part of the manifest every VU keeps; the id pools are shared
// arrays (stored once, not once per VU).
const MANIFEST = JSON.parse(open(MANIFEST_PATH));
if (MANIFEST.kind !== 'stockpilot-loadtest-manifest')
  throw new Error('LOADTEST_MANIFEST is not a seeder manifest.');
export const ORG = {
  id: MANIFEST.organizationId,
  w1: MANIFEST.warehouses[0].id,
  terms: MANIFEST.searchTerms,
  otherTerm: MANIFEST.otherWarehouseTerm,
};
function pool(name) {
  return new SharedArray(`pool:${name}`, () => {
    const p = MANIFEST.pools[name] || [];
    if (p.length === 0) throw new Error(`The manifest pool "${name}" is empty.`);
    return p;
  });
}
const POOLS = {
  read: pool('read'),
  w1Read: pool('w1Read'),
  otherWarehouse: pool('otherWarehouse'),
  order: pool('order'),
  adjust: pool('adjust'),
  receive: pool('receive'),
};

// ── Metrics ──
export const authOk = new Rate('auth_ok');
const signinRedirects = new Counter('signin_redirects');
const mfaRequired = new Counter('mfa_required');
const scopeViolations = new Counter('scope_violations');
const viewerWriteAllowed = new Counter('viewer_write_allowed');
const rateLimited = new Counter('rate_limited');
const ordersCreated = new Counter('orders_created');
const ordersReplayed = new Counter('orders_replayed');
const replayMismatch = new Counter('replay_mismatch');
const receiptsCreated = new Counter('receipts_created');
const receiptsReplayed = new Counter('receipts_replayed');
const adjustUp = new Counter('adjust_up_ok');
const adjustDown = new Counter('adjust_down_ok');
const responseBytes = new Trend('response_bytes');
const writesSent = new Counter('writes_sent');
const writesAnswered = new Counter('writes_answered');

// ── Configuration ──
function num(name, dflt) {
  const v = __ENV[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} is not a number.`);
  return n;
}
export const CONFIG = {
  actors: num('LOADTEST_ACTORS', 25),
  duration: __ENV.LOADTEST_DURATION || '2m',
  p95: {
    ssr: num('LOADTEST_P95_SSR_MS', 1500),
    api_read: num('LOADTEST_P95_API_READ_MS', 800),
    write: num('LOADTEST_P95_WRITE_MS', 2000),
  },
  sessionsPerRole: num('LOADTEST_SESSIONS_PER_ROLE', 50),
  // Iterations k6 could not start on time (no free VU): the offered load was
  // not delivered. Percent of the planned iterations a run may drop.
  maxDroppedPct: num('LOADTEST_MAX_DROPPED_PCT', 1),
  replayShare: num('LOADTEST_REPLAY_SHARE', 0.1),
};

/** Share of the concurrent people in each role (sums to 1). LOADTEST_MIX overrides, as JSON. */
export const DEFAULT_ROLE_SHARE = {
  owner: 0.02,
  admin: 0.08,
  manager: 0.15,
  staff: 0.45,
  viewer: 0.2,
  staff_one_warehouse: 0.1,
};

/** Relative weight of each action per role. */
export const DEFAULT_ACTIONS = {
  owner: {
    dashboard_home: 10,
    items_list: 22,
    low_stock: 8,
    item_detail: 14,
    web_search: 10,
    orders_new: 4,
    phone_permissions: 3,
    phone_storefront: 3,
    phone_catalog: 3,
    phone_lookup: 5,
    phone_history: 5,
    adjust_pair: 4,
    receive_line: 6,
    place_order: 3,
  },
  admin: {
    dashboard_home: 8,
    items_list: 22,
    low_stock: 8,
    item_detail: 14,
    web_search: 10,
    orders_new: 4,
    phone_permissions: 3,
    phone_storefront: 3,
    phone_catalog: 3,
    phone_lookup: 6,
    phone_history: 5,
    adjust_pair: 5,
    receive_line: 6,
    place_order: 3,
  },
  manager: {
    dashboard_home: 6,
    items_list: 18,
    low_stock: 8,
    item_detail: 12,
    web_search: 8,
    orders_new: 4,
    phone_permissions: 4,
    phone_storefront: 4,
    phone_catalog: 4,
    phone_lookup: 8,
    phone_history: 6,
    adjust_pair: 6,
    receive_line: 8,
    place_order: 4,
  },
  staff: {
    dashboard_home: 4,
    items_list: 12,
    low_stock: 4,
    item_detail: 8,
    web_search: 8,
    orders_new: 6,
    phone_permissions: 6,
    phone_storefront: 6,
    phone_catalog: 8,
    phone_lookup: 12,
    phone_history: 8,
    adjust_pair: 10,
    place_order: 8,
  },
  viewer: {
    dashboard_home: 6,
    items_list: 18,
    low_stock: 6,
    item_detail: 12,
    web_search: 10,
    orders_new: 6,
    phone_permissions: 6,
    phone_storefront: 6,
    phone_catalog: 8,
    phone_lookup: 8,
    phone_history: 6,
    place_order: 4,
    viewer_write_denied: 4,
  },
  staff_one_warehouse: {
    dashboard_home: 4,
    items_list: 10,
    low_stock: 4,
    item_detail: 8,
    web_search: 6,
    orders_new: 6,
    phone_permissions: 6,
    phone_storefront: 6,
    phone_catalog: 8,
    phone_lookup: 10,
    phone_history: 6,
    adjust_pair: 8,
    place_order: 6,
    scope_probe: 12,
  },
};

const THINK = { web: [3, 8], phone: [1, 3] };
/** A rough answer time, only used to size the arrival rate. */
const EST_ANSWER_S = {
  ssr: 0.4,
  api_read: 0.15,
  write: 0.3,
  write_refused: 0.1,
  write_replay: 0.15,
  probe: 0.3,
};

// ── Requests ──
function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}
function rand(a, b) {
  return a + Math.random() * (b - a);
}
function jsonOf(res) {
  try {
    return res.json();
  } catch (_e) {
    return null;
  }
}

/**
 * One request as `who`. auth: 'bearer' (the phone, /api) or 'cookie' (the
 * browser). Records the sign-in signals for every answer: a redirect to
 * /signin, a 401, or an authenticator demand is an auth failure. `write`
 * names a counted write (COUNTED_WRITES): counted when sent and when answered.
 */
function call(who, method, path, { auth, kind, action, body, expect = [200], name, write }) {
  const tags = {
    kind,
    role: who.role,
    action,
    name: name || `${method} ${path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '[id]')}`,
  };
  const headers = { Accept: auth === 'cookie' ? 'text/html,application/json' : 'application/json' };
  if (auth === 'bearer') headers.Authorization = `Bearer ${who.session.bearer}`;
  else headers.Cookie = who.session.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (write) writesSent.add(1, { write });
  const res = http.request(
    method,
    assertRequestUrl(`${TARGET.baseUrl}${path}`),
    body === undefined ? null : JSON.stringify(body),
    {
      headers,
      tags,
      redirects: 0,
      responseCallback: http.expectedStatuses(...expect),
    },
  );
  // Status 0: no answer (timeout, reset, or the run's end cut it off).
  if (write && res.status !== 0) writesAnswered.add(1, { write });
  const location = res.headers.Location || res.headers.location || '';
  const toSignin = res.status >= 300 && res.status < 400 && /\/signin/.test(location);
  const text = typeof res.body === 'string' ? res.body : '';
  const mfa =
    (res.status === 401 || res.status === 403) &&
    /"(mfa_required|aal2_required)"/.test(text.slice(0, 2000));
  if (toSignin) signinRedirects.add(1, tags);
  if (mfa) mfaRequired.add(1, tags);
  authOk.add(!(toSignin || mfa || res.status === 401), tags);
  if (res.status === 429) rateLimited.add(1, tags);
  responseBytes.add(text.length, tags);
  return res;
}

const SKU_RE = /LT-W\d+-\d{6}/;
/** The answer's text, or '' (a check must never throw on an empty answer). */
function textOf(res) {
  return typeof res.body === 'string' ? res.body : '';
}

// ── Actions ──
// Each returns nothing; checks record the outcome. `who` = { role, session }.
const ACTIONS = {
  dashboard_home: {
    surface: 'web',
    kind: 'ssr',
    run(who) {
      const res = call(who, 'GET', '/dashboard', {
        auth: 'cookie',
        kind: 'ssr',
        action: 'dashboard_home',
      });
      check(res, { 'dashboard home 200': (r) => r.status === 200 && textOf(r).length > 1000 });
    },
  },
  items_list: {
    surface: 'web',
    kind: 'ssr',
    run(who) {
      const page = 1 + Math.floor(Math.random() * 5);
      const filter = pick([
        '',
        '',
        'status=active',
        'stock=low',
        'sort=name_asc',
        'sort=qty_desc',
        'sort=updated_desc',
        `q=${encodeURIComponent(pick(ORG.terms))}`,
      ]);
      const qs = [filter, page > 1 ? `page=${page}` : ''].filter(Boolean).join('&');
      const res = call(who, 'GET', `/dashboard/inventory${qs ? `?${qs}` : ''}`, {
        auth: 'cookie',
        kind: 'ssr',
        action: 'items_list',
        name: 'GET /dashboard/inventory',
      });
      check(res, {
        'items list 200': (r) => r.status === 200,
        // The first page of the unfiltered list always holds items.
        'items list shows items': (r) => page > 1 || filter !== '' || SKU_RE.test(textOf(r)),
      });
    },
  },
  low_stock: {
    surface: 'web',
    kind: 'ssr',
    run(who) {
      const res = call(who, 'GET', '/dashboard/inventory?stock=low', {
        auth: 'cookie',
        kind: 'ssr',
        action: 'low_stock',
        name: 'GET /dashboard/inventory?stock=low',
      });
      check(res, { 'low stock 200': (r) => r.status === 200 });
    },
  },
  item_detail: {
    surface: 'web',
    kind: 'ssr',
    run(who) {
      const item = pick(who.role === 'staff_one_warehouse' ? POOLS.w1Read : POOLS.read);
      const res = call(who, 'GET', `/dashboard/inventory/${item.id}`, {
        auth: 'cookie',
        kind: 'ssr',
        action: 'item_detail',
      });
      check(res, {
        'item detail 200 with the item': (r) => r.status === 200 && textOf(r).includes(item.sku),
      });
    },
  },
  web_search: {
    surface: 'web',
    kind: 'api_read',
    run(who) {
      const q = pick(ORG.terms);
      const res = call(who, 'GET', `/api/search?q=${encodeURIComponent(q)}`, {
        auth: 'cookie',
        kind: 'api_read',
        action: 'web_search',
        name: 'GET /api/search',
      });
      const body = jsonOf(res);
      check(res, {
        'search 200 with items': () => res.status === 200 && !!body && Array.isArray(body.items),
      });
      if (who.role === 'staff_one_warehouse' && body && Array.isArray(body.items)) {
        const leaked = body.items.filter(
          (i) => typeof i.sku === 'string' && !i.sku.startsWith('LT-W1-'),
        ).length;
        if (leaked > 0) scopeViolations.add(leaked, { role: who.role, action: 'web_search' });
      }
    },
  },
  orders_new: {
    surface: 'web',
    kind: 'ssr',
    run(who) {
      const res = call(who, 'GET', '/dashboard/orders/new', {
        auth: 'cookie',
        kind: 'ssr',
        action: 'orders_new',
      });
      check(res, {
        'order storefront page 200': (r) => r.status === 200 && textOf(r).length > 1000,
      });
    },
  },
  procedures_list: {
    surface: 'web',
    kind: 'ssr',
    run(who) {
      const res = call(who, 'GET', '/dashboard/procedures', {
        auth: 'cookie',
        kind: 'ssr',
        action: 'procedures_list',
      });
      check(res, { 'procedures page 200': (r) => r.status === 200 && textOf(r).length > 1000 });
    },
  },
  phone_permissions: {
    surface: 'phone',
    kind: 'api_read',
    run(who) {
      const res = call(who, 'GET', '/api/v1/me/permissions', {
        auth: 'bearer',
        kind: 'api_read',
        action: 'phone_permissions',
      });
      const body = jsonOf(res);
      check(res, {
        'permissions 200': () => res.status === 200 && !!body && Array.isArray(body.permissions),
      });
    },
  },
  phone_storefront: {
    surface: 'phone',
    kind: 'api_read',
    run(who) {
      const res = call(who, 'GET', '/api/v1/orders/storefront', {
        auth: 'bearer',
        kind: 'api_read',
        action: 'phone_storefront',
      });
      const body = jsonOf(res);
      check(res, { 'storefront 200': () => res.status === 200 && !!body && body.enabled === true });
    },
  },
  phone_catalog: {
    surface: 'phone',
    kind: 'api_read',
    run(who) {
      const res = call(who, 'GET', `/api/v1/orders/catalog?warehouseId=${ORG.w1}`, {
        auth: 'bearer',
        kind: 'api_read',
        action: 'phone_catalog',
        name: 'GET /api/v1/orders/catalog',
      });
      check(res, { 'catalog 200': (r) => r.status === 200 });
    },
  },
  phone_lookup: {
    surface: 'phone',
    kind: 'api_read',
    run(who) {
      const item = pick(who.role === 'staff_one_warehouse' ? POOLS.w1Read : POOLS.read);
      const code = Math.random() < 0.5 ? item.barcode : item.sku;
      const res = call(who, 'GET', `/api/v1/items/lookup?code=${encodeURIComponent(code)}`, {
        auth: 'bearer',
        kind: 'api_read',
        action: 'phone_lookup',
        name: 'GET /api/v1/items/lookup',
      });
      const body = jsonOf(res);
      check(res, {
        'lookup finds the item': () =>
          res.status === 200 &&
          !!body &&
          Array.isArray(body.matches) &&
          body.matches.some((m) => m.id === item.id),
      });
    },
  },
  phone_history: {
    surface: 'phone',
    kind: 'api_read',
    run(who) {
      const item = pick(who.role === 'staff_one_warehouse' ? POOLS.w1Read : POOLS.read);
      const res = call(who, 'GET', `/api/v1/items/${item.id}/history?limit=50`, {
        auth: 'bearer',
        kind: 'api_read',
        action: 'phone_history',
        name: 'GET /api/v1/items/[id]/history',
      });
      const body = jsonOf(res);
      check(res, { 'history 200': () => res.status === 200 && !!body && Array.isArray(body.rows) });
    },
  },
  place_order: {
    surface: 'phone',
    kind: 'write',
    run(who) {
      const item = pick(POOLS.order);
      const body = {
        idempotencyKey: crypto.randomUUID(),
        placerUserId: who.session.userId,
        warehouseId: item.warehouseId,
        fulfillmentType: 'pickup',
        deliveryCharterId: null,
        onBehalfOf: null,
        notes: 'Load test order',
        neededByLocal: null,
        lines: [{ itemId: item.id, quantity: 1 }],
      };
      const res = call(who, 'POST', '/api/v1/orders', {
        auth: 'bearer',
        kind: 'write',
        action: 'place_order',
        body,
        expect: [201],
        write: 'place_order',
      });
      const first = jsonOf(res);
      const created =
        res.status === 201 && !!first && first.result && first.result.replay === false;
      if (created) ordersCreated.add(1, { role: who.role });
      check(res, { 'order placed 201': () => created });
      if (created && Math.random() < CONFIG.replayShare) {
        // The phone resending the same submission: one order, answered again.
        const again = call(who, 'POST', '/api/v1/orders', {
          auth: 'bearer',
          kind: 'write_replay',
          action: 'place_order_replay',
          body,
          expect: [200],
          name: 'POST /api/v1/orders (replay)',
        });
        const second = jsonOf(again);
        const same =
          again.status === 200 &&
          !!second &&
          second.result &&
          second.result.replay === true &&
          second.result.order &&
          second.result.order.id === first.result.order.id;
        if (same) ordersReplayed.add(1, { role: who.role });
        else replayMismatch.add(1, { role: who.role, action: 'place_order' });
        check(again, { 'order resend replays the same order': () => same });
      }
    },
  },
  adjust_pair: {
    surface: 'phone',
    kind: 'write',
    run(who) {
      const item = pick(POOLS.adjust);
      const path = `/api/v1/items/${item.id}/adjust`;
      const up = call(who, 'POST', path, {
        auth: 'bearer',
        kind: 'write',
        action: 'adjust_pair',
        body: { quantityChange: 1, reason: 'Load test +1' },
        write: 'adjust_up',
      });
      const upOk = up.status === 200;
      if (upOk) adjustUp.add(1, { role: who.role });
      check(up, { 'adjust +1 200': () => upOk });
      if (!upOk) return;
      sleep(rand(0.3, 1));
      const down = call(who, 'POST', path, {
        auth: 'bearer',
        kind: 'write',
        action: 'adjust_pair',
        body: { quantityChange: -1, reason: 'Load test -1' },
        write: 'adjust_down',
      });
      const downOk = down.status === 200;
      if (downOk) adjustDown.add(1, { role: who.role });
      check(down, { 'adjust -1 200': () => downOk });
    },
  },
  receive_line: {
    surface: 'phone',
    kind: 'write',
    run(who) {
      const target = pick(POOLS.receive);
      const body = {
        itemId: target.itemId,
        qty: 1,
        warehouseId: target.warehouseId,
        idempotencyKey: crypto.randomUUID(),
      };
      const path = `/api/v1/po/${target.poId}/receive-line`;
      const res = call(who, 'POST', path, {
        auth: 'bearer',
        kind: 'write',
        action: 'receive_line',
        body,
        write: 'receive_line',
      });
      const first = jsonOf(res);
      const ok = res.status === 200 && !!first && typeof first.receiptId === 'string';
      if (ok) receiptsCreated.add(1, { role: who.role });
      check(res, { 'receive line 200': () => ok });
      if (ok && Math.random() < CONFIG.replayShare) {
        const again = call(who, 'POST', path, {
          auth: 'bearer',
          kind: 'write_replay',
          action: 'receive_line_replay',
          body,
          name: 'POST /api/v1/po/[id]/receive-line (replay)',
        });
        const second = jsonOf(again);
        const same = again.status === 200 && !!second && second.receiptId === first.receiptId;
        if (same) receiptsReplayed.add(1, { role: who.role });
        else replayMismatch.add(1, { role: who.role, action: 'receive_line' });
        check(again, { 'receive resend answers the same receipt': () => same });
      }
    },
  },
  viewer_write_denied: {
    surface: 'phone',
    kind: 'write_refused',
    run(who) {
      const item = pick(POOLS.adjust);
      const res = call(who, 'POST', `/api/v1/items/${item.id}/adjust`, {
        auth: 'bearer',
        kind: 'write_refused',
        action: 'viewer_write_denied',
        body: { quantityChange: 1, reason: 'Viewer must be refused' },
        expect: [403],
      });
      if (res.status >= 200 && res.status < 300) viewerWriteAllowed.add(1, { role: who.role });
      check(res, { 'viewer write refused 403': (r) => r.status === 403 });
    },
  },
  scope_probe: {
    surface: 'web',
    kind: 'probe',
    run(who) {
      // Staff limited to the first warehouse must never see another
      // warehouse's items, by search, scan, page or list.
      const other = pick(POOLS.otherWarehouse);
      const probe = Math.floor(Math.random() * 4);
      if (probe === 0) {
        const res = call(who, 'GET', `/api/search?q=${encodeURIComponent(ORG.otherTerm)}`, {
          auth: 'cookie',
          kind: 'probe',
          action: 'scope_probe',
          name: 'GET /api/search (other warehouse)',
        });
        const body = jsonOf(res);
        const leaked =
          body && Array.isArray(body.items)
            ? body.items.filter((i) => !String(i.sku).startsWith('LT-W1-')).length
            : 0;
        if (leaked) scopeViolations.add(leaked, { role: who.role, action: 'scope_probe' });
        check(res, {
          'scope: search answers without other-warehouse items': () =>
            res.status === 200 && !leaked,
        });
      } else if (probe === 1) {
        const res = call(who, 'GET', `/api/v1/items/lookup?code=${encodeURIComponent(other.sku)}`, {
          auth: 'bearer',
          kind: 'probe',
          action: 'scope_probe',
          expect: [404],
          name: 'GET /api/v1/items/lookup (other warehouse)',
        });
        if (res.status === 200) scopeViolations.add(1, { role: who.role, action: 'scope_probe' });
        check(res, {
          'scope: scan of an other-warehouse item is not found': (r) => r.status === 404,
        });
      } else if (probe === 2) {
        const res = call(who, 'GET', `/dashboard/inventory/${other.id}`, {
          auth: 'cookie',
          kind: 'probe',
          action: 'scope_probe',
          expect: [200, 404],
          name: 'GET /dashboard/inventory/[id] (other warehouse)',
        });
        const leaked = textOf(res).includes(other.sku);
        if (leaked) scopeViolations.add(1, { role: who.role, action: 'scope_probe' });
        check(res, {
          'scope: other-warehouse item page does not show it': () =>
            (res.status === 200 || res.status === 404) && !leaked,
        });
      } else {
        const res = call(
          who,
          'GET',
          `/dashboard/inventory?q=${encodeURIComponent(ORG.otherTerm)}`,
          {
            auth: 'cookie',
            kind: 'probe',
            action: 'scope_probe',
            name: 'GET /dashboard/inventory?q=other',
          },
        );
        const leaked = /LT-W(?!1-)\d+-\d{6}/.test(textOf(res));
        if (leaked) scopeViolations.add(1, { role: who.role, action: 'scope_probe' });
        check(res, {
          'scope: list search shows no other-warehouse item': () => res.status === 200 && !leaked,
        });
      }
    },
  },
};

export const ACTION_NAMES = Object.keys(ACTIONS);

// ── Options ──
function roleShare() {
  if (!__ENV.LOADTEST_MIX) return DEFAULT_ROLE_SHARE;
  const mix = JSON.parse(__ENV.LOADTEST_MIX);
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  const out = {};
  for (const r of Object.keys(mix)) {
    if (!ALL_ROLES.includes(r)) throw new Error(`LOADTEST_MIX names an unknown role: ${r}`);
    out[r] = mix[r] / total;
  }
  return out;
}

/** Mean seconds one iteration of `actions` takes: the action, then think time. */
function meanIterationSeconds(actions) {
  let w = 0;
  let s = 0;
  for (const [name, weight] of Object.entries(actions)) {
    const a = ACTIONS[name];
    if (!a) throw new Error(`Unknown action ${name}`);
    const think = THINK[a.surface];
    const calls = name === 'adjust_pair' ? 2 : 1;
    s +=
      weight *
      ((think[0] + think[1]) / 2 +
        calls * EST_ANSWER_S[a.kind] +
        (name === 'adjust_pair' ? 0.65 : 0));
    w += weight;
  }
  return s / w;
}

function parseDurationSeconds(d) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(d);
  if (!m) throw new Error(`LOADTEST_DURATION must look like 90s, 3m or 1h (got ${d}).`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
}

/**
 * The k6 options for a workload. `plan` maps role -> { share, actions } and
 * defaults to every role with the default mix.
 */
let BUILT_SCENARIOS = {};
let PLANNED = { iterations: 0, maxDropped: 0, durationS: 0 };

export function buildOptions(plan) {
  const durationS = parseDurationSeconds(CONFIG.duration);
  // Sessions are minted once, in setup(), and GoTrue's local tokens last an
  // hour: a longer step would run on expired sessions.
  if (durationS > 50 * 60)
    throw new Error('LOADTEST_DURATION is limited to 50m per run (sessions last 1 h).');
  const scenarios = {};
  const thresholds = {
    checks: ['rate>0.99'],
    auth_ok: [{ threshold: 'rate==1', abortOnFail: true, delayAbortEval: '5s' }],
    signin_redirects: [{ threshold: 'count==0', abortOnFail: true, delayAbortEval: '5s' }],
    mfa_required: [{ threshold: 'count==0', abortOnFail: true, delayAbortEval: '5s' }],
    scope_violations: [{ threshold: 'count==0', abortOnFail: true }],
    viewer_write_allowed: [{ threshold: 'count==0', abortOnFail: true }],
    replay_mismatch: ['count==0'],
    http_req_failed: ['rate<0.01'],
  };
  // setup()'s own requests to the app, so the report can count them apart.
  thresholds['http_reqs{kind:setup}'] = ['count>=0'];
  for (const kind of [...KINDS, ...REPORTED_KINDS]) {
    thresholds[`http_req_duration{kind:${kind}}`] = KINDS.includes(kind)
      ? [`p(95)<${CONFIG.p95[kind]}`]
      : ['max>=0'];
    // Reporting only (a threshold is what makes k6 keep a tagged sub-metric).
    thresholds[`response_bytes{kind:${kind}}`] = ['max>=0'];
    thresholds[`http_reqs{kind:${kind}}`] = ['count>=0'];
  }
  for (const write of COUNTED_WRITES) {
    thresholds[`writes_sent{write:${write}}`] = ['count>=0'];
    thresholds[`writes_answered{write:${write}}`] = ['count>=0'];
  }
  let plannedIterations = 0;
  for (const [role, p] of Object.entries(plan)) {
    const actors = CONFIG.actors * p.share;
    if (actors <= 0) continue;
    const iter = meanIterationSeconds(p.actions);
    const perMinute = Math.max(1, Math.round((actors * 60) / iter));
    plannedIterations += (perMinute * durationS) / 60;
    // About `actors` iterations are in flight at once; random think times
    // make it burst above that. VUs started mid-run take time to start and
    // drop iterations, so most are started up front.
    scenarios[role] = {
      executor: 'constant-arrival-rate',
      exec: 'iterate',
      rate: perMinute,
      timeUnit: '1m',
      duration: CONFIG.duration,
      preAllocatedVUs: Math.max(4, Math.ceil(actors * 2)),
      maxVUs: Math.max(8, Math.ceil(actors * 4)),
      gracefulStop: '15s',
      tags: { role },
    };
    for (const kind of [...KINDS, ...REPORTED_KINDS]) {
      thresholds[`http_req_duration{kind:${kind},role:${role}}`] = ['max>=0'];
    }
    for (const action of Object.keys(p.actions)) {
      thresholds[`http_req_duration{action:${action}}`] = ['max>=0'];
      thresholds[`response_bytes{action:${action}}`] = ['max>=0'];
    }
  }
  // The offered load must be delivered: a run that could not start its
  // iterations on time measured a lighter load than it reports.
  const maxDropped = Math.floor((plannedIterations * CONFIG.maxDroppedPct) / 100);
  thresholds.dropped_iterations = [`count<=${maxDropped}`];
  BUILT_SCENARIOS = scenarios;
  PLANNED = { iterations: Math.round(plannedIterations), maxDropped, durationS };
  return {
    scenarios,
    thresholds,
    // Never follow a redirect: a redirect is an answer to record (to /signin,
    // it is a sign-in failure), and following one could leave this machine.
    maxRedirects: 0,
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
    setupTimeout: '300s',
    userAgent: 'stockpilot-loadtest/1 (local)',
  };
}

/** The default plan: every role, the default share and actions. */
export function defaultPlan(roles = ALL_ROLES) {
  const share = roleShare();
  const plan = {};
  for (const r of roles) {
    if (!share[r]) continue;
    plan[r] = { share: share[r], actions: DEFAULT_ACTIONS[r] };
  }
  return plan;
}

// ── setup / iteration ──
export function setupSessions(plan, pagePath = '/dashboard') {
  const roles = Object.keys(plan);
  const sessions = mintSessions(TARGET, MANIFEST, roles, CONFIG.sessionsPerRole);
  proveSessions(TARGET, sessions, pagePath);
  return { sessions, startedAt: new Date().toISOString() };
}

/** One iteration of the running scenario's role. */
export function iterate(plan, data) {
  const role = exec.scenario.name;
  const p = plan[role];
  const list = data.sessions[role];
  // One session per VU: a VU always signs in as the same person.
  const session = list[(exec.vu.idInTest - 1) % list.length];
  const who = { role, session };
  let total = 0;
  for (const w of Object.values(p.actions)) total += w;
  let roll = Math.random() * total;
  let chosen = null;
  for (const [name, w] of Object.entries(p.actions)) {
    roll -= w;
    if (roll <= 0) {
      chosen = name;
      break;
    }
  }
  if (!chosen) chosen = Object.keys(p.actions)[0];
  const action = ACTIONS[chosen];
  action.run(who);
  const t = THINK[action.surface];
  sleep(rand(t[0], t[1]));
}

// ── Summary ──
function fmt(v) {
  return v === undefined || v === null ? '-' : Math.round(v).toString();
}

/**
 * handleSummary: the JSON summary for the report (setup data, which holds
 * session tokens, is removed) and a short text summary on stdout.
 */
export function summarize(data) {
  const clean = Object.assign({}, data);
  delete clean.setup_data;
  // The offered load per role (k6 does not put the scenarios in the summary).
  clean.loadtest = {
    actors: CONFIG.actors,
    duration: CONFIG.duration,
    durationSeconds: PLANNED.durationS,
    plannedIterations: PLANNED.iterations,
    maxDropped: PLANNED.maxDropped,
    p95: CONFIG.p95,
    scenarios: Object.fromEntries(
      Object.entries(BUILT_SCENARIOS).map(([r, sc]) => [
        r,
        { ratePerMinute: sc.rate, maxVUs: sc.maxVUs },
      ]),
    ),
  };
  const lines = ['', 'StockPilot load test (local)', ''];
  for (const kind of [...KINDS, ...REPORTED_KINDS]) {
    const m = data.metrics[`http_req_duration{kind:${kind}}`];
    if (!m) continue;
    const v = m.values;
    const ok = m.thresholds ? Object.values(m.thresholds).every((t) => t.ok) : true;
    lines.push(
      `  ${kind.padEnd(13)} n=${fmt(v.count)} p50=${fmt(v.med)}ms p95=${fmt(v['p(95)'])}ms p99=${fmt(v['p(99)'])}ms ${ok ? 'ok' : 'OVER TARGET'}`,
    );
  }
  const counters = [
    'signin_redirects',
    'mfa_required',
    'scope_violations',
    'viewer_write_allowed',
    'replay_mismatch',
    'rate_limited',
    'orders_created',
    'orders_replayed',
    'receipts_created',
    'receipts_replayed',
    'adjust_up_ok',
    'adjust_down_ok',
    'dropped_iterations',
  ];
  for (const c of counters) {
    if (data.metrics[c]) lines.push(`  ${c.padEnd(22)} ${fmt(data.metrics[c].values.count)}`);
  }
  for (const w of COUNTED_WRITES) {
    const sent = data.metrics[`writes_sent{write:${w}}`];
    const answered = data.metrics[`writes_answered{write:${w}}`];
    const n = (sent ? sent.values.count : 0) - (answered ? answered.values.count : 0);
    if (n) lines.push(`  unanswered ${w.padEnd(11)} ${n}`);
  }
  for (const r of ['checks', 'auth_ok', 'http_req_failed']) {
    if (data.metrics[r])
      lines.push(`  ${r.padEnd(22)} ${(data.metrics[r].values.rate * 100).toFixed(2)}%`);
  }
  const failed = [];
  for (const [name, m] of Object.entries(data.metrics)) {
    if (m.thresholds)
      for (const [t, r] of Object.entries(m.thresholds)) if (!r.ok) failed.push(`${name}: ${t}`);
  }
  lines.push(
    '',
    failed.length
      ? `  FAILED thresholds:\n    ${failed.join('\n    ')}`
      : '  All thresholds passed.',
    '',
  );
  const out = { stdout: lines.join('\n') };
  if (__ENV.LOADTEST_SUMMARY_OUT) out[__ENV.LOADTEST_SUMMARY_OUT] = JSON.stringify(clean, null, 1);
  return out;
}
