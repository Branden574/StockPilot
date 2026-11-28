// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WHO MAY IMPORT THE SECURITY ALERTS' READ, AND WHO MAY CALL ITS ACTION.
 *
 * Security invariant. readPlatformSecurityAlerts reads the security alert
 * record (every organization's aimed alerts among it) with the service
 * client, and has no gate of its own (like its sibling platform services).
 * So the files that import it are the doors to that data, and each is
 * pinned here with its gate:
 *   - the alerts section (a server component), rendered only by the page
 *     /platform/security/alerts, which asks requirePlatformAdmin() first;
 *   - the "Check again" Server Action, which asks checkPlatformConsoleRead()
 *     (the console's own rule) before it reads its input or the record, and
 *     is called only by the alerts' client.
 * A new importer (a route, a cron, another page or action) must be judged
 * before it is added here.
 */

const SRC = join(__dirname, '..', '..', '..');

const importOf = (alias: string, name: string) =>
  new RegExp(
    `['"](?:${alias.replace(/[/@-]/g, (c) => `\\${c}`)}|(?:\\.{1,2}\\/)+(?:[\\w()[\\]-]+\\/)*${name})['"]`,
  );

const SERVICE_ALIAS = '@/server/services/platform/security-alerts';
const ACTION_ALIAS = '@/server/actions/platform/security-alerts';
const SECTION_ALIAS = '@/components/platform/platform-security-alerts-section';

const SERVICE_FILE = 'server/services/platform/security-alerts.ts';
const ACTION_FILE = 'server/actions/platform/security-alerts.ts';
const SECTION_FILE = 'components/platform/platform-security-alerts-section.tsx';
const CLIENT_FILE = 'components/platform/security-alerts/security-alerts-client.tsx';
const PAGE_FILE = 'app/(platform)/platform/security/alerts/page.tsx';

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

describe("the security alerts' read", () => {
  it('is imported by the alerts section and the Check again action, and by nothing else', () => {
    expect(
      importers(
        importOf(SERVICE_ALIAS, 'security-alerts'),
        SERVICE_ALIAS,
        join('server', 'services', 'platform'),
        SERVICE_FILE,
      ),
    ).toEqual([SECTION_FILE, ACTION_FILE].sort());
  });

  it("the action is called by the alerts' client alone", () => {
    expect(
      importers(
        importOf(ACTION_ALIAS, 'security-alerts'),
        ACTION_ALIAS,
        join('server', 'actions', 'platform'),
        ACTION_FILE,
      ),
    ).toEqual([CLIENT_FILE]);
  });

  it('the section is rendered by the gated alerts page alone', () => {
    expect(
      importers(
        importOf(SECTION_ALIAS, 'platform-security-alerts-section'),
        SECTION_ALIAS,
        join('components', 'platform'),
        SECTION_FILE,
      ),
    ).toEqual([PAGE_FILE]);
  });

  it('the page asks requirePlatformAdmin() before it renders the section', () => {
    const page = read(PAGE_FILE);
    const gate = page.indexOf('await requirePlatformAdmin()');
    const section = page.indexOf('<PlatformSecurityAlertsSection');
    expect(gate).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(gate);
  });

  it("the action asks the console's own rule first: before its input is read and before the record is", () => {
    const action = read(ACTION_FILE);
    const body = action.slice(
      action.indexOf('export async function readPlatformSecurityAlertsAction'),
    );
    const gate = body.indexOf('await checkPlatformConsoleRead()');
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf('.safeParse(')).toBeGreaterThan(gate);
    expect(body.indexOf('readPlatformSecurityAlerts(')).toBeGreaterThan(gate);
    // Not the weaker action check, which serves an allowlisted account with
    // no authenticator (its comment may name it; its code may not call it).
    const code = action.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/checkPlatformAdmin\s*\(/);
    expect(code).toMatch(/checkPlatformConsoleRead\s*\(/);
  });

  it('the section reads the alerts once', () => {
    const section = read(SECTION_FILE);
    expect(section.split('readPlatformSecurityAlerts(').length - 1).toBe(1);
  });
});
