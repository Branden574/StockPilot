import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PIN: every push-token write must go through register_push_token.
 *
 * THE BUG (SP-073): `push_tokens` carries exactly one policy —
 * push_tokens_self `using (user_id = auth.uid())` — so a raw
 * `upsert(..., { onConflict: 'token' })` cannot rebind a token row still owned
 * by a PREVIOUS user of the handset. Postgres answers "new row violates
 * row-level security policy", and in use-push-notifications.ts that error was
 * swallowed by a best-effort catch: the device kept the old binding and
 * silently received the previous user's notifications.
 *
 * The API route was fixed alongside the 0348 migration; THIS file is the
 * second, primary call site (it runs on sign-in and on every user change) and
 * was missed by that pass. Both are pinned here so a future edit cannot
 * reintroduce a raw write on either side.
 */

const MOBILE_LIB = __dirname;
const WEB_ROUTE = path.resolve(
  __dirname,
  '../../../web/src/app/api/v1/push/register/route.ts',
);

/** Source with comments removed — the route's header QUOTES the old raw
 *  upsert to explain what went wrong, and a naive grep would match that. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('push token registration goes through the RPC (SP-073)', () => {
  it('the mobile hook calls register_push_token and never a raw push_tokens upsert', () => {
    const src = readFileSync(path.join(MOBILE_LIB, 'use-push-notifications.ts'), 'utf8');
    expect(src).toMatch(/rpc\(\s*'register_push_token'/);
    // The raw write must be gone: an upsert here cannot rebind another user's token.
    expect(codeOnly(src)).not.toMatch(/from\('push_tokens'\)\s*\.\s*upsert/);
    // And the failure must not be swallowed silently any more.
    expect(src).toMatch(/if \(registerErr\) throw registerErr/);
  });

  it('the web Bearer twin also uses the RPC', () => {
    const src = readFileSync(WEB_ROUTE, 'utf8');
    expect(src).toMatch(/register_push_token/);
    // Comments stripped: the header deliberately quotes the old raw upsert.
    expect(codeOnly(src)).not.toMatch(/from\('push_tokens'\)\s*\.\s*upsert/);
  });
});
