// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WHO MAY IMPORT THE PLATFORM'S SECURITY BRIEFING READS.
 *
 * Security invariant. readPlatformSecurityBriefing and
 * readOrganizationSecurityBriefing read every organization's numbers, and one
 * organization's members by name, with the service client. Like their
 * sibling platform services they have no gate of their own. So the list of
 * files that import them is the list of doors to that data: the briefing
 * section (a server component that reads its own data, as the Passkeys
 * section does), which only the gated platform Security page renders. A new
 * importer (a route, a cron, a server action, another page) must be judged
 * before it is added here.
 */

const SRC = join(__dirname, '..', '..', '..');
const SERVICE =
  /['"](?:@\/server\/services\/platform\/security-briefing|(?:\.{1,2}\/)+(?:[\w()[\]-]+\/)*security-briefing)['"]/;
const SECTION =
  /['"](?:@\/components\/platform\/platform-security-briefing-section|(?:\.{1,2}\/)+(?:[\w()[\]-]+\/)*platform-security-briefing-section)['"]/;

const SECTION_FILE = 'components/platform/platform-security-briefing-section.tsx';
const PAGE_FILE = 'app/(platform)/platform/security/page.tsx';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function importers(module: RegExp, alias: string, folder: string, self: string): string[] {
  return sourceFiles(SRC)
    .filter((path) => {
      const text = readFileSync(path, 'utf8');
      if (!module.test(text)) return false;
      if (text.includes(alias)) return true;
      // A relative import of that name counts only from inside its folder.
      return path.startsWith(join(SRC, folder) + sep);
    })
    .map((path) => relative(SRC, path).split(sep).join('/'))
    .filter((path) => path !== self)
    .sort();
}

describe("the platform's security briefing reads", () => {
  it('are imported by the briefing section and by nothing else', () => {
    expect(
      importers(
        SERVICE,
        '@/server/services/platform/security-briefing',
        join('server', 'services', 'platform'),
        'server/services/platform/security-briefing.ts',
      ),
    ).toEqual([SECTION_FILE]);
  });

  it('the briefing section is rendered by the gated platform Security page and by nothing else', () => {
    expect(
      importers(
        SECTION,
        '@/components/platform/platform-security-briefing-section',
        join('components', 'platform'),
        SECTION_FILE,
      ),
    ).toEqual([PAGE_FILE]);
  });

  it('the page asks the platform gate before it renders the section', () => {
    const page = readFileSync(join(SRC, PAGE_FILE), 'utf8');
    const gate = page.indexOf('await requirePlatformAdmin()');
    const check = page.indexOf('notFoundUnlessUuid(org)');
    const section = page.indexOf('<PlatformSecurityBriefingSection');
    expect(gate).toBeGreaterThan(-1);
    // The ?org= value is checked to be a uuid after the gate and before the section.
    expect(check).toBeGreaterThan(gate);
    expect(section).toBeGreaterThan(check);
  });

  it("one organization's part: the organization is found, then the audit row is written, then the detail is read", () => {
    const section = readFileSync(join(SRC, SECTION_FILE), 'utf8');
    const found = section.indexOf('await findBriefingOrganization(');
    const recorded = section.indexOf('await recordPlatformAudit(');
    const read = section.indexOf('await readOrganizationSecurityBriefing(');
    expect(found).toBeGreaterThan(-1);
    expect(recorded).toBeGreaterThan(found);
    expect(read).toBeGreaterThan(recorded);
    // The detail read is called in one place only.
    expect(section.split('readOrganizationSecurityBriefing(').length - 1).toBe(1);
  });
});
