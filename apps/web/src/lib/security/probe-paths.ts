/**
 * Scanner paths: addresses no page of this app has, that automated scanners
 * ask every site for (a settings file, source control files, WordPress pages,
 * a PHP script, a database admin tool, a file outside the site). next.config.ts
 * rewrites each of them, before the filesystem, to
 * /api/security/probe/<kind>, which answers a plain-text 404 ("Not found",
 * text/plain, never cached), the same for every method and every kind, and
 * records the request as a security event (exploit / blocked / <kind>).
 *
 * That answer is NOT the app's own not-found page: an address that simply
 * does not exist gets the HTML page, a probe path gets bare text. So a probe
 * path can be told apart from an unknown address, and a person who types one
 * sees the bare text. Nothing is served and nothing about the kind is said
 * either way.
 *
 * Plain module, NO IMPORTS: next.config.ts imports it, and a config may
 * import only modules that import nothing. The kinds are written out here and
 * probe-paths.test.ts pins them to core's SECURITY_PROBE_KINDS.
 *
 * Next compiles each rule without case and with an optional trailing slash,
 * for next start and for the routes-manifest Vercel reads alike
 * (probe-paths.test.ts runs both of Next's own matchers). A rule here must
 * never take an address the app serves: probe-paths.test.ts checks every page,
 * route and public file, and /.well-known/*, against every rule.
 */

/** The probe kinds, as core's SECURITY_PROBE_KINDS spells them. */
export const PROBE_KINDS = [
  'env_file',
  'git_dir',
  'wordpress',
  'php_file',
  'admin_tool',
  'path_traversal',
] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

/** The route every rule rewrites to, with the kind as its last segment. */
export const PROBE_ROUTE_PREFIX = '/api/security/probe/';

/**
 * One path segment that is not a dot segment and does not start with a dot:
 * so `..`, `.well-known` and every other dot directory are never a segment
 * the general rules (php_file, a nested settings file) walk through.
 */
const SEGMENT = '[A-Za-z0-9_~%-][A-Za-z0-9_.~%-]{0,99}';

/** A settings file: .env, or .env.<name> (.env.local, .env.production). */
const ENV_FILE = '\\.env(?:\\.[A-Za-z0-9_-]{1,32})?';

/** A segment that is either a plain segment or `..` (path_traversal only). */
const TRAVERSAL_SEGMENT = `\\.\\.|${SEGMENT}`;

export type ProbeRule = { readonly kind: ProbeKind; readonly source: string };

/**
 * The rules, most specific first (a request takes the first rule it matches,
 * and php_file, the widest, is last).
 */
export const PROBE_RULES: readonly ProbeRule[] = [
  // /.env, /.env.local, /api/.env, /backend/core/.env.production.
  { kind: 'env_file', source: `/:dirs(${SEGMENT})*/:file(${ENV_FILE})` },
  // /.git, /.git/config, /app/.git/HEAD (never /.gitignore or /.github).
  { kind: 'git_dir', source: `/:dirs(${SEGMENT})*/.git/:rest*` },
  // WordPress folders at the root, and its well-known scripts at any depth.
  {
    kind: 'wordpress',
    source: '/:wp(wp-admin|wp-content|wp-includes|wp-json|wordpress|wp)/:rest*',
  },
  {
    kind: 'wordpress',
    source: `/:dirs(${SEGMENT})*/:wp(wp-login\\.php|xmlrpc\\.php|wp-config\\.php(?:\\.[A-Za-z0-9_~-]{1,16})?|wp-cron\\.php|wp-signup\\.php)`,
  },
  // Database and server admin tools at the root.
  {
    kind: 'admin_tool',
    source:
      '/:tool(phpmyadmin(?:[-_.]?[0-9][0-9.]*)?|pma|myadmin|mysqladmin|adminer|adminer\\.php|dbadmin|sqladmin|actuator|server-status|server-info|solr)/:rest*',
  },
  { kind: 'admin_tool', source: '/manager/html/:rest*' },
  // A system file named in the path (after any `..` segments a client sent
  // unresolved), and a segment that steps out of the site with an encoded
  // dot-dot-slash or dot-dot-backslash.
  {
    kind: 'path_traversal',
    source: `/:dirs(${TRAVERSAL_SEGMENT})*/:target(etc/passwd|etc/shadow|etc/hosts|proc/self/environ|win\\.ini|windows/win\\.ini|boot\\.ini)`,
  },
  // The work this rule can take grows with the square of the number of
  // segments. It is bounded by the longest path a server accepts, not by the
  // rule: probe-paths.test.ts pins that length and the time at it. A rule
  // that must hold without that cap would give :dirs a fixed depth.
  {
    kind: 'path_traversal',
    source: `/:dirs(${TRAVERSAL_SEGMENT})*/:seg([^/]*(?:\\.\\.|%2e%2e|%2e\\.|\\.%2e|%252e%252e)(?:%2f|%5c|%252f|%255c|\\\\)[^/]*)/:rest*`,
  },
  // Any other PHP script, at any depth that has no dot directory.
  { kind: 'php_file', source: `/:dirs(${SEGMENT})*/:file(${SEGMENT}\\.(?:php[0-9]?|phtml))` },
];

/** The rewrites next.config.ts appends to beforeFiles, after the marketing ones. */
export function probeRewrites(): Array<{ source: string; destination: string }> {
  return PROBE_RULES.map((rule) => ({
    source: rule.source,
    destination: `${PROBE_ROUTE_PREFIX}${rule.kind}`,
  }));
}
