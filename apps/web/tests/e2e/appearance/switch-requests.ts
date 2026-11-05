/**
 * Which requests a look switch may make (Liquid Glass plan 8.2: "no data
 * request during a switch, apart from the appearance save and the scene
 * images"). Pure, so a unit test proves the rules
 * (src/test/appearance-switch-requests.test.ts); the transition specs feed it
 * Playwright's requests through orders-look.ts.
 *
 * Allowed while the look changes:
 *  - the account save, and only it: a server action POST whose body is
 *    setMyAppearanceAction's one argument ({ userId, style?, theme? }, at
 *    least one of the two, nothing else), always under the action id of the
 *    first such save. Every other server action is a data read or write
 *    (getMyAppearanceAction among them: a switch never reads the account
 *    row), and so is a second action that only looks like the save;
 *  - POST /api/appearance/style (the Design cookie route);
 *  - GET of the scene photos (/liquid-glass/...) and the build's own static
 *    files (/_next/static/...);
 *  - analytics and error reporting (PostHog, Sentry and its /monitoring
 *    tunnel), which read no data;
 *  - a router prefetch of a link the page already held when the watch began,
 *    other than the page itself: the router warming a link that a new layout
 *    brought into view, never a read of the page's own data.
 * Everything else counts: a refresh of the page (an RSC request without the
 * prefetch header), a prefetch of the page itself or of a link the page did
 * not hold, an API route, the database, storage.
 */

/** The parts of one request the rules read (Playwright's Request, reduced). */
export interface SeenRequest {
  method: string;
  url: string;
  /** Lower-case names, as Playwright gives them. */
  headers: Record<string, string>;
  postData: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STYLES = new Set(['liquid-glass', 'classic']);
const THEMES = new Set(['light', 'dark', 'system']);
/** How React's reply encoder writes a property that is present but undefined. */
const UNDEFINED = '$undefined';

/** True when `body` is setMyAppearanceAction's argument list, as the browser sends it. */
export function isAppearanceSaveBody(body: string | null): boolean {
  if (body === null) return false;
  let args: unknown;
  try {
    args = JSON.parse(body);
  } catch {
    return false;
  }
  if (!Array.isArray(args) || args.length !== 1) return false;
  const input: unknown = args[0];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== 'userId' && key !== 'style' && key !== 'theme')) {
    return false;
  }
  if (typeof fields.userId !== 'string' || !UUID.test(fields.userId)) return false;
  const named = (value: unknown, allowed: Set<string>): boolean | null => {
    if (value === undefined || value === UNDEFINED) return null;
    return typeof value === 'string' && allowed.has(value);
  };
  const style = named(fields.style, STYLES);
  const theme = named(fields.theme, THEMES);
  if (style === false || theme === false) return false;
  return style === true || theme === true;
}

export interface SwitchRequestFilter {
  /** null for a request a switch may make; otherwise why it counts. */
  verdict(request: SeenRequest): string | null;
}

/**
 * The rules for one page: `pageUrl` is where the page is when the watch
 * begins, `linkHrefs` the href of every link it holds then.
 */
export function switchRequestFilter(options: {
  pageUrl: string;
  linkHrefs: Iterable<string>;
}): SwitchRequestFilter {
  const page = new URL(options.pageUrl);
  const prefetchable = new Set<string>();
  for (const href of options.linkHrefs) {
    let target: URL;
    try {
      target = new URL(href, page);
    } catch {
      continue;
    }
    if (target.origin === page.origin && target.pathname !== page.pathname) {
      prefetchable.add(target.pathname);
    }
  }
  let saveAction: string | null = null;

  return {
    verdict(request) {
      const url = new URL(request.url);
      if (url.protocol === 'data:' || url.protocol === 'blob:') return null;
      if (/posthog|sentry/iu.test(url.hostname)) return null;
      if (url.origin !== page.origin) return 'a request to another host';
      if (url.pathname === '/monitoring' || url.pathname.startsWith('/monitoring/')) return null;
      const method = request.method.toUpperCase();
      const action = request.headers['next-action'];
      if (method === 'POST' && action) {
        if (!isAppearanceSaveBody(request.postData)) return `server action ${action}`;
        saveAction ??= action;
        return action === saveAction ? null : `server action ${action} (not the save's)`;
      }
      if (method === 'POST' && url.pathname === '/api/appearance/style') return null;
      if (method === 'GET' && url.pathname.startsWith('/liquid-glass/')) return null;
      if (method === 'GET' && url.pathname.startsWith('/_next/static/')) return null;
      if (request.headers['next-router-prefetch']) {
        if (url.pathname === page.pathname) return 'a prefetch of the page itself';
        return prefetchable.has(url.pathname)
          ? null
          : `a prefetch of ${url.pathname}, which no link on the page named`;
      }
      return 'a data request';
    },
  };
}
