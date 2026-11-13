import * as fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCallGraph, shippedSourceFiles, type CallGraph } from './gate-reach';

/**
 * Security invariant (docket S43c): every dashboard page asks for the
 * member's context itself, first, so a session that still owes its
 * authenticator code is sent to /signin/mfa by the page, whether or not the
 * layout above it ran for the request.
 *
 * requireOrgContext() (lib/auth/session.ts) is where that happens. The
 * dashboard layout asks it too, but a page is also rendered by itself (a
 * navigation renders only the segments that changed), so each page must hold
 * the rule alone, and so must each layout below the first. Over every
 * `page.tsx` and `layout.tsx` under src/app/(dashboard), read on the syntax
 * tree (test/gate-reach.ts; a call whose redirect a catch could keep does not
 * count):
 *
 *   1. the file's default export asks first: the first call it awaits is
 *      requireOrgContext() or a function that itself asks first, all the way
 *      down (withContext(), a service's static forCurrentUser(),
 *      checkModuleAccess(), ...; gate-reach.ts, "asks first"), so nothing is
 *      read before the context. The same for a generateMetadata it
 *      exports, which runs for the same request (one that awaits no call
 *      reads nothing). Or the file is listed in REVIEWED, as one of:
 *        'redirect-only'  it awaits no call and reads nothing: it only sends
 *                         the browser to another page, which asks;
 *        'delegates'      it awaits no call itself and renders a server
 *                         component that reaches the gate. Checked: so it does.
 *      Asking first in a Promise.all means nothing is started beside the
 *      context: every other entry that calls something asks first itself
 *      (gate-reach.ts). The one exception is a call listed in ALLOWED_BESIDE,
 *      by its function, with why it reads nothing for a session the context
 *      turns away: its bare call may stand beside the context, and nothing
 *      else on the page is excused by it;
 *   2. every listed entry is current: the file exists, does not meet rule 1
 *      (one that does leaves the list), still fits its kind, gives a reason;
 *      an ALLOWED_BESIDE function still exists, does not ask first itself,
 *      still awaits only the request's own cookies or headers (and calls only
 *      methods of its own values) before it asks for the context, and is
 *      still what lets some page pass rule 1.
 *      And no other kind of server entry file sits under the dashboard (a
 *      template, a parallel route's default, a route handler): a new one is
 *      reported until this guard reads it;
 *   3. the platform console's pages, under src/app/(platform), ask their own
 *      gate first: requirePlatformAdmin(), which wants aal2 outright;
 *   4. the sign-in pages can never be sent away by the gate: no page or layout
 *      under src/app/(auth), nor the root layout, reaches requireOrgContext(),
 *      by a call or by a component it renders. /signin/mfa is where the gate
 *      sends people, so reaching it there would be a loop;
 *   5. the customer portal's page, under src/app/portal, asks its own funnel
 *      first: resolvePortalContext() (server/services/portal.ts), which holds
 *      a portal customer to the same rule.
 *
 * The self-test at the bottom plants a violation of each rule.
 */

const WEB_SRC = path.resolve(__dirname, '..');

const GATE = 'lib/auth/session.ts#requireOrgContext';
const PLATFORM_GATE = 'lib/auth/platform-admin.ts#requirePlatformAdmin';
const PORTAL_GATE = 'server/services/portal.ts#resolvePortalContext';
const DASHBOARD = 'app/(dashboard)/';
const PLATFORM = 'app/(platform)/';
const AUTH = 'app/(auth)/';
const PORTAL = 'app/portal/';
const ROOT_LAYOUT = 'app/layout.tsx';

interface Reviewed {
  kind: 'redirect-only' | 'delegates';
  reason: string;
}

/** Src-relative page files. Reviewed 2026-11-12 (docket S43c). */
const REVIEWED: Record<string, Reviewed> = {
  'app/(dashboard)/dashboard/admin/audit/page.tsx': {
    kind: 'redirect-only',
    reason: 'An old address: it only redirects to /dashboard/audit, carrying the filters.',
  },
  'app/(dashboard)/dashboard/admin/users/page.tsx': {
    kind: 'redirect-only',
    reason: 'An old address: it only redirects to /dashboard/team, and reads nothing.',
  },
  'app/(dashboard)/dashboard/settings/audit/page.tsx': {
    kind: 'redirect-only',
    reason: 'An old address: it only redirects to /dashboard/audit, carrying the filters.',
  },
  'app/(dashboard)/dashboard/books/[id]/page.tsx': {
    kind: 'delegates',
    reason:
      'Reads nothing itself: it checks the id and renders ItemDetail, which builds its context with withContext() before any read.',
  },
  'app/(dashboard)/dashboard/inventory/[id]/page.tsx': {
    kind: 'delegates',
    reason:
      'Reads nothing itself: it checks the id and renders ItemDetail, which builds its context with withContext() before any read.',
  },
  'app/(dashboard)/dashboard/settings/layout.tsx': {
    kind: 'delegates',
    reason:
      'Reads nothing itself: the settings navigation is its own server component, which asks requireOrgContext() before its module check.',
  },
};

/**
 * Calls a dashboard page may start beside requireOrgContext() in a Promise.all
 * although they do not ask first themselves, as `<src-relative file>#<export>`,
 * each with why it reads nothing for a session the context turns away. Only
 * the bare call is excused, and only beside an entry that asks
 * (gate-reach.ts, "EXCUSED BESIDE THE TARGET"); every other entry of the same
 * Promise.all, and everything else the page does, is held to rule 1.
 * Reviewed 2026-11-13 (docket S43c).
 */
const ALLOWED_BESIDE: Record<string, string> = {
  'lib/warehouse-filter.ts#getActiveWarehouseFilter': `It reads only the caller's own filter cookie, and looks a warehouse up only through getWarehouseAccess(), which asks requireOrgContext() before any read. The Inventory page's table section and the Locations page start it beside requireOrgContext() so the cookie is read while the context resolves.`,
};

/* ───────────────────────────── the reading ───────────────────────────── */

interface Tree {
  graph: CallGraph;
  /** Src-relative paths of every file. */
  files: string[];
  abs: (rel: string) => string;
}

function treeOf(files: Array<{ path: string; text: string }>, srcRoot: string): Tree {
  return {
    graph: buildCallGraph(files, srcRoot),
    files: files.map((f) => path.relative(srcRoot, f.path).split(path.sep).join('/')).sort(),
    abs: (rel) => path.join(srcRoot, rel),
  };
}

const targetOf = (tree: Tree, key: string) => {
  const [file, name] = key.split('#') as [string, string];
  return `${tree.abs(file)}#${name}`;
};

const pagesUnder = (tree: Tree, dir: string) =>
  tree.files.filter((f) => f.startsWith(dir) && /(^|\/)page\.tsx$/.test(f));

/** Pages and layouts: the server components a request for a dashboard address renders. */
const entriesUnder = (tree: Tree, dir: string) =>
  tree.files.filter((f) => f.startsWith(dir) && /(^|\/)(page|layout)\.tsx$/.test(f));

/** Other server entry files Next.js would run under `dir`, which this guard does not read. */
const unreadEntriesUnder = (tree: Tree, dir: string) =>
  tree.files.filter(
    (f) => f.startsWith(dir) && /(^|\/)(template|default|route)\.(ts|tsx)$/.test(f),
  );

/** What reaches `gate`, with the calls in `allowed` excused beside it. */
const reachOf = (tree: Tree, gate: string, allowed: Record<string, string> = {}) =>
  tree.graph.reach([targetOf(tree, gate)], {
    besideAllowed: Object.keys(allowed).map((key) => targetOf(tree, key)),
  });

/** Why a page does not ask `gate` first by its own calls, or null when it does. */
function notGateFirst(
  tree: Tree,
  page: string,
  gate: string,
  name = 'default',
  allowed: Record<string, string> = {},
): string | null {
  const reach = reachOf(tree, gate, allowed);
  const file = tree.abs(page);
  const asks = reach.exportAsksFirst(file, name);
  if (asks === null) return 'has no default export that is a function';
  if (asks) return null;
  if (!reach.exportReaches(file, name)) return 'never reaches it by its own calls';
  const beside = reach.startedBesideFirst(file, name);
  if (beside) return `starts \`${beside.text}\` beside it (line ${beside.line})`;
  const first = reach.firstAwaitedCall(file, name);
  if (first === null) return 'is not one function, so its order cannot be read';
  if (first === 'none') return 'awaits nothing, and calls nothing that asks first';
  return `awaits \`${first.text}\` first (line ${first.line})`;
}

/** Why a file's generateMetadata reads before `gate`, or null when it exports none or it does not. */
function metadataReadsFirst(
  tree: Tree,
  page: string,
  gate: string,
  allowed: Record<string, string> = {},
): string | null {
  const file = tree.abs(page);
  if (!tree.graph.hasExport(file, 'generateMetadata')) return null;
  const reach = reachOf(tree, gate, allowed);
  // One that awaits no call reads nothing.
  if (reach.firstAwaitedCall(file, 'generateMetadata') === 'none') return null;
  const why = notGateFirst(tree, page, gate, 'generateMetadata', allowed);
  return why ? `generateMetadata ${why}` : null;
}

/** Rule 1: dashboard pages and layouts that do not ask for the context first and are not listed. */
function openPages(
  tree: Tree,
  reviewed: Record<string, Reviewed>,
  allowed: Record<string, string> = {},
): string[] {
  return entriesUnder(tree, DASHBOARD).flatMap((page) => {
    const problems: string[] = [];
    const why = reviewed[page] ? null : notGateFirst(tree, page, GATE, 'default', allowed);
    if (why) problems.push(`${page}: ${why}`);
    const metadata = metadataReadsFirst(tree, page, GATE, allowed);
    if (metadata) problems.push(`${page}: ${metadata}`);
    return problems;
  });
}

/** Rule 2: listed entries that are no longer true. */
function staleEntries(
  tree: Tree,
  reviewed: Record<string, Reviewed>,
  allowed: Record<string, string> = {},
): string[] {
  const calls = tree.graph.reach([targetOf(tree, GATE)]);
  const rendered = tree.graph.reach([targetOf(tree, GATE)], { jsx: true });
  const problems: string[] = [];
  for (const f of unreadEntriesUnder(tree, DASHBOARD)) {
    problems.push(`${f}: a server entry file this guard does not read`);
  }
  const open = openPages(tree, reviewed, allowed).join('\n');
  for (const [key, why] of Object.entries(allowed)) {
    const [file, name] = key.split('#') as [string, string];
    const after = calls.asksFirstAfterInert(tree.abs(file), name);
    if (after === null) {
      problems.push(`${key}: no such function`);
      continue;
    }
    if (calls.exportAsksFirst(tree.abs(file), name)) {
      problems.push(`${key}: asks for the context first itself, so it leaves the list`);
    } else if (!after) {
      problems.push(
        `${key}: does more than read the request's own cookies or headers before it asks for the context`,
      );
    }
    if (why.length <= 40) problems.push(`${key}: no reason given`);
    const without = Object.fromEntries(Object.entries(allowed).filter(([k]) => k !== key));
    if (openPages(tree, reviewed, without).join('\n') === open) {
      problems.push(`${key}: excuses nothing on any dashboard page, so it leaves the list`);
    }
  }
  for (const [page, entry] of Object.entries(reviewed)) {
    if (!entriesUnder(tree, DASHBOARD).includes(page)) {
      problems.push(`${page}: no such dashboard page or layout`);
      continue;
    }
    if (notGateFirst(tree, page, GATE, 'default', allowed) === null) {
      problems.push(`${page}: asks for the context first, so it leaves the list`);
      continue;
    }
    if (entry.reason.length <= 40) problems.push(`${page}: no reason given`);
    const file = tree.abs(page);
    const first = calls.firstAwaitedCall(file, 'default');
    if (first !== 'none') {
      problems.push(
        `${page}: listed as '${entry.kind}' but ${first === null ? 'its body cannot be read' : `awaits \`${first.text}\``}`,
      );
    }
    if (entry.kind === 'delegates' && !rendered.exportReaches(file, 'default')) {
      problems.push(`${page}: listed as 'delegates' but renders nothing that reaches the gate`);
    }
    if (entry.kind === 'redirect-only' && rendered.exportReaches(file, 'default')) {
      problems.push(
        `${page}: listed as 'redirect-only' but renders something that reaches the gate`,
      );
    }
  }
  return problems.sort();
}

/** Rule 3: platform console pages that do not ask their own gate first. */
function openPlatformPages(tree: Tree): string[] {
  return pagesUnder(tree, PLATFORM).flatMap((page) => {
    const why = notGateFirst(tree, page, PLATFORM_GATE);
    return why ? [`${page}: ${why}`] : [];
  });
}

/** Rule 5: customer portal pages and layouts that do not ask the portal's own funnel first. */
function openPortalPages(tree: Tree): string[] {
  return entriesUnder(tree, PORTAL).flatMap((page) => {
    const why = notGateFirst(tree, page, PORTAL_GATE);
    return why ? [`${page}: ${why}`] : [];
  });
}

/** Rule 4: sign-in pages and layouts (and the root layout) that reach the gate. */
function signInFilesReachingTheGate(tree: Tree): string[] {
  const rendered = tree.graph.reach([targetOf(tree, GATE)], { jsx: true });
  return tree.files
    .filter((f) => f === ROOT_LAYOUT || (f.startsWith(AUTH) && /(^|\/)(page|layout)\.tsx$/.test(f)))
    .filter((f) => rendered.exportReaches(tree.abs(f), 'default'))
    .map((f) => `${f}: ${rendered.pathToTarget(tree.abs(f), 'default')?.join(' -> ')}`);
}

/* ───────────────────────────── the real tree ───────────────────────────── */

const REAL = treeOf(shippedSourceFiles(WEB_SRC, fs), WEB_SRC);

describe('every dashboard page asks for the member context first (docket S43c)', () => {
  it('scans a real tree', () => {
    // 125 dashboard pages, 6 dashboard layouts and 5 platform pages on 2026-11-12.
    expect(pagesUnder(REAL, DASHBOARD).length).toBeGreaterThan(115);
    expect(entriesUnder(REAL, DASHBOARD).length).toBeGreaterThan(
      pagesUnder(REAL, DASHBOARD).length + 4,
    );
    // The one generateMetadata that reads (a release's title) is among them.
    expect(
      REAL.graph.hasExport(
        REAL.abs('app/(dashboard)/dashboard/whats-new/[slug]/page.tsx'),
        'generateMetadata',
      ),
    ).toBe(true);
    expect(pagesUnder(REAL, PLATFORM).length).toBeGreaterThanOrEqual(5);
    for (const known of [
      'app/(dashboard)/dashboard/page.tsx',
      'app/(dashboard)/dashboard/inventory/page.tsx',
      'app/(dashboard)/dashboard/settings/profile/page.tsx',
      'app/(dashboard)/dashboard/admin/support/page.tsx',
      'app/(auth)/signin/mfa/page.tsx',
      ROOT_LAYOUT,
    ]) {
      expect(REAL.files, known).toContain(known);
    }
    expect(Object.keys(REVIEWED).length).toBeLessThan(10);
  });

  it('1. every dashboard page and layout reaches requireOrgContext() by its own calls, before anything else it awaits, or is listed', () => {
    expect(openPages(REAL, REVIEWED, ALLOWED_BESIDE)).toEqual([]);
  });

  it('2. every listed entry is current', () => {
    expect(staleEntries(REAL, REVIEWED, ALLOWED_BESIDE)).toEqual([]);
    expect(Object.keys(ALLOWED_BESIDE).length).toBeLessThan(5);
  });

  it('3. every platform console page asks requirePlatformAdmin() first', () => {
    expect(openPlatformPages(REAL)).toEqual([]);
  });

  it('4. no sign-in page or layout, nor the root layout, reaches the gate', () => {
    expect(signInFilesReachingTheGate(REAL)).toEqual([]);
    // The code page is among the files read.
    expect(
      REAL.files.filter((f) => f.startsWith(AUTH) && /(page|layout)\.tsx$/.test(f)).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it('5. the customer portal page asks resolvePortalContext() first, which asks the same rule', () => {
    expect(entriesUnder(REAL, PORTAL)).toContain('app/portal/page.tsx');
    expect(openPortalPages(REAL)).toEqual([]);
    const byUser = REAL.graph.reach([
      targetOf(REAL, 'lib/auth/step-up-gate.ts#stepUpIsOwedByUser'),
    ]);
    expect(
      byUser.exportReaches(REAL.abs('server/services/portal.ts'), 'resolvePortalContext'),
    ).toBe(true);
  });
});

/* ───────────────────── self-test: each rule can fail ───────────────────── */

describe('self-test: a planted violation of each rule is reported', () => {
  const ROOT = '/planted';
  const base = {
    'lib/auth/session.ts': `
      export const requireOrgContext = cache(async () => ({ organizationId: 'o' }));
      export const requireSession = cache(async () => ({ userId: 'u' }));`,
    'server/services/context.ts': `
      import { requireOrgContext } from '@/lib/auth/session';
      export const withContext = cache(async () => requireOrgContext());`,
    'lib/auth/platform-admin.ts': `
      export async function requirePlatformAdmin() { return { userId: 'u' }; }
      export async function currentUserIsPlatformAdmin() { return true; }`,
    'components/detail.tsx': `
      import { withContext } from '@/server/services/context';
      export async function Detail() { const ctx = await withContext(); return <p>{String(ctx)}</p>; }`,
    'components/plain.tsx': `export function Plain() { return <p>plain</p>; }`,
    'server/services/portal.ts': `export async function resolvePortalContext() { return null; }`,
  };
  const tree = (files: Record<string, string>) =>
    treeOf(
      Object.entries({ ...base, ...files }).map(([k, text]) => ({ path: `${ROOT}/${k}`, text })),
      ROOT,
    );
  const D = 'app/(dashboard)/dashboard';
  const reason = 'x'.repeat(41);

  it('1. pages that ask first pass: directly, in a Promise.all, through withContext(), through a rethrowing catch', () => {
    const t = tree({
      [`${D}/a/page.tsx`]: `
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function Page({ params }: { params: Promise<{ id: string }> }) {
          const { id } = await params;
          const ctx = await requireOrgContext();
          return <p>{id}{ctx.organizationId}</p>;
        }`,
      [`${D}/b/page.tsx`]: `
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function Page({ searchParams }: { searchParams: Promise<object> }) {
          const [ctx, sp] = await Promise.all([requireOrgContext(), searchParams]);
          return <p>{String(ctx)}{String(sp)}</p>;
        }`,
      [`${D}/c/page.tsx`]: `
        import { withContext } from '@/server/services/context';
        async function Page() {
          let ctx;
          try { ctx = await withContext(); } catch (e) { if (e instanceof TypeError) notFound(); throw e; }
          return <p>{String(ctx)}</p>;
        }
        export default Page;`,
    });
    expect(openPages(t, {})).toEqual([]);
  });

  it('1. pages that do not are reported: another gate first, a read first, a session only, a kept redirect, only a child that asks', () => {
    const t = tree({
      [`${D}/admin/page.tsx`]: `
        import { currentUserIsPlatformAdmin } from '@/lib/auth/platform-admin';
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function Page() {
          if (!(await currentUserIsPlatformAdmin())) return null;
          await requireOrgContext();
          return <p>tickets</p>;
        }`,
      [`${D}/profile/page.tsx`]: `
        import { requireSession } from '@/lib/auth/session';
        import { createClient } from '@/lib/supabase/server';
        export default async function Page() {
          const session = await requireSession();
          const { data } = await (await createClient()).from('user_profiles').select('*');
          return <p>{String(session)}{String(data)}</p>;
        }`,
      [`${D}/kept/page.tsx`]: `
        import { withContext } from '@/server/services/context';
        export default async function Page() {
          let ctx = null;
          try { ctx = await withContext(); } catch { ctx = null; }
          return <p>{String(ctx)}</p>;
        }`,
      [`${D}/child/page.tsx`]: `
        import { Detail } from '@/components/detail';
        import { createClient } from '@/lib/supabase/server';
        export default async function Page() {
          const { data } = await (await createClient()).from('items').select('*');
          return <><p>{String(data)}</p><Detail /></>;
        }`,
      [`${D}/comment/page.tsx`]: `
        // requireOrgContext() runs in the layout
        export default async function Page() { return <p>requireOrgContext()</p>; }`,
      'lib/filter.ts': `
        import { requireOrgContext } from '@/lib/auth/session';
        export async function activeFilter() {
          const raw = (await cookies()).get('filter')?.value;
          if (!raw) return null;
          await requireOrgContext();
          return raw;
        }`,
      [`${D}/early/page.tsx`]: `
        import { activeFilter } from '@/lib/filter';
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function Page() {
          const filter = await activeFilter();
          const ctx = await requireOrgContext();
          return <p>{String(filter)}{String(ctx)}</p>;
        }`,
    });
    expect(openPages(t, {})).toEqual([
      `${D}/admin/page.tsx: awaits \`await currentUserIsPlatformAdmin()\` first (line 5)`,
      `${D}/child/page.tsx: never reaches it by its own calls`,
      `${D}/comment/page.tsx: never reaches it by its own calls`,
      `${D}/early/page.tsx: awaits \`await activeFilter()\` first (line 5)`,
      `${D}/kept/page.tsx: never reaches it by its own calls`,
      `${D}/profile/page.tsx: never reaches it by its own calls`,
    ]);
  });

  it('1. a page that starts something beside the context is reported, unless what it starts asks first or reads nothing', () => {
    const t = tree({
      'lib/filter.ts': `
        import { cookies } from 'next/headers';
        import { requireOrgContext } from '@/lib/auth/session';
        export async function activeFilter() {
          const raw = (await cookies()).get('filter')?.value;
          if (!raw) return null;
          await requireOrgContext();
          return raw;
        }
        export async function label() { const ctx = await requireOrgContext(); return String(ctx); }`,
      [`${D}/read/page.tsx`]: `
        import { requireOrgContext } from '@/lib/auth/session';
        import { createAdminClient } from '@/lib/supabase/admin';
        export default async function Page() {
          const [ctx, rows] = await Promise.all([
            requireOrgContext(),
            createAdminClient().from('items').select('*'),
          ]);
          return <p>{String(ctx)}{String(rows)}</p>;
        }`,
      [`${D}/filter/page.tsx`]: `
        import { activeFilter } from '@/lib/filter';
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function Page() {
          const [ctx, filter] = await Promise.all([requireOrgContext(), activeFilter()]);
          return <p>{String(ctx)}{String(filter)}</p>;
        }`,
      [`${D}/section/page.tsx`]: `
        import { activeFilter } from '@/lib/filter';
        import { requireOrgContext } from '@/lib/auth/session';
        async function section() {
          const [ctx, filter] = await Promise.all([requireOrgContext(), activeFilter()]);
          return <p>{String(ctx)}{String(filter)}</p>;
        }
        export default async function Page() {
          const [ctx, table] = await Promise.all([requireOrgContext(), section()]);
          return <p>{String(ctx)}{table}</p>;
        }`,
      [`${D}/fine/page.tsx`]: `
        import { cookies } from 'next/headers';
        import { label } from '@/lib/filter';
        import { requireOrgContext } from '@/lib/auth/session';
        import { createClient } from '@/lib/supabase/server';
        import { withContext } from '@/server/services/context';
        export default async function Page({ searchParams }: { searchParams: Promise<object> }) {
          const [ctx, title, jar, supabase, sp, rows] = await Promise.all([
            requireOrgContext(),
            label(),
            cookies(),
            createClient(),
            searchParams,
            withContext().then((c) => fetch('/rows/' + String(c))),
          ]);
          return <p>{String(ctx)}{title}{String(jar)}{String(supabase)}{String(sp)}{String(rows)}</p>;
        }`,
      [`${D}/own-cookies/page.tsx`]: `
        import { requireOrgContext } from '@/lib/auth/session';
        async function cookies() { return fetch('/not-the-cookie-jar'); }
        export default async function Page() {
          const [ctx, jar] = await Promise.all([requireOrgContext(), cookies()]);
          return <p>{String(ctx)}{String(jar)}</p>;
        }`,
      [`${D}/chained-client/page.tsx`]: `
        import { requireOrgContext } from '@/lib/auth/session';
        import { createClient } from '@/lib/supabase/server';
        export default async function Page() {
          const [ctx, rows] = await Promise.all([
            requireOrgContext(),
            createClient().then((c) => c.from('items').select('*')),
          ]);
          return <p>{String(ctx)}{String(rows)}</p>;
        }`,
      [`${D}/inert-argument/page.tsx`]: `
        import { cookies } from 'next/headers';
        import { requireOrgContext } from '@/lib/auth/session';
        import { createAdminClient } from '@/lib/supabase/admin';
        export default async function Page() {
          const [ctx, jar] = await Promise.all([
            requireOrgContext(),
            cookies(createAdminClient().from('items').select('*')),
          ]);
          return <p>{String(ctx)}{String(jar)}</p>;
        }`,
    });
    expect(openPages(t, {})).toEqual([
      `${D}/chained-client/page.tsx: starts \`createClient().then((c) => c.from('items').select('*'))\` beside it (line 7)`,
      `${D}/filter/page.tsx: starts \`activeFilter()\` beside it (line 5)`,
      `${D}/inert-argument/page.tsx: starts \`cookies(createAdminClient().from('items').select('*'))\` beside it (line 8)`,
      `${D}/own-cookies/page.tsx: starts \`cookies()\` beside it (line 5)`,
      `${D}/read/page.tsx: starts \`createAdminClient().from('items').select('*')\` beside it (line 7)`,
      `${D}/section/page.tsx: starts \`section()\` beside it (line 9)`,
    ]);
  });

  /** A filter read as getActiveWarehouseFilter() does: the request's own cookie, then the context. */
  const FILTER = `
    import { cookies } from 'next/headers';
    import { requireOrgContext } from '@/lib/auth/session';
    import { createAdminClient } from '@/lib/supabase/admin';
    export async function activeFilter() {
      const jar = await cookies();
      const raw = jar.get('filter')?.value;
      if (!raw) return null;
      await requireOrgContext();
      return raw;
    }
    export async function readsFirst() {
      const jar = await cookies();
      const rows = await createAdminClient().from('items').select('*');
      await requireOrgContext();
      return [jar, rows];
    }
    export async function startsUnawaited() {
      const jar = await cookies();
      void createAdminClient().from('audit').insert({ seen: true });
      await requireOrgContext();
      return jar;
    }
    export async function asksItself() {
      await requireOrgContext();
      return (await cookies()).get('filter')?.value ?? null;
    }
    export async function unused() {
      const jar = await cookies();
      if (!jar.get('filter')) return null;
      await requireOrgContext();
      return 'unused';
    }`;
  const besidePage = (call: string) => `
    import { ${call.replace(/\(.*$/s, '')} } from '@/lib/filter';
    import { requireOrgContext } from '@/lib/auth/session';
    export default async function Page() {
      const [ctx, filter] = await Promise.all([requireOrgContext(), ${call}]);
      return <p>{String(ctx)}{String(filter)}</p>;
    }`;
  const ALLOWED = { 'lib/filter.ts#activeFilter': reason };

  it('1. an excused call is excused as its bare call beside the context only: a second entry beside it, a read before the context in a helper, a chain or an argument is reported', () => {
    const t = tree({
      'lib/filter.ts': FILTER,
      [`${D}/filter/page.tsx`]: besidePage('activeFilter()'),
      [`${D}/second/page.tsx`]: `
        import { activeFilter } from '@/lib/filter';
        import { requireOrgContext } from '@/lib/auth/session';
        import { createAdminClient } from '@/lib/supabase/admin';
        export default async function Page() {
          const [ctx, filter, rows] = await Promise.all([
            requireOrgContext(),
            activeFilter(),
            createAdminClient().from('items').select('*'),
          ]);
          return <p>{String(ctx)}{String(filter)}{String(rows)}</p>;
        }`,
      [`${D}/section/page.tsx`]: `
        import { activeFilter } from '@/lib/filter';
        import { requireOrgContext } from '@/lib/auth/session';
        async function section() {
          const [ctx, filter] = await Promise.all([requireOrgContext(), activeFilter()]);
          return <p>{String(ctx)}{String(filter)}</p>;
        }
        export default async function Page() {
          const [ctx, table] = await Promise.all([requireOrgContext(), section()]);
          return <p>{String(ctx)}{table}</p>;
        }`,
      [`${D}/section-reads/page.tsx`]: `
        import { activeFilter } from '@/lib/filter';
        import { requireOrgContext } from '@/lib/auth/session';
        import { createAdminClient } from '@/lib/supabase/admin';
        async function section() {
          const pre = await createAdminClient().from('items').select('*');
          const [ctx, filter] = await Promise.all([requireOrgContext(), activeFilter()]);
          return <p>{String(pre)}{String(ctx)}{String(filter)}</p>;
        }
        export default async function Page() {
          const [ctx, table] = await Promise.all([requireOrgContext(), section()]);
          return <p>{String(ctx)}{table}</p>;
        }`,
      [`${D}/chained/page.tsx`]: besidePage(
        "activeFilter().then((f) => createAdminClient().from('items').select('*').eq('w', f))",
      ),
      [`${D}/argument/page.tsx`]: besidePage(
        "activeFilter(createAdminClient().from('items').select('*'))",
      ),
      [`${D}/alone/page.tsx`]: `
        import { activeFilter } from '@/lib/filter';
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function Page() {
          const filter = await activeFilter();
          const ctx = await requireOrgContext();
          return <p>{String(filter)}{String(ctx)}</p>;
        }`,
      [`${D}/no-context/page.tsx`]: `
        import { cookies } from 'next/headers';
        import { activeFilter } from '@/lib/filter';
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function Page() {
          const [filter, jar] = await Promise.all([activeFilter(), cookies()]);
          const ctx = await requireOrgContext();
          return <p>{String(filter)}{String(jar)}{String(ctx)}</p>;
        }`,
    });
    expect(openPages(t, {}, ALLOWED)).toEqual([
      `${D}/alone/page.tsx: awaits \`await activeFilter()\` first (line 5)`,
      `${D}/argument/page.tsx: starts \`activeFilter(createAdminClient().from('items').select('*'))\` beside it (line 5)`,
      `${D}/chained/page.tsx: starts \`activeFilter().then((f) => createAdminClient().from('items').select('*').eq('w', f))\` beside it (line 5)`,
      `${D}/no-context/page.tsx: awaits \`await Promise.all([activeFilter(), cookies()])\` first (line 6)`,
      `${D}/second/page.tsx: starts \`createAdminClient().from('items').select('*')\` beside it (line 9)`,
      `${D}/section-reads/page.tsx: starts \`section()\` beside it (line 11)`,
    ]);
    // Without the excuse, the two pages it lets through are reported too.
    expect(openPages(t, {}).filter((p) => /\/(filter|section)\/page/.test(p))).toEqual([
      `${D}/filter/page.tsx: starts \`activeFilter()\` beside it (line 5)`,
      `${D}/section/page.tsx: starts \`section()\` beside it (line 9)`,
    ]);
  });

  it("2. an excused call that does more than read the request's own cookies before the context, asks first itself, excuses nothing, gives no reason or is gone is reported", () => {
    const t = tree({
      'lib/filter.ts': FILTER,
      [`${D}/filter/page.tsx`]: besidePage('activeFilter()'),
      [`${D}/reads/page.tsx`]: besidePage('readsFirst()'),
      [`${D}/unawaited/page.tsx`]: besidePage('startsUnawaited()'),
      [`${D}/asks/page.tsx`]: besidePage('asksItself()'),
    });
    expect(
      staleEntries(
        t,
        {},
        {
          'lib/filter.ts#activeFilter': reason,
          'lib/filter.ts#readsFirst': reason,
          'lib/filter.ts#startsUnawaited': reason,
          'lib/filter.ts#asksItself': reason,
          'lib/filter.ts#unused': reason,
          'lib/filter.ts#gone': reason,
          'lib/nowhere.ts#activeFilter': reason,
        },
      ),
    ).toEqual([
      'lib/filter.ts#asksItself: asks for the context first itself, so it leaves the list',
      'lib/filter.ts#asksItself: excuses nothing on any dashboard page, so it leaves the list',
      'lib/filter.ts#gone: no such function',
      "lib/filter.ts#readsFirst: does more than read the request's own cookies or headers before it asks for the context",
      "lib/filter.ts#startsUnawaited: does more than read the request's own cookies or headers before it asks for the context",
      'lib/filter.ts#unused: excuses nothing on any dashboard page, so it leaves the list',
      'lib/nowhere.ts#activeFilter: no such function',
    ]);
    expect(staleEntries(t, {}, { 'lib/filter.ts#activeFilter': 'short' })).toEqual([
      'lib/filter.ts#activeFilter: no reason given',
    ]);
    // The true entry is accepted.
    expect(staleEntries(t, {}, ALLOWED)).toEqual([]);
  });

  it('1. a layout is held to the same rule, and so is a generateMetadata that reads', () => {
    const t = tree({
      [`${D}/area/layout.tsx`]: `
        import { createClient } from '@/lib/supabase/server';
        export default async function Layout({ children }: { children: unknown }) {
          const { data } = await (await createClient()).from('organizations').select('name');
          return <section>{String(data)}{children}</section>;
        }`,
      [`${D}/gated/layout.tsx`]: `
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function Layout({ children }: { children: unknown }) {
          await requireOrgContext();
          return children;
        }`,
      [`${D}/item/page.tsx`]: `
        import { requireOrgContext } from '@/lib/auth/session';
        import { createClient } from '@/lib/supabase/server';
        export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
          const { id } = await params;
          const { data } = await (await createClient()).from('items').select('name').eq('id', id);
          return { title: String(data) };
        }
        export default async function Page() { await requireOrgContext(); return null; }`,
      [`${D}/release/page.tsx`]: `
        import { withContext } from '@/server/services/context';
        export async function generateMetadata() { return { title: String(await withContext()) }; }
        export default async function Page() { await withContext(); return null; }`,
      [`${D}/static/page.tsx`]: `
        import { requireOrgContext } from '@/lib/auth/session';
        export async function generateMetadata() { return { title: 'Static' }; }
        export default async function Page() { await requireOrgContext(); return null; }`,
      [`${D}/late/page.tsx`]: `
        import { requireOrgContext } from '@/lib/auth/session';
        import { createClient } from '@/lib/supabase/server';
        export async function generateMetadata() {
          const { data } = await (await createClient()).from('items').select('name');
          await requireOrgContext();
          return { title: String(data) };
        }
        export default async function Page() { await requireOrgContext(); return null; }`,
    });
    expect(openPages(t, {})).toEqual([
      `${D}/area/layout.tsx: never reaches it by its own calls`,
      `${D}/item/page.tsx: generateMetadata never reaches it by its own calls`,
      `${D}/late/page.tsx: generateMetadata awaits \`await createClient()\` first (line 5)`,
    ]);
  });

  it('2. a template, a parallel route default or a route handler under the dashboard is reported until it is read', () => {
    const t = tree({
      [`${D}/template.tsx`]: `export default function Template({ children }: { children: unknown }) { return children; }`,
      [`${D}/@panel/default.tsx`]: `export default function Default() { return null; }`,
      [`${D}/export/route.ts`]: `export async function GET() { return new Response('x'); }`,
    });
    expect(staleEntries(t, {})).toEqual([
      `${D}/@panel/default.tsx: a server entry file this guard does not read`,
      `${D}/export/route.ts: a server entry file this guard does not read`,
      `${D}/template.tsx: a server entry file this guard does not read`,
    ]);
  });

  it('2. a listed page that asks first, is gone, reads something, or does not fit its kind is reported', () => {
    const t = tree({
      [`${D}/gated/page.tsx`]: `
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function Page() { await requireOrgContext(); return null; }`,
      [`${D}/reads/page.tsx`]: `
        import { createClient } from '@/lib/supabase/server';
        export default async function Page() { await createClient(); redirect('/dashboard'); }`,
      [`${D}/plain/page.tsx`]: `
        import { Plain } from '@/components/plain';
        export default function Page() { return <Plain />; }`,
      [`${D}/detail/page.tsx`]: `
        import { Detail } from '@/components/detail';
        export default function Page() { return <Detail />; }`,
      [`${D}/old/page.tsx`]: `export default function Page() { redirect('/dashboard'); }`,
    });
    expect(
      staleEntries(t, {
        [`${D}/gated/page.tsx`]: { kind: 'redirect-only', reason },
        [`${D}/reads/page.tsx`]: { kind: 'redirect-only', reason },
        [`${D}/plain/page.tsx`]: { kind: 'delegates', reason },
        [`${D}/detail/page.tsx`]: { kind: 'redirect-only', reason: 'short' },
        [`${D}/missing/page.tsx`]: { kind: 'redirect-only', reason },
      }),
    ).toEqual([
      `${D}/detail/page.tsx: listed as 'redirect-only' but renders something that reaches the gate`,
      `${D}/detail/page.tsx: no reason given`,
      `${D}/gated/page.tsx: asks for the context first, so it leaves the list`,
      `${D}/missing/page.tsx: no such dashboard page or layout`,
      `${D}/plain/page.tsx: listed as 'delegates' but renders nothing that reaches the gate`,
      `${D}/reads/page.tsx: listed as 'redirect-only' but awaits \`await createClient()\``,
    ]);
    // The two true entries are accepted.
    expect(
      staleEntries(t, {
        [`${D}/detail/page.tsx`]: { kind: 'delegates', reason },
        [`${D}/old/page.tsx`]: { kind: 'redirect-only', reason },
      }),
    ).toEqual([]);
  });

  it('3. a platform page that reads before requirePlatformAdmin() is reported', () => {
    const t = tree({
      'app/(platform)/platform/a/page.tsx': `
        import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
        export default async function Page() { await requirePlatformAdmin(); return null; }`,
      'app/(platform)/platform/b/page.tsx': `
        import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
        import { listTickets } from '@/server/services/tickets';
        export default async function Page() {
          const tickets = await listTickets();
          await requirePlatformAdmin();
          return <p>{String(tickets)}</p>;
        }`,
    });
    expect(openPlatformPages(t)).toEqual([
      'app/(platform)/platform/b/page.tsx: awaits `await listTickets()` first (line 5)',
    ]);
  });

  it('5. a portal page that reads before resolvePortalContext() is reported', () => {
    const t = tree({
      'app/portal/page.tsx': `
        import { resolvePortalContext } from '@/server/services/portal';
        export default async function Page() { const ctx = await resolvePortalContext(); return <p>{String(ctx)}</p>; }`,
      'app/portal/orders/page.tsx': `
        import { createAdminClient } from '@/lib/supabase/admin';
        import { resolvePortalContext } from '@/server/services/portal';
        export default async function Page() {
          const orders = await createAdminClient().from('order_requests').select('*');
          const ctx = await resolvePortalContext();
          return <p>{String(orders)}{String(ctx)}</p>;
        }`,
      'app/portal/help/page.tsx': `export default function Page() { return <p>help</p>; }`,
    });
    expect(openPortalPages(t)).toEqual([
      'app/portal/help/page.tsx: never reaches it by its own calls',
      "app/portal/orders/page.tsx: awaits `await createAdminClient().from('order_requests').select('*')` first (line 5)",
    ]);
  });

  it('4. a sign-in page or layout that reaches the gate, by a call or a component, is reported', () => {
    const t = tree({
      'app/layout.tsx': `export default function Root({ children }: { children: unknown }) { return children; }`,
      'app/(auth)/layout.tsx': `
        import { Detail } from '@/components/detail';
        export default function AuthLayout() { return <Detail />; }`,
      'app/(auth)/signin/mfa/page.tsx': `
        import { requireOrgContext } from '@/lib/auth/session';
        export default async function Page() { await requireOrgContext(); return null; }`,
      'app/(auth)/signin/page.tsx': `
        import { Plain } from '@/components/plain';
        export default function Page() { return <Plain />; }`,
    });
    expect(signInFilesReachingTheGate(t)).toEqual([
      'app/(auth)/layout.tsx: app/(auth)/layout.tsx#AuthLayout -> components/detail.tsx#Detail -> server/services/context.ts#withContext -> lib/auth/session.ts#requireOrgContext',
      'app/(auth)/signin/mfa/page.tsx: app/(auth)/signin/mfa/page.tsx#Page -> lib/auth/session.ts#requireOrgContext',
    ]);
  });
});
