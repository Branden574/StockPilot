// Signed-in sessions for the k6 load tests, on the LOCAL stack.
//
// In setup(), for each synthetic account in the seeder's manifest, one
// password sign-in: POST {supabase}/auth/v1/token?grant_type=password with the
// anon key, the same call the app's sign-in makes. GoTrue answers a session
// (access_token, refresh_token, user). The access token is the bearer for
// /api/*; the same session, encoded the way @supabase/ssr stores it
// (lib/cookie.js), is the cookie for the pages.
//
// The accounts' passwords are never stored: the seeder sets each one to
// HMAC-SHA256(service key, "stockpilot-loadtest:" + email), and setup()
// derives it again here. Sign-in links are not used: the repository allows
// only its two browser harnesses to make them (confirm-landing.test.ts).
//
// setup() then proves each account is who the run thinks it is:
//   - GET /api/v1/me/permissions answers 200 with the expected role, and a
//     read the authenticator rule gates (/api/search) answers 200: a wrong
//     role or an `mfa_required`/`aal2_required` answer stops the run;
//   - one page per role answers 200 to the cookie, not a redirect to sign-in.
//
// The service key is read from the environment only inside mintSessions(),
// which only setup() calls. It is never returned, logged or tagged; the data
// setup() hands the VUs holds the tokens and cookies, never the key.
import http from 'k6/http';
import { check, fail } from 'k6';
import { hmac } from 'k6/crypto';

import { cookieHeader } from './cookie.js';
import { assertRequestUrl } from './safety.js';

/** The role each synthetic group signs in as (the restricted staff is staff). */
export const DB_ROLE = {
  owner: 'owner',
  admin: 'admin',
  manager: 'manager',
  staff: 'staff',
  viewer: 'viewer',
  staff_one_warehouse: 'staff',
};

/**
 * The password the seeder gave an account (tools/seed.mjs accountPassword():
 * the same HMAC, hex, wrapped so it meets the stack's password rules).
 */
export function accountPassword(serviceKey, email) {
  return `Lt9x${hmac('sha256', serviceKey, `stockpilot-loadtest:${email}`, 'hex').slice(0, 32)}Q`;
}

function post(url, body, headers, name) {
  return http.post(assertRequestUrl(url), JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...headers },
    tags: { name, kind: 'setup_auth' },
    redirects: 0,
  });
}

/**
 * Sessions for up to `perRole` accounts of each role in `roles`.
 * Returns { [role]: [{ userId, email, bearer, cookie }] }. SETUP ONLY.
 */
export function mintSessions(target, manifest, roles, perRole) {
  // Read here and nowhere else (see the header).
  const serviceKey = __ENV.LOADTEST_SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = __ENV.LOADTEST_SUPABASE_ANON_KEY;
  if (!serviceKey)
    fail('LOADTEST_SUPABASE_SERVICE_ROLE_KEY is not set (the local stack service key).');
  if (!anonKey) fail('LOADTEST_SUPABASE_ANON_KEY is not set (the local stack anon key).');

  const out = {};
  for (const role of roles) {
    const accounts = (manifest.users[role] || []).slice(0, perRole);
    if (accounts.length === 0) fail(`The manifest has no ${role} accounts.`);
    out[role] = [];
    for (const acct of accounts) {
      const password = accountPassword(serviceKey, acct.email);
      const res = post(
        `${target.supabaseUrl}/auth/v1/token?grant_type=password`,
        { email: acct.email, password },
        { apikey: anonKey },
        'auth/token',
      );
      let session = null;
      try {
        session = res.json();
      } catch (_e) {
        session = null;
      }
      if (res.status !== 200 || !session || typeof session.access_token !== 'string') {
        fail(`Signing in a ${role} account answered ${res.status}.`);
      }
      if (!session.user || session.user.id !== acct.id) {
        fail(`Signing in a ${role} account returned a different user.`);
      }
      out[role].push({
        userId: acct.id,
        email: acct.email,
        bearer: session.access_token,
        cookie: cookieHeader(target.supabaseUrl, session),
      });
    }
  }
  return out;
}

/**
 * Stops the run unless every session answers /api/v1/me/permissions with its
 * role, and one page per role opens with the cookie (200, not a redirect).
 */
export function proveSessions(target, sessions, pagePath = '/dashboard') {
  for (const role of Object.keys(sessions)) {
    for (const s of sessions[role]) {
      const res = http.get(assertRequestUrl(`${target.baseUrl}/api/v1/me/permissions`), {
        headers: { Authorization: `Bearer ${s.bearer}`, Accept: 'application/json' },
        tags: { name: 'setup/me/permissions', kind: 'setup' },
        redirects: 0,
      });
      let body = null;
      try {
        body = res.json();
      } catch (_e) {
        body = null;
      }
      const err = body && body.error;
      if (err === 'mfa_required' || err === 'aal2_required') {
        fail(
          `A ${role} account was asked for an authenticator (${err}). The seeded organization must not require one.`,
        );
      }
      if (res.status !== 200 || !body || body.role !== DB_ROLE[role]) {
        fail(
          `A ${role} account answered /api/v1/me/permissions with ${res.status} and role ${body && body.role}; expected ${DB_ROLE[role]}.`,
        );
      }
      // /api/v1/me/permissions answers the role even when the session still
      // owes an authenticator; a gated read says so (403 mfa_required).
      const gated = http.get(assertRequestUrl(`${target.baseUrl}/api/search?q=zz`), {
        headers: { Authorization: `Bearer ${s.bearer}`, Accept: 'application/json' },
        tags: { name: 'setup/search', kind: 'setup' },
        redirects: 0,
      });
      if (gated.status !== 200) {
        const why = /"(mfa_required|aal2_required)"/.test(String(gated.body).slice(0, 500))
          ? 'was asked for an authenticator. The seeded organization must not require one.'
          : `answered a gated read with ${gated.status}.`;
        fail(`A ${role} account ${why}`);
      }
    }
    const first = sessions[role][0];
    const page = http.get(assertRequestUrl(`${target.baseUrl}${pagePath}`), {
      headers: { Cookie: first.cookie },
      tags: { name: `setup/page`, kind: 'setup' },
      redirects: 0,
    });
    const ok = check(page, {
      'setup: session cookie opens a page (200, not a sign-in redirect)': (r) => r.status === 200,
    });
    if (!ok) {
      const where = page.headers.Location || page.headers.location || '';
      fail(`The ${role} session cookie did not open ${pagePath}: ${page.status} ${where}`);
    }
  }
}
