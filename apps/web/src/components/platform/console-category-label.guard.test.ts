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

  it('no platform page calls the shared label, so none can say "Phishing"', () => {
    const shared = callers(WEB, 'securityEventCategoryLabel');
    expect(shared.filter((rel) => CONSOLE.test(rel))).toEqual([]);
    // Core's console modules neither.
    const core = callers(CORE, 'securityEventCategoryLabel');
    expect(core).not.toContain('security/security-briefing.ts');
    expect(core).not.toContain('security/security-map.ts');
  });
});
