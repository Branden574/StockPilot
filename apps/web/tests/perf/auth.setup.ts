import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test as setup } from '@playwright/test';

import { toRouteTemplate } from '../../src/lib/perf/route-template';
import { authStatePath, identityPath, isLoopback } from './paths';
import { endSavedSession } from './session';
import { serviceKey, supabaseOrigin } from './supabase-admin';

/**
 * Signs in ONCE per run and saves the session cookies for the scenarios.
 *
 * Two modes, chosen by which variables are present:
 *
 *   magic link PERF_USER_EMAIL + PERF_SUPABASE_URL + a service key
 *              (SUPABASE_SERVICE_ROLE_KEY in the process env, or in the file
 *              PERF_ENV_FILE points at). Mints a one-time sign-in link through
 *              the Supabase admin API and walks /auth/confirm. No password is
 *              typed, stored or needed, which is what a production QA account
 *              wants. No email is sent.
 *
 *   password   PERF_USER_EMAIL + PERF_USER_PASSWORD, LOCAL TARGETS ONLY.
 *              Playwright writes whatever was typed into a form into its own
 *              call log, so a password must never be typed at a remote site.
 *
 * NOTHING SECRET IS EVER PRINTED, in either mode. Playwright quotes URLs,
 * selectors and `fill()` arguments in its error messages, so every step that
 * touches a credential catches and rethrows a FIXED message, and the page is
 * blanked before the throw so no typed value is left in the DOM. The perf
 * config also switches off Playwright's failure snapshot, which would otherwise
 * serialize every input's value (password fields included) to disk.
 */

const STEP_TIMEOUT = 15_000;

async function mintTokenHash(origin: string, key: string, email: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${origin}/auth/v1/admin/generate_link`, {
      method: 'POST',
      // A redirect would forward the key to another host.
      redirect: 'error',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email }),
    });
  } catch {
    throw new Error(
      'generate_link request failed (details withheld: the request carries the service key).',
    );
  }
  if (!res.ok) throw new Error(`generate_link answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { hashed_token?: string };
  if (!body.hashed_token) throw new Error('generate_link returned no hashed_token');
  return body.hashed_token;
}

setup('sign in', async ({ page, baseURL }) => {
  const email = process.env.PERF_USER_EMAIL;
  const password = process.env.PERF_USER_PASSWORD;
  const supabaseUrl = process.env.PERF_SUPABASE_URL;
  const targetHost = new URL(baseURL ?? 'http://localhost:3000').hostname;

  // A run that was interrupted (Ctrl-C skips the teardown project) leaves a
  // live session on disk. End and delete whatever is there before making more.
  const authDir = path.dirname(authStatePath());
  if (existsSync(authDir)) {
    for (const name of readdirSync(authDir)) {
      if (name.endsWith('.json') && !name.endsWith('.identity.json'))
        await endSavedSession(path.join(authDir, name));
    }
  }

  if (!email) throw new Error('Perf sign-in needs PERF_USER_EMAIL.');
  if (!process.env.PERF_ROLE) {
    throw new Error(
      'Set PERF_ROLE to name this account (for example "admin" or "staff-restricted"); a run is never labelled by default.',
    );
  }

  if (supabaseUrl) {
    // The minted link signs in as the account, so it goes only to a host that
    // is known to be ours, and only over TLS.
    const target = new URL(baseURL ?? 'http://localhost:3000');
    const allowed =
      isLoopback(target.hostname) ||
      (target.protocol === 'https:' &&
        (target.hostname === 'stockpilotusa.com' ||
          target.hostname === 'www.stockpilotusa.com' ||
          target.hostname === process.env.PERF_ALLOW_HOST));
    if (!allowed) {
      throw new Error(
        'Magic-link sign-in is only sent to stockpilotusa.com, a local target, or the https host named in PERF_ALLOW_HOST.',
      );
    }
    const key = serviceKey();
    if (!key)
      throw new Error(
        'Magic-link sign-in needs a service key (SUPABASE_SERVICE_ROLE_KEY or PERF_ENV_FILE).',
      );
    const tokenHash = await mintTokenHash(supabaseOrigin(supabaseUrl), key, email);
    try {
      await page.goto(
        `/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&next=%2Fdashboard`,
        {
          timeout: STEP_TIMEOUT * 2,
        },
      );
      // /auth/confirm shows a confirm step so an email scanner that merely
      // fetches the link cannot burn it.
      await page
        .getByRole('button', { name: /continue to stockpilot/i })
        .click({ timeout: STEP_TIMEOUT });
    } catch {
      await page.goto('about:blank').catch(() => {});
      throw new Error(
        'The sign-in link could not be opened (details withheld: the URL is a credential).',
      );
    }
  } else if (password) {
    if (!isLoopback(targetHost)) {
      throw new Error(
        'Password sign-in is for local targets only. Use magic-link sign-in (PERF_SUPABASE_URL) for a remote site.',
      );
    }
    try {
      await page.goto('/signin', { timeout: STEP_TIMEOUT * 2 });
      await page.getByLabel(/email/i).fill(email, { timeout: STEP_TIMEOUT });
      await page.getByLabel('Password', { exact: true }).fill(password, { timeout: STEP_TIMEOUT });
      await page.getByRole('button', { name: /sign in/i }).click({ timeout: STEP_TIMEOUT });
    } catch {
      await page.goto('about:blank').catch(() => {});
      throw new Error(
        'The sign-in form could not be completed (details withheld: the call log quotes what was typed).',
      );
    }
  } else {
    throw new Error(
      'Perf sign-in needs PERF_SUPABASE_URL with a service key, or PERF_USER_PASSWORD for a local target.',
    );
  }

  try {
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  } catch {
    const stoppedOn = toRouteTemplate(page.url());
    await page.goto('about:blank').catch(() => {});
    throw new Error(
      `Sign-in did not reach the dashboard (stopped on ${stoppedOn}). An MFA prompt cannot be automated.`,
    );
  }

  // The role in the results is what the SERVER says this session is, never
  // what the operator typed. PERF_ROLE stays as a label beside it.
  const me = await page.request.get('/api/v1/me/permissions').catch(() => null);
  const role = me?.ok()
    ? (((await me.json().catch(() => null)) as { role?: string } | null)?.role ?? null)
    : null;

  const statePath = authStatePath();
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  await page.context().storageState({ path: statePath });
  // A storage state IS a signed-in session: owner-readable only.
  chmodSync(statePath, 0o600);
  writeFileSync(identityPath(), JSON.stringify({ verifiedRole: role }), { mode: 0o600 });
});
