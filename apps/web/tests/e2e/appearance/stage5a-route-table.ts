/**
 * The `next build` route table comparison of plan 8.5 ("the next build route
 * table shows the same static and dynamic markers for every existing
 * route"), pure, for route-table-compare.mjs; the unit test is
 * src/test/stage5a-route-table.test.ts.
 *
 * NO IMPORTS and only erasable TypeScript: route-table-compare.mjs loads this
 * file with Node's own type stripping (Node 22.18 and later).
 *
 * A build log's table is read section by section ("Route (app)", "Route
 * (pages)"): each row is `<tree> <marker> <route>` (the tree drawn with ┌ ├ └
 * │), with columns after the route on older Next versions; rows of a route's
 * generated paths (no marker, deeper in the tree) are left out. ANSI colours
 * are removed first. The proxy line (`ƒ Proxy (Middleware)`) is kept as the
 * route `(proxy)` so its loss shows.
 */

export type RouteTable = Map<string, string>;

const ANSI = /\u001b\[[0-9;]*m/gu;
const SECTION = /^Route \((app|pages)\)/u;
const ROW = /^[┌├└│ ]*[┌├└]\s+(\S)\s+(\/\S*)/u;
const PROXY = /^(\S)\s+Proxy\b/u;
const MARKERS = new Set(['○', '●', 'ƒ', '◐', 'λ', 'ℇ']);

/** Every route in a build log, keyed `app /path` or `pages /path`, to its marker. */
export function parseRouteTable(log: string): RouteTable {
  const table: RouteTable = new Map();
  let section: string | null = null;
  for (const raw of log.replace(ANSI, '').split(/\r?\n/u)) {
    const line = raw.trimEnd();
    const head = SECTION.exec(line.trim());
    if (head) {
      section = head[1]!;
      continue;
    }
    const proxy = PROXY.exec(line.trim());
    if (proxy && MARKERS.has(proxy[1]!)) {
      table.set('(proxy)', proxy[1]!);
      continue;
    }
    if (section === null) continue;
    const row = ROW.exec(line);
    if (row && MARKERS.has(row[1]!)) table.set(`${section} ${row[2]!}`, row[1]!);
  }
  return table;
}

export interface RouteTableComparison {
  /** Routes of the base build whose marker is different on the branch. */
  changed: string[];
  /** Routes of the base build the branch does not have. */
  removed: string[];
  /** Routes only the branch has (listed; new routes are allowed). */
  added: string[];
  /** Added routes outside EXPECTED_NEW_ROUTES (listed for a person to read). */
  unexpectedAdded: string[];
}

/** The routes Liquid Glass adds: the marketing twins and the Design cookie route. */
export const EXPECTED_NEW_ROUTES: readonly RegExp[] = [
  /^app \/glass-site(\/.*)?$/u,
  /^app \/api\/appearance\/style$/u,
];

export function compareRouteTables(base: RouteTable, branch: RouteTable): RouteTableComparison {
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [route, marker] of base) {
    const now = branch.get(route);
    if (now === undefined) removed.push(route);
    else if (now !== marker) changed.push(`${route}: ${marker} -> ${now}`);
  }
  const added = [...branch.keys()].filter((route) => !base.has(route)).sort();
  return {
    changed: changed.sort(),
    removed: removed.sort(),
    added,
    unexpectedAdded: added.filter((route) => !EXPECTED_NEW_ROUTES.some((re) => re.test(route))),
  };
}

/** A failing comparison: a changed or a removed existing route, or an empty table. */
export function routeTableFails(
  base: RouteTable,
  branch: RouteTable,
  comparison: RouteTableComparison,
): string[] {
  const out: string[] = [];
  if (base.size === 0) out.push('the base build log holds no route table');
  if (branch.size === 0) out.push('the branch build log holds no route table');
  for (const line of comparison.changed) out.push(`marker changed: ${line}`);
  for (const route of comparison.removed) out.push(`route missing on the branch: ${route}`);
  return out;
}

/** A fictional id for a parameterised route's one asked record (no lab data in this file). */
export const FICTIONAL_PARAM = '0d3c2b1a-0000-4000-8000-0000000000b5';

/**
 * Route prefixes headers-parity.spec.ts never GETs: route handlers whose GET
 * may act (the API, the auth callbacks and the session-ended sign-out) and
 * the analytics tunnels.
 */
export const NOT_ASKED: readonly RegExp[] = [
  /^\/api(\/|$)/u,
  /^\/auth(\/|$)/u,
  /^\/ingest(\/|$)/u,
  /^\/monitoring(\/|$)/u,
];

/**
 * The paths headers parity asks, from a build's route table: every app route
 * (static and dynamic), each `[param]` segment filled with FICTIONAL_PARAM
 * and a catch-all with one segment (`[[...x]]` with none), so each
 * parameterised family is asked once; Next's own `/_...` entries and
 * NOT_ASKED are left out. Sorted, without repeats.
 */
export function pathsToAsk(table: RouteTable): string[] {
  const out = new Set<string>();
  for (const key of table.keys()) {
    if (!key.startsWith('app ')) continue;
    const route = key.slice('app '.length);
    if (route.split('/').some((segment) => segment.startsWith('_'))) continue;
    if (NOT_ASKED.some((re) => re.test(route))) continue;
    const path =
      route
        .split('/')
        .map((segment) => {
          if (/^\[\[\.\.\.[^\]]+\]\]$/u.test(segment)) return null;
          if (/^\[\.\.\.[^\]]+\]$/u.test(segment)) return 'x';
          if (/^\[[^\]]+\]$/u.test(segment)) return FICTIONAL_PARAM;
          return segment;
        })
        .filter((segment) => segment !== null)
        .join('/') || '/';
    out.add(path);
  }
  return [...out].sort();
}
