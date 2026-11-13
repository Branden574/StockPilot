import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The stage 5 lab files must not change what the default Playwright config
 * (playwright.config.ts, `pnpm test:e2e`) runs. Its `setup` project takes
 * every file under tests/e2e that its testMatch matches, and its `chromium`
 * project depends on that setup: a stage 5 sign-in file picked up there fails
 * at once ("names no stage 5 role") and stops every default e2e test. So the
 * stage 5 sign-in lives in appearance/stage5.auth.ts, which only
 * playwright.stage5.config.ts matches.
 *
 * Reads both configs as text (no Playwright import in a unit test): the
 * default setup project's testMatch and the stage 5 setup projects' testMatch.
 */

const WEB = join(__dirname, '..', '..');
const E2E = join(WEB, 'tests', 'e2e');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? d.name === 'node_modules' || d.name.startsWith('.')
        ? []
        : filesUnder(join(dir, d.name))
      : [join(dir, d.name)],
  );
}

/** The regex literal after `testMatch:` in the project block that starts at `from`. */
function testMatchAfter(text: string, from: number): RegExp {
  const m = /testMatch:\s*\/((?:\\\/|[^/\n])+)\/([a-z]*)/u.exec(text.slice(from));
  if (!m) throw new Error('no testMatch regex literal found');
  return new RegExp(m[1]!, m[2]!.replace('g', ''));
}

describe('the stage 5 files stay out of the default e2e config', () => {
  const defaults = readFileSync(join(WEB, 'playwright.config.ts'), 'utf8');
  const setupAt = defaults.indexOf("name: 'setup'");
  const defaultSetup = testMatchAfter(defaults, setupAt);
  const files = filesUnder(E2E).map((f) => relative(E2E, f));

  it('reads the default setup project', () => {
    expect(setupAt).toBeGreaterThan(-1);
    expect(files.filter((f) => defaultSetup.test(f))).toContain('auth.setup.ts');
  });

  it('the default setup project matches no file under appearance/ (stage 5 sign-in included)', () => {
    expect(files.filter((f) => defaultSetup.test(f) && f.startsWith('appearance/'))).toEqual([]);
  });

  it('the stage 5 config signs in from appearance/stage5.auth.ts and only from it', () => {
    const stage5 = readFileSync(join(WEB, 'playwright.stage5.config.ts'), 'utf8');
    const setupProjects = testMatchAfter(stage5, stage5.indexOf('const setupProjects'));
    // The stage 5 config's testDir is ./tests/e2e/appearance.
    const appearance = files
      .filter((f) => f.startsWith('appearance/'))
      .map((f) => f.slice('appearance/'.length));
    expect(appearance.filter((f) => setupProjects.test(f))).toEqual(['stage5.auth.ts']);
  });
});
