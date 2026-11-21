// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WHO MAY IMPORT THE PLATFORM READ OF SECURITY EVENTS.
 *
 * listPlatformSecurityEvents reads every organization's events with the
 * service client and, like its sibling platform services, has no gate of its
 * own: the page that calls it runs requirePlatformAdmin() first. So the list
 * of files that import it is the list of doors to that data. A new importer
 * (a route, a cron, a server action) must be judged before it is added here.
 */

const SRC = join(__dirname, '..', '..', '..');
const MODULE =
  /['"](?:@\/server\/services\/platform\/security-events|(?:\.{1,2}\/)+(?:[\w()[\]-]+\/)*security-events)['"]/;

const ALLOWED = new Set(['app/(platform)/platform/security/page.tsx']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function importsThePlatformRead(path: string, text: string): boolean {
  if (!MODULE.test(text)) return false;
  if (text.includes('@/server/services/platform/security-events')) return true;
  // A relative import named security-events counts only from inside this folder.
  return path.startsWith(join(SRC, 'server', 'services', 'platform') + sep);
}

describe('the platform read of security events', () => {
  it('is imported by the gated platform page and by nothing else', () => {
    const importers = sourceFiles(SRC)
      .filter((path) => importsThePlatformRead(path, readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split(sep).join('/'))
      .filter((path) => path !== 'server/services/platform/security-events.ts')
      .sort();
    expect(importers).toEqual([...ALLOWED].sort());
  });

  it('the page asks the platform gate before it reads', () => {
    const page = readFileSync(join(SRC, 'app/(platform)/platform/security/page.tsx'), 'utf8');
    const gate = page.indexOf('await requirePlatformAdmin()');
    const read = page.indexOf('listPlatformSecurityEvents(');
    expect(gate).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(gate);
  });
});
