import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Call-site pins for the phone's Orders list (src/screens/orders.tsx), which
 * vitest cannot load (native modules). Each names the mutation it catches.
 */

const ROOT = path.resolve(__dirname, '../..');
/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const orders = codeOnly(readFileSync(path.join(ROOT, 'src/screens/orders.tsx'), 'utf8'));

describe('the Orders list read', () => {
  // L107: after sign-out the list reloaded on focus with no user, as anon,
  // and logged a Postgres error. Mutation caught: the guard dropped, or only
  // the org checked.
  it('reads nothing without an organization and a signed-in user', () => {
    expect(orders).toMatch(/const load = React\.useCallback\(async \(\) => \{\s*if \(!orgId \|\| !userId\) return;/);
  });

  // L84: the approver's list could show pending_confirmation rows, the public
  // submissions not yet confirmed by email, which the web never lists
  // (OrderRequestsService.list). Mutation caught: the filter dropped.
  it('never lists orders still waiting for their email confirmation', () => {
    expect(orders).toMatch(/\.eq\('organization_id', orgId\)\s*\.neq\('status', 'pending_confirmation'\);/);
  });
});
