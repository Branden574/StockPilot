import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  gateCalls,
  readRouteHandlers,
  ROUTE_METHODS,
  sessionReadersIn,
  type RouteHandler,
  type RouteMethod,
} from './route-write-handlers';

/**
 * Security invariant (docket S43a): no route handler serves a session that
 * still owes its authenticator code, except the reviewed ones listed here.
 *
 * withApiContext (lib/auth/api-context.ts) refuses an account with a verified
 * factor whose session is not aal2, right after the identity check, unless the
 * call passes `allowStepUpPending`. That covers a route only if the route builds
 * its context there. So, over every route file under src/app, read on the
 * syntax tree (a comment or a string naming a function is never a call):
 *
 *   1. every handler a route file exports (GET, HEAD, OPTIONS, POST, PUT,
 *      PATCH, DELETE) reaches withApiContext: directly, through the file's
 *      own functions, through a shared gate in GATE_MODULES (each hands it its
 *      own request: cookie-write-routes.guard.test.ts), or by re-exporting a
 *      handler that does. Or its file is listed with that method in one of:
 *        NON_SESSION  reads no session at all: webhooks, API keys, public
 *                     token links, health, version, password reset, the
 *                     analytics relay. Checked:
 *                     it imports no session reader and calls no session read
 *                     (getUser, getSession, getClaims, ...). Every route under
 *                     app/api/cron/ is held to the same checks as a folder
 *                     (CRON_DIR), for GET only;
 *        OWN_SESSION  builds its own principal from the cookie session: the
 *                     two OAuth callbacks. Checked: every listed handler calls
 *                     cookieSessionOwesStepUp (the same rule, exported from
 *                     lib/auth/api-context) and acts on its answer;
 *        AAL1_AUTH    an auth flow that must work before the code, because it
 *                     creates or ends the session. Checked: the cookie client
 *                     is the only session reader it imports;
 *   2. every listed entry is current: the file exists, exports exactly the
 *      listed methods, still reaches no gate, gives a reason, and is in one
 *      list only (a cron route in none);
 *   3. `allowStepUpPending` appears in no source file but lib/auth/api-context.ts
 *      and the routes on AAL1_ROUTES (which must work before the code), and
 *      every withApiContext call in such a route passes exactly
 *      `{ allowStepUpPending: true }`.
 *
 * The self-test at the bottom plants a violation of each rule, so this cannot
 * pass by reading nothing.
 */

const WEB_SRC = path.resolve(__dirname, '..');
const APP = path.join(WEB_SRC, 'app');
const ROUTE_FILE = /^route\.(ts|tsx|js|mjs)$/;
const SOURCE_FILE = /\.(ts|tsx|js|mjs)$/;

/** Where withApiContext and its opt-out are defined. */
const API_CONTEXT = 'lib/auth/api-context.ts';
const OPT_OUT = 'allowStepUpPending';

/** The step-up check a route that builds its own principal calls, by the module it comes from. */
const STEP_UP_CHECK: Readonly<Record<string, string>> = {
  cookieSessionOwesStepUp: 'lib/auth/api-context',
};

/** Calls that read or make a session, by method name, on any object. */
const SESSION_CALLS: ReadonlySet<string> = new Set([
  'getUser',
  'getSession',
  'getClaims',
  'getAuthenticatorAssuranceLevel',
  'exchangeCodeForSession',
  'verifyOtp',
  'setSession',
  'refreshSession',
]);

type NonSessionAuth =
  /** Authorization: Bearer <an operator secret>, refused when unset. */
  | 'admin secret'
  /** Authorization: Bearer sk_live_..., scoped (lib/auth/api-key.ts). */
  | 'API key'
  /** A provider's signature over the raw body. */
  | 'webhook signature'
  /** A token in the URL or the body that opens one record, with no session. */
  | 'public token'
  /** Nothing: public by design. */
  | 'none';

interface Listed {
  methods: RouteMethod[];
  reason: string;
}

interface NonSession extends Listed {
  auth: NonSessionAuth;
}

interface Lists {
  nonSession: Readonly<Record<string, NonSession>>;
  ownSession: Readonly<Record<string, Listed>>;
  aal1Auth: Readonly<Record<string, Listed>>;
  aal1Routes: Readonly<Record<string, { reason: string }>>;
}

/**
 * Every route file under app/api/cron/ is a Vercel Cron job: Authorization:
 * Bearer CRON_SECRET, refused without it, working with the service client. A
 * folder rule, not a list of names (21 files on 2026-11-01; and one of them may
 * not be named in code at all, no-request-path-prewarm.guard.test.ts). Each is
 * held to a NON_SESSION entry's checks: it exports GET only (what Vercel Cron
 * calls), reaches no gate, imports no session reader and calls no session read.
 */
const CRON_DIR = 'api/cron/';
const CRON_METHODS: RouteMethod[] = ['GET'];

/** Paths relative to src/app. Reviewed 2026-11-01 (docket S43a). */
const NON_SESSION: Record<string, NonSession> = {
  'api/admin/backfill-item-thumbs/route.ts': {
    methods: ['GET', 'POST'],
    auth: 'admin secret',
    reason:
      'An operator job behind Authorization: Bearer BACKFILL_ADMIN_SECRET (refused when unset). No browser or phone session reaches it.',
  },
  'api/admin/qa-recovery-link/route.ts': {
    methods: ['POST'],
    auth: 'admin secret',
    reason:
      'QA tooling behind the same BACKFILL_ADMIN_SECRET bearer, for an allowlist of demo addresses only. It reads no session.',
  },
  'api/appearance/style/route.ts': {
    methods: ['POST'],
    auth: 'none',
    reason:
      "Liquid Glass (REVISION-DEFAULT R6): sets only the caller's own sp_style cookie to a validated Design, for 400 days. Same-origin browser headers and x-sp-appearance required. No session, no database.",
  },
  'api/books/lookup/route.ts': {
    methods: ['GET'],
    auth: 'none',
    reason:
      'The public ISBN lookup: book metadata from public catalogues, limited per IP (fail closed). Nothing of any organization is read.',
  },
  'api/health/route.ts': {
    methods: ['GET'],
    auth: 'none',
    reason:
      'The uptime check: one row-less count with the anon key and no session, answering only whether the database answered.',
  },
  'api/public/v1/hooks/[id]/route.ts': {
    methods: ['DELETE'],
    auth: 'API key',
    reason:
      'The public API unsubscribes a webhook for an sk_live_ key, within its own organization. A key is not a member session.',
  },
  'api/public/v1/hooks/route.ts': {
    methods: ['GET', 'POST'],
    auth: 'API key',
    reason:
      'The public API lists and subscribes webhooks for an sk_live_ key with the webhooks:manage scope. A key is not a member session.',
  },
  'api/public/v1/items/route.ts': {
    methods: ['GET'],
    auth: 'API key',
    reason:
      'The public API lists items for an sk_live_ key with its read scope. A key is not a member session.',
  },
  'api/public/v1/orders/route.ts': {
    methods: ['GET'],
    auth: 'API key',
    reason:
      'The public API lists orders for an sk_live_ key with its read scope. A key is not a member session.',
  },
  'api/public/v1/purchase-orders/route.ts': {
    methods: ['GET'],
    auth: 'API key',
    reason:
      'The public API lists purchase orders for an sk_live_ key with its read scope. A key is not a member session.',
  },
  'api/v1/auth/password-reset/route.ts': {
    methods: ['POST'],
    auth: 'none',
    reason:
      "The phone's Forgot password: public by design, one answer for every address, limited per IP and per address. It reads no session.",
  },
  'api/v1/public/catalog-thumbnails/route.ts': {
    methods: ['GET'],
    auth: 'public token',
    reason:
      "The public order link's photos: the organization's link token opens one warehouse's orderable items, limited per IP, read with the service client.",
  },
  'api/v1/public/order-requests/[id]/location/route.ts': {
    methods: ['GET'],
    auth: 'public token',
    reason:
      "A requester's tracking link: the request's token, its id and the requester's address together open one delivery's location, limited per IP.",
  },
  'api/v1/public/order-requests/[id]/route.ts': {
    methods: ['GET'],
    auth: 'public token',
    reason:
      "A requester's tracking link: the request's token, its id and the requester's address together open one request's status, limited per IP.",
  },
  'api/v1/public/order-requests/route.ts': {
    methods: ['POST'],
    auth: 'public token',
    reason:
      "The public order link (/r/<token>): the organization's link token in the body, limited per IP, address and token, written with the service client.",
  },
  'api/v1/public/returns/options/route.ts': {
    methods: ['POST'],
    auth: 'public token',
    reason:
      "The return link's exchange sizes: the order's return token opens that one order, nothing is written.",
  },
  'api/v1/public/returns/route.ts': {
    methods: ['POST'],
    auth: 'public token',
    reason:
      "A requester's return link: the order's return token in the body opens that one order, limited per IP and per token.",
  },
  'api/version/route.ts': {
    methods: ['GET'],
    auth: 'none',
    reason:
      'Which build production is serving, as an opaque hash, for the update prompt. It reads no session and no organization data.',
  },
  'api/webhooks/easypost/route.ts': {
    methods: ['POST'],
    auth: 'webhook signature',
    reason:
      "EasyPost: an HMAC-SHA256 of the raw body under the connection's secret, compared in constant time before anything is changed.",
  },
  'api/webhooks/stripe/route.ts': {
    methods: ['POST'],
    auth: 'webhook signature',
    reason: 'Stripe: stripe.webhooks.constructEvent over the raw body with STRIPE_WEBHOOK_SECRET.',
  },
  'ingest/[...path]/route.ts': {
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    auth: 'none',
    reason:
      "PostHog's first-party relay (S34): it passes on only the requests the analytics SDK makes, never a cookie or a member credential, and every other method or path is refused here. It reads no session and no organization data.",
  },
  'm/[token]/photo/[n]/route.ts': {
    methods: ['GET'],
    auth: 'public token',
    reason:
      "A maintenance share link's photo: the link's token (stored as a hash) opens that one request's photos, limited per IP, read with the service client.",
  },
  'r/confirm/submit/route.ts': {
    methods: ['POST'],
    auth: 'public token',
    reason:
      "Confirms a public order request with the confirmation email's single-use token, checked by confirm_public_order_request with the service client.",
  },
  'unsubscribe/route.ts': {
    methods: ['GET', 'POST'],
    auth: 'public token',
    reason:
      "Unsubscribe with the address's HMAC token (and RFC 8058 one-click posts from mail providers). It reads no session.",
  },
};

/** Routes that build their own principal from the cookie session. Reviewed 2026-11-01. */
const OWN_SESSION: Record<string, Listed> = {
  'api/appearance/account/route.ts': {
    methods: ['POST'],
    reason:
      "Liquid Glass (reviewed 2026-11-11): reads the signed-in person's own Design and Theme row. It builds no organization context (a portal customer has none), so it validates the cookie session with getUser and asks cookieSessionOwesStepUp right after, answering 'unauthenticated' before the row is read.",
  },
  'api/integrations/quickbooks/callback/route.ts': {
    methods: ['GET'],
    reason:
      "QuickBooks' OAuth return: it validates the cookie session with getUser and writes the connection's tokens, so it asks cookieSessionOwesStepUp right after getUser and refuses with its 'forbidden' redirect before reading or exchanging anything.",
  },
  'api/integrations/sage_intacct/callback/route.ts': {
    methods: ['GET'],
    reason:
      "Sage Intacct's OAuth return, the QuickBooks callback's twin: the same check right after getUser, the same 'forbidden' redirect, before reading or exchanging anything.",
  },
};

/** Auth flows that must work before the code: they create or end the session. Reviewed 2026-11-01. */
const AAL1_AUTH: Record<string, Listed> = {
  'auth/callback/route.ts': {
    methods: ['GET'],
    reason:
      'Exchanges an auth code for a session and redirects. The session it makes is aal1 by definition; the dashboard layout then sends an enrolled member to /signin/mfa.',
  },
  'auth/confirm/route.ts': {
    methods: ['GET', 'POST'],
    reason:
      'The emailed reset, invite and email-change links: the single-use token makes the session (aal1). Its GET reads the session only to say which account the browser is signed in as, beside the account the link itself is for, which it looks up with the service client once the signed account reference the link carries (r, docket S25) checks out.',
  },
  'auth/session-ended/route.ts': {
    methods: ['GET'],
    reason:
      'Ends a session that no longer exists (sign-out, scope local) and clears its cookies. It reads only whether the session is live, and must work at any level.',
  },
};

/**
 * Routes whose withApiContext call passes allowStepUpPending: they must answer
 * before the code. Reviewed 2026-11-01; S5a's two phone notes joined 2026-11-02
 * (plans/S5.md). app/api/v1/auth/step-up-pending.test.ts serves each at aal1
 * through the real withApiContext; rules 1 and 3 here keep every other route
 * refusing.
 */
const AAL1_ROUTES: Record<string, { reason: string }> = {
  'api/client-error/route.ts': {
    reason:
      'The client crash beacon. app/error.tsx and app/global-error.tsx post to it from /signin/mfa too, so a crash on the code screen still reaches the error feed. It reads nothing of the organization: it forwards the report, keyed by the verified user and limited per user.',
  },
  'api/v1/auth/signed-in/route.ts': {
    reason:
      "The phone's sign-in note, sent right after the password and before the authenticator code, so a sign-in with a stolen password still writes its Audit log row and sends the new-device email. It accepts only a verified bearer token of the account itself, asks for no permission, and writes one row per session and the account's device note.",
  },
  'api/v1/auth/signed-out/route.ts': {
    reason:
      "The phone's sign-out note, sent while the session still exists, which can be aal1 for an account with an authenticator: it revokes the account's other sessions, which the Auth server's own logout and revoke_my_other_sessions already allow before the code, names them on the sessions channel, and writes one row per session. Bearer only, of the account itself.",
  },
};

const LISTS: Lists = {
  nonSession: NON_SESSION,
  ownSession: OWN_SESSION,
  aal1Auth: AAL1_AUTH,
  aal1Routes: AAL1_ROUTES,
};

/* ───────────────────────────── the reading ───────────────────────────── */

type Reading = { handlers: RouteHandler[]; unreadable: string[] };

/** apps/web/src-relative route file -> its reading. */
function readAll(sources: ReadonlyMap<string, string>): Map<string, Reading> {
  return new Map([...sources].map(([file, src]) => [file, readRouteHandlers(file, src)]));
}

/** Covered: reaches a gate, or re-exports a handler that does. */
function isCovered(
  handler: RouteHandler,
  readings: ReadonlyMap<string, Reading>,
  seen = new Set<string>(),
): boolean {
  if (handler.gates.length > 0) return true;
  if (!handler.reexport) return false;
  const key = `${handler.reexport.module}#${handler.reexport.name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const target = [...readings.keys()].find(
    (f) => f.replace(/\.(ts|tsx|js|mjs)$/, '') === handler.reexport!.module,
  );
  const targetHandler = target
    ? readings.get(target)!.handlers.find((h) => h.method === handler.reexport!.name)
    : undefined;
  return !!targetHandler && isCovered(targetHandler, readings, seen);
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Calls of a session read or write (SESSION_CALLS), by method name, as `file:line name`. */
function sessionCallsIn(fileName: string, source: string): string[] {
  const sf = parse(fileName, source);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : null;
      if (name && SESSION_CALLS.has(name)) {
        found.push(
          `${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${name}`,
        );
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Where the opt-out is written as code (an identifier or a string), not in a comment. */
function optOutsIn(fileName: string, source: string): number[] {
  if (!source.includes(OPT_OUT)) return [];
  const sf = parse(fileName, source);
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === OPT_OUT) {
      lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

const keyOf = (file: string) => file.replace(/^app\//, '');

function listedMethods(key: string, lists: Lists): RouteMethod[] {
  return [
    ...(key.startsWith(CRON_DIR) ? CRON_METHODS : []),
    ...(lists.nonSession[key]?.methods ?? []),
    ...(lists.ownSession[key]?.methods ?? []),
    ...(lists.aal1Auth[key]?.methods ?? []),
  ];
}

/** Rule 1: handlers that reach no gate and are not listed. */
function openHandlers(sources: ReadonlyMap<string, string>, lists: Lists): string[] {
  const readings = readAll(sources);
  const open: string[] = [];
  for (const [file, reading] of readings) {
    const listed = listedMethods(keyOf(file), lists);
    for (const handler of reading.handlers) {
      if (isCovered(handler, readings)) continue;
      if (listed.includes(handler.method)) continue;
      open.push(`${file} ${handler.method}`);
    }
  }
  return open.sort();
}

/** Rule 2: listed entries that are no longer true. */
function staleEntries(sources: ReadonlyMap<string, string>, lists: Lists): string[] {
  const readings = readAll(sources);
  const problems: string[] = [];
  const kinds = [
    ['NON_SESSION', lists.nonSession],
    ['OWN_SESSION', lists.ownSession],
    ['AAL1_AUTH', lists.aal1Auth],
  ] as const;

  const seenIn = new Map<string, string[]>();
  for (const [kind, list] of [...kinds, ['AAL1_ROUTES', lists.aal1Routes] as const]) {
    for (const key of Object.keys(list)) {
      seenIn.set(key, [...(seenIn.get(key) ?? []), kind]);
      if (key.startsWith(CRON_DIR)) {
        problems.push(`${kind} ${key}: under ${CRON_DIR}, which the folder rule holds`);
      }
    }
  }
  for (const [key, inLists] of seenIn) {
    if (inLists.length > 1) problems.push(`${key}: in more than one list (${inLists.join(', ')})`);
  }

  for (const [kind, list] of kinds) {
    for (const [key, entry] of Object.entries(list)) {
      const file = `app/${key}`;
      const source = sources.get(file);
      const reading = readings.get(file);
      if (source === undefined || !reading) {
        problems.push(`${kind} ${key}: no such route file`);
        continue;
      }
      if (entry.reason.length <= 40) problems.push(`${kind} ${key}: no reason given`);
      const exported = reading.handlers.map((h) => h.method).sort();
      if (exported.join() !== [...entry.methods].sort().join()) {
        problems.push(
          `${kind} ${key}: exports ${exported.join() || 'nothing'}, listed for ${entry.methods.join()}`,
        );
      }
      for (const h of reading.handlers) {
        if (isCovered(h, readings))
          problems.push(`${kind} ${key} ${h.method}: reaches a gate, so it leaves the list`);
      }

      if (kind === 'NON_SESSION') {
        for (const r of sessionReadersIn(file, source))
          problems.push(`${kind} ${key}: imports ${r}`);
        for (const c of sessionCallsIn(file, source)) problems.push(`${kind} ${key}: calls ${c}`);
      }
      if (kind === 'OWN_SESSION') {
        const checked = readRouteHandlers(file, source, STEP_UP_CHECK).handlers;
        for (const method of entry.methods) {
          const h = checked.find((x) => x.method === method);
          if (!h?.gates.includes('cookieSessionOwesStepUp')) {
            problems.push(`${kind} ${key} ${method}: does not call cookieSessionOwesStepUp`);
          }
        }
        for (const call of gateCalls(file, source, STEP_UP_CHECK)) {
          if (!call.resultKept && !call.resultTested) {
            problems.push(`${kind} ${file}:${call.line}: drops the step-up answer`);
          }
        }
      }
      if (kind === 'AAL1_AUTH') {
        const readers = sessionReadersIn(file, source);
        if (readers.join() !== 'createClient from @/lib/supabase/server') {
          problems.push(
            `${kind} ${key}: reads the session through ${readers.join(', ') || 'nothing'}`,
          );
        }
      }
    }
  }

  // The cron folder, held to a NON_SESSION entry's checks (CRON_DIR).
  for (const [file, source] of sources) {
    const key = keyOf(file);
    if (!key.startsWith(CRON_DIR)) continue;
    const reading = readings.get(file)!;
    const exported = reading.handlers.map((h) => h.method).sort();
    if (exported.join() !== CRON_METHODS.join()) {
      problems.push(
        `CRON ${key}: exports ${exported.join() || 'nothing'}, a cron job exports ${CRON_METHODS.join()}`,
      );
    }
    for (const h of reading.handlers) {
      if (isCovered(h, readings)) {
        problems.push(`CRON ${key} ${h.method}: reaches a gate, but a cron job reads no session`);
      }
    }
    for (const r of sessionReadersIn(file, source)) problems.push(`CRON ${key}: imports ${r}`);
    for (const c of sessionCallsIn(file, source)) problems.push(`CRON ${key}: calls ${c}`);
  }

  for (const [key, entry] of Object.entries(lists.aal1Routes)) {
    const file = `app/${key}`;
    const source = sources.get(file);
    const reading = readings.get(file);
    if (source === undefined || !reading) {
      problems.push(`AAL1_ROUTES ${key}: no such route file`);
      continue;
    }
    if (entry.reason.length <= 40) problems.push(`AAL1_ROUTES ${key}: no reason given`);
    const calls = gateCalls(file, source).filter((c) => c.gate === 'withApiContext');
    if (calls.length === 0) problems.push(`AAL1_ROUTES ${key}: calls withApiContext nowhere`);
    for (const call of calls) {
      if (call.options?.replace(/,\}$/, '}') !== `{${OPT_OUT}:true}`) {
        problems.push(
          `AAL1_ROUTES ${file}:${call.line}: withApiContext without { ${OPT_OUT}: true }`,
        );
      }
    }
  }
  return problems.sort();
}

/** Rule 3: the opt-out written anywhere but its definition and the reviewed routes. */
function optOutsOutsideTheList(sources: ReadonlyMap<string, string>, lists: Lists): string[] {
  const allowed = new Set([API_CONTEXT, ...Object.keys(lists.aal1Routes).map((k) => `app/${k}`)]);
  const found: string[] = [];
  for (const [file, source] of sources) {
    if (allowed.has(file)) continue;
    for (const line of optOutsIn(file, source)) found.push(`${file}:${line}`);
  }
  return found.sort();
}

/* ───────────────────────────── the real tree ───────────────────────────── */

function walk(dir: string, keep: (name: string, full: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(name, full)) out.push(full);
  }
  return out;
}

/** apps/web/src-relative, posix. */
const rel = (abs: string) => path.relative(WEB_SRC, abs).split(path.sep).join('/');

const ROUTES = new Map(
  walk(APP, (name) => ROUTE_FILE.test(name))
    .sort()
    .map((f) => [rel(f), readFileSync(f, 'utf8')] as const),
);

/** Every source file under src that ships: not a test, not the test helpers. */
const SHIPPED = new Map(
  walk(
    WEB_SRC,
    (name, full) =>
      SOURCE_FILE.test(name) && !name.includes('.test.') && !rel(full).startsWith('test/'),
  )
    .sort()
    .map((f) => [rel(f), readFileSync(f, 'utf8')] as const),
);

describe('every route handler is held to the step-up rule (docket S43a)', () => {
  it('scans a real tree', () => {
    // 228 route files on 2026-11-01, 6 of them outside app/api.
    expect(ROUTES.size).toBeGreaterThan(220);
    expect(
      [...ROUTES.keys()].filter((f) => !f.startsWith('app/api/')).length,
    ).toBeGreaterThanOrEqual(6);
    const handlers = [...readAll(ROUTES).values()].flatMap((r) => r.handlers);
    expect(handlers.length).toBeGreaterThan(240);
    // GETs are read too, not only the writes the cross-site guard reads.
    expect(handlers.filter((h) => h.method === 'GET').length).toBeGreaterThan(110);
    for (const known of [
      'app/api/v1/mobile/snapshot/route.ts',
      'app/api/v1/orders/[id]/route.ts',
      'app/api/inventory/export.csv/route.ts',
      'app/api/integrations/quickbooks/callback/route.ts',
      'app/auth/confirm/route.ts',
      'app/unsubscribe/route.ts',
    ]) {
      expect(ROUTES.has(known), known).toBe(true);
    }
    // The cron folder rule reads real files: 21 on 2026-11-01.
    expect([...ROUTES.keys()].filter((f) => keyOf(f).startsWith(CRON_DIR)).length).toBeGreaterThan(
      15,
    );
    expect(SHIPPED.has(API_CONTEXT)).toBe(true);
    expect(SHIPPED.size).toBeGreaterThan(1000);
  });

  it('reads every route file (no export shape it cannot follow)', () => {
    const unreadable = [...readAll(ROUTES)].flatMap(([file, r]) =>
      r.unreadable.map((u) => `${file}: ${u}`),
    );
    expect(unreadable).toEqual([]);
  });

  it('1. every handler reaches withApiContext, re-exports one that does, or is listed', () => {
    expect(openHandlers(ROUTES, LISTS)).toEqual([]);
  });

  it('2. every listed entry is current', () => {
    expect(staleEntries(ROUTES, LISTS)).toEqual([]);
  });

  it('3. the opt-out is written only in api-context.ts and the routes on AAL1_ROUTES', () => {
    expect(optOutsOutsideTheList(SHIPPED, LISTS)).toEqual([]);
    // And it is really there, where the list says.
    for (const key of Object.keys(AAL1_ROUTES)) {
      expect(optOutsIn(`app/${key}`, ROUTES.get(`app/${key}`)!).length, key).toBeGreaterThan(0);
    }
    expect(optOutsIn(API_CONTEXT, SHIPPED.get(API_CONTEXT)!).length).toBeGreaterThan(0);
  });

  it('the lists name every method a route file can export', () => {
    expect([...ROUTE_METHODS].sort()).toEqual([
      'DELETE',
      'GET',
      'HEAD',
      'OPTIONS',
      'PATCH',
      'POST',
      'PUT',
    ]);
  });
});

/* ───────────────────── self-test: each rule can fail ───────────────────── */

describe('self-test: a planted violation of each rule is reported', () => {
  const GATED = `import { withApiContext } from '@/lib/auth/api-context';
    export async function GET(req: Request) { const ctx = await withApiContext(req); return ctx; }`;
  const COOKIE_READ = `import { createClient } from '@/lib/supabase/server';
    export async function GET() { const s = await createClient(); return s.auth.getUser(); }`;
  const EMPTY: Lists = { nonSession: {}, ownSession: {}, aal1Auth: {}, aal1Routes: {} };
  const tree = (files: Record<string, string>) =>
    new Map(Object.entries(files).map(([k, v]) => [`app/${k}`, v]));

  it('1. an unlisted handler that reaches no gate is open; a comment naming the gate is not a call', () => {
    expect(
      openHandlers(
        tree({
          'api/a/route.ts': GATED,
          'api/b/route.ts': COOKIE_READ,
          'api/c/route.ts': `// withApiContext(req) is called elsewhere
            export async function GET(req: Request) { return 'withApiContext(req)'; }`,
          'api/d/route.ts': `export { GET } from '../a/route';`,
          'api/e/route.ts': `export async function HEAD() { return null; }
            export async function OPTIONS() { return null; }`,
        }),
        EMPTY,
      ),
    ).toEqual([
      'app/api/b/route.ts GET',
      'app/api/c/route.ts GET',
      'app/api/e/route.ts HEAD',
      'app/api/e/route.ts OPTIONS',
    ]);
  });

  it('1. listing a file covers only the methods it lists', () => {
    const lists: Lists = {
      ...EMPTY,
      nonSession: { 'api/b/route.ts': { methods: ['POST'], auth: 'none', reason: 'x'.repeat(41) } },
    };
    expect(openHandlers(tree({ 'api/b/route.ts': COOKIE_READ }), lists)).toEqual([
      'app/api/b/route.ts GET',
    ]);
  });

  it('2. a NON_SESSION entry that reads a session, a stale method list, a gated entry, a missing file and a double listing are reported', () => {
    const reason = 'x'.repeat(41);
    const problems = staleEntries(
      tree({
        'api/reads/route.ts': COOKIE_READ,
        'api/bearer/route.ts': `import { createClient } from '@supabase/supabase-js';
          export async function GET(req: Request) { return createClient('u', 'k').auth.getUser('t'); }`,
        'api/methods/route.ts': `export async function GET() { return null; }
          export async function POST() { return null; }`,
        'api/gated/route.ts': GATED,
      }),
      {
        ...EMPTY,
        nonSession: {
          'api/reads/route.ts': { methods: ['GET'], auth: 'none', reason },
          'api/bearer/route.ts': { methods: ['GET'], auth: 'none', reason },
          'api/methods/route.ts': { methods: ['GET'], auth: 'none', reason: 'short' },
          'api/gated/route.ts': { methods: ['GET'], auth: 'none', reason },
          'api/gone/route.ts': { methods: ['GET'], auth: 'none', reason },
        },
        aal1Auth: { 'api/methods/route.ts': { methods: ['GET', 'POST'], reason } },
      },
    );
    expect(problems).toEqual(
      [
        'NON_SESSION api/reads/route.ts: imports createClient from @/lib/supabase/server',
        'NON_SESSION api/reads/route.ts: calls app/api/reads/route.ts:2 getUser',
        'NON_SESSION api/bearer/route.ts: calls app/api/bearer/route.ts:2 getUser',
        'NON_SESSION api/methods/route.ts: no reason given',
        'NON_SESSION api/methods/route.ts: exports GET,POST, listed for GET',
        'NON_SESSION api/gated/route.ts GET: reaches a gate, so it leaves the list',
        'NON_SESSION api/gated/route.ts: imports withApiContext from @/lib/auth/api-context',
        'NON_SESSION api/gone/route.ts: no such route file',
        'api/methods/route.ts: in more than one list (NON_SESSION, AAL1_AUTH)',
        'AAL1_AUTH api/methods/route.ts: reads the session through nothing',
      ].sort(),
    );
  });

  it('2. an OWN_SESSION route without the step-up check, or one that drops its answer, is reported; an alias is followed', () => {
    const reason = 'x'.repeat(41);
    const own = (src: string) =>
      staleEntries(tree({ 'api/cb/route.ts': src }), {
        ...EMPTY,
        ownSession: { 'api/cb/route.ts': { methods: ['GET'], reason } },
      });
    const prelude = `import { createClient } from '@/lib/supabase/server';`;
    expect(
      own(`${prelude}
        export async function GET() { const s = await createClient(); const { data } = await s.auth.getUser(); return data; }`),
    ).toEqual(['OWN_SESSION api/cb/route.ts GET: does not call cookieSessionOwesStepUp']);
    expect(
      own(`${prelude}
        import { cookieSessionOwesStepUp } from '@/lib/auth/api-context';
        export async function GET() {
          const s = await createClient(); const { data } = await s.auth.getUser();
          await cookieSessionOwesStepUp(s, data.user);
          return data;
        }`),
    ).toEqual(['OWN_SESSION app/api/cb/route.ts:5: drops the step-up answer']);
    expect(
      own(`${prelude}
        import { cookieSessionOwesStepUp as owes } from '@/lib/auth/api-context';
        export async function GET() {
          const s = await createClient(); const { data } = await s.auth.getUser();
          if (await owes(s, data.user)) return 'forbidden';
          return data;
        }`),
    ).toEqual([]);
    // A namesake from another module is not the check.
    expect(
      own(`${prelude}
        import { cookieSessionOwesStepUp } from '@/lib/auth/not-the-rule';
        export async function GET() {
          const s = await createClient(); const { data } = await s.auth.getUser();
          if (await cookieSessionOwesStepUp(s, data.user)) return 'forbidden';
          return data;
        }`),
    ).toEqual(['OWN_SESSION api/cb/route.ts GET: does not call cookieSessionOwesStepUp']);
  });

  it('2. an AAL1_AUTH route that reads the session another way is reported', () => {
    const reason = 'x'.repeat(41);
    expect(
      staleEntries(
        tree({
          'auth/x/route.ts': `import { requireSession } from '@/lib/auth/session';
            export async function GET() { return requireSession(); }`,
        }),
        { ...EMPTY, aal1Auth: { 'auth/x/route.ts': { methods: ['GET'], reason } } },
      ),
    ).toEqual([
      'AAL1_AUTH auth/x/route.ts: reads the session through requireSession from @/lib/auth/session',
    ]);
  });

  it('1-2. the cron folder covers GET only; a cron route that reads a session, exports another method, or is also listed is reported', () => {
    const CRON_JOB = `export async function GET() { return new Response('ok'); }`;
    const files = tree({
      'api/cron/fine/route.ts': CRON_JOB,
      'api/cron/reads/route.ts': COOKIE_READ,
      'api/cron/methods/route.ts': `${CRON_JOB}
        export async function POST() { return null; }`,
      'api/cron/listed/route.ts': CRON_JOB,
      'api/elsewhere/route.ts': CRON_JOB,
    });
    const lists: Lists = {
      ...EMPTY,
      nonSession: {
        'api/cron/listed/route.ts': { methods: ['GET'], auth: 'none', reason: 'x'.repeat(41) },
      },
    };
    expect(openHandlers(files, lists)).toEqual([
      'app/api/cron/methods/route.ts POST',
      'app/api/elsewhere/route.ts GET',
    ]);
    expect(staleEntries(files, lists)).toEqual(
      [
        'CRON api/cron/reads/route.ts: imports createClient from @/lib/supabase/server',
        'CRON api/cron/reads/route.ts: calls app/api/cron/reads/route.ts:2 getUser',
        'CRON api/cron/methods/route.ts: exports GET,POST, a cron job exports GET',
        'NON_SESSION api/cron/listed/route.ts: under api/cron/, which the folder rule holds',
      ].sort(),
    );
    expect(staleEntries(tree({ 'api/cron/gated/route.ts': GATED }), EMPTY)).toEqual([
      'CRON api/cron/gated/route.ts GET: reaches a gate, but a cron job reads no session',
      'CRON api/cron/gated/route.ts: imports withApiContext from @/lib/auth/api-context',
    ]);
  });

  it('3. the opt-out outside the list is reported; a comment is not; an AAL1 route must pass it on every call', () => {
    const lists: Lists = {
      ...EMPTY,
      aal1Routes: { 'api/beacon/route.ts': { reason: 'x'.repeat(41) } },
    };
    expect(
      optOutsOutsideTheList(
        new Map([
          ['app/api/elsewhere/route.ts', `withApiContext(req, { allowStepUpPending: true });`],
          ['server/lib/opts.ts', `export const OPTS = { 'allowStepUpPending': true } as const;`],
          ['lib/note.ts', `// allowStepUpPending is only for the beacon\nexport const x = 1;`],
          ['app/api/beacon/route.ts', `withApiContext(req, { allowStepUpPending: true });`],
          [
            API_CONTEXT,
            `export function withApiContext(req?: Request, opts?: { allowStepUpPending?: true }) {}`,
          ],
        ]),
        lists,
      ),
    ).toEqual(['app/api/elsewhere/route.ts:1', 'server/lib/opts.ts:1']);

    const beacon = (body: string) =>
      staleEntries(
        tree({
          'api/beacon/route.ts': `import { withApiContext } from '@/lib/auth/api-context';
            export async function POST(req: Request) { ${body} }`,
        }),
        lists,
      );
    expect(
      beacon(`const ctx = await withApiContext(req, { allowStepUpPending: true }); return ctx;`),
    ).toEqual([]);
    expect(
      beacon(`const ctx = await withApiContext(req, {
        allowStepUpPending: true,
      }); return ctx;`),
    ).toEqual([]);
    expect(beacon(`const ctx = await withApiContext(req); return ctx;`)).toEqual([
      'AAL1_ROUTES app/api/beacon/route.ts:2: withApiContext without { allowStepUpPending: true }',
    ]);
    expect(
      beacon(
        `const ctx = await withApiContext(req, { allowStepUpPending: true, other: 1 }); return ctx;`,
      ),
    ).toEqual([
      'AAL1_ROUTES app/api/beacon/route.ts:2: withApiContext without { allowStepUpPending: true }',
    ]);
    expect(beacon(`return null;`)).toEqual([
      'AAL1_ROUTES api/beacon/route.ts: calls withApiContext nowhere',
    ]);
  });
});
