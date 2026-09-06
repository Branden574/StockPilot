import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SP-095 regression guard for the root package.json Prettier globs.
 *
 * WHAT WENT WRONG: `scripts.format` / `scripts["format:check"]` globbed
 * `**\/*.{ts,tsx,md,json,sql,css}` and lint-staged carried the same `sql`
 * key — but no Prettier SQL parser has ever been installed (the only plugin
 * is prettier-plugin-tailwindcss). Prettier exits 2 with
 * `[error] No parser could be inferred for file "...0345_....sql"` on the
 * FIRST .sql file it reaches, so `pnpm format:check` aborted before
 * reporting a single line of real formatting drift, across 345 migrations
 * and ~140 pgTAP files. Nothing in prod or CI ran it, so the scripts were
 * simply dead — and would have blocked every commit touching a migration
 * the moment anyone restored the (currently absent) husky pre-commit hook.
 *
 * WHAT STOPS IT NOW: `sql` is gone from both globs and from the lint-staged
 * key, and this test asks Prettier ITSELF — via `--file-info`, which reports
 * the parser it would infer for a path without needing the file to exist —
 * whether every extension those globs claim is actually parseable. Adding an
 * extension with no parser fails here instead of silently killing the script.
 *
 * The deliberate non-fix: we did NOT install prettier-plugin-sql. It would
 * reformat 345 already-applied migrations and every pgTAP file for zero
 * benefit. If a future maintainer does install one and wires it into the
 * `prettier.plugins` config, this test forwards those plugins to
 * `--file-info` as `--plugin` flags (the CLI does NOT read config-declared
 * plugins on its own), so re-adding `sql` to the globs would then pass.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PRETTIER_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'prettier');

type RootPackageJson = {
  scripts?: Record<string, string>;
  'lint-staged'?: Record<string, unknown>;
  prettier?: { plugins?: string[] };
};

const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
) as RootPackageJson;

/**
 * Pull the file extensions out of a Prettier glob. Handles both the brace
 * form the repo uses (`**\/*.{ts,tsx,md}`) and a bare single-extension glob
 * (`*.sql`), so a future single-extension entry is still covered.
 */
function extensionsFromGlob(glob: string): string[] {
  const brace = glob.match(/\{([^}]*)\}/);
  if (brace?.[1]) {
    return brace[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  const single = glob.match(/\.([A-Za-z0-9]+)$/);
  return single?.[1] ? [single[1]] : [];
}

/** Every glob the root package.json hands to Prettier, from both surfaces. */
function prettierGlobs(): { source: string; glob: string }[] {
  const globs: { source: string; glob: string }[] = [];

  for (const scriptName of ['format', 'format:check']) {
    const script = pkg.scripts?.[scriptName];
    if (!script) continue;
    // `prettier --write "**/*.{ts,tsx}"` — grab each quoted argument.
    for (const quoted of script.match(/"([^"]+)"/g) ?? []) {
      globs.push({ source: `scripts.${scriptName}`, glob: quoted.slice(1, -1) });
    }
  }

  for (const [key, commands] of Object.entries(pkg['lint-staged'] ?? {})) {
    const runsPrettier = JSON.stringify(commands).includes('prettier');
    if (runsPrettier) globs.push({ source: `lint-staged["${key}"]`, glob: key });
  }

  return globs;
}

/**
 * Ask the repo's own Prettier which parser it would infer for `probe.<ext>`.
 * `--file-info` never reads the file, so no fixture content is needed and the
 * answer is purely about parser availability.
 */
function inferredParserFor(ext: string): string | null {
  const pluginArgs = (pkg.prettier?.plugins ?? []).flatMap((plugin) => ['--plugin', plugin]);
  const stdout = execFileSync(
    PRETTIER_BIN,
    [...pluginArgs, '--file-info', `sp095-probe.${ext}`],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return (JSON.parse(stdout) as { inferredParser: string | null }).inferredParser;
}

describe('root package.json prettier globs (SP-095)', () => {
  const globs = prettierGlobs();

  it('declares prettier globs on both the format scripts and lint-staged', () => {
    // Guards the extractor itself: if the scripts are renamed away, the
    // per-extension assertions below would vacuously pass over an empty list.
    expect(globs.map((entry) => entry.source)).toEqual(
      expect.arrayContaining(['scripts.format', 'scripts.format:check']),
    );
  });

  it.each(globs)('$source glob "$glob" only claims extensions prettier can parse', ({ glob }) => {
    const unparseable = extensionsFromGlob(glob).filter((ext) => inferredParserFor(ext) === null);
    expect(unparseable).toEqual([]);
  });
});
