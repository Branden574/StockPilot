import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GATE_MODULES,
  importsOf,
  moduleExists,
  readRouteFile,
  resolveModule,
  withApiContextCalls,
  WRITE_METHODS,
  type WriteHandler,
  type WriteMethod,
} from './route-write-handlers';

/**
 * Security invariant (docket S14, INV-E5): every route handler that can write
 * is held to the cross-site cookie rule, or is on the reviewed list below.
 *
 * withApiContext's cookie path refuses a write (any method but GET, HEAD and
 * OPTIONS) that a browser sent from another origin (lib/auth/cross-site-request
 * .ts). That covers a route only if the route builds its context there. So:
 *
 *   1. every POST, PUT, PATCH or DELETE exported by a route file under
 *      src/app reaches withApiContext (directly, through the file's own
 *      functions, or through the returns routes' two shared gates), or is
 *      re-exported from a route that does, or is listed in EXEMPT with how it
 *      authenticates and why it needs no cookie rule;
 *   2. every EXEMPT entry is current: the file exists, exports exactly the
 *      listed methods, still reaches no gate, and imports no cookie-session
 *      reader (the cookie client, cookies(), the page-session helpers). The
 *      one route that CREATES a session (/auth/confirm) must judge the post by
 *      Sec-Fetch-Site before it builds the cookie client;
 *   3. every withApiContext call, in a route or a shared gate, hands it the
 *      request it was given (or one rebuilt from it with the same URL and
 *      method), and keeps the answer: the rule reads the method, the URL and
 *      the headers, and a GET built from a POST would never be judged.
 *
 * The self-test at the bottom runs the same reading over sources written to
 * fail, so this cannot pass by reading nothing.
 */

const WEB_SRC = path.resolve(__dirname, '..');
const APP = path.join(WEB_SRC, 'app');
const ROUTE_FILE = /^route\.(ts|tsx|js|mjs)$/;

type HowItAuthenticates =
  /** Authorization: Bearer <a server secret>, compared in constant time, refused when unset. */
  | 'admin secret'
  /** Authorization: Bearer sk_live_..., scoped (lib/auth/api-key.ts). */
  | 'API key'
  /** A provider's signature over the raw body. */
  | 'webhook signature'
  /** A token in the body or the URL that opens one record, with no session. */
  | 'public token'
  /** A single-use emailed token whose answer CREATES the session. */
  | 'one-time token'
  /** Nothing: public by design. */
  | 'none';

interface Exemption {
  methods: WriteMethod[];
  auth: HowItAuthenticates;
  /** 'none': reads no cookie session (checked). 'creates': sets one, judged by Sec-Fetch-Site (checked). */
  session: 'none' | 'creates';
  reason: string;
}

/** Paths relative to src/app. Reviewed 2026-10-24 (docket S14). */
const EXEMPT: Record<string, Exemption> = {
  'api/admin/backfill-item-thumbs/route.ts': {
    methods: ['POST'],
    auth: 'admin secret',
    session: 'none',
    reason:
      'An operator job behind Authorization: Bearer BACKFILL_ADMIN_SECRET (refused when unset). No browser holds the secret.',
  },
  'api/admin/qa-recovery-link/route.ts': {
    methods: ['POST'],
    auth: 'admin secret',
    session: 'none',
    reason:
      'QA tooling behind the same BACKFILL_ADMIN_SECRET bearer, for an allowlist of demo addresses only.',
  },
  'api/public/v1/hooks/route.ts': {
    methods: ['POST'],
    auth: 'API key',
    session: 'none',
    reason:
      'The public API subscribes a webhook for an sk_live_ key with the webhooks:manage scope. A key is never ambient in a browser.',
  },
  'api/public/v1/hooks/[id]/route.ts': {
    methods: ['DELETE'],
    auth: 'API key',
    session: 'none',
    reason: 'The public API unsubscribes a webhook for an sk_live_ key, within its own organization.',
  },
  'api/v1/auth/password-reset/route.ts': {
    methods: ['POST'],
    auth: 'none',
    session: 'none',
    reason:
      "The phone's Forgot password: public by design, one answer for every address, limited per IP and per address (fail closed). A cross-site post can do nothing a direct request cannot.",
  },
  'api/v1/public/order-requests/route.ts': {
    methods: ['POST'],
    auth: 'public token',
    session: 'none',
    reason:
      "The public order link (/r/<token>): the organization's link token in the body, limited per IP, address and token, written with the service client.",
  },
  'api/v1/public/returns/route.ts': {
    methods: ['POST'],
    auth: 'public token',
    session: 'none',
    reason:
      "A requester's return link: the order's return token in the body opens that one order, limited per IP and per token (fail closed).",
  },
  'api/v1/public/returns/options/route.ts': {
    methods: ['POST'],
    auth: 'public token',
    session: 'none',
    reason: "The return link's exchange sizes: the same token, the same limits, nothing written.",
  },
  'api/webhooks/easypost/route.ts': {
    methods: ['POST'],
    auth: 'webhook signature',
    session: 'none',
    reason:
      "EasyPost: an HMAC-SHA256 of the raw body under the connection's secret, compared in constant time before anything is changed.",
  },
  'api/webhooks/stripe/route.ts': {
    methods: ['POST'],
    auth: 'webhook signature',
    session: 'none',
    reason: 'Stripe: stripe.webhooks.constructEvent over the raw body with STRIPE_WEBHOOK_SECRET.',
  },
  'auth/confirm/route.ts': {
    methods: ['POST'],
    auth: 'one-time token',
    session: 'creates',
    reason:
      'The emailed password-reset, invite and email-change links: the single-use token in the form is the credential and the answer sets the session. Its own page posts to it with Origin null (no-referrer), so it refuses a post whose Sec-Fetch-Site names another site, before verifyOtp.',
  },
  'r/confirm/submit/route.ts': {
    methods: ['POST'],
    auth: 'public token',
    session: 'none',
    reason:
      "Confirms a public order request with the confirmation email's single-use token, checked by confirm_public_order_request with the service client.",
  },
  'unsubscribe/route.ts': {
    methods: ['POST'],
    auth: 'public token',
    session: 'none',
    reason:
      "Unsubscribe with the address's HMAC token. RFC 8058 one-click providers post it from their own servers, so it must never be judged by Origin.",
  },
};

/**
 * What reads a cookie session, by the module it comes from: the cookie-bound
 * client, the request cookies, and the page-session helpers (INV-E4's list).
 * '*' is any import from that module.
 */
const SESSION_READERS: Record<string, readonly string[]> = {
  '@/lib/supabase/server': ['*'],
  'next/headers': ['cookies'],
  '@/lib/auth/session': ['*'],
  '@/lib/dashboard/request-cache': ['*'],
  '@/lib/auth/api-context': ['*'],
  '@/server/services/context': ['withContext'],
  '@/server/services/portal': ['resolvePortalContext'],
  '@/server/lib/sign-page-session': ['*'],
};

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (ROUTE_FILE.test(name)) out.push(full);
  }
  return out;
}

/** apps/web/src-relative, posix. */
const rel = (abs: string) => path.relative(WEB_SRC, abs).split(path.sep).join('/');

const FILES = routeFiles(APP).sort();
const SOURCES = new Map(FILES.map((f) => [rel(f), readFileSync(f, 'utf8')]));
const READINGS = new Map([...SOURCES].map(([file, src]) => [file, readRouteFile(file, src)]));

/** Covered: reaches a gate, or re-exports a handler that does. */
function isCovered(file: string, handler: WriteHandler, seen = new Set<string>()): boolean {
  if (handler.gates.length > 0) return true;
  if (!handler.reexport) return false;
  const key = `${handler.reexport.module}#${handler.reexport.name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const target = [...READINGS.keys()].find((f) => f.replace(/\.(ts|tsx|js|mjs)$/, '') === handler.reexport!.module);
  const targetHandler = target
    ? READINGS.get(target)!.handlers.find((h) => h.method === handler.reexport!.name)
    : undefined;
  return !!target && !!targetHandler && isCovered(target, targetHandler, seen);
}

describe('every route that can write is held to the cross-site cookie rule', () => {
  it('scans a real tree', () => {
    expect(FILES.length).toBeGreaterThan(200);
    const writes = [...READINGS.values()].flatMap((r) => r.handlers);
    expect(writes.length).toBeGreaterThan(110);
    // Known members of each kind, so a walker that stopped descending fails.
    for (const known of [
      'app/api/v1/cycle-counts/[id]/lines/[lineId]/record/route.ts',
      'app/api/v1/me/release-state/route.ts',
      'app/api/orders/sign/route.ts',
      'app/api/v1/returns/[id]/cancel/route.ts',
      'app/api/webhooks/stripe/route.ts',
    ]) {
      expect(READINGS.has(known), known).toBe(true);
    }
  });

  it('reads every route file (no export shape it cannot follow)', () => {
    const unreadable = [...READINGS].flatMap(([file, r]) => r.unreadable.map((u) => `${file}: ${u}`));
    expect(unreadable).toEqual([]);
  });

  it('every POST, PUT, PATCH and DELETE reaches withApiContext, re-exports one that does, or is exempt', () => {
    const open: string[] = [];
    for (const [file, reading] of READINGS) {
      const exemption = EXEMPT[file.replace(/^app\//, '')];
      for (const handler of reading.handlers) {
        if (isCovered(file, handler)) continue;
        if (exemption?.methods.includes(handler.method)) continue;
        open.push(`${file} ${handler.method}`);
      }
    }
    expect(open).toEqual([]);
  });

  it('a re-export names a route file that exists', () => {
    for (const [file, reading] of READINGS) {
      for (const h of reading.handlers.filter((x) => x.reexport)) {
        expect(moduleExists(h.reexport!.module), `${file} ${h.method}`).toBe(true);
        expect(isCovered(file, h), `${file} ${h.method} -> ${h.reexport!.module}`).toBe(true);
      }
    }
  });
});

describe('the reviewed exemptions are current', () => {
  it.each(Object.entries(EXEMPT))('%s', (key, exemption) => {
    const file = `app/${key}`;
    const reading = READINGS.get(file);
    expect(reading, 'the file exists and is a route').toBeDefined();
    expect(exemption.reason.length).toBeGreaterThan(40);
    // Exactly the listed write methods: a new one must be reviewed on its own.
    expect(reading!.handlers.map((h) => h.method).sort()).toEqual([...exemption.methods].sort());
    // Still uncovered: a route that now reaches withApiContext leaves the list.
    for (const h of reading!.handlers) expect(isCovered(file, h), `${h.method} reaches a gate`).toBe(false);

    const source = SOURCES.get(file)!;
    const readers = importsOf(file, source).flatMap(({ specifier, names }) => {
      const banned = SESSION_READERS[specifier];
      if (!banned) return [];
      return names.filter((n) => banned.includes('*') || banned.includes(n)).map((n) => `${n} from ${specifier}`);
    });
    if (exemption.session === 'none') {
      expect(readers, 'reads no cookie session').toEqual([]);
    } else {
      // It builds the cookie client only to SET the session, after judging the
      // post by Sec-Fetch-Site (its Origin is null by its own page's policy).
      expect(readers).toEqual(['createClient from @/lib/supabase/server']);
      expect(
        importsOf(file, source).some(
          (i) => i.specifier === '@/lib/auth/cross-site-request' && i.names.includes('fetchSiteIsElsewhere'),
        ),
      ).toBe(true);
      const post = source.slice(source.indexOf('export async function POST'));
      const judged = post.indexOf('fetchSiteIsElsewhere(');
      const client = post.indexOf('createClient(');
      expect(judged).toBeGreaterThan(-1);
      expect(client).toBeGreaterThan(judged);
    }
  });
});

describe('every withApiContext call is handed the request it judges', () => {
  // The routes, and the two shared gates whose routes hand them their request.
  const GATE_FILES = Object.entries(GATE_MODULES)
    .filter(([name]) => name !== 'withApiContext')
    .map(([, module]) => `${module}.ts`);
  const CALLERS = new Map<string, string>([
    ...SOURCES,
    ...GATE_FILES.map((f) => [f, readFileSync(path.join(WEB_SRC, f), 'utf8')] as [string, string]),
  ]);

  it('finds the calls (routes and the shared gates)', () => {
    const total = [...CALLERS].reduce((n, [file, src]) => n + withApiContextCalls(file, src).length, 0);
    expect(total).toBeGreaterThan(150);
    for (const gate of GATE_FILES) expect(withApiContextCalls(gate, CALLERS.get(gate)!)).toHaveLength(1);
  });

  it('each passes its own request parameter, or rebuilds it with the same URL and method, and keeps the answer', () => {
    const bad: string[] = [];
    for (const [file, src] of CALLERS) {
      for (const call of withApiContextCalls(file, src)) {
        if (!(call.passesOwnParameter || call.rebuildsOwnParameter)) {
          bad.push(`${file}:${call.line} is given ${call.argument}`);
        }
        if (!call.resultKept) bad.push(`${file}:${call.line} drops its answer`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the shared gates are imported from their own modules (an alias is followed, a namesake is not a gate)', () => {
    for (const [name, module] of Object.entries(GATE_MODULES)) {
      expect(moduleExists(module), `${name} lives at ${module}`).toBe(true);
    }
    expect(readFileSync(path.join(WEB_SRC, 'lib/auth/api-context.ts'), 'utf8')).toContain(
      'refusesCrossSiteCookieWrite(req)',
    );
  });
});

/* ───────────────────── self-test: the reading can fail ───────────────────── */

describe('self-test: the reading reports what it should', () => {
  const FILE = 'app/api/v1/example/route.ts';
  const handlers = (src: string, file = FILE) => readRouteFile(file, src).handlers;
  const methodsOf = (src: string) => handlers(src).map((h) => `${h.method}:${h.gates.join('+') || '-'}`);

  it('a write with no gate is open; a GET is not a write', () => {
    expect(
      methodsOf(`
        import { NextResponse } from 'next/server';
        export async function GET() { return NextResponse.json({}); }
        export async function POST(req: Request) { return NextResponse.json({ ok: true }); }
      `),
    ).toEqual(['POST:-']);
  });

  it('every write method and every export shape is read', () => {
    expect(
      methodsOf(`
        import { withApiContext } from '@/lib/auth/api-context';
        export async function PUT(req: Request) { const ctx = await withApiContext(req); return ctx; }
        export const PATCH = async (req: Request) => { const ctx = await withApiContext(req); return ctx; };
        async function remove(req: Request) { return withApiContext(req); }
        export { remove as DELETE };
        export function POST() { return null; }
      `).sort(),
    ).toEqual(['DELETE:withApiContext', 'PATCH:withApiContext', 'POST:-', 'PUT:withApiContext']);
  });

  it("a gate reached through the file's own function or a shared handler counts; a property of the same name does not", () => {
    expect(
      methodsOf(`
        import { withApiContext } from '@/lib/auth/api-context';
        async function contextFor(req: Request) { return withApiContext(req); }
        const handler = async (req: Request) => { const c = await contextFor(req); return c; };
        export const POST = handler;
        export async function DELETE(req: Request) { const o = { contextFor: 1 }; return o.contextFor; }
      `).sort(),
    ).toEqual(['DELETE:-', 'POST:withApiContext']);
  });

  it('an alias of the gate is followed; a namesake from another module, or a method call, is not a gate', () => {
    expect(
      methodsOf(`
        import { withApiContext as ctxOf } from '@/lib/auth/api-context';
        export async function POST(req: Request) { const c = await ctxOf(req); return c; }
      `),
    ).toEqual(['POST:withApiContext']);
    expect(
      methodsOf(`
        import { withApiContext } from '@/lib/auth/not-the-rule';
        const auth = { withApiContext: async (r: Request) => r };
        export async function POST(req: Request) { await auth.withApiContext(req); return withApiContext(req); }
      `),
    ).toEqual(['POST:-']);
  });

  it('a comment or a string naming the gate is not a call', () => {
    expect(
      methodsOf(`
        // withApiContext(req) is called elsewhere
        export async function POST(req: Request) { return 'withApiContext(req)'; }
      `),
    ).toEqual(['POST:-']);
  });

  it('the shared returns gates count only from their own modules', () => {
    const file = 'app/api/v1/returns/[id]/cancel/route.ts';
    expect(
      handlers(
        `import { returnsContext } from '../../http';
         export async function POST(req: Request) { const g = await returnsContext(req, 'write'); return g; }`,
        file,
      ).map((h) => h.gates),
    ).toEqual([['returnsContext']]);
    expect(
      handlers(
        `import { returnsContext } from './somewhere-else';
         export async function POST(req: Request) { const g = await returnsContext(req, 'write'); return g; }`,
        file,
      ).map((h) => h.gates),
    ).toEqual([[]]);
  });

  it('a re-export is followed to its module; export * and a destructured export are reported', () => {
    const reading = readRouteFile(
      'app/api/v1/orders/sign/route.ts',
      `export { POST } from '../../../orders/sign/route';`,
    );
    expect(reading.handlers).toEqual([
      { method: 'POST', gates: [], reexport: { module: 'app/api/orders/sign/route', name: 'POST' } },
    ]);
    expect(readRouteFile(FILE, `export * from './handlers';`).unreadable).toEqual(['export * from ./handlers']);
    expect(readRouteFile(FILE, `export const { POST } = makeHandlers();`).unreadable).toHaveLength(1);
  });

  it('resolveModule maps @/ and relative specifiers to apps/web/src paths', () => {
    expect(resolveModule('app/api/v1/returns/[id]/cancel/route.ts', '../../http')).toBe('app/api/v1/returns/http');
    expect(resolveModule(FILE, '@/lib/auth/api-context')).toBe('lib/auth/api-context');
    expect(resolveModule(FILE, 'next/server')).toBeNull();
  });

  it('a withApiContext call given anything but its own request is reported, and so is a dropped answer', () => {
    const calls = withApiContextCalls(
      FILE,
      `import { withApiContext } from '@/lib/auth/api-context';
       export async function POST(req: Request) {
         const a = await withApiContext(req);
         const b = await withApiContext(new Request(req.url, { method: req.method, headers: new Headers(req.headers) }));
         const c = await withApiContext(new Request(req.url, { method: 'GET', headers: req.headers }));
         const d = await withApiContext();
         await withApiContext(req);
         return [a, b, c, d];
       }`,
    );
    expect(calls.map((c) => [c.passesOwnParameter || c.rebuildsOwnParameter, c.resultKept])).toEqual([
      [true, true],
      [true, true],
      [false, true],
      [false, true],
      [true, false],
    ]);
  });

  it('every write method is in the list the reading uses', () => {
    expect([...WRITE_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
  });
});
