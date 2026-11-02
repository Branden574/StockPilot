/**
 * The two auth calls readVerifiedSessionClaims (lib/auth/verified-claims.ts)
 * makes on a cookie client, for unit tests that fake the client: getSession(),
 * for the stored access token, then getClaims(token), the verified read.
 *
 * The stub answers for a session whose verified token names `sub` at `aal`, so
 * a test chooses both the level the cookie path reads AND whose session it is:
 * a session that refreshed into another account mid-request has another `sub`
 * (docket S43a, review round 1).
 *
 * The token is unsigned on purpose: the stub's getClaims stands in for
 * auth-js's verified read, which src/lib/auth/verified-claims.test.ts and
 * src/lib/auth/api-context.refresh-swap.test.ts run for real.
 */
export interface StubbedCookieSession {
  /** The verified token's subject. */
  sub: string;
  /** The verified token's `aal` claim; null leaves the claim out. */
  aal: 'aal1' | 'aal2' | null;
  /** How the session load goes: answered (default), an error answer, or a throw. */
  read?: 'answer' | 'error' | 'throw';
}

const seg = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function unsignedToken(session: StubbedCookieSession): string {
  return `${seg({ alg: 'none', typ: 'JWT' })}.${seg({
    sub: session.sub,
    ...(session.aal ? { aal: session.aal } : {}),
  })}.`;
}

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

/**
 * `auth.getSession` and `auth.getClaims` for a fake client. `record` hears
 * 'getSession' and 'getClaims' as they are called.
 */
export function verifiedSessionAuth(
  session: () => StubbedCookieSession,
  record: (call: 'getSession' | 'getClaims') => void = () => {},
) {
  return {
    getSession: async () => {
      record('getSession');
      const current = session();
      if (current.read === 'throw') throw new Error('session storage unreadable');
      if (current.read === 'error') {
        return {
          data: { session: null },
          error: { name: 'AuthSessionMissingError', message: 'Auth session missing!' },
        };
      }
      return { data: { session: { access_token: unsignedToken(current) } }, error: null };
    },
    getClaims: async (token: string) => {
      record('getClaims');
      return { data: { claims: payloadOf(token), header: {}, signature: null }, error: null };
    },
  };
}
