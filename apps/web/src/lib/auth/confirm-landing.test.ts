import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONFIRM_FALLBACK_LANDING, CONFIRM_LANDINGS, confirmLanding } from './confirm-landing';

/**
 * Security invariant (docket S14 review, INV-E5): where an emailed
 * confirmation link lands is fixed by its type, not chosen by the link.
 *
 * Any page can send a browser to /auth/confirm with a link it holds for its
 * own account and its own `next`; the person then presses the button on the
 * app's own page (the post is same-origin, so Sec-Fetch-Site cannot tell). With
 * `next` free, that page also chose where its account opened: a data-entry
 * page, Billing, an integration to connect. Each type now lands where the app's
 * own emails and its sign-in tools send it, and the sweeps below fail when an
 * email or a test harness starts sending another landing without this list
 * being changed with it.
 */

describe('confirmLanding', () => {
  it("each type keeps the landings the app's own emails and sign-in tools use", () => {
    expect(confirmLanding('recovery', '/reset/complete')).toBe('/reset/complete');
    expect(confirmLanding('invite', '/reset/complete')).toBe('/reset/complete');
    expect(confirmLanding('invite', '/portal')).toBe('/portal');
    expect(confirmLanding('magiclink', '/portal')).toBe('/portal');
    expect(confirmLanding('magiclink', '/dashboard')).toBe('/dashboard');
  });

  it('any other next lands on the first landing of its type: never a page inside the account', () => {
    for (const next of [
      '/dashboard/items/new',
      '/dashboard/settings/billing',
      '/dashboard/settings/integrations',
      '/portal/x',
      '/',
      '',
    ]) {
      expect(confirmLanding('recovery', next), next).toBe('/reset/complete');
      expect(confirmLanding('invite', next), next).toBe('/reset/complete');
      expect(confirmLanding('magiclink', next), next).toBe('/dashboard');
    }
    expect(confirmLanding('recovery', '/dashboard')).toBe('/reset/complete');
    expect(confirmLanding('invite', '/dashboard')).toBe('/reset/complete');
    expect(confirmLanding('recovery', null)).toBe('/reset/complete');
    expect(confirmLanding('magiclink', undefined)).toBe('/dashboard');
  });

  it('only an exact landing matches (no prefix, case, whitespace or protocol-relative variant)', () => {
    for (const next of [
      '/portal/',
      '/Portal',
      ' /portal',
      '/portal\t',
      '//portal',
      '/reset/complete?x=1',
      'https://evil.example/portal',
      '/dashboard/',
      '/Dashboard',
      '/dashboard#x',
    ]) {
      expect(confirmLanding('magiclink', next), JSON.stringify(next)).toBe('/dashboard');
      expect(confirmLanding('recovery', next), JSON.stringify(next)).toBe('/reset/complete');
    }
  });

  it('a type the list does not know lands on the default, never on next (and never throws)', () => {
    for (const type of ['signup', 'email_change', 'constructor', '__proto__', 'toString', '']) {
      expect(confirmLanding(type, '/dashboard/items/new'), type).toBe(CONFIRM_FALLBACK_LANDING);
    }
    expect(CONFIRM_FALLBACK_LANDING).toBe('/dashboard');
  });

  it('every landing is a path on this origin', () => {
    for (const landings of Object.values(CONFIRM_LANDINGS)) {
      for (const landing of landings) expect(landing).toMatch(/^\/[a-z]/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The builders. Every /auth/confirm link the app emails is built in one of
// these files, and its (type, next) must be a landing the route keeps, or the
// route would quietly send that email's readers somewhere else.
// ─────────────────────────────────────────────────────────────────────────
describe("the app's confirmation emails land where the route sends them", () => {
  const WEB_SRC = path.resolve(__dirname, '../..');

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  /** Files that build a link (not a comment that names the route). */
  const BUILDERS = sources(WEB_SRC)
    .filter((f) => /\/auth\/confirm\?token_hash=\$\{/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(WEB_SRC, f))
    .sort();

  it('the builders are the five reviewed ones (a new one must be checked against the landings)', () => {
    expect(BUILDERS).toEqual([
      'app/api/admin/qa-recovery-link/route.ts',
      'lib/auth/password-reset-email.ts',
      'server/actions/platform-admin.ts',
      'server/services/customers.ts',
      'server/services/email-change.ts',
    ]);
  });

  it('each literal (type, next) a builder sends is a landing the route keeps', () => {
    const pairs: Array<[string, string, string]> = [];
    for (const rel of BUILDERS) {
      const src = readFileSync(path.join(WEB_SRC, rel), 'utf8');
      for (const m of src.matchAll(/&type=([a-z_]+)&next=\$\{encodeURIComponent\('([^']+)'\)\}/g)) {
        pairs.push([rel, m[1]!, m[2]!]);
      }
    }
    expect(pairs.map(([rel, type, next]) => `${rel} ${type} ${next}`).sort()).toEqual([
      'app/api/admin/qa-recovery-link/route.ts recovery /reset/complete',
      'lib/auth/password-reset-email.ts recovery /reset/complete',
      'server/actions/platform-admin.ts invite /reset/complete',
    ]);
    for (const [rel, type, next] of pairs) {
      expect([rel, confirmLanding(type, next)]).toEqual([rel, next]);
    }
  });

  it('the portal invite (invite for a new user, magiclink for an existing one) lands on /portal under both types', () => {
    const src = readFileSync(path.join(WEB_SRC, 'server/services/customers.ts'), 'utf8');
    expect(src).toMatch(/let linkType: 'invite' \| 'magiclink' = 'invite';/);
    expect(src).toContain("&type=${linkType}&next=${encodeURIComponent('/portal')}");
    expect(confirmLanding('invite', '/portal')).toBe('/portal');
    expect(confirmLanding('magiclink', '/portal')).toBe('/portal');
  });

  it('the email-change link carries no next (the route fixes that destination itself)', () => {
    const src = readFileSync(path.join(WEB_SRC, 'server/services/email-change.ts'), 'utf8');
    expect(src).toMatch(/&type=email_change`/);
    expect(src).not.toMatch(/type=email_change&next=/);
  });
});

// The test harnesses sign in the same way, with links they mint through the
// admin API (never emailed): the perf harness opens a magic link and waits for
// the dashboard. Their landings must be kept too, or a run stops at sign-in.
describe("the repository's sign-in harnesses land where they wait", () => {
  const WEB_TESTS = path.resolve(__dirname, '../../../tests');

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...files(full));
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('each (type, next) a harness opens is a landing the route keeps', () => {
    const pairs: string[] = [];
    for (const file of files(WEB_TESTS)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(
        /\/auth\/confirm\?token_hash=[^&\s]+&type=([a-z_]+)&next=([^`'"&\s]+)/g,
      )) {
        const next = decodeURIComponent(m[2]!);
        pairs.push(`${path.relative(WEB_TESTS, file)} ${m[1]} ${next}`);
        expect([file, confirmLanding(m[1]!, next)]).toEqual([file, next]);
      }
    }
    expect(pairs).toEqual(['perf/auth.setup.ts magiclink /dashboard']);
  });
});
