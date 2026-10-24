import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Dependency advisories fixed in pnpm-lock.yaml stay fixed (docket S13,
 * 2026-10-24).
 *
 * WHAT WAS OPEN: after the Next.js 16.4.3 upgrade (#381), Dependabot still
 * had alerts open on versions the lockfile resolved although every
 * consumer's range already allowed a fixed release, and `pnpm audit` listed
 * advisories that had no alert yet, one of them critical:
 *
 *   - compression 1.8.1 (GHSA-vc2v-76pw-4v95, Dependabot #114): the Expo
 *     CLI's development server (apps/mobile: expo > @expo/cli, ^1.7.4).
 *   - dompurify 3.4.15 (GHSA-cg2g-xh64-v4q7 critical, GHSA-mrv2-3pqr-j5jr
 *     high, three low; Dependabot #110 and #116): asked for only by
 *     posthog-js's product-tours source (^3.4.13). The app imports
 *     posthog-js's main bundle, which does not contain it.
 *   - source-map-js 1.2.1 (GHSA-68fv-2mgg-jv7q, Dependabot #115): postcss
 *     8.5.28 and @tailwindcss/node 4.3.3 (both ^1.2.1), at build time.
 *   - image-size 1.2.1 (GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq,
 *     Dependabot #108 and #109): through metro 0.84.4, which react-native
 *     0.86's command-line plugin (@react-native/community-cli-plugin,
 *     ^0.84.3) resolved to. image-size has no fixed 1.x, but metro 0.84.5 and
 *     later do not depend on it at all, so the plugin now resolves metro
 *     0.84.6, the copy @react-native/metro-config already used. Expo bundles
 *     the phone app with its own pinned metro 0.84.5 (@expo/metro).
 *   - fast-uri 3.1.8 (four advisories of 2026-10-23): ajv 8, for commitlint
 *     and as @hookform/resolvers' unused ajv peer.
 *
 * sharp and shell-quote, fixed by #381 while their alerts (#119 and #118)
 * were still open, are held to the same rule.
 *
 * WHAT STOPS IT NOW: root package.json overrides set the floors
 * (compression@1 ^1.8.2, dompurify@3 ^3.4.17, source-map-js@1 ^1.2.2,
 * fast-uri@3 ^3.1.9), and this test reads every version the lockfile
 * resolves and fails when one is inside an advisory's vulnerable range. A
 * lockfile change that brings one back (a new dependency, a revert, a hand
 * edit) fails CI instead of waiting for an alert.
 *
 * NOT COVERED: node-forge (GHSA-86w9-cpqp-85rv) has no fixed release; zod 3
 * (GHSA-mrhx-c7xc-m3w5) needs zod 4, a change of its own. A withdrawn
 * advisory (sprintf-js, GHSA-hp3w-g68c-fv3c) is not a defect.
 *
 * IF THIS FAILS: a lockfile change resolved a vulnerable version. Find what
 * asks for it (`pnpm why -r <package>`) and resolve the fixed version; do not
 * lower a range here.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

type Version = { major: number; minor: number; patch: number; pre: string[] };

/** A semver version, or null for anything else (a tarball URL, a git or file reference). */
function parseVersion(text: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

function version(text: string): Version {
  const v = parseVersion(text);
  if (!v) throw new Error(`not a version: ${text}`);
  return v;
}

/** Below zero, zero or above zero as `a` is lower than, equal to or higher than `b` (semver order). */
function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A prerelease sorts before its release.
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** A vulnerable range: from `from` (inclusive, or every version when absent) up to, not including, `fixed`. */
type Range = { from?: string; fixed: string };

type Floor = { pkg: string; advisories: string[]; ranges: Range[] };

/**
 * Each package's vulnerable ranges, merged across the advisories named
 * (copied from the GitHub advisory records, `first_patched_version` as
 * `fixed`).
 */
const FLOORS: Floor[] = [
  {
    pkg: 'compression',
    advisories: ['GHSA-vc2v-76pw-4v95'],
    ranges: [{ fixed: '1.8.2' }],
  },
  {
    pkg: 'dompurify',
    // GHSA-cg2g-xh64-v4q7 >=3.4.4 <=3.4.16; GHSA-mrv2-3pqr-j5jr and
    // GHSA-c6gr-qvv4-5v3f <=3.4.16; GHSA-6688-9rhm-gjv2 <=3.4.15;
    // GHSA-p98j-92pf-mc4p >=3.4.13 <=3.4.15. Every one is fixed in 3.4.17.
    advisories: [
      'GHSA-cg2g-xh64-v4q7',
      'GHSA-mrv2-3pqr-j5jr',
      'GHSA-c6gr-qvv4-5v3f',
      'GHSA-6688-9rhm-gjv2',
      'GHSA-p98j-92pf-mc4p',
    ],
    ranges: [{ fixed: '3.4.17' }],
  },
  {
    pkg: 'source-map-js',
    advisories: ['GHSA-68fv-2mgg-jv7q'],
    ranges: [{ from: '1.0.0', fixed: '1.2.2' }],
  },
  {
    pkg: 'image-size',
    // GHSA-w3rx-r6r6-pgpr >=0.6.3 <=2.0.2; GHSA-5p2g-fcmc-qvqq >=1.2.0 <=2.0.2.
    advisories: ['GHSA-w3rx-r6r6-pgpr', 'GHSA-5p2g-fcmc-qvqq'],
    ranges: [{ from: '0.6.3', fixed: '2.0.3' }],
  },
  {
    pkg: 'fast-uri',
    advisories: [
      'GHSA-w74x-v6f9-j3xg',
      'GHSA-wjr9-j795-jxcr',
      'GHSA-xhq7-xmqj-769h',
      'GHSA-333x-w4r6-6crp',
    ],
    ranges: [
      { fixed: '2.4.8' },
      { from: '3.0.0', fixed: '3.1.9' },
      { from: '4.0.0', fixed: '4.2.3' },
    ],
  },
  {
    pkg: 'sharp',
    advisories: ['GHSA-wq5f-xc86-pv6w'],
    ranges: [{ fixed: '0.35.5' }],
  },
  {
    pkg: 'shell-quote',
    advisories: ['GHSA-pqg4-j6r4-53mv'],
    ranges: [{ from: '1.8.4', fixed: '1.11.0' }],
  },
];

/**
 * Every version pnpm-lock.yaml resolves for each package, from the keys of
 * its `packages:` section (lockfile v9: one `  name@version:` line per
 * resolved package, quoted when the name is scoped). Throws rather than
 * returning nothing when the file does not have that shape.
 */
function lockedVersions(lockfile: string): Map<string, string[]> {
  const lines = lockfile.split('\n');
  if (lines[0] !== "lockfileVersion: '9.0'") {
    throw new Error(`unexpected lockfile version line: ${lines[0]}`);
  }
  const start = lines.indexOf('packages:');
  const end = lines.indexOf('snapshots:');
  if (start < 0 || end < start) throw new Error('no packages: section before snapshots:');
  const out = new Map<string, string[]>();
  for (const line of lines.slice(start + 1, end)) {
    const m = /^ {2}'?((?:@[^@/'\s]+\/)?[^@'\s]+)@([^'\s]+?)'?:$/.exec(line);
    const name = m?.[1];
    const ver = m?.[2];
    if (name === undefined || ver === undefined) continue;
    out.set(name, [...(out.get(name) ?? []), ver]);
  }
  return out;
}

/** Each locked version inside a floor's vulnerable range (or not a version at all), as `name@version (advisories)`. */
function vulnerableLocked(lockfile: string, floors: Floor[] = FLOORS): string[] {
  const locked = lockedVersions(lockfile);
  const found: string[] = [];
  for (const floor of floors) {
    for (const text of locked.get(floor.pkg) ?? []) {
      const v = parseVersion(text);
      const hit =
        v === null ||
        floor.ranges.some(
          (r) =>
            (r.from === undefined || compare(v, version(r.from)) >= 0) &&
            compare(v, version(r.fixed)) < 0,
        );
      if (hit) found.push(`${floor.pkg}@${text} (${floor.advisories.join(', ')})`);
    }
  }
  return found;
}

const LOCKFILE = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');

describe('the lockfile resolves no version an advisory fixed here covers', () => {
  it('reads the real lockfile (fails closed on a format it does not know)', () => {
    const locked = lockedVersions(LOCKFILE);
    expect(locked.size).toBeGreaterThan(1000);
    for (const pkg of ['next', 'react', 'expo', '@supabase/supabase-js']) {
      expect(locked.get(pkg)?.length, pkg).toBeGreaterThan(0);
    }
  });

  it('resolves only fixed versions of every package listed', () => {
    expect(vulnerableLocked(LOCKFILE)).toEqual([]);
  });

  it('has no image-size at all: metro 0.84.5 and later dropped it', () => {
    const locked = lockedVersions(LOCKFILE);
    expect(locked.get('image-size')).toBeUndefined();
    const metros = locked.get('metro') ?? [];
    expect(metros.length).toBeGreaterThan(0);
    const floor = version('0.84.5');
    for (const m of metros) {
      expect(compare(version(m), floor), m).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the check itself', () => {
  const fixture = (keys: string[]): string =>
    [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      ...keys.flatMap((k) => [`  ${k}:`, '    resolution: {integrity: sha512-x}', '']),
      'snapshots:',
      '',
      ...keys.flatMap((k) => [`  ${k}: {}`, '']),
    ].join('\n');

  it('flags a vulnerable version, scoped or not, and passes the first fixed one', () => {
    const lock = fixture([
      'compression@1.8.1',
      'dompurify@3.4.16',
      'source-map-js@1.2.1',
      'image-size@1.2.1',
      'fast-uri@3.1.8',
      'sharp@0.35.4',
      'shell-quote@1.10.0',
      "'@scope/other@1.0.0'",
    ]);
    expect(vulnerableLocked(lock).map((f) => f.split(' ')[0])).toEqual([
      'compression@1.8.1',
      'dompurify@3.4.16',
      'source-map-js@1.2.1',
      'image-size@1.2.1',
      'fast-uri@3.1.8',
      'sharp@0.35.4',
      'shell-quote@1.10.0',
    ]);
    expect(
      vulnerableLocked(
        fixture([
          'compression@1.8.2',
          'dompurify@3.4.17',
          'source-map-js@1.2.2',
          'fast-uri@3.1.9',
          'sharp@0.35.5',
          'shell-quote@1.11.0',
        ]),
      ),
    ).toEqual([]);
  });

  it('honours where a range starts, and checks each major line on its own', () => {
    expect(vulnerableLocked(fixture(['source-map-js@0.6.2', 'shell-quote@1.8.3']))).toEqual([]);
    expect(vulnerableLocked(fixture(['fast-uri@2.4.7', 'fast-uri@4.2.2']))).toHaveLength(2);
    expect(vulnerableLocked(fixture(['fast-uri@2.4.8', 'fast-uri@4.2.3']))).toEqual([]);
  });

  it('orders prereleases before their release and fails a version it cannot read', () => {
    expect(vulnerableLocked(fixture(['compression@1.8.2-rc.1']))).toHaveLength(1);
    expect(vulnerableLocked(fixture(['compression@1.8.3-rc.1']))).toEqual([]);
    expect(
      vulnerableLocked(fixture(["'compression@https://codeload.example.invalid/x/tar.gz/abc'"])),
    ).toHaveLength(1);
  });

  it('refuses a lockfile of another format instead of finding nothing', () => {
    expect(() => vulnerableLocked("lockfileVersion: '10.0'\n\npackages:\n\nsnapshots:\n")).toThrow(
      /lockfile version/,
    );
    expect(() => vulnerableLocked("lockfileVersion: '9.0'\n\nimporters:\n")).toThrow(/packages:/);
  });
});
