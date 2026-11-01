import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security invariant: server code never decides anything from the auth
 * cookie as stored.
 *
 * On a server client (createServerClient from @supabase/ssr), getSession()
 * returns the cookie's session as written, and
 * auth.mfa.getAuthenticatorAssuranceLevel() with no argument decodes that
 * session's token without checking its signature and reads its stored user
 * object. auth-js wraps the stored user and logs "Using the user object as
 * returned from supabase.auth.getSession() ... could be insecure!" when it is
 * read before getUser() has run on the same client. Production logged it on
 * the dashboard pages and actions of members with an authenticator: the
 * dashboard layout and withContext() called getAuthenticatorAssuranceLevel()
 * on fresh clients. Verified reads go through lib/auth/verified-claims.ts
 * (getClaims, falling back to the Auth server).
 *
 * Every remaining server-side call is listed with the number of calls and why
 * it is safe, so a new one fails here until someone reasons about it.
 * Browser code ('use client') is out of scope: there the stored session is the
 * browser's own and auth-js does not warn.
 */

const SRC = path.resolve(__dirname, '../..');

const GET_SESSION = /\.auth\.getSession\(\)/g;
const AAL_NO_ARGUMENT = /\.auth\.mfa\.getAuthenticatorAssuranceLevel\(\)/g;

/** Server files allowed to call getSession(), with the count and the reason. */
const GET_SESSION_ALLOWED: Record<string, { calls: number; why: string }> = {
  'lib/auth/verified-claims.ts': {
    calls: 1,
    why: 'reads only access_token, for the Auth server to verify (getUser(token)) when getClaims() cannot answer locally',
  },
};

/**
 * Server files allowed to call getAuthenticatorAssuranceLevel() with no
 * argument: each runs only after the same client verified the session with
 * the Auth server (getUser(), listFactors() which calls it, or a sign-in that
 * GoTrue just answered), which is also when auth-js stops warning.
 */
const AAL_ALLOWED: Record<string, { calls: number; why: string }> = {
  'app/(auth)/signin/mfa/page.tsx': { calls: 1, why: 'after getUser() and listFactors()' },
  'server/actions/auth.ts': {
    calls: 3,
    why: 'sign in: after signInWithPassword(); password reset and change password: after getUser() and listFactors()',
  },
  'server/actions/profile.ts': { calls: 1, why: 'after listFactors()' },
  'server/actions/email-change.ts': { calls: 1, why: 'after getUser() and listFactors()' },
  'lib/auth/api-context.ts': { calls: 1, why: 'cookie path, after getUser() on the same client' },
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** The code without its comments, so prose that names a call is not a call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function isClientModule(source: string): boolean {
  return /^\s*['"]use client['"]/.test(source);
}

function census(pattern: RegExp): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of files(SRC)) {
    const source = readFileSync(file, 'utf8');
    if (isClientModule(source)) continue;
    const count = code(source).match(pattern)?.length ?? 0;
    if (count > 0) found.set(path.relative(SRC, file), count);
  }
  return found;
}

describe('server code reads the session only through verified calls', () => {
  it('getSession() appears only where it is listed, as often as listed', () => {
    const found = Object.fromEntries(census(GET_SESSION));
    const expected = Object.fromEntries(
      Object.entries(GET_SESSION_ALLOWED).map(([file, { calls }]) => [file, calls]),
    );
    expect(found).toEqual(expected);
  });

  it('getAuthenticatorAssuranceLevel() with no argument appears only where it is listed, as often as listed', () => {
    const found = Object.fromEntries(census(AAL_NO_ARGUMENT));
    const expected = Object.fromEntries(
      Object.entries(AAL_ALLOWED).map(([file, { calls }]) => [file, calls]),
    );
    expect(found).toEqual(expected);
  });

  it('the census sees what it is for (control): both shapes, in code and not in comments', () => {
    const sample = [
      "'use server';",
      'const { data } = await supabase.auth.getSession();',
      '// await supabase.auth.mfa.getAuthenticatorAssuranceLevel();',
      '/* supabase.auth.getSession() */',
      'const aal = await ctx.supabase.auth.mfa.getAuthenticatorAssuranceLevel();',
      "const url = 'https://example.com/a';",
    ].join('\n');
    expect(isClientModule(sample)).toBe(false);
    expect(code(sample).match(GET_SESSION)?.length).toBe(1);
    expect(code(sample).match(AAL_NO_ARGUMENT)?.length).toBe(1);
    expect(code(sample)).toContain('https://example.com/a');
    expect(isClientModule("'use client';\nexport {}")).toBe(true);
    // The browser modules that do call getSession() exist, and are skipped.
    const clientCallers = files(SRC).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return isClientModule(source) && (code(source).match(GET_SESSION)?.length ?? 0) > 0;
    });
    expect(clientCallers.length).toBeGreaterThanOrEqual(2);
  });
});
