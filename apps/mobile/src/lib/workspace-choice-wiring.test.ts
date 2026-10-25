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
    // The stored id is this account's own (docket B10): another account's
    // saved workspace counts as none, as it does for the request header.
    expect(hydrate).toContain('const persisted = savedWorkspaceFor(saved, userId);');
    expect(hydrate).toMatch(/chooseActiveOrg\(\{ orgIds: orgs\.map\(\(o\) => o\.id\), stored: persisted, profileDefault \}\)/);
    expect(hydrate).toMatch(/\.from\('user_profiles'\)|loadProfileDefaultOrg\(userId\)/);
  });

  it('writes the choice to the key the API header is read from', () => {
    // Re-pinned by docket B10 (was `if (activeOrgId && choice.persist)`, the
    // workspace key alone): the choice is saved with the account that made
    // it, also when the saved one had no owner or another account's
    // (use-workspace.owner.test.ts runs it). The workspace is written first.
    expect(hydrate).toMatch(
      /if \(activeOrgId && \(choice\.persist \|\| saved\.ownerId !== userId\)\) \{\s*try \{\s*await AsyncStorage\.setItem\(ACTIVE_ORG_STORAGE_KEY, activeOrgId\);\s*await AsyncStorage\.setItem\(ACTIVE_ORG_OWNER_STORAGE_KEY, userId\);/,
    );
    // One constant for the writer and the header (workspace-keys.wiring.test.ts
    // keeps the literal to that one module), read through one reader.
    expect(src).toMatch(/import \{[^}]*\bACTIVE_ORG_STORAGE_KEY\b[^}]*\} from '\.\/workspace-keys';/);
    expect(readFileSync(path.join(__dirname, 'api.ts'), 'utf8')).toMatch(
      /savedWorkspaceFor\(await readSavedWorkspace\(AsyncStorage\), account\)/,
    );
  });

  it('clears the org-scoped cache and pulls in full only when told to', () => {
    expect(hydrate).toMatch(/if \(activeOrgId && choice\.resetCache\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*try \{\s*await deleteOrgData\(\);/);
    expect(hydrate).toMatch(/if \(activeOrgId && choice\.resetCache\) \{\s*void syncNow\(true\)/);
  });
});
