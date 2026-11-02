import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Dependency advisories fixed in pnpm-lock.yaml stay fixed (docket S13,
 * 2026-10-24), and the alerts dismissed instead keep their reasons (docket
 * C20, 2026-11-01).
 *
 * WHAT WAS OPEN: after the Next.js 16.4.3 upgrade (#381), Dependabot still
 * had alerts open on versions the lockfile resolved although every
 * consumer's range already allowed a fixed release, and `pnpm audit` listed
 * advisories that had no alert yet, one of them critical (Dependabot opened
 * those alerts on 2026-10-25):
 *
 *   - compression 1.8.1 (GHSA-vc2v-76pw-4v95, Dependabot #114): the Expo
 *     CLI's development server (apps/mobile: expo > @expo/cli, ^1.7.4).
 *   - dompurify 3.4.15 (GHSA-cg2g-xh64-v4q7 critical, GHSA-mrv2-3pqr-j5jr
 *     high, three low; Dependabot #110, #116 and #131 to #133): asked for
 *     only by posthog-js's product-tours source (^3.4.13). The app imports
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
 *   - fast-uri 3.1.8 (four advisories of 2026-10-23, Dependabot #135 to
 *     #138): ajv 8, for commitlint and as @hookform/resolvers' unused ajv
 *     peer.
 *   - vite 6.4.3 (five advisories of 2026-10-20 and 2026-10-21, in its
 *     development server and the launch-editor copy it bundles, Dependabot
 *     #124 to #128) and @vitest/mocker 4.1.11 (GHSA-qxg6-89mg-rqv8,
 *     GHSA-xp26-3454-mjgp, Dependabot #129 and #130): the test runner in
 *     apps/web, apps/mobile and packages/core. The first fixed releases are
 *     vite 6.4.4 (the lockfile resolves 6.4.5) and @vitest/mocker 4.1.12,
 *     which vitest 4.1.12 brings.
 *   - happy-dom 20.14.5 (GHSA-834v-8h66-3h79, Dependabot #122 and #139): the
 *     DOM of apps/web's component tests, and vitest's optional peer. It is
 *     reachable only with JavaScript evaluation turned on, which no test
 *     does. 21.0.4 is the only fixed release; 21.0.0 also turned CSS file
 *     and iframe page loading off by default, which no test relies on.
 *
 * sharp and shell-quote, fixed by #381 while their alerts (#119 and #118)
 * were still open, are held to the same rule.
 *
 * On 2026-11-01 Dependabot opened fifteen more alerts (#140 to #154):
 *
 *   - node-forge 1.4.0 (eleven advisories, #142 to #152): Expo's command-line
 *     tools in apps/mobile, on a developer machine or the EAS build server.
 *     1.4.1 fixes them, and the override takes 1.4.2.
 *   - decode-uri-component 0.5.0 (GHSA-qr28-fpjm-wq7f, #141): the decoder of
 *     the patched query-string 7.1.3 in the phone bundle. 0.5.1 fixes it;
 *     apps/mobile/src/lib/query-string-decode.test.ts runs the patched module
 *     with it.
 *   - glob 13.0.6 (#153), minimatch 10.2.6 and 3.1.5 (#154) and deepmerge
 *     4.3.1 (#140): their fixes are glob 14 and minimatch 11, majors no parent
 *     accepts yet, and deepmerge has no fixed release. Their alerts are
 *     dismissed instead, and DISMISSED below checks why.
 *
 * WHAT STOPS IT NOW: root package.json overrides set the floors
 * (compression@1 ^1.8.2, dompurify@3 ^3.4.17, source-map-js@1 ^1.2.2,
 * fast-uri@3 ^3.1.9, vite ^6.4.4, node-forge@1 ^1.4.2,
 * decode-uri-component@<0.5.1 0.5.1), apps/web asks for happy-dom ^21.0.4,
 * and this test reads every version the lockfile resolves and fails when one
 * is inside an advisory's vulnerable range. A lockfile change that brings one
 * back (a new dependency, a revert, a hand edit) fails CI instead of waiting
 * for an alert. For each dismissed alert it reads who depends on each locked
 * version inside the advisory's range, and fails on a dependent the dismissal
 * does not name, or when no locked version is inside the range any more (an
 * upgrade took the vulnerable copy out: remove the entry and re-check the
 * alert, which a dismissal never does by itself).
 *
 * NOT COVERED: zod 3 (GHSA-mrhx-c7xc-m3w5, Dependabot #120, #121, #123 and
 * #134) needs zod 4, a change of its own (docket C12; #381 refuses over-long
 * lists on the two public routes until then). A withdrawn advisory
 * (sprintf-js, GHSA-hp3w-g68c-fv3c) is not a defect.
 *
 * IF THIS FAILS: a lockfile change resolved a vulnerable version, or gave a
 * dismissed one a new dependent. Find what asks for it
 * (`pnpm why -r <package>`) and resolve the fixed version; do not lower a
 * range here. Before naming a new dependent of a dismissed package, find out
 * whether it runs on the web server or in the phone app with input that is
 * not ours: if it does, the alert cannot stay dismissed.
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
 * `fixed`). The comment on each entry records every advisory's own range and
 * first patched release, as `range -> fix`, so a floor can be checked
 * against `gh api /advisories/<id>`.
 */
const FLOORS: Floor[] = [
  {
    pkg: 'compression',
    // GHSA-vc2v-76pw-4v95 <1.8.2 -> 1.8.2.
    advisories: ['GHSA-vc2v-76pw-4v95'],
    ranges: [{ fixed: '1.8.2' }],
  },
  {
    pkg: 'dompurify',
    // GHSA-cg2g-xh64-v4q7 >=3.4.4 <=3.4.16 -> 3.4.17; GHSA-mrv2-3pqr-j5jr and
    // GHSA-c6gr-qvv4-5v3f <=3.4.16 -> 3.4.17; GHSA-6688-9rhm-gjv2 <=3.4.15 ->
    // 3.4.16; GHSA-p98j-92pf-mc4p >=3.4.13 <=3.4.15 -> 3.4.16. 3.4.17 is the
    // first release that fixes all five.
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
    // GHSA-68fv-2mgg-jv7q >=1.0.0 <1.2.2 -> 1.2.2.
    advisories: ['GHSA-68fv-2mgg-jv7q'],
    ranges: [{ from: '1.0.0', fixed: '1.2.2' }],
  },
  {
    pkg: 'image-size',
    // GHSA-w3rx-r6r6-pgpr >=0.6.3 <=2.0.2 -> 2.0.3; GHSA-5p2g-fcmc-qvqq
    // >=1.2.0 <=2.0.2 -> 2.0.3. No 1.x release is fixed.
    advisories: ['GHSA-w3rx-r6r6-pgpr', 'GHSA-5p2g-fcmc-qvqq'],
    ranges: [{ from: '0.6.3', fixed: '2.0.3' }],
  },
  {
    pkg: 'fast-uri',
    // GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h and GHSA-333x-w4r6-6crp:
    // <2.4.8 -> 2.4.8, >=3.0.0 <3.1.9 -> 3.1.9, >=4.0.0 <4.2.3 -> 4.2.3.
    // GHSA-wjr9-j795-jxcr: >=2.4.2 <2.4.8 -> 2.4.8, >=3.1.3 <3.1.9 -> 3.1.9,
    // >=4.0.1 <4.2.3 -> 4.2.3.
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
    pkg: 'vite',
    // All five list the same vite ranges and first patched releases:
    // <=6.4.3 -> 6.4.4, >=7.0.0 <=7.3.6 -> 7.3.7, >=8.0.0 <=8.1.5 -> 8.1.6,
    // >=8.2.0 <=8.2.3 -> 8.2.4, >=8.3.0 <=8.3.2 -> 8.3.3. The 6.x fix is
    // 6.4.4; the lockfile resolves 6.4.5.
    advisories: [
      'GHSA-587h-7wmj-h5pm',
      'GHSA-698v-4r3x-3vcv',
      'GHSA-r825-w8mm-5pxw',
      'GHSA-rq7h-c2jc-7f22',
      'GHSA-9jrq-w75r-8gcw',
    ],
    ranges: [
      { fixed: '6.4.4' },
      { from: '7.0.0', fixed: '7.3.7' },
      { from: '8.0.0', fixed: '8.1.6' },
      { from: '8.2.0', fixed: '8.2.4' },
      { from: '8.3.0', fixed: '8.3.3' },
    ],
  },
  {
    pkg: '@vitest/mocker',
    // GHSA-qxg6-89mg-rqv8 >=2.1.0-beta.7 <4.1.12 -> 4.1.12, >=5.0.0-beta.1
    // <5.0.3 -> 5.0.3; GHSA-xp26-3454-mjgp >=4.1.11 <4.1.12 -> 4.1.12,
    // >=5.0.0-rc.2 <5.0.3 -> 5.0.3.
    advisories: ['GHSA-qxg6-89mg-rqv8', 'GHSA-xp26-3454-mjgp'],
    ranges: [
      { from: '2.1.0-beta.7', fixed: '4.1.12' },
      { from: '5.0.0-beta.1', fixed: '5.0.3' },
    ],
  },
  {
    pkg: 'happy-dom',
    // GHSA-834v-8h66-3h79 >=17.0.0 <=21.0.3 -> 21.0.4.
    advisories: ['GHSA-834v-8h66-3h79'],
    ranges: [{ from: '17.0.0', fixed: '21.0.4' }],
  },
  {
    pkg: 'sharp',
    // GHSA-wq5f-xc86-pv6w <0.35.5 -> 0.35.5.
    advisories: ['GHSA-wq5f-xc86-pv6w'],
    ranges: [{ fixed: '0.35.5' }],
  },
  {
    pkg: 'shell-quote',
    // GHSA-pqg4-j6r4-53mv >=1.8.4 <1.11.0 -> 1.11.0.
    advisories: ['GHSA-pqg4-j6r4-53mv'],
    ranges: [{ from: '1.8.4', fixed: '1.11.0' }],
  },
  {
    pkg: 'node-forge',
    // The eleven of Dependabot #142 to #152 (listed in alert order): <=1.4.0
    // -> 1.4.1. GHSA-86w9-cpqp-85rv (#112, dismissed 2026-10-25): <=1.4.0 ->
    // none listed by GitHub, but forge's CHANGELOG (tag v1.4.2, 7928054627d)
    // lists its CVE-2026-85393 in the Security section of 1.4.1. The override
    // asks for ^1.4.2 because 1.4.1's pem.decode() threw a TypeError on Buffer
    // input, which 1.4.2 fixed.
    advisories: [
      'GHSA-5x38-2vff-x55p',
      'GHSA-hqq3-7jhf-c5jx',
      'GHSA-8hrf-8g6f-7xwp',
      'GHSA-jc66-7q78-782g',
      'GHSA-5cwg-6vw7-rj6p',
      'GHSA-4487-j8r4-4g2f',
      'GHSA-h6cr-wjv9-3cpp',
      'GHSA-7wch-p9px-956x',
      'GHSA-525v-9gp9-w22h',
      'GHSA-6wvx-3r32-xmcg',
      'GHSA-4642-5mcj-2rqw',
      'GHSA-86w9-cpqp-85rv',
    ],
    ranges: [{ fixed: '1.4.1' }],
  },
  {
    pkg: 'decode-uri-component',
    // GHSA-vcc3-ghjq-m6fr <=0.4.2 -> 0.5.0 (Dependabot #79); GHSA-qr28-fpjm-wq7f
    // <=0.5.0 -> 0.5.1 (#141).
    advisories: ['GHSA-vcc3-ghjq-m6fr', 'GHSA-qr28-fpjm-wq7f'],
    ranges: [{ fixed: '0.5.1' }],
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

/** Whether a locked version is inside one of the ranges. A text that is not a version counts as inside. */
function inRanges(text: string, ranges: Range[]): boolean {
  const v = parseVersion(text);
  return (
    v === null ||
    ranges.some(
      (r) =>
        (r.from === undefined || compare(v, version(r.from)) >= 0) &&
        compare(v, version(r.fixed)) < 0,
    )
  );
}

/** Each locked version inside a floor's vulnerable range (or not a version at all), as `name@version (advisories)`. */
function vulnerableLocked(lockfile: string, floors: Floor[] = FLOORS): string[] {
  const locked = lockedVersions(lockfile);
  const found: string[] = [];
  for (const floor of floors) {
    for (const text of locked.get(floor.pkg) ?? []) {
      if (inRanges(text, floor.ranges)) {
        found.push(`${floor.pkg}@${text} (${floor.advisories.join(', ')})`);
      }
    }
  }
  return found;
}

/**
 * An alert dismissed on GitHub instead of fixed: the vulnerable ranges
 * (copied from the advisory, as in FLOORS), the Dependabot alert number, and
 * the packages the dismissal's reason allows to depend on a version inside
 * those ranges.
 */
type Dismissal = Floor & { alert: number; dependents: string[] };

/**
 * Each alert here is dismissed (as tolerable risk) for one reason: every
 * package that depends on a locked version inside its ranges either runs on a
 * developer machine or a build server with only our own input, or never
 * reaches the flawed code. Only the dependents of versions inside the ranges
 * count, so archiver-utils and rimraf, which pull glob 7.2.3 onto the web
 * server (through exceljs), are not named, and either of them moving onto a
 * glob inside the range fails the check.
 *
 *   - glob 13.0.6: Expo's build tools, on our own patterns. The advisory is
 *     about a walk that keeps reading directories after it is aborted. The
 *     only walk they abort is the TypeScript check's, in `expo start` and
 *     `expo run`: @expo/cli 57.0.24 gives it AbortSignal.timeout(5000)
 *     (TypeScriptProjectPrerequisite.js:179-181; its anyMatchAsync helper
 *     aborts too, but nothing calls it). That check walks only a project with
 *     no tsconfig.json. apps/mobile has one (checked below), so it never
 *     walks here, and it would only ever walk our own files on a developer
 *     machine. glob 14 changes its API and needs minimatch 11; every Expo
 *     release still asks for ^13.
 *   - minimatch 10.2.6 and 3.1.5: ESLint and its plugins, typescript-eslint,
 *     @expo/fingerprint and glob, on our own patterns, and readdir-glob,
 *     which only archiver uses, inside exceljs, without ever globbing (see
 *     DISMISSAL_CHAINS). 3.1.5 does not hold the flawed code
 *     (firstPhasePreProcess). The fix is 11.x, and no parent accepts it.
 *   - deepmerge 4.3.1: @expo/config, merging our own app config. No release
 *     is fixed; @expo/config 58 (Expo SDK 58) no longer depends on it.
 *
 * Neither glob, minimatch nor deepmerge is in the phone app's bundle.
 */
const DISMISSED: Dismissal[] = [
  {
    pkg: 'glob',
    alert: 153,
    // GHSA-3g3m-2fjr-6pw4 >=9.0.0 <=14.0.1 -> 14.0.2.
    advisories: ['GHSA-3g3m-2fjr-6pw4'],
    ranges: [{ from: '9.0.0', fixed: '14.0.2' }],
    dependents: [
      '@expo/cli',
      '@expo/config',
      '@expo/config-plugins',
      '@expo/fingerprint',
      '@expo/metro-config',
      'expo-updates',
    ],
  },
  {
    pkg: 'minimatch',
    alert: 154,
    // GHSA-g3hv-75wg-m249 <11.0.1 -> 11.0.1.
    advisories: ['GHSA-g3hv-75wg-m249'],
    ranges: [{ fixed: '11.0.1' }],
    dependents: [
      '@eslint/config-array',
      '@eslint/eslintrc',
      '@expo/fingerprint',
      '@typescript-eslint/typescript-estree',
      'eslint',
      'eslint-plugin-import',
      'eslint-plugin-jsx-a11y',
      'eslint-plugin-react',
      'glob',
      'readdir-glob',
    ],
  },
  {
    pkg: 'deepmerge',
    alert: 140,
    // GHSA-gcqx-w48m-w2h4 >=4.2.0 <=4.3.1, no patched version listed: 4.3.2
    // is the next version up, not a known fix.
    advisories: ['GHSA-gcqx-w48m-w2h4'],
    ranges: [{ from: '4.2.0', fixed: '4.3.2' }],
    dependents: ['@expo/config'],
  },
];

/**
 * Packages a dismissal relies on staying where they are, whatever their
 * version: minimatch 10.2.6 reaches the web server through exceljs >
 * archiver > readdir-glob, and #154 stays dismissed because exceljs adds
 * entries only with archiver's append() and file(), while only its
 * directory() and glob() call readdir-glob. Any other dependent of either,
 * our own code included, fails the check.
 */
const DISMISSAL_CHAINS: Record<string, string[]> = {
  'readdir-glob': ['archiver'],
  archiver: ['exceljs'],
};

/** The package name in a lockfile key: `@scope/name@1.0.0(peer@2.0.0)` is `@scope/name`. */
function packageName(key: string): string {
  const name = /^((?:@[^@/'\s]+\/)?[^@'\s]+)@[^@'\s]/.exec(key)?.[1];
  if (name === undefined) throw new Error(`not a package key: ${key}`);
  return name;
}

/**
 * The real package behind an aliased dependency (`alias: real@1.0.0`), or null
 * for a plain version. A version has no `@` before its first `(`.
 */
function aliasOf(value: string): string | null {
  return /^((?:@[^@/'\s(]+\/)?[^@'\s(]+)@\d/.exec(value)?.[1] ?? null;
}

/**
 * The locked `name@version` a dependency resolves to: its version without the
 * `(peer@2.0.0)` suffixes, and for an alias (`x: real@1.2.3`) the real
 * package's.
 */
function resolvedAs(name: string, value: string): string {
  const key = aliasOf(value) === null ? `${name}@${value}` : value;
  return key.replace(/\(.*$/, '');
}

const DEPENDENCY_LISTS = new Set(['dependencies', 'devDependencies', 'optionalDependencies']);

/**
 * Who depends on what, read in one pass: `byName` maps each package to the
 * packages whose `snapshots:` entry lists it and the workspace packages (as
 * `workspace apps/mobile`) whose `importers:` entry lists it; `byVersion`
 * maps each locked `name@version` the same way. A dependency installed under
 * an alias also counts for the real package. Throws rather than returning
 * nothing when the file does not have that shape.
 */
function dependents(lockfile: string): {
  byName: Map<string, Set<string>>;
  byVersion: Map<string, Set<string>>;
} {
  const lines = lockfile.split('\n');
  if (lines[0] !== "lockfileVersion: '9.0'") {
    throw new Error(`unexpected lockfile version line: ${lines[0]}`);
  }
  const importersAt = lines.indexOf('importers:');
  const packagesAt = lines.indexOf('packages:');
  const snapshotsAt = lines.indexOf('snapshots:');
  if (importersAt < 0 || packagesAt < importersAt || snapshotsAt < packagesAt) {
    throw new Error('no importers:, packages: and snapshots: sections, in that order');
  }
  const byName = new Map<string, Set<string>>();
  const byVersion = new Map<string, Set<string>>();
  const add = (to: Map<string, Set<string>>, key: string, owner: string): void => {
    to.set(key, (to.get(key) ?? new Set<string>()).add(owner));
  };
  // Both sections hold one entry per line at two spaces, with its dependency
  // lists at four and their entries at six.
  const read = (
    section: string[],
    ownerOf: (key: string) => string,
    dependencyOn: (line: string) => { names: string[]; resolved?: string },
  ): void => {
    let owner: string | undefined;
    let listing = false;
    for (const line of section) {
      const key = /^ {2}'?(\S.*?)'?:(?: \{\})?$/.exec(line)?.[1];
      if (key !== undefined) {
        owner = ownerOf(key);
        listing = false;
        continue;
      }
      const list = /^ {4}(\w+):/.exec(line)?.[1];
      if (list !== undefined) {
        listing = DEPENDENCY_LISTS.has(list);
        continue;
      }
      if (!listing || owner === undefined) continue;
      const { names, resolved } = dependencyOn(line);
      for (const pkg of names) add(byName, pkg, owner);
      if (resolved !== undefined) add(byVersion, resolved, owner);
    }
  };
  // An importer lists a dependency's name at six spaces and its `version:` at
  // eight, a few lines below.
  let importing: string | undefined;
  read(
    lines.slice(importersAt + 1, packagesAt),
    (key) => `workspace ${key}`,
    (line) => {
      const name = /^ {6}'?([^'\s][^']*?)'?:$/.exec(line)?.[1];
      if (name !== undefined) {
        importing = name;
        return { names: [name] };
      }
      const version = /^ {8}version: '?([^'\s]+?)'?$/.exec(line)?.[1];
      if (version === undefined || importing === undefined) return { names: [] };
      const resolved = resolvedAs(importing, version);
      importing = undefined;
      const real = aliasOf(version);
      return { names: real === null ? [] : [real], resolved };
    },
  );
  read(lines.slice(snapshotsAt + 1), packageName, (line) => {
    const m = /^ {6}'?([^'\s][^']*?)'?: '?([^'\s]+?)'?$/.exec(line);
    if (!m?.[1] || !m[2]) return { names: [] };
    const real = aliasOf(m[2]);
    return { names: real === null ? [m[1]] : [m[1], real], resolved: resolvedAs(m[1], m[2]) };
  });
  return { byName, byVersion };
}

/**
 * Each dependent of a package in `named` that its list does not name, as
 * `package <- dependent`, whatever the version. Throws when a package is
 * locked but nothing seems to depend on it, since that means the lockfile was
 * not read.
 */
function unnamedDependents(lockfile: string, named: Record<string, string[]>): string[] {
  const locked = lockedVersions(lockfile);
  const all = dependents(lockfile).byName;
  const found: string[] = [];
  for (const [pkg, allowed] of Object.entries(named)) {
    const by = [...(all.get(pkg) ?? [])].sort();
    if (locked.has(pkg) && by.length === 0) {
      throw new Error(`${pkg} is locked but nothing depends on it: the lockfile was not read`);
    }
    for (const dependent of by) {
      if (!allowed.includes(dependent)) found.push(`${pkg} <- ${dependent}`);
    }
  }
  return found;
}

/**
 * What a dismissal no longer covers: each dependent of a locked version
 * inside its ranges that it does not name, as `glob@13.0.6 <- some-lib`, and
 * a dismissal with no locked version inside its ranges any more (stale: an
 * upgrade took the vulnerable copy out). Throws when a version inside the
 * ranges is locked but nothing seems to depend on it, since that means the
 * lockfile was not read.
 */
function undismissed(lockfile: string, dismissed: Dismissal[] = DISMISSED): string[] {
  const locked = lockedVersions(lockfile);
  const all = dependents(lockfile).byVersion;
  const found: string[] = [];
  for (const d of dismissed) {
    const inside = (locked.get(d.pkg) ?? []).filter((text) => inRanges(text, d.ranges));
    if (inside.length === 0) {
      found.push(
        `${d.pkg}: no locked version is inside the dismissed range any more: remove this entry and re-check alert #${d.alert}`,
      );
    }
    for (const text of inside) {
      const by = [...(all.get(`${d.pkg}@${text}`) ?? [])].sort();
      if (by.length === 0) {
        throw new Error(
          `${d.pkg}@${text} is locked but nothing depends on it: the lockfile was not read`,
        );
      }
      for (const dependent of by) {
        if (!d.dependents.includes(dependent)) found.push(`${d.pkg}@${text} <- ${dependent}`);
      }
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
      'vite@6.4.3',
      "'@vitest/mocker@4.1.11'",
      'happy-dom@21.0.3',
      'sharp@0.35.4',
      'shell-quote@1.10.0',
      'node-forge@1.4.0',
      'decode-uri-component@0.5.0',
      "'@scope/other@1.0.0'",
    ]);
    expect(vulnerableLocked(lock).map((f) => f.split(' ')[0])).toEqual([
      'compression@1.8.1',
      'dompurify@3.4.16',
      'source-map-js@1.2.1',
      'image-size@1.2.1',
      'fast-uri@3.1.8',
      'vite@6.4.3',
      '@vitest/mocker@4.1.11',
      'happy-dom@21.0.3',
      'sharp@0.35.4',
      'shell-quote@1.10.0',
      'node-forge@1.4.0',
      'decode-uri-component@0.5.0',
    ]);
    expect(
      vulnerableLocked(
        fixture([
          'compression@1.8.2',
          'dompurify@3.4.17',
          'source-map-js@1.2.2',
          'fast-uri@3.1.9',
          'vite@6.4.4',
          "'@vitest/mocker@4.1.12'",
          'happy-dom@21.0.4',
          'sharp@0.35.5',
          'shell-quote@1.11.0',
          'node-forge@1.4.1',
          'decode-uri-component@0.5.1',
        ]),
      ),
    ).toEqual([]);
  });

  it('honours where a range starts, and checks each major line on its own', () => {
    expect(vulnerableLocked(fixture(['source-map-js@0.6.2', 'shell-quote@1.8.3']))).toEqual([]);
    expect(vulnerableLocked(fixture(['fast-uri@2.4.7', 'fast-uri@4.2.2']))).toHaveLength(2);
    expect(vulnerableLocked(fixture(['fast-uri@2.4.8', 'fast-uri@4.2.3']))).toEqual([]);
    expect(vulnerableLocked(fixture(['vite@7.3.6', 'vite@8.2.0', 'vite@8.3.2']))).toHaveLength(3);
    expect(vulnerableLocked(fixture(['vite@7.3.7', 'vite@8.1.6', 'vite@8.3.3']))).toEqual([]);
    // vite's 6.x fix is 6.4.4: 6.4.3 fails, 6.4.4 and the resolved 6.4.5 pass.
    expect(vulnerableLocked(fixture(['vite@6.4.3']))).toHaveLength(1);
    expect(vulnerableLocked(fixture(['vite@6.4.4', 'vite@6.4.5']))).toEqual([]);
    expect(vulnerableLocked(fixture(["'@vitest/mocker@2.1.0-beta.6'"]))).toEqual([]);
    expect(vulnerableLocked(fixture(["'@vitest/mocker@2.1.0-beta.7'"]))).toHaveLength(1);
    expect(
      vulnerableLocked(
        fixture([
          "'@vitest/mocker@5.0.0-beta.1'",
          "'@vitest/mocker@5.0.2'",
          "'@vitest/mocker@4.2.0'",
        ]),
      ),
    ).toEqual([
      '@vitest/mocker@5.0.0-beta.1 (GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp)',
      '@vitest/mocker@5.0.2 (GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp)',
    ]);
    expect(vulnerableLocked(fixture(["'@vitest/mocker@5.0.3'"]))).toEqual([]);
    expect(vulnerableLocked(fixture(['happy-dom@16.8.1']))).toEqual([]);
    expect(vulnerableLocked(fixture(['happy-dom@17.0.0', 'happy-dom@20.14.5']))).toHaveLength(2);
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

describe('the alerts dismissed instead of fixed keep their reasons', () => {
  it('names every dependent of a locked version a dismissal covers, and no dismissal is stale', () => {
    expect(undismissed(LOCKFILE)).toEqual([]);
  });

  it('keeps readdir-glob and archiver where the minimatch dismissal relies on them', () => {
    expect(unnamedDependents(LOCKFILE, DISMISSAL_CHAINS)).toEqual([]);
  });

  it("keeps the phone app's tsconfig.json, without which `expo start` runs the glob walk #153 is about", () => {
    // Expo's TypeScript check looks for TypeScript files with a glob walk it
    // aborts when it runs over five seconds, and only in a project with no
    // tsconfig.json (see DISMISSED).
    const tsconfig = statSync(join(REPO_ROOT, 'apps', 'mobile', 'tsconfig.json'), {
      throwIfNoEntry: false,
    });
    expect(tsconfig?.isFile()).toBe(true);
  });

  it('reads who depends on what in the real lockfile', () => {
    const all = dependents(LOCKFILE).byName;
    expect(all.size).toBeGreaterThan(1000);
    expect([...(all.get('react') ?? [])]).toEqual(
      expect.arrayContaining(['workspace apps/web', 'workspace apps/mobile']),
    );
    // A development dependency counts too (the root's TypeScript).
    expect([...(all.get('typescript') ?? [])]).toContain('workspace .');
  });

  it('reads who depends on each locked version in the real lockfile', () => {
    // Every version the lockfile locks has a dependent, so one the reader
    // misses (a peer suffix it kept, an alias it did not follow) shows here.
    const { byVersion } = dependents(LOCKFILE);
    const unread = [...lockedVersions(LOCKFILE)].flatMap(([pkg, versions]) =>
      versions.map((v) => `${pkg}@${v}`).filter((key) => !byVersion.has(key)),
    );
    expect(unread).toEqual([]);
  });

  type Lists = { dependencies?: string[]; optionalDependencies?: string[] };
  // Workspace and package dependencies are both written `name: version`.
  const graph = (workspace: Record<string, string[]>, snapshots: Record<string, Lists>): string =>
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      ...Object.entries(workspace).flatMap(([path, deps]) => [
        `  ${path}:`,
        '    dependencies:',
        ...deps.flatMap((d) => {
          const [name = '', version = ''] = d.split(': ');
          return [`      ${name}:`, `        specifier: ${version}`, `        version: ${version}`];
        }),
        '',
      ]),
      'packages:',
      '',
      ...Object.keys(snapshots).flatMap((k) => [
        `  ${k}:`,
        '    resolution: {integrity: sha512-x}',
        '',
      ]),
      'snapshots:',
      '',
      ...Object.entries(snapshots).flatMap(([k, lists]) => {
        const body = Object.entries(lists).flatMap(([list, deps]) => [
          `    ${list}:`,
          ...deps.map((d) => `      ${d}`),
        ]);
        return body.length === 0 ? [`  ${k}: {}`, ''] : [`  ${k}:`, ...body, ''];
      }),
    ].join('\n');

  // Today's shape, cut down: the versions inside the ranges, with dependents
  // the dismissals name; glob 7.2.3, outside glob's range, under
  // archiver-utils and rimraf; and exceljs > archiver > readdir-glob on the
  // web server.
  const web = { 'apps/web': ['exceljs: 4.4.0'] };
  const today: Record<string, Lists> = {
    "'@expo/cli@57.0.24(expo@57.0.22)'": { dependencies: ['glob: 13.0.6'] },
    "'@expo/config@57.0.9'": { dependencies: ['deepmerge: 4.3.1', 'glob: 13.0.6'] },
    "'@expo/fingerprint@0.20.3'": { dependencies: ['glob: 13.0.6', 'minimatch: 10.2.6'] },
    'archiver-utils@2.1.0': { dependencies: ['glob: 7.2.3'] },
    'archiver@5.3.2': { dependencies: ['archiver-utils: 2.1.0', 'readdir-glob: 1.1.3'] },
    'deepmerge@4.3.1': {},
    'eslint@9.39.5': { dependencies: ['minimatch: 3.1.5'] },
    'exceljs@4.4.0': { dependencies: ['archiver: 5.3.2', 'rimraf: 2.7.1'] },
    'glob@13.0.6': { dependencies: ['minimatch: 10.2.6'] },
    'glob@7.2.3': { dependencies: ['minimatch: 3.1.5'] },
    'minimatch@10.2.6': {},
    'minimatch@3.1.5': {},
    'readdir-glob@1.1.3': { dependencies: ['minimatch: 10.2.6'] },
    'rimraf@2.7.1': { dependencies: ['glob: 7.2.3'] },
  };

  it('passes the dependents a dismissal names, and ignores those of a version outside its range', () => {
    expect(undismissed(graph(web, today))).toEqual([]);
    expect(unnamedDependents(graph(web, today), DISMISSAL_CHAINS)).toEqual([]);
  });

  it('flags a dependent the dismissal does not name, however it is listed', () => {
    // A workspace or a package can list a dependency under an npm alias
    // (`g: glob@13.0.6`), and both checks follow it to the real package.
    const lock = graph(
      {
        'apps/web': ['exceljs: 4.4.0', 'minimatch: 10.2.6', 'archiver: 5.3.2'],
        'packages/core': ['g: glob@13.0.6', 'rg: readdir-glob@1.1.3'],
      },
      {
        ...today,
        'alias-lib@1.0.0': { dependencies: ['arc: archiver@5.3.2'] },
        'other-lib@1.0.0': { dependencies: ['g: glob@13.0.6', 'readdir-glob: 1.1.3'] },
        'server-lib@2.0.0': { optionalDependencies: ['deepmerge: 4.3.1(peer-lib@1.0.0)'] },
      },
    );
    expect(undismissed(lock)).toEqual([
      'glob@13.0.6 <- other-lib',
      'glob@13.0.6 <- workspace packages/core',
      'minimatch@10.2.6 <- workspace apps/web',
      'deepmerge@4.3.1 <- server-lib',
    ]);
    expect(unnamedDependents(lock, DISMISSAL_CHAINS)).toEqual([
      'readdir-glob <- other-lib',
      'readdir-glob <- workspace packages/core',
      'archiver <- alias-lib',
      'archiver <- workspace apps/web',
    ]);
  });

  it('flags a dependent that moves onto a version inside the range', () => {
    // archiver 7 asks for archiver-utils ^5.0.2, which asks for glob ^10.
    const lock = graph(web, {
      ...today,
      'archiver@5.3.2': { dependencies: ['archiver-utils: 5.0.2', 'readdir-glob: 1.1.3'] },
      'archiver-utils@5.0.2': { dependencies: ['glob: 10.5.0'] },
      'glob@10.5.0': { dependencies: ['minimatch: 10.2.6'] },
    });
    expect(undismissed(lock)).toEqual(['glob@10.5.0 <- archiver-utils']);
  });

  it('reports a dismissal with no locked version inside its range any more', () => {
    // An Expo release on glob 14, and glob 7.2.3 still under rimraf: none of
    // the three dismissals has a vulnerable copy left to cover.
    const lock = graph(web, {
      "'@expo/cli@58.1.18'": { dependencies: ['glob: 14.0.3'] },
      'exceljs@4.4.0': { dependencies: ['rimraf: 2.7.1'] },
      'glob@14.0.3': {},
      'glob@7.2.3': {},
      'rimraf@2.7.1': { dependencies: ['glob: 7.2.3'] },
    });
    expect(undismissed(lock)).toEqual([
      'glob: no locked version is inside the dismissed range any more: remove this entry and re-check alert #153',
      'minimatch: no locked version is inside the dismissed range any more: remove this entry and re-check alert #154',
      'deepmerge: no locked version is inside the dismissed range any more: remove this entry and re-check alert #140',
    ]);
  });

  it('fails closed when it cannot read who asks for a version it checks', () => {
    // Something asks for glob 7.2.3, but nothing for 13.0.6.
    expect(() =>
      undismissed(
        graph(
          {},
          {
            'glob@13.0.6': {},
            'glob@7.2.3': {},
            'rimraf@2.7.1': { dependencies: ['glob: 7.2.3'] },
          },
        ),
      ),
    ).toThrow(/glob@13\.0\.6 is locked but nothing depends on it/);
    expect(() =>
      unnamedDependents(graph({}, { 'readdir-glob@1.1.3': {} }), DISMISSAL_CHAINS),
    ).toThrow(/nothing depends on it/);
    expect(() => dependents("lockfileVersion: '9.0'\n\npackages:\n\nsnapshots:\n")).toThrow(
      /importers:/,
    );
    expect(() => dependents("lockfileVersion: '10.0'\n\nimporters:\n")).toThrow(/lockfile version/);
  });
});
