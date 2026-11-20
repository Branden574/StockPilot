// Safety rails shared by every k6 scenario and every load-test tool.
//
// The load tests run against a LOCAL build of the app and a LOCAL Supabase
// stack only. Every address they are given must name this machine
// (127.0.0.1 or [::1], written as those literal addresses); anything else stops the run before the
// first request. There is no default address anywhere: a missing address is
// refused the same way.
//
// This file has no k6 imports, so the Node tools (seeder, teardown, checks)
// and the vitest guard test import the same rules.

/** The host names this machine answers to. Compared in lower case. */
// Literal addresses only. `localhost` is a name: an environment proxy
// (Node's NODE_USE_ENV_PROXY with HTTP_PROXY) sends requests for it through the
// proxy, where 127.0.0.1 goes direct, and a hosts file or a k6 `hosts` option
// can point it anywhere. A name is never compared, so none of that applies.
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '[::1]']);

// scheme://[userinfo@]host[:port][/?#...]  The userinfo part is matched only
// so that the host after it is the one compared ("localhost@example.com" is
// the host example.com).
const URL_RE =
  /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#\\]*@)?(\[[^\]/?#]*\]|[^:/?#\\]*)(?::(\d{1,5}))?(?:[/?#]|$)/i;

export class UnsafeTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeTargetError';
  }
}

/**
 * The host of an address, lower case, or null when the address cannot be read.
 * Refuses spaces, control characters and backslashes outright: a browser and a
 * parser can disagree about where the host ends when they are present.
 */
export function hostOf(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(value)) return null;
  const m = URL_RE.exec(value);
  if (!m) return null;
  return m[2].toLowerCase();
}

/** True when `value` is an address on this machine. */
export function isLoopbackUrl(value) {
  const host = hostOf(value);
  return host !== null && LOOPBACK_HOSTS.includes(host);
}

/**
 * The address with no trailing slash, or a thrown UnsafeTargetError naming the
 * setting (never its value: a database address carries a password).
 */
export function assertLoopbackUrl(name, value, schemes = ['http']) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UnsafeTargetError(
      `${name} is not set. The load tests have no default address; give a local one (http://127.0.0.1:<port>).`,
    );
  }
  const v = value.trim();
  const m = URL_RE.exec(v);
  const scheme = m ? m[1].toLowerCase() : '';
  if (!m || !schemes.includes(scheme)) {
    throw new UnsafeTargetError(`${name} is not a ${schemes.join(' or ')} address.`);
  }
  if (!isLoopbackUrl(v)) {
    throw new UnsafeTargetError(
      `${name} does not point at this machine. The load tests run against 127.0.0.1 or [::1] only (not the name localhost).`,
    );
  }
  return v.replace(/\/+$/, '');
}

/**
 * The local targets every scenario uses. Call it at the top level of each
 * scenario (k6's init stage), so a bad address stops the run before setup().
 *
 *   LOADTEST_BASE_URL       the app, e.g. http://127.0.0.1:3600 (required)
 *   LOADTEST_SUPABASE_URL   the local Supabase API (required unless
 *                           `needSupabase` is false)
 */
export function localTarget(env, { needSupabase = true } = {}) {
  // An old variable name from the earlier suite is not read: a shell that
  // still exports BASE_URL for some other tool must not steer a load test.
  const baseUrl = assertLoopbackUrl('LOADTEST_BASE_URL', env.LOADTEST_BASE_URL);
  const supabaseUrl = needSupabase
    ? assertLoopbackUrl('LOADTEST_SUPABASE_URL', env.LOADTEST_SUPABASE_URL)
    : null;
  return { baseUrl, supabaseUrl };
}

/** The local database address, or a thrown UnsafeTargetError. */
export function assertLoopbackDbUrl(name, value) {
  return assertLoopbackUrl(name, value, ['postgres', 'postgresql']);
}

/**
 * Every address a request is about to go to passes through here as well, so
 * a scenario that builds an address by hand still cannot leave this machine.
 */
export function assertRequestUrl(url) {
  if (!isLoopbackUrl(url)) {
    throw new UnsafeTargetError('A load-test request was about to leave this machine. Stopped.');
  }
  return url;
}
