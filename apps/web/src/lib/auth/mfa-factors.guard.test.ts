import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every server-side `mfa.listFactors()` whose answer decides ACCESS must bind
 * `error` and deny on it. auth-js resolves a GoTrue failure as
 * { data: null, error }, and five call sites read that as "not enrolled" until
 * 2026-09-22: the dashboard gate, the MFA challenge page, change password,
 * email change and ownership transfer.
 */

const SRC = path.resolve(__dirname, '../..');

/** Sites that only DISPLAY or tidy up, with the reason they may ignore an error. */
const NOT_A_GATE: Record<string, string> = {
  'server/actions/mfa.ts': 'enroll: deletes stale UNVERIFIED factors before enrolling; decides nothing',
  'app/(dashboard)/dashboard/settings/security/page.tsx': 'renders the factor list; every action on it re-checks server-side',
  'components/auth/step-up-modal.tsx': 'client UI picking a factor to challenge; the server verifies the code',
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('an unreadable MFA factor list never reads as "not enrolled"', () => {
  it('every gate that calls listFactors binds and checks the error', () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const file of files(SRC)) {
      const rel = path.relative(SRC, file);
      const code = readFileSync(file, 'utf8');
      if (!code.includes('mfa.listFactors()')) continue;
      sites += 1;
      if (NOT_A_GATE[rel]) continue;
      // The call's own destructure (or result variable) must name the error,
      // and that name must be checked.
      const bound = /\{[^}]*\berror(?::\s*(\w+))?[^}]*\}\s*=\s*await\s+[\w.]*mfa\.listFactors\(\)/.exec(code);
      const viaRes = /const\s+(\w+)\s*=\s*await\s+[\w.]*mfa\.listFactors\(\)/.exec(code);
      const checked = bound
        ? new RegExp(`if\\s*\\(\\s*${bound[1] ?? 'error'}\\b`).test(code)
        : viaRes
          ? new RegExp(`if\\s*\\(\\s*${viaRes[1]}\\.error\\b`).test(code)
          : false;
      if (!checked) offenders.push(rel);
    }
    expect(sites).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });
});
