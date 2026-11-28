// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE CONSOLE'S CATEGORY WORDS STAY THE CONSOLE'S (lab walk 3, F1; the
 * coordinator, 2026-11-24). The platform console names the category whose
 * code is phishing "Sign-in alert" (core's securityConsoleCategoryLabel); an
 * organization's own pages and the phone app keep the shared label
 * (securityEventCategoryLabel, "Phishing"), a separate decision. Pinned, so
 * neither drifts by accident: the console label is called only by the
 * platform pages and core's console modules, and no platform page calls the
 * shared one. (The organization's Blocked activity page test pins that it
 * still says "Phishing".)
 *
 * THE OTHER WAY ROUND FOR MALWARE (part 6; the coordinator, 2026-11-24). The
 * category whose code is malware holds files the upload checks refused or
 * could not check: the console keeps core's "Malware", and an organization's
 * own pages say "Refused file" (core's securityMemberCategoryLabel), because
 * those checks are not an antivirus and a renamed file is not malware. Pinned:
 * the member label is called only outside the console, the shared label is
 * called by no web page at all (so a member page cannot say "Malware"), and
 * the phone app calls neither the shared nor the console label. (The Blocked
 * activity page test pins "Refused file"; the console's tests pin "Malware".)
 */

const WEB = join(__dirname, '..', '..');
const REPO = join(WEB, '..', '..', '..');
const CORE = join(REPO, 'packages', 'core', 'src');
const MOBILE = join(REPO, 'apps', 'mobile');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** The code only, comments taken out: a comment that names a function proves nothing. */
const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function callers(root: string, name: string): string[] {
  const word = new RegExp(`\\b${name}\\b`);
  return sourceFiles(root)
    .filter((abs) => word.test(codeOf(readFileSync(abs, 'utf8'))))
    .map((abs) => relative(root, abs).split(sep).join('/'))
    .sort();
}

const CONSOLE = /^(components\/platform\/|app\/\(platform\)\/)/;

describe("the platform console's category words", () => {
  it('only the platform pages and the map call the console label in the web app; the phone app never does', () => {
    const web = callers(WEB, 'securityConsoleCategoryLabel');
    expect(web.length).toBeGreaterThan(0);
    for (const rel of web) expect(rel).toMatch(CONSOLE);
    expect(callers(MOBILE, 'securityConsoleCategoryLabel')).toEqual([]);
  });

  it("in core, only the label's own module and the console's modules (the map's words, the briefing)", () => {
    expect(callers(CORE, 'securityConsoleCategoryLabel')).toEqual([
      'security/security-briefing.ts',
      'security/security-events.ts',
      'security/security-map.ts',
    ]);
  });

  it('the member label is called by the organization\'s own pages only, never by the console; in core only by its own module', () => {
    const web = callers(WEB, 'securityMemberCategoryLabel');
    expect(web).toContain('app/(dashboard)/dashboard/settings/security/activity/page.tsx');
    for (const rel of web) expect(rel).not.toMatch(CONSOLE);
    expect(callers(CORE, 'securityMemberCategoryLabel')).toEqual(['security/security-events.ts']);
  });

  it('no web page calls the shared label, so a member page cannot say "Malware" and no console page "Phishing"', () => {
    expect(callers(WEB, 'securityEventCategoryLabel')).toEqual([]);
    // The phone app, if it ever names a kind, uses the member label.
    expect(callers(MOBILE, 'securityEventCategoryLabel')).toEqual([]);
  });

  it('no platform page calls the shared label, so none can say "Phishing"', () => {
    const shared = callers(WEB, 'securityEventCategoryLabel');
    expect(shared.filter((rel) => CONSOLE.test(rel))).toEqual([]);
    // Core's console modules neither.
    const core = callers(CORE, 'securityEventCategoryLabel');
    expect(core).not.toContain('security/security-briefing.ts');
    expect(core).not.toContain('security/security-map.ts');
  });
});
