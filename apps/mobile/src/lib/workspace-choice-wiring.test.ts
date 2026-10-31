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
    // workspace key alone, then two setItems): the choice is saved with the
    // account that made it, in one value and one write (integrator decision
    // 3), also when the saved one had no owner or another account's
    // (use-workspace.owner.test.ts runs it). And again when an older app's key
    // sits beside it, so that the save removes that key (the B10 review).
    // Re-pinned by round c10: never when a repair the load owes could not be
    // recorded first (the save would erase its only record).
    expect(hydrate).toMatch(
      /if \(\s*activeOrgId &&\s*\(choice\.persist \|\| saved\.ownerId !== userId \|\| olderBuildSince !== null\) &&\s*\(repairRecord !== null \|\| !resetCache\)\s*\) \{\s*try \{\s*await saveWorkspace\(AsyncStorage, activeOrgId, userId\);/,
    );
    // One writer and one reader for the writer and the header
    // (workspace-keys.wiring.test.ts keeps the literals to that one module).
    expect(src).toMatch(/import \{[^}]*\bsaveWorkspace\b[^}]*\} from '\.\/workspace-keys';/);
    expect(readFileSync(path.join(__dirname, 'api.ts'), 'utf8')).toMatch(
      /savedWorkspaceFor\(await readSavedWorkspace\(AsyncStorage\), userId\)/,
    );
  });

  it('clears the org-scoped cache and pulls in full only when told to', () => {
    // Re-pinned by the docket B10 review (was `choice.resetCache` at each
    // site): the cache is also cleared when another account's saved
    // workspace, which the choice does not count, is not the one chosen
    // (use-workspace.owner.test.ts and cache-owner.sqlite.test.ts run it),
    // or when an older app saved another workspace since this build did (a
    // rolled-back phone update; use-workspace.owner.test.ts).
    expect(hydrate).toContain('const othersWorkspace = persisted === null ? saved.orgId : null;');
    expect(hydrate).toContain(
      'const olderBuildSince = await readOlderBuildWorkspaceSince(AsyncStorage).catch(() => null);',
    );
    // Re-pinned by round c10 (integrator decision cache_clear_order): and
    // while a repair an earlier load or a switch recorded is still owed.
    expect(hydrate).toContain('readCacheRepairOwed(AsyncStorage),');
    expect(hydrate).toMatch(
      /const resetCache =\s*repairOwed \|\|\s*choice\.resetCache \|\|\s*\(othersWorkspace !== null && othersWorkspace !== activeOrgId\) \|\|\s*\(olderBuildSince !== null && olderBuildSince !== activeOrgId\);/,
    );
    // Every site reads the combined rule, never the choice's alone.
    expect(hydrate.match(/choice\.resetCache/g)).toHaveLength(1);
    expect(hydrate).toMatch(
      /if \(activeOrgId && resetCache\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*let wiped = false;\s*try \{\s*await deleteOrgData\(\);\s*wiped = true;/,
    );
    expect(hydrate).toMatch(/if \(activeOrgId && resetCache\) \{\s*void syncNow\(true\)/);
  });

  // Round c10 (integrator decision cache_clear_order): the save erases the
  // signal the repair is for, so the repair is recorded as owed before it,
  // and recorded done only after a wipe that worked, by the load that
  // recorded it, while its record is the latest and its account and the
  // switches are unchanged (use-workspace.owner.test.ts and
  // cache-owner.sqlite.test.ts run it).
  it('records the repair owed before the save, and done only after a wipe that worked', () => {
    const order = [
      'repairRecord = await recordRepairOwed();',
      'await saveWorkspace(AsyncStorage, activeOrgId, userId);',
      'await deleteOrgData();',
      'await recordRepairDone(repairRecord);',
    ].map((step) => {
      expect(hydrate.split(step)).toHaveLength(2); // once each
      return hydrate.indexOf(step);
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(hydrate).toMatch(
      /if \(activeOrgId && resetCache\) \{\s*try \{\s*repairRecord = await recordRepairOwed\(\);/,
    );
    expect(hydrate).toMatch(
      /if \(\s*wiped &&\s*repairRecord !== null &&\s*accountEpoch\(\) === epochAtStart &&\s*switchesStarted === switchesAtStart\s*\) \{\s*await recordRepairDone\(repairRecord\);/,
    );
    // The record-done helper settles only the latest record (repairsRecorded).
    expect(src).toMatch(
      /async function recordRepairDone\(record: number\): Promise<void> \{\s*\/\/[^\n]*\n\s*if \(record !== repairsRecorded\) return;/,
    );
  });

  it('a switch records the repair owed before it is counted and saves, and done only after a wipe that worked', () => {
    const switchSrc = src.slice(
      src.indexOf('async function switchActiveOrg('),
      src.indexOf('export async function setActiveWarehouse('),
    );
    const order = [
      'const repairRecord = await recordRepairOwed();',
      'switchesStarted += 1;',
      'await saveWorkspace(AsyncStorage, orgId, ownerId);',
      'await deleteOrgData();',
      'if (wiped) void recordRepairDone(repairRecord);',
    ].map((step) => {
      expect(switchSrc.split(step)).toHaveLength(2);
      return switchSrc.indexOf(step);
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Counted and saved in one step, as before: no await between them.
    expect(switchSrc).toMatch(/switchesStarted \+= 1;\s*(\/\/[^\n]*\n\s*)*await saveWorkspace\(/);
  });
});
