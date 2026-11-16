import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  importsOf,
  readRouteHandlers,
  resolveModule,
  type RouteHandler,
} from './route-write-handlers';

/**
 * Security invariant: a member whose organization requires an authenticator
 * of their role, and who has none, reads no organization data through
 * /api/v1. Every GET handler there answers them 403 `forbidden` with core's
 * sentence and `details.reason: 'mfa_required'`, or is listed here as open
 * with its reason.
 *
 * How the answer is given. withApiContext (lib/auth/api-context.ts) labels a
 * context that owes set-up (core authenticatorSetUpOwed). The read wrapper
 * (server/lib/api-read-context.ts, apiReadContext) answers a GET or HEAD with
 * such a context 403 through refuseSetUpOwedRead, and the returns routes' two
 * shared gates call refuseSetUpOwedRead themselves. That module builds the
 * answer; nothing else in the web app uses its sentence.
 *
 * Read on the syntax tree (a comment or a string never counts), over every
 * shipped source file under apps/web/src:
 *
 *   1. every GET and HEAD handler of a route file under app/api/v1 reaches
 *      apiReadContext, returnsContext or memberRequesterGate (directly,
 *      through the file's own functions, or as the handler it re-exports from
 *      another route file), or its file is on OPEN_READS with a reason; every
 *      OPEN_READS entry is current (the file exists, exports a GET, and
 *      reaches none of the three);
 *   2. the returns routes' shared gates give the answer (each imports
 *      refuseSetUpOwedRead from the read module and calls it), and so does
 *      apiReadContext; a GET that reaches the API context gate, which gives no
 *      set-up answer, is on OPEN_READS;
 *   3. core's AUTHENTICATOR_SET_UP_OWED_COPY is used in the web app only by
 *      server/lib/api-read-context.ts: one place builds the answer.
 *
 * The self-test at the bottom plants a violation of each rule, so this cannot
 * pass by reading nothing.
 */

const WEB_SRC = path.resolve(__dirname, '..');
const V1 = 'app/api/v1/';
const ROUTE_FILE = /^route\.(ts|tsx|js|mjs)$/;
const SOURCE_FILE = /\.(ts|tsx|js|mjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|mjs)$/;

const READ_CONTEXT = 'server/lib/api-read-context.ts';
const REFUSAL = 'refuseSetUpOwedRead';
const COPY = 'AUTHENTICATOR_SET_UP_OWED_COPY';

/** The functions that give the answer to a read, by the module each comes from (apps/web/src, no extension). */
const READ_GATES: Readonly<Record<string, string>> = {
  apiReadContext: 'server/lib/api-read-context',
  returnsContext: 'app/api/v1/returns/http',
  memberRequesterGate: 'app/api/v1/orders/[id]/return-request/http',
};

/** The returns routes' shared gates: each must give the answer itself. */
const SHARED_GATES = [
  'app/api/v1/returns/http.ts',
  'app/api/v1/orders/[id]/return-request/http.ts',
];

/** The API context gate, which gives no set-up answer itself. */
const CONTEXT_GATE: Readonly<Record<string, string>> = {
  apiContextGate: 'server/lib/api-context-gate',
};

/** The /api/v1 GET handlers that are not held, by route file (apps/web/src relative), each with why. */
const OPEN_READS: Record<string, string> = {
  'app/api/v1/account/email/route.ts':
    "The member's own sign-in email and its pending change, read through the API context gate. It is the person's own account, which they may see before setting up an authenticator, as the website's profile page shows it.",
  'app/api/v1/public/catalog-thumbnails/route.ts':
    'Public catalog thumbnails behind a signed link: no session is read, so there is no member to hold.',
  'app/api/v1/public/order-requests/[id]/route.ts':
    "A requester's order status behind the order's own signed token: no session is read, so there is no member to hold.",
  'app/api/v1/public/order-requests/[id]/location/route.ts':
    "The delivery location for a requester's order behind the order's own signed token: no session is read, so there is no member to hold.",
};

type Sources = ReadonlyMap<string, string>;

/** Every shipped source file under apps/web/src (no tests, no src/test helpers, no mocks). */
function shippedSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(WEB_SRC, full).split(path.sep).join('/');
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === '__mocks__' || rel === 'test') continue;
        walk(full);
      } else if (SOURCE_FILE.test(name) && !TEST_FILE.test(name) && !name.endsWith('.d.ts')) {
        out.set(rel, readFileSync(full, 'utf8'));
      }
    }
  };
  walk(WEB_SRC);
  return out;
}

function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** The lines where `name` is written as code (an identifier), never in a comment or a string. */
function codeUses(file: string, src: string, name: string): number[] {
  const sf = parse(file, src);
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name) {
      lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

/** The lines where `name(...)` is called by that name. */
function calls(file: string, src: string, name: string): number[] {
  const sf = parse(file, src);
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

/**
 * A file imports `name` by that name from `module` (apps/web/src relative, no
 * extension) and calls it. A function of the same name declared in the file,
 * or a comment naming it, is not that function.
 */
function importsAndCalls(file: string, src: string, name: string, module: string): boolean {
  const imported = importsOf(file, src).some(
    ({ specifier, names }) => names.includes(name) && resolveModule(file, specifier) === module,
  );
  return imported && calls(file, src, name).length > 0;
}

function v1RouteFiles(sources: Sources): string[] {
  return [...sources.keys()]
    .filter((f) => f.startsWith(V1) && ROUTE_FILE.test(path.posix.basename(f)))
    .sort();
}

function getHandlers(
  file: string,
  src: string,
  modules: Readonly<Record<string, string>>,
): RouteHandler[] {
  return readRouteHandlers(file, src, modules).handlers.filter(
    (h) => h.method === 'GET' || h.method === 'HEAD',
  );
}

/**
 * Does the handler reach a read gate: itself, or (for `export { GET } from
 * '...'`) the handler of that name in the route file it re-exports, followed
 * through further re-exports. A target that cannot be found is not held.
 */
function isHeld(h: RouteHandler, sources: Sources, seen = new Set<string>()): boolean {
  if (h.gates.length > 0) return true;
  if (!h.reexport) return false;
  const key = `${h.reexport.module}#${h.reexport.name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const target = ['.ts', '.tsx', '.js', '.mjs']
    .map((ext) => `${h.reexport!.module}${ext}`)
    .find((f) => sources.has(f));
  if (!target) return false;
  const next = getHandlers(target, sources.get(target)!, READ_GATES).find(
    (t) => t.method === h.reexport!.name,
  );
  return next !== undefined && isHeld(next, sources, seen);
}

/** Rule 1: GET and HEAD handlers under /api/v1 that are neither held nor listed, and stale entries. */
function openReadFindings(sources: Sources, open: Record<string, string>): string[] {
  const found: string[] = [];
  for (const file of v1RouteFiles(sources)) {
    const src = sources.get(file)!;
    for (const u of readRouteHandlers(file, src, READ_GATES).unreadable) {
      found.push(`${file}: cannot read ${u}`);
    }
    for (const h of getHandlers(file, src, READ_GATES)) {
      const held = isHeld(h, sources);
      if (open[file] !== undefined) {
        if (held) found.push(`${file} ${h.method}: is held, so it leaves OPEN_READS`);
      } else if (!held) {
        found.push(
          `${file} ${h.method}: reaches none of ${Object.keys(READ_GATES).join(', ')} and is not on OPEN_READS`,
        );
      }
    }
  }
  for (const [file, reason] of Object.entries(open)) {
    const src = sources.get(file);
    if (src === undefined) {
      found.push(`${file}: on OPEN_READS but not found`);
      continue;
    }
    if (getHandlers(file, src, READ_GATES).length === 0) {
      found.push(`${file}: on OPEN_READS but exports no GET`);
    }
    if (reason.length <= 40) found.push(`${file}: no reason given`);
  }
  return found.sort();
}

/** Rule 2: the shared gates and the wrapper answer; a GET through the API context gate is listed. */
function answerFindings(sources: Sources, open: Record<string, string>): string[] {
  const found: string[] = [];
  const readModule = READ_CONTEXT.replace(/\.ts$/, '');
  for (const file of SHARED_GATES) {
    const src = sources.get(file);
    if (src === undefined) found.push(`${file}: not found`);
    else if (!importsAndCalls(file, src, REFUSAL, readModule)) {
      found.push(`${file}: does not call ${REFUSAL} from ${READ_CONTEXT}`);
    }
  }
  const own = sources.get(READ_CONTEXT);
  if (own === undefined || calls(READ_CONTEXT, own, REFUSAL).length === 0) {
    found.push(`${READ_CONTEXT}: apiReadContext does not call ${REFUSAL}`);
  }
  for (const file of v1RouteFiles(sources)) {
    for (const h of getHandlers(file, sources.get(file)!, CONTEXT_GATE)) {
      if (h.gates.length > 0 && open[file] === undefined) {
        found.push(
          `${file} ${h.method}: reaches apiContextGate, which gives no set-up answer, and is not on OPEN_READS`,
        );
      }
    }
  }
  return found.sort();
}

/** Rule 3: core's sentence used outside the module that builds the answer. */
function copyFindings(sources: Sources): string[] {
  const found: string[] = [];
  for (const [file, src] of sources) {
    if (file === READ_CONTEXT) continue;
    for (const line of codeUses(file, src, COPY)) found.push(`${file}:${line} uses ${COPY}`);
  }
  const own = sources.get(READ_CONTEXT);
  if (own === undefined || codeUses(READ_CONTEXT, own, COPY).length === 0) {
    found.push(`${READ_CONTEXT}: does not build the answer from ${COPY}`);
  }
  return found.sort();
}

const SHIPPED = shippedSources();

describe('every /api/v1 read holds a member who must set up an authenticator first', () => {
  it('scans a real tree', () => {
    expect(SHIPPED.size).toBeGreaterThan(1000);
    const files = v1RouteFiles(SHIPPED);
    expect(files.length).toBeGreaterThan(150);
    const gets = files.flatMap((f) => getHandlers(f, SHIPPED.get(f)!, READ_GATES));
    // 58 GET handlers on 2026-11-16, one of them in a .tsx route.
    expect(gets.length).toBeGreaterThan(55);
    expect(files).toContain('app/api/v1/reports/book-order-totals/export/route.tsx');
    expect(files).toContain('app/api/v1/mobile/snapshot/route.ts');
    expect(files).toContain('app/api/v1/orders/[id]/signature/route.ts');
    const held = files.filter((f) =>
      getHandlers(f, SHIPPED.get(f)!, READ_GATES).some((h) => h.gates.length > 0),
    );
    expect(held.length).toBeGreaterThan(50);
  });

  it('1. every GET handler under /api/v1 is held or listed as open, and every listed one is current', () => {
    expect(openReadFindings(SHIPPED, OPEN_READS)).toEqual([]);
  });

  it('2. the shared gates and the wrapper give the answer; a GET through the API context gate is listed', () => {
    expect(answerFindings(SHIPPED, OPEN_READS)).toEqual([]);
  });

  it("3. core's set-up sentence is used in the web app only where the answer is built", () => {
    expect(copyFindings(SHIPPED)).toEqual([]);
  });
});

/* ───────────────────── self-test: each rule can fail ───────────────────── */

describe('self-test: a planted violation of each rule is reported', () => {
  const READ_WRAPPER = `import { withApiContext } from '@/lib/auth/api-context';
    import { AUTHENTICATOR_SET_UP_OWED_COPY } from '@stockpilot/core';
    export function refuseSetUpOwedRead(req: Request) { return req ? AUTHENTICATOR_SET_UP_OWED_COPY : null; }
    export async function apiReadContext(req: Request) {
      const ctx = await withApiContext(req);
      return refuseSetUpOwedRead(req) ? { response: 1 } : { ctx };
    }`;
  const SHARED = `import { refuseSetUpOwedRead } from '@/server/lib/api-read-context';
    export async function returnsContext(req: Request) { return refuseSetUpOwedRead(req); }`;
  const HELD_ROUTE = `import { apiReadContext } from '@/server/lib/api-read-context';
    export async function GET(req: Request) { const read = await apiReadContext(req); return read; }`;
  const PLAIN = `import { withApiContext } from '@/lib/auth/api-context';
    export async function GET(req: Request) { return withApiContext(req); }`;
  const base = (extra: Record<string, string>) =>
    new Map<string, string>(
      Object.entries({
        [READ_CONTEXT]: READ_WRAPPER,
        [SHARED_GATES[0]!]: SHARED,
        [SHARED_GATES[1]!]: SHARED,
        ...extra,
      }),
    );

  it('1. a GET that reaches no read gate, a namesake, a re-export of an open or a missing handler, a stale and an unreasoned entry', () => {
    const tree = base({
      'app/api/v1/held/route.ts': HELD_ROUTE,
      'app/api/v1/plain/route.ts': PLAIN,
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
      'app/api/v1/reexport-outside/route.ts': `export { GET } from '../../elsewhere/route';`,
      'app/api/v1/listed-but-held/route.ts': HELD_ROUTE,
      'app/api/v1/listed-no-get/route.ts': `export async function POST() { return null; }`,
      'app/api/v1/write-only/route.ts': `export async function POST() { return null; }`,
    });
    expect(
      openReadFindings(tree, {
        'app/api/v1/listed-but-held/route.ts': 'x'.repeat(50),
        'app/api/v1/listed-no-get/route.ts': 'short',
        'app/api/v1/missing/route.ts': 'x'.repeat(50),
      }),
    ).toEqual([
      'app/api/v1/listed-but-held/route.ts GET: is held, so it leaves OPEN_READS',
      'app/api/v1/listed-no-get/route.ts: no reason given',
      'app/api/v1/listed-no-get/route.ts: on OPEN_READS but exports no GET',
      'app/api/v1/missing/route.ts: on OPEN_READS but not found',
      'app/api/v1/namesake/route.ts GET: reaches none of apiReadContext, returnsContext, memberRequesterGate and is not on OPEN_READS',
      'app/api/v1/plain/route.ts GET: reaches none of apiReadContext, returnsContext, memberRequesterGate and is not on OPEN_READS',
      'app/api/v1/reexport-loop/route.ts GET: reaches none of apiReadContext, returnsContext, memberRequesterGate and is not on OPEN_READS',
      'app/api/v1/reexport-missing/route.ts GET: reaches none of apiReadContext, returnsContext, memberRequesterGate and is not on OPEN_READS',
      'app/api/v1/reexport-plain/route.ts GET: reaches none of apiReadContext, returnsContext, memberRequesterGate and is not on OPEN_READS',
    ]);
  });

  it('2. a shared gate or the wrapper with no answer, and a GET through the API context gate', () => {
    const gated = `import { apiContextGate } from '@/server/lib/api-context-gate';
      export async function GET(req: Request) { const gate = await apiContextGate(req); return gate; }`;
    const tree = base({
      [SHARED_GATES[0]!]: `import { withApiContext } from '@/lib/auth/api-context';
        // refuseSetUpOwedRead(req, ctx) is called elsewhere
        export async function returnsContext(req: Request) { return withApiContext(req); }`,
      [SHARED_GATES[1]!]: `import { withApiContext } from '@/lib/auth/api-context';
        async function refuseSetUpOwedRead() { return null; }
        export async function memberRequesterGate(req: Request) { await refuseSetUpOwedRead(); return withApiContext(req); }`,
      [READ_CONTEXT]: `export function refuseSetUpOwedRead() { return null; }
        export async function apiReadContext() { return null; }`,
      'app/api/v1/gated/route.ts': gated,
      'app/api/v1/gated-listed/route.ts': gated,
    });
    expect(answerFindings(tree, { 'app/api/v1/gated-listed/route.ts': 'x'.repeat(50) })).toEqual([
      'app/api/v1/gated/route.ts GET: reaches apiContextGate, which gives no set-up answer, and is not on OPEN_READS',
      'app/api/v1/orders/[id]/return-request/http.ts: does not call refuseSetUpOwedRead from server/lib/api-read-context.ts',
      'app/api/v1/returns/http.ts: does not call refuseSetUpOwedRead from server/lib/api-read-context.ts',
      'server/lib/api-read-context.ts: apiReadContext does not call refuseSetUpOwedRead',
    ]);
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
});
