import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGACY_ACTIVE_ORG_STORAGE_KEY, SAVED_WORKSPACE_STORAGE_KEY } from './workspace-keys';

/**
 * ONE place holds the saved-workspace keys (recurring pattern #26).
 *
 * use-workspace.ts writes the saved workspace, api.ts orgHeader() names it in
 * the workspace header, and session-scope.ts stamps it on every queued outbox
 * row. They were three literals. Renaming one would have made the outbox stamp
 * organization NULL on every row, and after a workspace switch those rows
 * would be sent under whichever workspace was live at send time (the 404/403
 * terminal rejection S4a fixed) with no test failing. The literals live in
 * workspace-keys.ts alone, and every reader and writer goes through its
 * functions (docket B10, integrator decision 3: the workspace and its owner
 * are one value, written in one place).
 */

const ROOTS = [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../app')];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments removed: a doc mentioning the key is not a copy of it. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FILES = ROOTS.flatMap((r) => sourceFiles(r)).filter((f) => !f.includes('__fixtures__'));

describe('the saved-workspace keys have one definition', () => {
  it("still reads the key every installed build stores (renaming it would strand today's phones' workspace)", () => {
    expect(LEGACY_ACTIVE_ORG_STORAGE_KEY).toBe('workspace.activeOrgId');
  });

  it.each([
    ['the one value', SAVED_WORKSPACE_STORAGE_KEY],
    ["the older builds' key", LEGACY_ACTIVE_ORG_STORAGE_KEY],
    ['the constant of the one value', 'SAVED_WORKSPACE_STORAGE_KEY'],
    ["the constant of the older builds' key", 'LEGACY_ACTIVE_ORG_STORAGE_KEY'],
  ])('%s appears in workspace-keys.ts only', (_what, needle) => {
    // Vacuity control: the sweep must have found the app's sources.
    expect(FILES.some((f) => f.endsWith(path.join('lib', 'api.ts')))).toBe(true);
    const holders = FILES.filter((f) => code(readFileSync(f, 'utf8')).includes(needle)).map((f) =>
      path.basename(f),
    );
    expect(holders).toEqual(['workspace-keys.ts']);
  });

  // Re-pinned by docket B10 (was a bare getItem of the workspace key in
  // api.ts and session-scope.ts, then two setItems in use-workspace.ts): the
  // readers read the workspace and its owner through one reader, the writers
  // write them through one writer, and each reader names it by its rule.
  it.each([
    ['use-workspace.ts', /readSavedWorkspace\(AsyncStorage\)/],
    ['use-workspace.ts', /savedWorkspaceFor\(saved, userId\)/],
    ['use-workspace.ts', /readOlderBuildWorkspaceSince\(AsyncStorage\)/],
    ['use-workspace.ts', /await saveWorkspace\(AsyncStorage, activeOrgId, userId\);/],
    ['use-workspace.ts', /await saveWorkspace\(AsyncStorage, orgId, ownerId\);/],
    ['api.ts', /savedWorkspaceFor\(await readSavedWorkspace\(AsyncStorage\), userId\)/],
    ['session-scope.ts', /readSavedWorkspace\(AsyncStorage\)/],
    ['session-scope.ts', /ownSavedWorkspace\(saved, userId \?\? lastSeenUserId\)/],
    ['session-scope.ts', /ownSavedWorkspace\(saved, userId\)/],
  ])('%s reads or writes it through the shared module (%s)', (file, use) => {
    const src = code(readFileSync(path.join(__dirname, file), 'utf8'));
    expect(src).toMatch(/import \{[^}]*\} from '\.\/workspace-keys';/);
    expect(src).toMatch(use);
  });

  it('nothing else writes the saved workspace: use-workspace.ts writes only warehouse keys itself', () => {
    const src = code(readFileSync(path.join(__dirname, 'use-workspace.ts'), 'utf8'));
    const writes = [...src.matchAll(/AsyncStorage\.(setItem|removeItem)\(([^,)]+)/g)].map(
      (m) => m[2],
    );
    expect(writes.length).toBeGreaterThan(0); // vacuity control
    expect(new Set(writes)).toEqual(new Set(['key']));
    expect(src).toMatch(/const key = WAREHOUSE_STORAGE_KEY\(cached\.activeOrgId\);/);
  });
});
