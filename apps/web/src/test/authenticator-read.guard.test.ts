import * as fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  apiRouteFiles,
  heldHandlers,
  isHeldByAskingRead,
  isHeldRead,
  OTHER_METHODS,
  parse,
  READ_CONTEXT,
  READ_GATES,
  READ_METHODS,
  readHandlersOf,
  REFUSAL,
  routeFilesOutsideScope,
  servedPath,
  servesV1,
  SHARED_GATES,
  shippedSources,
  unreadableExports,
  unreadableRouteFiles,
  WEB_SRC,
  type ReadHandler,
  type Sources,
} from './authenticator-read-tree';
import { buildCallGraph, shippedSourceFiles } from './gate-reach';
import {
  GATE_MODULES,
  importsOf,
  readRouteHandlers,
  resolveModule,
  sessionReadersIn,
} from './route-write-handlers';

/**
 * Security invariant: a member whose organization requires an authenticator
 * of their role, and who has none, reads no organization data through the
 * API. Every GET and HEAD handler under /api answers them 403 `forbidden`
 * with core's sentence and `details.reason: 'mfa_required'` (or, when their
 * organization's policy could not be read, the retryable 503 `check_failed`)
 * before it does anything else, or is listed here as open with its reason.
 * So does every POST, PUT, PATCH and DELETE under /api that writes nothing,
 * unless it is listed here with its reason. No endpoint served outside /api
 * builds a member context.
 *
 * How the answer is given. withApiContext (lib/auth/api-context.ts) labels a
 * context that owes set-up (core authenticatorSetUpOwed). The read wrapper
 * (server/lib/api-read-context.ts, apiReadContext) answers a GET or HEAD with
 * such a context, or any method its caller hands 'read', through
 * refuseSetUpOwedRead, and the returns routes' two shared gates call
 * refuseSetUpOwedRead themselves with their own `kind`. That module builds
 * the answer; nothing else in the web app uses its sentence.
 *
 * Read on the syntax tree (a comment or a string never counts), over every
 * shipped source file under apps/web/src (test/authenticator-read-tree.ts):
 *
 *   1. every GET and HEAD handler of a route file served under /api (route
 *      groups and slots left out of the address) reaches a read gate in a
 *      statement that always runs (`const x = await gate(...)`, `x = await
 *      gate(...)`, `return gate(...)`, an arrow's body; inside blocks and a
 *      `try` block only, never an `if`, a `?:`, a loop or a `catch`),
 *      following the file's own functions (a call to one counts only when
 *      that call is such a statement too) and the handler it re-exports from
 *      another route file. Otherwise its file is on OPEN_READS with a kind
 *      and a reason (the cron folder is open as a whole). A route file this reading cannot
 *      parse (route.js, .jsx, .mjs, .cjs) fails, and so does an export shape
 *      it cannot follow. Every OPEN_READS entry is current (the file exists,
 *      exports a GET, is not held), and an entry that says it reads no session
 *      imports no session reader and reaches no context gate;
 *   2. each shared gate in READ_GATES imports refuseSetUpOwedRead from the
 *      read module, calls it once, hands it its own `kind` parameter, keeps
 *      the answer and returns it at once (`if (x) return ...`), before any
 *      rate limit; apiReadContext hands it its `kind` too. A GET that reaches
 *      the API context gate, which gives no set-up answer, is on OPEN_READS;
 *   3. core's AUTHENTICATOR_SET_UP_OWED_COPY is used in the web app only by
 *      server/lib/api-read-context.ts: one place builds the answer;
 *   1b. a held handler (rule 1, or rule 4's 'read') calls nothing before its
 *      gate, in the order the code runs, awaited or not, in a `?:`, in the
 *      gate's own arguments, and builds no answer (`NextResponse.json(...)`,
 *      `new X(...)`), runs no tagged template and awaits no value that is
 *      not a call (its own route params aside), except exactly the calls its
 *      PRE_GATE entry lists: the reviewed checks of its own address and their
 *      400s. Every entry is current and has a reason;
 *   4. every POST, PUT, PATCH and DELETE handler under /api that the write
 *      reading (test/gate-reach.ts writeGate, as the write guard reads it)
 *      finds writing nothing hands a read gate 'read' as its first step, or is
 *      on OTHER_READS with the rule that holds it and a reason. Every entry is
 *      current (it exists, still writes nothing, is not held); a 'no-session'
 *      entry reads no session;
 *   5. no handler of a route file served outside /api reaches, through the
 *      call graph (test/gate-reach.ts), a function that builds a member
 *      context, and there is no file under pages/api. Every route file served
 *      outside /api, and every metadata file Next.js serves (opengraph-image,
 *      twitter-image, icon, apple-icon, sitemap, robots, manifest), is on
 *      OUTSIDE_ROUTES with its kind and a reason; an entry is current; a
 *      'sign-in' file calls no `.from(` and no `.rpc(` itself and reaches no
 *      function of a module that reads a table with the cookie client; a
 *      'token-link' or 'forwarder' file imports no session reader; a
 *      'metadata' file imports no session reader and no database client.
 *
 * WHAT IT IS NOT. It reads where the gate is, not what the handler does with
 * its answer: a handler that keeps the answer and goes on is caught by the
 * route sweep (app/api/v1/set-up-owed-reads.routes.test.ts), which calls every
 * held handler with recording clients (the service client, the cookie client
 * and `fetch`) and fails on any use before the answer. A read reached through
 * a getter on a plain property read, or a module's top-level code, is not a
 * step this reading sees.
 * Rule 5's call graph is gate-reach.ts's: it does not follow instance methods
 * (a service built from a context that was already resolved) or functions
 * held in variables, and a principal built by hand (the cookie client, then
 * a client keyed on its user) calls none of MEMBER_CONTEXT_BUILDERS; the
 * reviewed list makes a new route file outside /api fail until it is read and
 * listed.
 *
 * The self-test at the bottom plants a violation of each rule, so this cannot
 * pass by reading nothing.
 */

const COPY = 'AUTHENTICATOR_SET_UP_OWED_COPY';
const CRON_DIR = 'app/api/cron/';

/** The API context gate, which gives no set-up answer itself. */
const CONTEXT_GATE: Readonly<Record<string, string>> = {
  apiContextGate: 'server/lib/api-context-gate',
};

/**
 * Why a handler that is not held may stay open:
 *   - no-session: it reads no member session (a signed link or token, an
 *     organization API key, a secret, or nothing at all), so there is no
 *     member to hold. Checked: no session reader imported, no context gate
 *     reached;
 *   - own-account: the person's own account, which they may use before
 *     setting up an authenticator;
 *   - oauth-callback: an integration's OAuth return, which builds its own
 *     principal and refuses a session that has not met the policy itself
 *     (api-step-up.guard.test.ts holds it to cookieSessionMfaState);
 *   - service-gate (not a GET): it writes nothing, and its service asks the
 *     authenticator rule (assertPermission) before its first read;
 *   - no-org-data (not a GET): it reads no organization's data.
 */
type OpenKind = 'no-session' | 'own-account' | 'oauth-callback' | 'service-gate' | 'no-org-data';

interface Open {
  kind: OpenKind;
  reason: string;
}

/** The GET handlers under /api that are not held, by route file (apps/web/src relative). */
const OPEN_READS: Record<string, Open> = {
  'app/api/v1/account/email/route.ts': {
    kind: 'own-account',
    reason:
      "The member's own sign-in email and its pending change, read through the API context gate. It is the person's own account, which they may see before setting up an authenticator, as the website's profile page shows it.",
  },
  'app/api/v1/public/catalog-thumbnails/route.ts': {
    kind: 'no-session',
    reason:
      'Public catalog thumbnails behind a signed link: no session is read, so there is no member to hold.',
  },
  'app/api/v1/public/order-requests/[id]/route.ts': {
    kind: 'no-session',
    reason:
      "A requester's order status behind the order's own signed token: no session is read, so there is no member to hold.",
  },
  'app/api/v1/public/order-requests/[id]/location/route.ts': {
    kind: 'no-session',
    reason:
      "The delivery location for a requester's order behind the order's own signed token: no session is read, so there is no member to hold.",
  },
  'app/api/public/v1/hooks/route.ts': {
    kind: 'no-session',
    reason:
      "The public API, called with an organization's API key (authorizePublicApi): no member session is read, so there is no member to hold.",
  },
  'app/api/public/v1/items/route.ts': {
    kind: 'no-session',
    reason:
      "The public API, called with an organization's API key (authorizePublicApi): no member session is read, so there is no member to hold.",
  },
  'app/api/public/v1/orders/route.ts': {
    kind: 'no-session',
    reason:
      "The public API, called with an organization's API key (authorizePublicApi): no member session is read, so there is no member to hold.",
  },
  'app/api/public/v1/purchase-orders/route.ts': {
    kind: 'no-session',
    reason:
      "The public API, called with an organization's API key (authorizePublicApi): no member session is read, so there is no member to hold.",
  },
  'app/api/admin/backfill-item-thumbs/route.ts': {
    kind: 'no-session',
    reason:
      'An operator tool behind its own bearer secret (BACKFILL_ADMIN_SECRET); the GET says what the build accepts and reads no session.',
  },
  'app/api/books/lookup/route.ts': {
    kind: 'no-session',
    reason:
      'Book facts from public sources by ISBN, limited per address: no session is read and no organization data is served.',
  },
  'app/api/health/route.ts': {
    kind: 'no-session',
    reason: 'The health check for the host and monitors: no session is read and no data is served.',
  },
  'app/api/security/probe/[kind]/route.ts': {
    kind: 'no-session',
    reason:
      'The scanner-path answer: a plain 404 and an exploit event with no organization. No session is read, so there is no member to hold.',
  },
  'app/api/version/route.ts': {
    kind: 'no-session',
    reason:
      'The build the server is running, for the update prompt and the phone: no session is read and no organization data is served.',
  },
  'app/api/integrations/quickbooks/callback/route.ts': {
    kind: 'oauth-callback',
    reason:
      'The QuickBooks OAuth return: it builds its own principal from the cookie session and refuses a session that has not met the policy (cookieSessionMfaState), before it stores anything.',
  },
  'app/api/integrations/sage_intacct/callback/route.ts': {
    kind: 'oauth-callback',
    reason:
      'The Sage Intacct OAuth return: it builds its own principal from the cookie session and refuses a session that has not met the policy (cookieSessionMfaState), before it stores anything.',
  },
};

/** The cron folder is open as a whole: each job checks its own secret and reads no session. */
const CRON_OPEN: Open = {
  kind: 'no-session',
  reason: 'A scheduled job behind the cron secret: no member session is read.',
};

/**
 * The POST, PUT, PATCH and DELETE handlers under /api/v1 that write nothing
 * and are not held by the read answer, by `<route file> <METHOD>`.
 */
const OTHER_READS: Record<string, Open> = {
  'app/api/appearance/account/route.ts POST': {
    kind: 'own-account',
    reason:
      "Saves the caller's own appearance choice on their own account row; it reads and returns no organization data.",
  },
  'app/api/appearance/style/route.ts POST': {
    kind: 'no-session',
    reason:
      "Sets the browser's own appearance cookie from a same-origin page: no session is read and no organization data is served.",
  },
  'app/api/books/extract-isbns/route.ts POST': {
    kind: 'no-org-data',
    reason:
      "Reads ISBNs out of the caller's own uploaded file in memory; no organization's data is read or returned.",
  },
  'app/api/client-error/route.ts POST': {
    kind: 'no-org-data',
    reason:
      "The website's error beacon: it reports what the browser sent and returns no organization data.",
  },
  'app/api/v1/account/delete/code/route.ts POST': {
    kind: 'own-account',
    reason:
      "Emails the code that confirms deleting the caller's own account. Every member may delete their account, whatever the policy.",
  },
  'app/api/v1/ai/identify-from-photo/route.ts POST': {
    kind: 'no-org-data',
    reason:
      "Names a book or a product from the caller's own photo with the AI provider; it reads no organization's data and returns only what the model saw.",
  },
  'app/api/v1/public/returns/options/route.ts POST': {
    kind: 'no-session',
    reason:
      "The public return page's exchange sizes behind the order's own return token: no session is read, so there is no member to hold.",
  },
};

/**
 * What a held handler may do before its read gate, by `<route file> <METHOD>`
 * (the file whose code it is): every call it makes first, in the order it
 * runs, as written (whitespace collapsed). Each is a check of the request's
 * own address that reads nothing, with the 400 it answers. Anything else
 * before the gate (a read, a limiter, a call started and not awaited, a
 * cached answer) fails rule 1b.
 */
const PRE_GATE: Record<string, { calls: readonly string[]; reason: string }> = {
  'app/api/reports/[slug]/csv/route.ts GET': {
    calls: ['new URL(request.url)'],
    reason: 'Parses its own address into a URL; the query is read after the gate.',
  },
  'app/api/reports/[slug]/pdf/route.tsx GET': {
    calls: ['new URL(request.url)'],
    reason: 'Parses its own address into a URL; the query is read after the gate.',
  },
  'app/api/reports/item-cost-history/xlsx/route.ts GET': {
    calls: ['new URL(request.url)'],
    reason: 'Parses its own address into a URL; the query is read after the gate.',
  },
  'app/api/v1/items/[id]/barcode/route.ts GET': {
    calls: ['new URL(req.url)', "url.searchParams.get('type')", "url.searchParams.get('value')"],
    reason: 'Reads the requested barcode type and value from its own address; nothing else.',
  },
  'app/api/v1/orders/[id]/exchange-candidates/route.ts GET': {
    calls: [
      'UUID_RE.test(id)',
      "NextResponse.json( { error: 'validation_error', message: 'That order id is not valid.', details: { reason: 'return_invalid' } }, { status: 400, headers: NO_STORE }, )",
    ],
    reason: 'A malformed order id in its own address is the 400 before anything is read.',
  },
  'app/api/v1/returns/[id]/route.ts GET': {
    calls: ['invalidReturnId(id)'],
    reason:
      'A malformed return id in its own address is the 400 (invalidReturnId builds it, reading nothing).',
  },
  'app/api/v1/returns/[id]/candidates/route.ts GET': {
    calls: ['invalidReturnId(id)'],
    reason:
      'A malformed return id in its own address is the 400 (invalidReturnId builds it, reading nothing).',
  },
};

/* ───────────────────────────── rule 1: GET and HEAD ───────────────────────────── */

function openEntryFor(file: string, open: Record<string, Open>): Open | undefined {
  return open[file] ?? (file.startsWith(CRON_DIR) ? CRON_OPEN : undefined);
}

/** Does a handler reach any of `modules` (here, or for a re-export, nowhere this reading follows)? */
function reaches(file: string, src: string, modules: Readonly<Record<string, string>>): boolean {
  return readRouteHandlers(file, src, modules).handlers.some((h) => h.gates.length > 0);
}

/** A 'no-session' entry imports no session reader and reaches no context gate. */
function sessionFindings(key: string, file: string, src: string): string[] {
  const found = sessionReadersIn(file, src).map(
    (r) => `${key}: says it reads no session, but imports ${r}`,
  );
  if (reaches(file, src, GATE_MODULES)) {
    found.push(`${key}: says it reads no session, but reaches a context gate`);
  }
  return found;
}

function describeFirst(h: ReadHandler): string {
  if (h.first === null) {
    return h.from === null
      ? 'a re-export this reading cannot find'
      : 'not a function this reading can read';
  }
  if (h.first.gate) return `${h.first.gate} without 'read'`;
  return h.first.instead ?? '(none)';
}

/** Rule 1: GET and HEAD handlers under /api that are neither held nor listed, and stale entries. */
function openReadFindings(sources: Sources, open: Record<string, Open>): string[] {
  const found: string[] = [];
  for (const file of unreadableRouteFiles(sources)) {
    found.push(`${file}: a route file this guard does not read`);
  }
  for (const file of apiRouteFiles(sources)) {
    for (const u of unreadableExports(file, sources)) found.push(`${file}: cannot read ${u}`);
    const entry = openEntryFor(file, open);
    for (const h of readHandlersOf(file, sources, READ_METHODS)) {
      const held = isHeldRead(h);
      if (entry) {
        if (held) found.push(`${file} ${h.method}: is held, so it leaves OPEN_READS`);
      } else if (!held) {
        found.push(
          h.reaches
            ? `${file} ${h.method}: reaches a read gate, but its first step is ${describeFirst(h)}`
            : `${file} ${h.method}: calls none of ${Object.keys(READ_GATES).join(', ')} first and is not on OPEN_READS (first: ${describeFirst(h)})`,
        );
      }
    }
    if (entry?.kind === 'no-session')
      found.push(...sessionFindings(file, file, sources.get(file)!));
  }
  for (const [file, entry] of Object.entries(open)) {
    const src = sources.get(file);
    if (src === undefined) {
      found.push(`${file}: on OPEN_READS but not found`);
      continue;
    }
    if (readHandlersOf(file, sources, READ_METHODS).length === 0) {
      found.push(`${file}: on OPEN_READS but exports no GET`);
    }
    if (entry.kind === 'service-gate' || entry.kind === 'no-org-data') {
      found.push(`${file}: a GET is never open as ${entry.kind}`);
    }
    if (entry.reason.length <= 40) found.push(`${file}: no reason given`);
  }
  return found.sort();
}

/**
 * Rule 1b: every held handler (a GET or HEAD held first, or a handler by
 * another method that hands a read gate 'read') makes exactly the calls its
 * PRE_GATE entry lists before the gate, and every entry is current.
 */
function preGateFindings(
  sources: Sources,
  preGate: Record<string, { calls: readonly string[]; reason: string }>,
): string[] {
  const found: string[] = [];
  const used = new Set<string>();
  for (const file of apiRouteFiles(sources)) {
    const held = [
      ...readHandlersOf(file, sources, READ_METHODS).filter(isHeldRead),
      ...readHandlersOf(file, sources, OTHER_METHODS).filter(isHeldByAskingRead),
    ];
    for (const h of held) {
      const key = `${h.at} ${h.method}`;
      const before = h.first!.before;
      const entry = preGate[key];
      if (entry) used.add(key);
      const allowed = entry?.calls ?? [];
      if (JSON.stringify(before) !== JSON.stringify(allowed)) {
        found.push(
          `${key}: before its read gate it calls [${before.join(' | ')}], reviewed: [${allowed.join(' | ')}]`,
        );
      }
    }
  }
  for (const [key, entry] of Object.entries(preGate)) {
    if (!used.has(key)) found.push(`${key}: on PRE_GATE but not a held handler`);
    if (entry.reason.length <= 40) found.push(`${key}: no reason given`);
  }
  return [...new Set(found)].sort();
}

/**
 * Rule 5: an endpoint served outside /api (a route file elsewhere under app/)
 * builds no member context: no handler it exports reaches, through any chain
 * of calls the call graph follows (test/gate-reach.ts), a function that
 * builds one. Such a handler would be outside every rule above. Any file
 * under pages/api is a finding of its own.
 */
const MEMBER_CONTEXT_BUILDERS: readonly string[] = [
  'lib/auth/api-context.ts#withApiContext',
  'server/services/context.ts#withContext',
  'lib/auth/session.ts#requireOrgContext',
  'lib/auth/session.ts#requireOrgContextForLayout',
  'server/services/portal.ts#resolvePortalContext',
  'server/lib/api-read-context.ts#apiReadContext',
  'server/lib/api-context-gate.ts#apiContextGate',
];

/**
 * Why a route file is served outside /api, and what it may do:
 *   - sign-in: the sign-in machinery that must run before an authenticator
 *     exists. It uses the cookie client for the session itself (the user, a
 *     code exchange, an email code) and calls no `.from(` and no `.rpc(` in
 *     the file: no table or database function, so no organization data;
 *   - token-link: a link that carries its own signed or hashed token and
 *     reads no member session (no session reader imported);
 *   - forwarder: passes a request on to another service and reads no member
 *     session (no session reader imported);
 *   - metadata: a metadata file Next.js serves (an image, the manifest, the
 *     robots file, the sitemap); it imports no session reader and no
 *     database client at all.
 *
 * The sign-in check reads the file's own calls, and through the call graph
 * (graphOf) each function the handler reaches: no handler may reach a
 * function of a module that imports the cookie client
 * (`@/lib/supabase/server`) and calls `.from(` or `.rpc(` itself. A table
 * read through a client handed on by a parameter to a module that does not
 * import the cookie client, or through an instance method, is not seen
 * (the graph's limits, gate-reach.ts).
 */
type OutsideKind = 'sign-in' | 'token-link' | 'forwarder' | 'metadata';

/** Every route file served outside /api, by file (apps/web/src relative). */
const OUTSIDE_ROUTES: Record<string, { kind: OutsideKind; reason: string }> = {
  'app/auth/callback/route.ts': {
    kind: 'sign-in',
    reason:
      'The sign-in code exchange: the cookie client exchanges the code for a session and sends the browser on; no table is read.',
  },
  'app/auth/confirm/route.ts': {
    kind: 'sign-in',
    reason:
      "An email link's one-time code: the cookie client checks it and reads the account's own user; an email change is completed by its own service.",
  },
  'app/auth/session-ended/route.ts': {
    kind: 'sign-in',
    reason:
      "Clears the browser's session cookies after a sign-out elsewhere: the cookie client reads the user and signs out; no table is read.",
  },
  'app/ingest/[...path]/route.ts': {
    kind: 'forwarder',
    reason:
      "Forwards the website's product analytics to the analytics host; it reads no session and no database.",
  },
  'app/m/[token]/photo/[n]/route.ts': {
    kind: 'token-link',
    reason:
      "A maintenance request's photo behind the share link's hashed token, limited per address; no member session is read.",
  },
  'app/r/confirm/submit/route.ts': {
    kind: 'token-link',
    reason:
      "A requester confirms their order request with the request's own hashed token; no member session is read.",
  },
  'app/sign-in-alert/route.ts': {
    kind: 'token-link',
    reason:
      "A sign-in alert email's signed link: GET is counted per address before the alert is read, POST is limited per address and per alert; no member session is read.",
  },
  'app/unsubscribe/route.ts': {
    kind: 'token-link',
    reason:
      "An email's unsubscribe link behind its signed token, limited per address; no member session is read.",
  },
  'app/apple-icon.tsx': {
    kind: 'metadata',
    reason: 'The home-screen icon, drawn by next/og from fixed shapes; it reads nothing.',
  },
  'app/manifest.ts': {
    kind: 'metadata',
    reason: 'The web app manifest: fixed names, colours and icon addresses; it reads nothing.',
  },
  'app/opengraph-image.tsx': {
    kind: 'metadata',
    reason: 'The link preview image, drawn by next/og from fixed text; it reads nothing.',
  },
  'app/robots.ts': {
    kind: 'metadata',
    reason: 'The robots file: fixed allow and disallow rules and the sitemap address.',
  },
  'app/sitemap.ts': {
    kind: 'metadata',
    reason: 'The sitemap: the fixed public pages and their addresses; it reads nothing.',
  },
};

/** A database client a metadata file may not import. */
const DATABASE_CLIENT = /^(@\/lib\/supabase\/|@supabase\/)/;

/** The handlers of a route file, and a metadata file's default export. */
const HANDLER_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'default'];

/**
 * The call graph over every source, with every call counted. gate-reach.ts
 * leaves out a call inside a `try` whose `catch` keeps the error (its
 * question is whether a redirect gets out); here any call builds the
 * context, so each module is read the way it reads a 'use server' module,
 * where every call counts: the directive is put in front of each source for
 * this reading only.
 */
function graphOf(sources: Sources) {
  return buildCallGraph(
    [...sources].map(([rel, text]) => ({
      path: path.join(WEB_SRC, rel),
      text: `'use server';\n${text}`,
    })),
    WEB_SRC,
  );
}

function outsideScopeFindings(sources: Sources, graph = graphOf(sources)): string[] {
  const found: string[] = [];
  const abs = (key: string) => path.join(WEB_SRC, key);
  const reach = graph.reach(MEMBER_CONTEXT_BUILDERS.map(abs));
  for (const file of routeFilesOutsideScope(sources)) {
    if (file.startsWith('pages/api/')) {
      found.push(`${file}: a pages/api endpoint, outside every rule of this guard`);
      continue;
    }
    for (const method of HANDLER_METHODS) {
      const chain = reach.pathToTarget(abs(file), method);
      if (chain) {
        found.push(
          `${file} ${method}: served outside /api, but builds a member context (${chain.at(-1)})`,
        );
      }
    }
  }
  return found.sort();
}

/** The lines of `file` where a call to a property named `.from` or `.rpc` is made. */
function tableCallLines(file: string, src: string): number[] {
  const sf = parse(file, src);
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      (n.expression.name.text === 'from' || n.expression.name.text === 'rpc') &&
      // Buffer.from(...) and Array.from(...) build a value; they read no table.
      !(
        ts.isIdentifier(n.expression.expression) &&
        (n.expression.expression.text === 'Buffer' || n.expression.expression.text === 'Array')
      )
    ) {
      lines.push(lineOf(sf, n));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

/**
 * The functions (`<absolute file>#<name>`) of every module that imports the
 * cookie client and calls `.from(` or `.rpc(` in that function's own body:
 * the module's top-level functions, declared or held in a const.
 */
function cookieTableReaders(sources: Sources): string[] {
  const out: string[] = [];
  for (const [file, src] of sources) {
    if (!src.includes('@/lib/supabase/server')) continue;
    if (!importsOf(file, src).some((i) => i.specifier === '@/lib/supabase/server')) continue;
    const sf = parse(file, src);
    const fns: Array<[string, ts.Node]> = [];
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.body) fns.push([st.name.text, st.body]);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (
            ts.isIdentifier(d.name) &&
            d.initializer &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
          ) {
            fns.push([d.name.text, d.initializer.body]);
          }
        }
      }
    }
    for (const [name, body] of fns) {
      if (tableCallLines(file, body.getText(sf)).length > 0) {
        out.push(`${path.join(WEB_SRC, file)}#${name}`);
      }
    }
  }
  return out.sort();
}

/**
 * Rule 5's reviewed list: every route file served outside /api (and every
 * metadata file Next.js serves) is listed with its kind and a reason, every
 * entry is current, and each file keeps to its kind.
 */
function outsideListFindings(
  sources: Sources,
  listed: Record<string, { kind: OutsideKind; reason: string }>,
  graph?: ReturnType<typeof graphOf>,
): string[] {
  const found: string[] = [];
  const files = routeFilesOutsideScope(sources).filter((f) => !f.startsWith('pages/api/'));
  let readers: ReturnType<ReturnType<typeof graphOf>['reach']> | null = null;
  const tableReach = () =>
    (readers ??= (graph ?? graphOf(sources)).reach(cookieTableReaders(sources)));
  for (const file of files) {
    const entry = listed[file];
    if (!entry) {
      found.push(`${file}: served outside /api, but not on OUTSIDE_ROUTES`);
      continue;
    }
    const src = sources.get(file)!;
    if (entry.kind === 'sign-in') {
      for (const line of tableCallLines(file, src)) {
        found.push(`${file}: listed as sign-in, but calls .from( or .rpc( at line ${line}`);
      }
      for (const method of HANDLER_METHODS) {
        const chain = tableReach().pathToTarget(path.join(WEB_SRC, file), method);
        const end = chain?.at(-1) ?? '';
        // A read in the file itself is reported above, by line.
        if (chain && !end.startsWith(`${file}#`)) {
          found.push(
            `${file} ${method}: listed as sign-in, but reaches ${end}, which reads a table with the cookie client`,
          );
        }
      }
    } else if (entry.kind === 'metadata') {
      for (const r of sessionReadersIn(file, src)) {
        found.push(`${file}: listed as metadata, but imports ${r}`);
      }
      for (const i of importsOf(file, src)) {
        if (DATABASE_CLIENT.test(i.specifier)) {
          found.push(`${file}: listed as metadata, but imports ${i.specifier}`);
        }
      }
    } else {
      for (const r of sessionReadersIn(file, src)) {
        found.push(`${file}: listed as ${entry.kind}, but imports ${r}`);
      }
    }
  }
  for (const [key, entry] of Object.entries(listed)) {
    if (!files.includes(key)) found.push(`${key}: on OUTSIDE_ROUTES but no such route file`);
    if (entry.reason.length <= 40) found.push(`${key}: no reason given`);
  }
  return found.sort();
}

/* ──────────────────────────── rule 2: the shared gates ──────────────────────────── */

function lineOf(sf: ts.SourceFile, n: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}

/** The exported function `name` a file declares, or null. */
function exportedFunction(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body) return st;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          return d.initializer;
        }
      }
    }
  }
  return null;
}

function callsIn(fn: ts.Node, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return out;
}

/** `const x = refusal(...)` directly followed by `if (x) return ...;` in the same block. */
function answerReturnedAtOnce(call: ts.CallExpression): boolean {
  const decl = call.parent;
  if (!ts.isVariableDeclaration(decl) || decl.initializer !== call || !ts.isIdentifier(decl.name)) {
    return false;
  }
  const statement = decl.parent?.parent;
  if (!statement || !ts.isVariableStatement(statement)) return false;
  const block = statement.parent;
  if (!ts.isBlock(block)) return false;
  const next = block.statements[block.statements.indexOf(statement) + 1];
  if (!next || !ts.isIfStatement(next)) return false;
  const cond = next.expression;
  const leaves =
    ts.isReturnStatement(next.thenStatement) ||
    (ts.isBlock(next.thenStatement) &&
      next.thenStatement.statements.length === 1 &&
      ts.isReturnStatement(next.thenStatement.statements[0]!));
  return ts.isIdentifier(cond) && cond.text === decl.name.text && leaves;
}

/**
 * The refusal as a gate must call it: imported from the read module (or the
 * module's own), called once in the gate function, handed the gate's own
 * request and context, and its own `kind` parameter as the third argument.
 */
function gateCallFindings(
  label: string,
  file: string,
  src: string,
  gateName: string,
  ownModule: boolean,
): string[] {
  const found: string[] = [];
  const readModule = READ_CONTEXT.replace(/\.ts$/, '');
  if (!ownModule) {
    const imported = importsOf(file, src).some(
      ({ specifier, names }) =>
        names.includes(REFUSAL) && resolveModule(file, specifier) === readModule,
    );
    if (!imported) found.push(`${label}: does not import ${REFUSAL} from ${READ_CONTEXT}`);
  }
  const sf = parse(file, src);
  const fn = exportedFunction(sf, gateName);
  if (!fn) return [...found, `${label}: no exported function ${gateName}`];
  const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
  const kind = params.includes('kind') ? 'kind' : null;
  if (!kind) found.push(`${label}: ${gateName} takes no \`kind\``);
  const refusals = callsIn(fn, REFUSAL);
  if (refusals.length !== 1) {
    found.push(`${label}: ${gateName} calls ${REFUSAL} ${refusals.length} times, not once`);
    return found;
  }
  const call = refusals[0]!;
  const arg = (i: number) => {
    const a = call.arguments[i];
    return a && ts.isIdentifier(a) ? a.text : null;
  };
  if (arg(0) !== params[0])
    found.push(`${label}:${lineOf(sf, call)}: ${REFUSAL} is not handed the gate's own request`);
  if (kind && arg(2) !== kind) {
    found.push(`${label}:${lineOf(sf, call)}: ${REFUSAL} is not handed the gate's own \`kind\``);
  }
  if (!ownModule && !answerReturnedAtOnce(call)) {
    found.push(`${label}:${lineOf(sf, call)}: the answer of ${REFUSAL} is not returned at once`);
  }
  const limits = callsIn(fn, 'checkRateLimit');
  if (limits.some((l) => l.getStart(sf) < call.getStart(sf))) {
    found.push(`${label}:${lineOf(sf, call)}: a rate limit comes before ${REFUSAL}`);
  }
  return found;
}

/** Rule 2: the shared gates and the wrapper answer; a GET through the API context gate is listed. */
function answerFindings(sources: Sources, open: Record<string, Open>): string[] {
  const found: string[] = [];
  for (const { name, file } of SHARED_GATES) {
    const src = sources.get(file);
    if (src === undefined) found.push(`${file}: not found`);
    else found.push(...gateCallFindings(file, file, src, name, false));
  }
  const own = sources.get(READ_CONTEXT);
  if (own === undefined) found.push(`${READ_CONTEXT}: not found`);
  else found.push(...gateCallFindings(READ_CONTEXT, READ_CONTEXT, own, 'apiReadContext', true));
  for (const file of apiRouteFiles(sources)) {
    const src = sources.get(file)!;
    for (const h of readRouteHandlers(file, src, CONTEXT_GATE).handlers) {
      if (!READ_METHODS.includes(h.method) || h.gates.length === 0) continue;
      if (open[file] === undefined) {
        found.push(
          `${file} ${h.method}: reaches apiContextGate, which gives no set-up answer, and is not on OPEN_READS`,
        );
      }
    }
  }
  return found.sort();
}

/* ─────────────────────────────── rule 3: the sentence ─────────────────────────────── */

/** The lines where `name` is written as code (an identifier), never in a comment or a string. */
function codeUses(file: string, src: string, name: string): number[] {
  const sf = parse(file, src);
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name) lines.push(lineOf(sf, n));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

/** Rule 3: core's sentence used outside the module that builds the answer. */
function copyFindings(sources: Sources): string[] {
  const found: string[] = [];
  for (const [file, src] of sources) {
    if (file === READ_CONTEXT || !/\.(ts|tsx)$/.test(file)) continue;
    for (const line of codeUses(file, src, COPY)) found.push(`${file}:${line} uses ${COPY}`);
  }
  const own = sources.get(READ_CONTEXT);
  if (own === undefined || codeUses(READ_CONTEXT, own, COPY).length === 0) {
    found.push(`${READ_CONTEXT}: does not build the answer from ${COPY}`);
  }
  return found.sort();
}

/* ───────────────────────── rule 4: reads by another method ───────────────────────── */

/** Does the write reading find the handler writing? Null when it cannot read it as one function. */
type WritesOf = (file: string, method: string) => boolean | null;

/** Rule 4: handlers by another method that write nothing, are not held and are not listed; stale entries. */
function otherReadFindings(
  sources: Sources,
  writesOf: WritesOf,
  open: Record<string, Open>,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const file of apiRouteFiles(sources)) {
    for (const h of readHandlersOf(file, sources, OTHER_METHODS)) {
      const key = `${file} ${h.method}`;
      seen.add(key);
      const writes = writesOf(file, h.method);
      const held = isHeldByAskingRead(h);
      const entry = open[key];
      if (entry) {
        if (held) found.push(`${key}: is held, so it leaves OTHER_READS`);
        else if (writes !== false)
          found.push(`${key}: writes (or cannot be read), so it leaves OTHER_READS`);
        if (entry.kind === 'no-session')
          found.push(...sessionFindings(key, file, sources.get(file)!));
        if (entry.reason.length <= 40) found.push(`${key}: no reason given`);
      } else if (writes === false && !held) {
        found.push(
          `${key}: writes nothing, so it is a read: hand a read gate 'read' as its first step (first: ${describeFirst(h)}), or list it on OTHER_READS`,
        );
      }
    }
  }
  for (const key of Object.keys(open)) {
    if (!seen.has(key)) found.push(`${key}: on OTHER_READS but no such handler`);
  }
  return found.sort();
}

/* ───────────────────────────── the real tree ───────────────────────────── */

const MIGRATIONS = path.resolve(WEB_SRC, '../../../supabase/migrations');

/**
 * The RPCs whose latest definition is STABLE or IMMUTABLE, read as the write
 * guard reads them (authenticator-write.guard.test.ts readOnlyFunctions).
 */
function readOnlyRpcs(): Set<string> {
  const latest = new Map<string, string>();
  for (const name of fs
    .readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    const text = fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const rest = text.slice(m.index);
      const body = /\bas\s+(\$[a-z0-9_]*\$)/i.exec(rest);
      if (!body) continue;
      const tag = body[1]!;
      const bodyStart = body.index + body[0].length;
      const bodyEnd = rest.indexOf(tag, bodyStart);
      if (bodyEnd < 0) continue;
      const tailEnd = rest.indexOf(';', bodyEnd + tag.length);
      latest.set(
        m[1]!.toLowerCase(),
        `${rest.slice(0, body.index)} ${rest.slice(bodyEnd + tag.length, tailEnd < 0 ? undefined : tailEnd)}`,
      );
    }
  }
  return new Set(
    [...latest].filter(([, attrs]) => /\b(stable|immutable)\b/i.test(attrs)).map(([n]) => n),
  );
}

/** The write guard's own reading of "writes nothing" (its NOT_WRITES, no gates: any write counts). */
function realWritesOf(): WritesOf {
  const graph = buildCallGraph(shippedSourceFiles(WEB_SRC, fs), WEB_SRC);
  const abs = (key: string) => {
    const at = key.indexOf('#');
    return `${path.join(WEB_SRC, key.slice(0, at))}#${key.slice(at + 1)}`;
  };
  const gate = graph.writeGate({
    gates: [],
    readRpcs: readOnlyRpcs(),
    notWrites: ['lib/rate-limit.ts#checkRateLimit', 'lib/books/lookup.ts#writeBookCache'].map(abs),
  });
  return (file, method) => gate.exportVerdict(path.join(WEB_SRC, file), method)?.writes ?? null;
}

const SHIPPED = shippedSources();
let SHIPPED_GRAPH: ReturnType<typeof graphOf> | null = null;
/** The call graph over the shipped tree, built once for the rule 5 tests. */
const shippedGraph = () => (SHIPPED_GRAPH ??= graphOf(SHIPPED));
const SCAN = { timeout: 120_000 };

describe('every API read holds a member who must set up an authenticator first', () => {
  it('scans a real tree', () => {
    expect(SHIPPED.size).toBeGreaterThan(1000);
    const files = apiRouteFiles(SHIPPED);
    expect(files.filter(servesV1).length).toBeGreaterThan(150);
    expect(files.length).toBeGreaterThan(files.filter(servesV1).length + 50);
    expect(files).toContain('app/api/v1/reports/book-order-totals/export/route.tsx');
    expect(files).toContain('app/api/v1/mobile/snapshot/route.ts');
    expect(files).toContain('app/api/items/search/route.ts');
    expect(files).toContain('app/api/cron/drain-outbox/route.ts');
    const gets = files.flatMap((f) => readHandlersOf(f, SHIPPED, READ_METHODS));
    // 113 GET handlers under /api on 2026-11-16: 58 under /api/v1.
    expect(gets.length).toBeGreaterThan(100);
    expect(gets.filter(isHeldRead).length).toBeGreaterThan(75);
    expect(servedPath('app/(x)/api/v1/y/route.ts')).toBe('api/v1/y');
    const held = heldHandlers(SHIPPED);
    expect(held).toContain('v1/orders/signature-lookup POST');
    expect(held).toContain('ai/chat POST');
    expect(held).toContain('inventory/export POST');
    expect(held).toContain('inventory/export/preview POST');
    // The endpoints served outside /api are read for rule 5.
    expect(routeFilesOutsideScope(SHIPPED)).toContain('app/auth/callback/route.ts');
    expect(routeFilesOutsideScope(SHIPPED)).not.toContain('app/api/health/route.ts');
  });

  it('1. every GET handler under /api is held first or listed as open, and every listed one is current', () => {
    expect(openReadFindings(SHIPPED, OPEN_READS)).toEqual([]);
  });

  it('1b. a held handler does nothing before its gate but the reviewed checks of its own address', () => {
    expect(preGateFindings(SHIPPED, PRE_GATE)).toEqual([]);
  });

  it('2. the shared gates and the wrapper give the answer with their own kind; a GET through the API context gate is listed', () => {
    expect(answerFindings(SHIPPED, OPEN_READS)).toEqual([]);
  });

  it("3. core's set-up sentence is used in the web app only where the answer is built", () => {
    expect(copyFindings(SHIPPED)).toEqual([]);
  });

  it(
    '4. every /api handler by another method that writes nothing is held as a read or listed with its rule',
    SCAN,
    () => {
      const writesOf = realWritesOf();
      // The reading reads real handlers: a write writes, a lookup does not.
      expect(writesOf('app/api/v1/orders/[id]/return-request/route.ts', 'POST')).toBe(true);
      expect(writesOf('app/api/v1/orders/signature-lookup/route.ts', 'POST')).toBe(false);
      expect(writesOf('app/api/inventory/export/preview/route.ts', 'POST')).toBe(false);
      expect(otherReadFindings(SHIPPED, writesOf, OTHER_READS)).toEqual([]);
    },
  );

  it('5. no endpoint served outside /api builds a member context', SCAN, () => {
    const graph = shippedGraph();
    // The reading follows real chains: an /api handler that builds one is seen.
    const reach = graph.reach(MEMBER_CONTEXT_BUILDERS.map((k) => path.join(WEB_SRC, k)));
    expect(
      reach.pathToTarget(path.join(WEB_SRC, 'app/api/v1/items/route.ts'), 'POST'),
    ).not.toBeNull();
    expect(
      reach.pathToTarget(path.join(WEB_SRC, 'app/api/reports/[slug]/csv/route.ts'), 'GET'),
    ).not.toBeNull();
    expect(outsideScopeFindings(SHIPPED, graph)).toEqual([]);
  });

  it(
    '5. every route file served outside /api is on the reviewed list and keeps to its kind',
    SCAN,
    () => {
      expect(Object.keys(OUTSIDE_ROUTES).length).toBeGreaterThan(0);
      // The metadata files Next.js serves are read too.
      expect(routeFilesOutsideScope(SHIPPED)).toContain('app/opengraph-image.tsx');
      // The sign-in reading follows real chains: the cookie client's table readers are found.
      expect(cookieTableReaders(SHIPPED).length).toBeGreaterThan(0);
      expect(outsideListFindings(SHIPPED, OUTSIDE_ROUTES, shippedGraph())).toEqual([]);
    },
  );
});

/* ───────────────────── self-test: each rule can fail ───────────────────── */

describe('self-test: a planted violation of each rule is reported', () => {
  const READ_WRAPPER = `import { withApiContext } from '@/lib/auth/api-context';
    import { AUTHENTICATOR_SET_UP_OWED_COPY } from '@stockpilot/core';
    export function refuseSetUpOwedRead(req: Request, ctx: unknown, kind?: string) { return req && ctx && kind ? AUTHENTICATOR_SET_UP_OWED_COPY : null; }
    export async function apiReadContext(req: Request, kind?: 'read') {
      const ctx = await withApiContext(req);
      const refused = refuseSetUpOwedRead(req, ctx, kind);
      return refused ? { response: 1 } : { ctx };
    }`;
  const shared = (
    gate: string,
    extra = '',
  ) => `import { refuseSetUpOwedRead } from '@/server/lib/api-read-context';
    import { withApiContext } from '@/lib/auth/api-context';
    import { checkRateLimit } from '@/lib/rate-limit';
    export async function ${gate}(req: Request, ${extra}kind: 'read' | 'write') {
      const ctx = await withApiContext(req);
      const setUpOwed = refuseSetUpOwedRead(req, ctx, kind);
      if (setUpOwed) return { response: setUpOwed };
      await checkRateLimit(kind, 1, 1);
      return { ctx };
    }`;
  const HELD_ROUTE = `import { apiReadContext } from '@/server/lib/api-read-context';
    export async function GET(req: Request) { const read = await apiReadContext(req); return read; }`;
  const PLAIN = `import { withApiContext } from '@/lib/auth/api-context';
    export async function GET(req: Request) { return withApiContext(req); }`;
  const base = (extra: Record<string, string>) =>
    new Map<string, string>(
      Object.entries({
        [READ_CONTEXT]: READ_WRAPPER,
        'app/api/v1/returns/http.ts': shared('returnsContext'),
        'app/api/v1/orders/[id]/return-request/http.ts': shared(
          'memberRequesterGate',
          'params: unknown, ',
        ),
        ...extra,
      }),
    );
  const open = (reason: string, kind: OpenKind = 'own-account'): Open => ({ kind, reason });

  it('1. not held, held late, a namesake, a re-export of an open or missing handler, unread shapes, stale entries', () => {
    const tree = base({
      'app/api/v1/held/route.ts': HELD_ROUTE,
      'app/api/v1/plain/route.ts': PLAIN,
      'app/api/v1/late/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        import { createAdminClient } from '@/lib/supabase/admin';
        export async function GET(req: Request) {
          const { id } = await (req as unknown as { params: Promise<{ id: string }> }).params;
          await createAdminClient().from('items').select('id').eq('id', id);
          const read = await apiReadContext(req);
          return read;
        }`,
      'app/api/v1/after-params/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
          const { id } = await params;
          const url = new URL(req.url);
          const read = await apiReadContext(req);
          return [read, id, url];
        }`,
      'app/api/v1/answer-first/route.ts': `import { NextResponse } from 'next/server';
        import { apiReadContext } from '@/server/lib/api-read-context';
        export async function GET(req: Request) {
          if (!req.url) return NextResponse.json({ error: 'validation_error' }, { status: 400 });
          const read = await apiReadContext(req);
          return read;
        }`,
      'app/api/v1/read-in-answer/route.ts': `import { NextResponse } from 'next/server';
        import { apiReadContext } from '@/server/lib/api-read-context';
        import { loadItems } from '@/server/lib/items';
        export async function GET(req: Request) {
          if (!req.url) return NextResponse.json(await loadItems(), { status: 200 });
          const read = await apiReadContext(req);
          return read;
        }`,
      'app/api/v1/local-in-if/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        async function load(req: Request) { return apiReadContext(req); }
        export async function GET(req: Request) { if (req.url) return load(req); return null; }`,
      'app/api/v1/gate-in-ternary/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        export async function GET(req: Request) { const read = req.url ? await apiReadContext(req) : null; return read; }`,
      'app/api/v1/namesake/route.ts': `async function apiReadContext(req: Request) { return req; }
        export async function GET(req: Request) { return apiReadContext(req); }`,
      'app/api/v1/through-local/route.ts': `import { returnsContext } from '../returns/http';
        async function load(req: Request) { return returnsContext(req, 'read'); }
        export const GET = (req: Request) => load(req);`,
      'app/api/v1/reexport/route.ts': `export { GET } from '../held/route';`,
      'app/api/v1/reexport-plain/route.ts': `export { GET } from '../plain/route';`,
      'app/api/v1/reexport-missing/route.ts': `export { GET } from '../gone/route';`,
      'app/api/v1/reexport-loop/route.ts': `export { GET } from './route';`,
      'app/api/elsewhere/route.ts': HELD_ROUTE,
      'app/api/not-v1/route.ts': PLAIN,
      'app/(group)/api/v1/grouped/route.ts': PLAIN,
      'app/dashboard/page-data/route.ts': PLAIN,
      'app/api/v1/as-jsx/route.jsx': HELD_ROUTE,
      'app/api/v1/star/route.ts': `export * from '../held/route';`,
      'app/api/v1/listed-but-held/route.ts': HELD_ROUTE,
      'app/api/v1/listed-no-get/route.ts': `export async function POST() { return null; }`,
      'app/api/v1/listed-reads-session/route.ts': PLAIN,
      'app/api/v1/listed-as-service-gate/route.ts': PLAIN,
      'app/api/cron/job/route.ts': `import { createClient } from '@/lib/supabase/server';
        export async function GET() { return createClient(); }`,
      'app/api/v1/write-only/route.ts': `export async function POST() { return null; }`,
    });
    expect(
      openReadFindings(tree, {
        'app/api/v1/listed-but-held/route.ts': open('x'.repeat(50)),
        'app/api/v1/listed-no-get/route.ts': open('short'),
        'app/api/v1/listed-reads-session/route.ts': open('x'.repeat(50), 'no-session'),
        'app/api/v1/listed-as-service-gate/route.ts': open('x'.repeat(50), 'service-gate'),
        'app/api/v1/missing/route.ts': open('x'.repeat(50)),
      }),
    ).toEqual(
      [
        'app/(group)/api/v1/grouped/route.ts GET: calls none of apiReadContext, returnsContext, memberRequesterGate first and is not on OPEN_READS (first: withApiContext(req))',
        'app/api/cron/job/route.ts: says it reads no session, but imports createClient from @/lib/supabase/server',
        'app/api/not-v1/route.ts GET: calls none of apiReadContext, returnsContext, memberRequesterGate first and is not on OPEN_READS (first: withApiContext(req))',
        'app/api/v1/as-jsx/route.jsx: a route file this guard does not read',
        'app/api/v1/listed-as-service-gate/route.ts: a GET is never open as service-gate',
        'app/api/v1/listed-but-held/route.ts GET: is held, so it leaves OPEN_READS',
        'app/api/v1/listed-no-get/route.ts: no reason given',
        'app/api/v1/listed-no-get/route.ts: on OPEN_READS but exports no GET',
        'app/api/v1/listed-reads-session/route.ts: says it reads no session, but imports withApiContext from @/lib/auth/api-context',
        'app/api/v1/listed-reads-session/route.ts: says it reads no session, but reaches a context gate',
        'app/api/v1/missing/route.ts: on OPEN_READS but not found',
        'app/api/v1/namesake/route.ts GET: calls none of apiReadContext, returnsContext, memberRequesterGate first and is not on OPEN_READS (first: (no call))',
        'app/api/v1/local-in-if/route.ts GET: reaches a read gate, but its first step is load(req)',
        'app/api/v1/gate-in-ternary/route.ts GET: reaches a read gate, but its first step is apiReadContext(req)',
        'app/api/v1/plain/route.ts GET: calls none of apiReadContext, returnsContext, memberRequesterGate first and is not on OPEN_READS (first: withApiContext(req))',
        'app/api/v1/reexport-loop/route.ts GET: calls none of apiReadContext, returnsContext, memberRequesterGate first and is not on OPEN_READS (first: not a function this reading can read)',
        'app/api/v1/reexport-missing/route.ts GET: calls none of apiReadContext, returnsContext, memberRequesterGate first and is not on OPEN_READS (first: a re-export this reading cannot find)',
        'app/api/v1/reexport-plain/route.ts GET: calls none of apiReadContext, returnsContext, memberRequesterGate first and is not on OPEN_READS (first: withApiContext(req))',
        'app/api/v1/star/route.ts: cannot read export * from ../held/route',
      ].sort(),
    );
    // The held shapes, the derived list the sweep calls, and an address outside /api.
    expect(heldHandlers(tree)).toEqual([
      'elsewhere GET',
      'v1/after-params GET',
      'v1/answer-first GET',
      'v1/held GET',
      'v1/late GET',
      'v1/listed-but-held GET',
      'v1/read-in-answer GET',
      'v1/reexport GET',
      'v1/through-local GET',
    ]);
  });

  it("1b. work before the gate: late, not awaited, in a ternary, in the gate's arguments, an answer first, a tagged template, an awaited value; the reviewed list current", () => {
    const tree = base({
      'app/api/v1/tagged/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        import { sql } from '@/server/lib/sql';
        export async function GET(req: Request) {
          await sql\`select id from items\`;
          const read = await apiReadContext(req);
          return read;
        }`,
      'app/api/v1/awaited-value/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        import { loadItems } from '@/server/lib/items';
        const warm = loadItems();
        export async function GET(req: Request) {
          await warm;
          const read = await apiReadContext(req);
          return read;
        }`,
      'app/api/v1/awaited-property/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        import { store } from '@/server/lib/items';
        export async function GET(req: Request) {
          const rows = await store.rows;
          const read = await apiReadContext(req);
          return [read, rows];
        }`,
      'app/api/v1/params-first/[id]/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
          const { id } = await params;
          const read = await apiReadContext(req);
          return [read, id];
        }`,
      'app/api/v1/context-params-first/[id]/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
          const { id } = await context.params;
          const read = await apiReadContext(req);
          return [read, id];
        }`,
      'app/api/v1/held/route.ts': HELD_ROUTE,
      'app/api/v1/late/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        import { createAdminClient } from '@/lib/supabase/admin';
        export async function GET(req: Request) {
          await createAdminClient().from('items').select('id');
          const read = await apiReadContext(req);
          return read;
        }`,
      'app/api/v1/not-awaited/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        import { warm } from '@/server/lib/items';
        export async function GET(req: Request) { void warm(req); const read = await apiReadContext(req); return read; }`,
      'app/api/v1/in-ternary/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        import { loadItems } from '@/server/lib/items';
        export async function GET(req: Request) {
          const items = req.url ? await loadItems() : null;
          const read = await apiReadContext(req);
          return [read, items];
        }`,
      'app/api/v1/in-arguments/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        import { loadItems } from '@/server/lib/items';
        export async function POST(req: Request) { const read = await apiReadContext((await loadItems()) as Request, 'read'); return read; }`,
      'app/api/v1/answer-first/route.ts': `import { NextResponse } from 'next/server';
        import { apiReadContext } from '@/server/lib/api-read-context';
        export async function GET(req: Request) {
          if (!req.url) return NextResponse.json({ error: 'validation_error' }, { status: 400 });
          const read = await apiReadContext(req);
          return read;
        }`,
      'app/api/v1/reviewed/route.ts': `import { NextResponse } from 'next/server';
        import { apiReadContext } from '@/server/lib/api-read-context';
        export async function GET(req: Request) {
          if (!req.url) return NextResponse.json({ error: 'validation_error' }, { status: 400 });
          const read = await apiReadContext(req);
          return read;
        }`,
      'app/api/v1/reviewed-changed/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        export async function GET(req: Request) { const url = new URL(req.url); url.searchParams.get('q'); const read = await apiReadContext(req); return read; }`,
    });
    const reason = 'x'.repeat(50);
    expect(
      preGateFindings(tree, {
        'app/api/v1/reviewed/route.ts GET': {
          calls: ["NextResponse.json({ error: 'validation_error' }, { status: 400 })"],
          reason,
        },
        'app/api/v1/reviewed-changed/route.ts GET': { calls: ['new URL(req.url)'], reason },
        'app/api/v1/gone/route.ts GET': { calls: [], reason: 'short' },
      }),
    ).toEqual(
      [
        "app/api/v1/answer-first/route.ts GET: before its read gate it calls [NextResponse.json({ error: 'validation_error' }, { status: 400 })], reviewed: []",
        'app/api/v1/gone/route.ts GET: no reason given',
        'app/api/v1/gone/route.ts GET: on PRE_GATE but not a held handler',
        'app/api/v1/in-arguments/route.ts POST: before its read gate it calls [loadItems()], reviewed: []',
        'app/api/v1/in-ternary/route.ts GET: before its read gate it calls [loadItems()], reviewed: []',
        "app/api/v1/late/route.ts GET: before its read gate it calls [createAdminClient() | createAdminClient().from('items') | createAdminClient().from('items').select('id')], reviewed: []",
        'app/api/v1/not-awaited/route.ts GET: before its read gate it calls [warm(req)], reviewed: []',
        'app/api/v1/tagged/route.ts GET: before its read gate it calls [sql`select id from items`], reviewed: []',
        'app/api/v1/awaited-value/route.ts GET: before its read gate it calls [await warm], reviewed: []',
        'app/api/v1/awaited-property/route.ts GET: before its read gate it calls [await store.rows], reviewed: []',
        "app/api/v1/reviewed-changed/route.ts GET: before its read gate it calls [new URL(req.url) | url.searchParams.get('q')], reviewed: [new URL(req.url)]",
      ].sort(),
    );
  });

  it('2. a shared gate or the wrapper with no answer, its kind dropped, its answer not returned, a limit first; a GET through the API context gate', () => {
    const gated = `import { apiContextGate } from '@/server/lib/api-context-gate';
      export async function GET(req: Request) { const gate = await apiContextGate(req); return gate; }`;
    const tree = base({
      'app/api/v1/returns/http.ts': `import { withApiContext } from '@/lib/auth/api-context';
        // refuseSetUpOwedRead(req, ctx, kind) is called elsewhere
        export async function returnsContext(req: Request, kind: 'read' | 'write') { return withApiContext(req); }`,
      'app/api/v1/orders/[id]/return-request/http.ts': `import { refuseSetUpOwedRead } from '@/server/lib/api-read-context';
        import { checkRateLimit } from '@/lib/rate-limit';
        export async function memberRequesterGate(req: Request, params: unknown, kind: 'read' | 'write') {
          await checkRateLimit(kind, 1, 1);
          refuseSetUpOwedRead(req, params, 'write');
          return null;
        }`,
      [READ_CONTEXT]: `export function refuseSetUpOwedRead() { return null; }
        export async function apiReadContext(req: Request, kind?: 'read') { return refuseSetUpOwedRead(req, null); }`,
      'app/api/v1/gated/route.ts': gated,
      'app/api/gated-elsewhere/route.ts': gated,
      'app/api/v1/gated-listed/route.ts': gated,
    });
    expect(
      answerFindings(tree, { 'app/api/v1/gated-listed/route.ts': open('x'.repeat(50)) }),
    ).toEqual(
      [
        'app/api/gated-elsewhere/route.ts GET: reaches apiContextGate, which gives no set-up answer, and is not on OPEN_READS',
        'app/api/v1/gated/route.ts GET: reaches apiContextGate, which gives no set-up answer, and is not on OPEN_READS',
        "app/api/v1/orders/[id]/return-request/http.ts:5: refuseSetUpOwedRead is not handed the gate's own `kind`",
        'app/api/v1/orders/[id]/return-request/http.ts:5: the answer of refuseSetUpOwedRead is not returned at once',
        'app/api/v1/orders/[id]/return-request/http.ts:5: a rate limit comes before refuseSetUpOwedRead',
        'app/api/v1/returns/http.ts: does not import refuseSetUpOwedRead from server/lib/api-read-context.ts',
        'app/api/v1/returns/http.ts: returnsContext calls refuseSetUpOwedRead 0 times, not once',
        "server/lib/api-read-context.ts:2: refuseSetUpOwedRead is not handed the gate's own `kind`",
      ].sort(),
    );
    // The real shapes pass.
    expect(answerFindings(base({}), {})).toEqual([]);
  });

  it('3. the sentence used anywhere else, and a read module that does not build from it', () => {
    expect(
      copyFindings(
        base({
          'app/api/v1/x/route.ts': `import { AUTHENTICATOR_SET_UP_OWED_COPY } from '@stockpilot/core';
            export const m = AUTHENTICATOR_SET_UP_OWED_COPY;`,
          'server/lib/y.ts': `// AUTHENTICATOR_SET_UP_OWED_COPY in a comment is not a use
            export const s = 'AUTHENTICATOR_SET_UP_OWED_COPY';`,
        }),
      ),
    ).toEqual([
      'app/api/v1/x/route.ts:1 uses AUTHENTICATOR_SET_UP_OWED_COPY',
      'app/api/v1/x/route.ts:2 uses AUTHENTICATOR_SET_UP_OWED_COPY',
    ]);
    expect(copyFindings(base({ [READ_CONTEXT]: 'export {};' }))).toEqual([
      `${READ_CONTEXT}: does not build the answer from ${COPY}`,
    ]);
  });

  it('5. an endpoint outside /api that builds a member context, directly or through other files; a pages/api file', () => {
    const tree = base({
      'lib/auth/api-context.ts': `export async function withApiContext(req: Request) { return req; }`,
      'server/services/context.ts': `import { cache } from 'react';
        export const withContext = cache(async () => 1);`,
      'app/auth/direct/route.ts': `import { withApiContext } from '@/lib/auth/api-context';
        export async function GET(req: Request) { return withApiContext(req); }`,
      'app/auth/through/route.ts': `import { helper } from '@/server/lib/helper';
        export async function POST() { return helper(); }`,
      'server/lib/helper.ts': `import { withContext } from '@/server/services/context';
        export async function helper() { try { return await withContext(); } catch { return null; } }`,
      'app/(site)/plain/route.ts': `import { NextResponse } from 'next/server';
        import { assertPermission } from '@/server/services/context';
        export async function GET() { return NextResponse.json({ assertPermission: typeof assertPermission }); }`,
      'app/api/inside/route.ts': `import { withApiContext } from '@/lib/auth/api-context';
        export async function GET(req: Request) { return withApiContext(req); }`,
      'pages/api/legacy.ts': `export default function handler() { return null; }`,
    });
    const found = outsideScopeFindings(tree);
    expect(found.map((f) => f.replace(/ \(.*\)$/, ''))).toEqual(
      [
        'app/auth/direct/route.ts GET: served outside /api, but builds a member context',
        'app/auth/through/route.ts POST: served outside /api, but builds a member context',
        'pages/api/legacy.ts: a pages/api endpoint, outside every rule of this guard',
      ].sort(),
    );
    expect(found.join('\n')).toContain('server/services/context.ts#withContext');
  });

  it('5. the reviewed list: a route file outside /api missing from it, a stale or unreasoned entry, a sign-in file that reads a table, a token link that reads a session', () => {
    const tree = base({
      'app/auth/listed/route.ts': `import { createClient } from '@/lib/supabase/server';
        export async function GET() { const s = await createClient(); return s.auth.getUser(); }`,
      'app/auth/reads-table/route.ts': `import { createClient } from '@/lib/supabase/server';
        export async function GET() {
          const s = await createClient();
          await s.from('organizations').select('id');
          return s.rpc('anything');
        }`,
      'app/t/[token]/route.ts': `import { createAdminClient } from '@/lib/supabase/admin';
        export async function GET() { return createAdminClient(); }`,
      'app/t/session/route.ts': `import { createClient } from '@/lib/supabase/server';
        export async function GET() { return createClient(); }`,
      'app/(site)/not-listed/route.ts': `export async function GET() { return new Response('ok'); }`,
      'app/api/inside/route.ts': `export async function GET() { return new Response('ok'); }`,
    });
    const listed: Record<string, { kind: OutsideKind; reason: string }> = {
      'app/auth/listed/route.ts': {
        kind: 'sign-in',
        reason: 'A planted sign-in step that reads the user and nothing else.',
      },
      'app/auth/reads-table/route.ts': {
        kind: 'sign-in',
        reason: 'A planted sign-in step that reads a table, which its kind does not allow.',
      },
      'app/t/[token]/route.ts': {
        kind: 'token-link',
        reason: 'A planted token link that reads no member session at all.',
      },
      'app/t/session/route.ts': {
        kind: 'token-link',
        reason:
          'A planted token link that imports the cookie client, which its kind does not allow.',
      },
      'app/gone/route.ts': {
        kind: 'forwarder',
        reason: 'A planted entry whose route file does not exist in the tree.',
      },
      'app/t/short/route.ts': { kind: 'forwarder', reason: 'short' },
    };
    expect(outsideListFindings(tree, listed)).toEqual(
      [
        'app/(site)/not-listed/route.ts: served outside /api, but not on OUTSIDE_ROUTES',
        'app/auth/reads-table/route.ts: listed as sign-in, but calls .from( or .rpc( at line 4',
        'app/auth/reads-table/route.ts: listed as sign-in, but calls .from( or .rpc( at line 5',
        'app/t/session/route.ts: listed as token-link, but imports createClient from @/lib/supabase/server',
        'app/gone/route.ts: on OUTSIDE_ROUTES but no such route file',
        'app/t/short/route.ts: on OUTSIDE_ROUTES but no such route file',
        'app/t/short/route.ts: no reason given',
      ].sort(),
    );
    // The real list, with one of its files left out, reports that file.
    const { 'app/unsubscribe/route.ts': _left, ...rest } = OUTSIDE_ROUTES;
    expect(outsideListFindings(SHIPPED, rest, shippedGraph())).toEqual([
      'app/unsubscribe/route.ts: served outside /api, but not on OUTSIDE_ROUTES',
    ]);
    // And with a metadata file left out, that file.
    const { 'app/robots.ts': _robots, ...noRobots } = OUTSIDE_ROUTES;
    expect(outsideListFindings(SHIPPED, noRobots, shippedGraph())).toEqual([
      'app/robots.ts: served outside /api, but not on OUTSIDE_ROUTES',
    ]);
  });

  it('5. metadata files Next.js serves: each must be listed, and a listed one reads no session and no database; a sign-in route that hands its session to a helper that reads a table', () => {
    const tree = base({
      'app/opengraph-image.tsx': `import { ImageResponse } from 'next/og';
        export default async function Image() { return new ImageResponse(null as never); }`,
      'app/(site)/shop/twitter-image.tsx': `import { createClient } from '@/lib/supabase/server';
        export default async function Image() { const s = await createClient(); return s.from('items').select('name'); }`,
      'app/icon2.ts': `import { createAdminClient } from '@/lib/supabase/admin';
        export default function icon() { return createAdminClient(); }`,
      'app/api/sitemap.ts': `export default function sitemap() { return []; }`,
      'app/robots.ts': `export default function robots() { return {}; }`,
      'app/icon.svg.ts.bak': `export default 1;`,
      'lib/supabase/server.ts': `export async function createClient() { return {} as never; }`,
      'server/lib/org-read.ts': `import { createClient } from '@/lib/supabase/server';
        export async function readOrg() { const s = await createClient(); return s.from('organizations').select('name'); }
        export function quiet() { return createClient(); }`,
      'app/auth/hands-on/route.ts': `import { readOrg } from '@/server/lib/org-read';
        export async function GET() { return readOrg(); }`,
      'app/auth/quiet/route.ts': `import { quiet } from '@/server/lib/org-read';
        export async function GET() { return quiet(); }`,
    });
    const reason = 'A planted entry with a reason that is long enough.';
    const listed: Record<string, { kind: OutsideKind; reason: string }> = {
      'app/opengraph-image.tsx': { kind: 'metadata', reason },
      'app/(site)/shop/twitter-image.tsx': { kind: 'metadata', reason },
      'app/icon2.ts': { kind: 'metadata', reason },
      'app/auth/hands-on/route.ts': { kind: 'sign-in', reason },
      'app/auth/quiet/route.ts': { kind: 'sign-in', reason },
    };
    expect(outsideListFindings(tree, listed)).toEqual(
      [
        'app/(site)/shop/twitter-image.tsx: listed as metadata, but imports @/lib/supabase/server',
        'app/(site)/shop/twitter-image.tsx: listed as metadata, but imports createClient from @/lib/supabase/server',
        'app/icon2.ts: listed as metadata, but imports @/lib/supabase/admin',
        'app/api/sitemap.ts: served outside /api, but not on OUTSIDE_ROUTES',
        'app/auth/hands-on/route.ts GET: listed as sign-in, but reaches server/lib/org-read.ts#readOrg, which reads a table with the cookie client',
        'app/robots.ts: served outside /api, but not on OUTSIDE_ROUTES',
      ].sort(),
    );
  });

  it('4. a read by POST held by nothing, one held through a gate, stale and unreasoned entries, a public entry that reads a session', () => {
    const tree = base({
      'app/api/v1/lookup/route.ts': `import { withApiContext } from '@/lib/auth/api-context';
        export async function POST(req: Request) { return withApiContext(req); }`,
      'app/api/v1/lookup-held/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        export async function POST(req: Request) { const read = await apiReadContext(req, 'read'); return read; }`,
      'app/api/v1/options/route.ts': `import { memberRequesterGate } from '../orders/[id]/return-request/http';
        export async function POST(req: Request) { const gate = await memberRequesterGate(req, null, 'read'); return gate; }`,
      'app/api/v1/options-as-write/route.ts': `import { memberRequesterGate } from '../orders/[id]/return-request/http';
        export async function POST(req: Request) { const gate = await memberRequesterGate(req, null, 'write'); return gate; }`,
      'app/api/v1/save/route.ts': `export async function POST() { return null; }`,
      'app/api/v1/listed-writes/route.ts': `export async function PUT() { return null; }`,
      'app/api/v1/listed-held/route.ts': `import { apiReadContext } from '@/server/lib/api-read-context';
        export async function POST(req: Request) { const read = await apiReadContext(req, 'read'); return read; }`,
      'app/api/v1/listed-public/route.ts': `import { withApiContext } from '@/lib/auth/api-context';
        export async function POST(req: Request) { return withApiContext(req); }`,
      'app/api/not-v1/route.ts': `export async function POST() { return null; }`,
    });
    const writes = new Set([
      'app/api/v1/save/route.ts POST',
      'app/api/v1/listed-writes/route.ts PUT',
    ]);
    const writesOf: WritesOf = (file, method) => writes.has(`${file} ${method}`);
    expect(
      otherReadFindings(tree, writesOf, {
        'app/api/v1/listed-writes/route.ts PUT': open('x'.repeat(50), 'service-gate'),
        'app/api/v1/listed-held/route.ts POST': open('short', 'no-org-data'),
        'app/api/v1/listed-public/route.ts POST': open('x'.repeat(50), 'no-session'),
        'app/api/v1/gone/route.ts POST': open('x'.repeat(50)),
      }),
    ).toEqual(
      [
        "app/api/v1/lookup/route.ts POST: writes nothing, so it is a read: hand a read gate 'read' as its first step (first: withApiContext(req)), or list it on OTHER_READS",
        "app/api/v1/options-as-write/route.ts POST: writes nothing, so it is a read: hand a read gate 'read' as its first step (first: memberRequesterGate without 'read'), or list it on OTHER_READS",
        'app/api/v1/gone/route.ts POST: on OTHER_READS but no such handler',
        'app/api/v1/listed-held/route.ts POST: is held, so it leaves OTHER_READS',
        'app/api/v1/listed-held/route.ts POST: no reason given',
        'app/api/v1/listed-public/route.ts POST: says it reads no session, but imports withApiContext from @/lib/auth/api-context',
        'app/api/v1/listed-public/route.ts POST: says it reads no session, but reaches a context gate',
        'app/api/v1/listed-writes/route.ts PUT: writes (or cannot be read), so it leaves OTHER_READS',
        "app/api/not-v1/route.ts POST: writes nothing, so it is a read: hand a read gate 'read' as its first step (first: (no call)), or list it on OTHER_READS",
      ].sort(),
    );
    expect(heldHandlers(tree)).toEqual([
      'v1/listed-held POST',
      'v1/lookup-held POST',
      'v1/options POST',
    ]);
  });
});
