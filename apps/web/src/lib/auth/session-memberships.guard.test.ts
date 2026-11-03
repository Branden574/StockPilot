import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * getSessionMemberships() answers an empty list both when the person belongs
 * to no workspace and when their memberships could not be read. That is right
 * for the one screen that uses it: the dashboard layout's workspace switcher,
 * which renders only after requireOrgContext() resolved a membership. Code that
 * must tell "no workspace" from "could not read" uses readSessionMemberships(),
 * which says which it was (lib/auth/session.ts).
 *
 * The scan reads every non-test source file with comments removed.
 */

const SRC = path.resolve(__dirname, '../..');
const DEFINED_IN = 'lib/auth/session.ts';

const code = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function usersOf(name: string): string[] {
  const word = new RegExp(`\\b${name}\\b`);
  return files(SRC)
    .map((file) => path.relative(SRC, file))
    .filter((rel) => rel !== DEFINED_IN && word.test(code(path.join(SRC, rel))))
    .sort();
}

describe('which session reader answers "which workspaces does this person belong to?"', () => {
  it('only the dashboard layout (the workspace switcher) uses getSessionMemberships', () => {
    expect(usersOf('getSessionMemberships')).toEqual(['app/(dashboard)/layout.tsx']);
  });

  it('account deletion uses readSessionMemberships, which tells a failed read from no workspace', () => {
    expect(usersOf('readSessionMemberships')).toContain('server/actions/profile.ts');
    expect(code(path.join(SRC, 'server/actions/profile.ts'))).toMatch(
      /import\s*\{[^}]*\breadSessionMemberships\b[^}]*\}\s*from\s*'@\/lib\/auth\/session'/,
    );
  });
});
