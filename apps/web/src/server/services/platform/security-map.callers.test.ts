// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WHO MAY IMPORT THE ATTACK MAP'S READ, AND WHO MAY CALL ITS POLL.
 *
 * Security invariant. readPlatformSecurityMap reads the security record of
 * every organization and none with the service client, and has no gate of
 * its own (like its sibling platform services). So the files that import it
 * are the doors to that data, and each is pinned here with its gate:
 *   - the map section (a server component), rendered only by the page
 *     /platform/security/map, which asks requirePlatformAdmin() first;
 *   - the poll's Server Action, which asks checkPlatformConsoleRead() (the
 *     console's own rule) before it reads its input or the record, and is
 *     called only by the map's island.
 * A new importer (a route, a cron, another page or action) must be judged
 * before it is added here.
 */

const SRC = join(__dirname, '..', '..', '..');

const importOf = (alias: string, name: string) =>
  new RegExp(
    `['"](?:${alias.replace(/[/@-]/g, (c) => `\\${c}`)}|(?:\\.{1,2}\\/)+(?:[\\w()[\\]-]+\\/)*${name})['"]`,
  );

const SERVICE_ALIAS = '@/server/services/platform/security-map';
const ACTION_ALIAS = '@/server/actions/platform/security-map';
const SECTION_ALIAS = '@/components/platform/platform-security-map-section';

const SERVICE_FILE = 'server/services/platform/security-map.ts';
const ACTION_FILE = 'server/actions/platform/security-map.ts';
const SECTION_FILE = 'components/platform/platform-security-map-section.tsx';
const ISLAND_CLIENT_FILE = 'components/platform/security-map/security-map-client.tsx';
const PAGE_FILE = 'app/(platform)/platform/security/map/page.tsx';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function importers(pattern: RegExp, alias: string, folder: string, self: string): string[] {
  return sourceFiles(SRC)
    .filter((path) => {
      const text = readFileSync(path, 'utf8');
      if (!pattern.test(text)) return false;
      if (text.includes(alias)) return true;
      // A relative import of that name counts only from inside its folder.
      return path.startsWith(join(SRC, folder) + sep);
    })
    .map((path) => relative(SRC, path).split(sep).join('/'))
    .filter((path) => path !== self)
    .sort();
}

const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

describe("the attack map's read", () => {
  it('is imported by the map section and the poll action, and by nothing else', () => {
    expect(
      importers(
        importOf(SERVICE_ALIAS, 'security-map'),
        SERVICE_ALIAS,
        join('server', 'services', 'platform'),
        SERVICE_FILE,
      ),
    ).toEqual([SECTION_FILE, ACTION_FILE].sort());
  });

  it("the poll action is called by the map's island alone", () => {
    expect(
      importers(
        importOf(ACTION_ALIAS, 'security-map'),
        ACTION_ALIAS,
        join('server', 'actions', 'platform'),
        ACTION_FILE,
      ),
    ).toEqual([ISLAND_CLIENT_FILE]);
  });

  it('the map section is rendered by the gated map page alone', () => {
    expect(
      importers(
        importOf(SECTION_ALIAS, 'platform-security-map-section'),
        SECTION_ALIAS,
        join('components', 'platform'),
        SECTION_FILE,
      ),
    ).toEqual([PAGE_FILE]);
  });

  it('the page asks requirePlatformAdmin() before it renders the section', () => {
    const page = read(PAGE_FILE);
    const gate = page.indexOf('await requirePlatformAdmin()');
    const section = page.indexOf('<PlatformSecurityMapSection');
    expect(gate).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(gate);
  });

  it("the action asks the console's own rule first: before its input is read and before the record is", () => {
    const action = read(ACTION_FILE);
    const body = action.slice(
      action.indexOf('export async function pollPlatformSecurityMapAction'),
    );
    const gate = body.indexOf('await checkPlatformConsoleRead()');
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf('.safeParse(')).toBeGreaterThan(gate);
    expect(body.indexOf('readPlatformSecurityMap(')).toBeGreaterThan(gate);
    // Not the weaker action check, which serves an allowlisted account with
    // no authenticator (its comment may name it; its code may not call it).
    const code = action.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/checkPlatformAdmin\s*\(/);
    expect(code).toMatch(/checkPlatformConsoleRead\s*\(/);
  });

  it('the section reads the whole window once, with no day start', () => {
    const section = read(SECTION_FILE);
    expect(section.split('readPlatformSecurityMap(').length - 1).toBe(1);
    expect(section).toContain("readPlatformSecurityMap({ scope: 'whole', dayStart: null })");
  });
});
