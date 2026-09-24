import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * use-workspace.ts imports the Supabase client and React Native modules, so it
 * cannot load under the node test runner; its use of the pure choice is pinned
 * by source text instead (the rule itself is tested in workspace-choice.test.ts).
 */
const src = readFileSync(path.join(__dirname, 'use-workspace.ts'), 'utf8');
const hydrate = src.slice(src.indexOf('async function hydrate('), src.indexOf('/** Workspace switches in the order'));

describe('hydrate() saves the workspace it chooses', () => {
  it('chooses with the stored id, the profile default and the memberships', () => {
    expect(hydrate).toMatch(/chooseActiveOrg\(\{ orgIds: orgs\.map\(\(o\) => o\.id\), stored: persisted, profileDefault \}\)/);
    expect(hydrate).toMatch(/\.from\('user_profiles'\)|loadProfileDefaultOrg\(userId\)/);
  });

  it('writes the choice to the key the API header is read from', () => {
    expect(hydrate).toMatch(/if \(activeOrgId && choice\.persist\) \{\s*try \{\s*await AsyncStorage\.setItem\(ACTIVE_ORG_STORAGE_KEY, activeOrgId\);/);
    // One constant for the writer and the header (workspace-keys.wiring.test.ts
    // keeps the literal to that one module).
    expect(src).toMatch(/import \{ ACTIVE_ORG_STORAGE_KEY \} from '\.\/workspace-keys';/);
    expect(readFileSync(path.join(__dirname, 'api.ts'), 'utf8')).toMatch(/AsyncStorage\.getItem\(ACTIVE_ORG_STORAGE_KEY\)/);
  });

  it('clears the org-scoped cache and pulls in full only when told to', () => {
    expect(hydrate).toMatch(/if \(activeOrgId && choice\.resetCache\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*try \{\s*await deleteOrgData\(\);/);
    expect(hydrate).toMatch(/if \(activeOrgId && choice\.resetCache\) \{\s*void syncNow\(true\)/);
  });
});
