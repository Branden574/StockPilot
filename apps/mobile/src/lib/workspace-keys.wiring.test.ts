import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACTIVE_ORG_STORAGE_KEY } from './workspace-keys';

/**
 * ONE active-workspace key (recurring pattern #26).
 *
 * use-workspace.ts writes it, api.ts orgHeader() sends it as the workspace
 * header, and session-scope.ts stamps it on every queued outbox row. They were
 * three literals. Renaming one would have made the outbox stamp organization
 * NULL on every row, and after a workspace switch those rows would be sent
 * under whichever workspace was live at send time (the 404/403 terminal
 * rejection S4a fixed) with no test failing. The three now import one constant,
 * and the literal lives in workspace-keys.ts alone.
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

describe('the active-workspace key has one definition', () => {
  it('is the value every installed build already stores (renaming it would strand the saved workspace)', () => {
    expect(ACTIVE_ORG_STORAGE_KEY).toBe('workspace.activeOrgId');
  });

  it('appears as a literal in workspace-keys.ts only', () => {
    const files = ROOTS.flatMap((r) => sourceFiles(r));
    // Vacuity control: the sweep must have found the app's sources.
    expect(files.some((f) => f.endsWith(path.join('lib', 'api.ts')))).toBe(true);
    const holders = files
      .filter((f) => code(readFileSync(f, 'utf8')).includes('workspace.activeOrgId'))
      .map((f) => path.basename(f));
    expect(holders).toEqual(['workspace-keys.ts']);
  });

  it.each([
    ['use-workspace.ts', /AsyncStorage\.setItem\(ACTIVE_ORG_STORAGE_KEY,/],
    ['api.ts', /AsyncStorage\.getItem\(ACTIVE_ORG_STORAGE_KEY\)/],
    ['session-scope.ts', /AsyncStorage\.getItem\(ACTIVE_ORG_STORAGE_KEY\)/],
  ])('%s reads or writes it through the shared constant', (file, use) => {
    const src = code(readFileSync(path.join(__dirname, file), 'utf8'));
    expect(src).toMatch(/import \{ ACTIVE_ORG_STORAGE_KEY \} from '\.\/workspace-keys';/);
    expect(src).toMatch(use);
  });
});
