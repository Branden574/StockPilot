import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every place that decides MFA from an organization's policy takes it from
 * `enforcedMfaPolicy`. Until 2026-09-22 each wrote `?? 'optional'`, which held
 * a session whose organization row it could not read to NO policy.
 */

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string) =>
  readFileSync(path.join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** From `export async function name(` up to the next top-level export. */
function functionBody(code: string, name: string): string {
  const start = code.indexOf(`export async function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const next = code.indexOf('\nexport ', start + 1);
  return code.slice(start, next === -1 ? undefined : next);
}

const GATES: Array<[string, string]> = [
  ['the service gate', 'server/services/context.ts'],
  ['the API gate', 'lib/auth/api-context.ts'],
  ['the dashboard layout redirect', 'app/(dashboard)/layout.tsx'],
  ['the security settings page', 'app/(dashboard)/dashboard/settings/security/page.tsx'],
];

describe('one rule for an organization MFA policy that cannot be read', () => {
  it.each(GATES)('%s uses enforcedMfaPolicy and never defaults to optional', (_label, rel) => {
    const code = read(rel);
    expect(code).toContain('enforcedMfaPolicy(');
    expect(code).not.toMatch(/\?\?\s*['"]optional['"]/);
  });

  it('the disable-MFA action binds the read error and uses the same rule', () => {
    const body = functionBody(read('server/actions/mfa.ts'), 'unenrollFactorAction');
    expect(body).toContain('enforcedMfaPolicy(');
    expect(body).not.toMatch(/\?\?\s*['"]optional['"]/);
    expect(body).toMatch(/error:\s*orgError/);
    expect(body).toMatch(/if\s*\(\s*orgError\s*\)/);
  });
});
