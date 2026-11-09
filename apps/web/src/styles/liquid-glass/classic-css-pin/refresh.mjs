#!/usr/bin/env node
/**
 * Refreshes the CLASSIC CSS PIN fixture (classic-css-pin.guard.test.ts, defence
 * (g)) from origin/main's text at the merge base, and from nowhere else.
 *
 *   git fetch origin
 *   node apps/web/src/styles/liquid-glass/classic-css-pin/refresh.mjs
 *
 * Run it after main is merged into the branch (the merge base moves, so main's
 * new Classic CSS becomes the pin). An optional argument names the commit you
 * expect; the script refuses unless it is that merge base. It also refuses when
 * origin/main is missing, when HEAD is already on origin/main (nothing to pin
 * against) and when the merge base is not on origin/main.
 *
 * It writes, in this folder:
 *   files/<path under apps/web/src>  the merge base's text of every Classic
 *                                    stylesheet (apps/web/src outside
 *                                    styles/liquid-glass);
 *   candidates.dat                   the class tokens of Classic's source at
 *                                    the merge base: what Tailwind's scanner
 *                                    finds in apps/web there, kept when the
 *                                    merge base's globals.css builds a rule
 *                                    for it or it names a custom property;
 *                                    one per line. Tailwind's scanner
 *                                    skips .dat files, so the list never
 *                                    reaches the app's stylesheet. It DOES
 *                                    scan the .css copies under files/ (the
 *                                    app's automatic scan reads every .css
 *                                    file of apps/web): they add nothing
 *                                    because check (a) keeps them equal to
 *                                    the live Classic files, and the guard's
 *                                    "own files add nothing" test builds the
 *                                    stylesheet with and without this folder
 *                                    and requires the same output;
 *   manifest.json                    the merge base, the file list, every
 *                                    stylesheet outside styles/liquid-glass
 *                                    a source file imports, the token count,
 *                                    and the CSS toolchain at the merge base
 *                                    (apps/web's tailwindcss,
 *                                    @tailwindcss/postcss, postcss and
 *                                    tailwindcss-animate from its
 *                                    pnpm-lock.yaml, @tailwindcss/node and
 *                                    @tailwindcss/oxide from the
 *                                    @tailwindcss/postcss snapshot there, and
 *                                    postcss.config.mjs's text). The script
 *                                    refuses when the installed toolchain is
 *                                    not that one (run pnpm install first).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: HERE,
  encoding: 'utf8',
}).trim();
const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 }).trim();
const fail = (message) => {
  console.error(`refresh.mjs: refusing: ${message}`);
  process.exit(1);
};

const WEB = join(ROOT, 'apps', 'web');
const SRC_PREFIX = 'apps/web/src/';
const GLASS_PREFIX = 'apps/web/src/styles/liquid-glass/';
const STYLESHEET = /\.(css|scss|sass|less|pcss|postcss)$/;
/** A static or dynamic import, or a require, of a stylesheet (relative, @/ or a package). */
const IMPORT_STYLESHEET =
  /\b(?:import|require)\s*\(?\s*(?:[^'"();]*?\bfrom\s*)?['"]([^'"]+\.(?:css|scss|sass|less|pcss|postcss))['"]/g;

let main;
try {
  main = git('rev-parse', '--verify', 'origin/main^{commit}');
} catch {
  fail('origin/main is not available (git fetch origin first)');
}
const head = git('rev-parse', 'HEAD');
const base = git('merge-base', head, main);
if (base === head) fail(`HEAD ${head} is already on origin/main; there is no branch to pin`);
try {
  git('merge-base', '--is-ancestor', base, main);
} catch {
  fail(`${base} is not on origin/main`);
}
const wanted = process.argv[2];
if (wanted !== undefined) {
  let resolved = '';
  try {
    resolved = git('rev-parse', '--verify', `${wanted}^{commit}`);
  } catch {
    // An unknown name is refused below with the merge base named.
  }
  if (resolved !== base) {
    fail(`${wanted} is not the merge base of HEAD and origin/main (${base})`);
  }
}

// Every Classic stylesheet at the merge base, by its text there.
const files = git('ls-tree', '-r', '--name-only', base, '--', 'apps/web/src')
  .split('\n')
  .filter((p) => p.startsWith(SRC_PREFIX) && !p.startsWith(GLASS_PREFIX) && STYLESHEET.test(p))
  .sort();
if (!files.includes('apps/web/src/app/globals.css'))
  fail(`${base} has no apps/web/src/app/globals.css`);
const texts = new Map(
  files.map((p) => [p, execFileSync('git', ['show', `${base}:${p}`], { cwd: ROOT })]),
);

/**
 * The CSS toolchain at the merge base, from its pnpm-lock.yaml: apps/web's
 * resolved versions of its direct CSS packages, and the halves of
 * @tailwindcss/postcss (node and oxide) from that package's snapshot.
 */
function toolchainAt(commit) {
  const lock = git('show', `${commit}:pnpm-lock.yaml`);
  const importer = /\n  apps\/web:\n([\s\S]*?)(?=\n  [^\s]|\n\S|$)/.exec(lock)?.[1];
  if (!importer) fail(`${commit}'s pnpm-lock.yaml has no apps/web importer`);
  const direct = (name) => {
    const quoted = name.startsWith('@') ? `'${name}'` : name;
    const m = new RegExp(
      `\\n      ${quoted.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}:\\n        specifier: [^\\n]*\\n        version: ([^\\s(]+)`,
    ).exec(`\n${importer}`);
    if (!m) fail(`${commit}'s pnpm-lock.yaml: apps/web has no ${name}`);
    return m[1];
  };
  const packages = {
    '@tailwindcss/postcss': direct('@tailwindcss/postcss'),
    postcss: direct('postcss'),
    tailwindcss: direct('tailwindcss'),
    'tailwindcss-animate': direct('tailwindcss-animate'),
  };
  const snapshot = new RegExp(
    `\\n  '@tailwindcss/postcss@${packages['@tailwindcss/postcss'].replace(/\./g, '\\.')}':\\n    dependencies:\\n((?:      [^\\n]+\\n)+)`,
  ).exec(lock)?.[1];
  if (!snapshot) fail(`${commit}'s pnpm-lock.yaml has no @tailwindcss/postcss snapshot`);
  for (const half of ['@tailwindcss/node', '@tailwindcss/oxide']) {
    const m = new RegExp(`      '${half}': ([^\\s(]+)`).exec(snapshot);
    if (!m) fail(`${commit}'s pnpm-lock.yaml: @tailwindcss/postcss has no ${half}`);
    packages[half] = m[1];
  }
  return {
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => (a < b ? -1 : 1))),
    postcssConfig: execFileSync('git', ['show', `${commit}:apps/web/postcss.config.mjs`], {
      cwd: ROOT,
      encoding: 'utf8',
    }),
  };
}
const toolchain = toolchainAt(base);

/**
 * Every stylesheet a non-test source file under `src` imports, outside
 * styles/liquid-glass: a path under src for './x.css' and '@/x.css', the
 * specifier itself for a package. The guard reads the branch with the same
 * function (stylesheetImports in classic-css-pin.guard.test.ts).
 */
function stylesheetImports(src) {
  const out = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?|mjs)$/.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name)) {
        const rel = relative(src, full).split(sep).join('/');
        for (const m of readFileSync(full, 'utf8').matchAll(IMPORT_STYLESHEET)) {
          const spec = m[1];
          const target = spec.startsWith('.')
            ? posix.join(posix.dirname(rel), spec)
            : spec.startsWith('@/')
              ? spec.slice(2)
              : spec;
          if (!target.startsWith('styles/liquid-glass/')) out.add(target);
        }
      }
    }
  };
  walk(src);
  return [...out].sort();
}

// The class tokens of Classic's source at the merge base: apps/web as the app
// builds it (Tailwind's automatic source detection from apps/web), checked out
// from the merge base into a temporary folder.
const fromWeb = createRequire(join(WEB, 'package.json'));
const fromTailwind = createRequire(fromWeb.resolve('@tailwindcss/postcss'));
const { Scanner } = fromTailwind('@tailwindcss/oxide');

// The installed toolchain must be the merge base's (the guard holds the
// install to the manifest; the candidates below are built with it).
const versionOf = (resolveFrom, name) => {
  let dir = dirname(resolveFrom.resolve(name));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === name) return pkg.version;
    } catch {
      // No package.json at this level: keep climbing.
    }
    if (dirname(dir) === dir) fail(`no package.json for ${name}`);
    dir = dirname(dir);
  }
};
const installed = {
  '@tailwindcss/node': versionOf(fromTailwind, '@tailwindcss/node'),
  '@tailwindcss/oxide': versionOf(fromTailwind, '@tailwindcss/oxide'),
  '@tailwindcss/postcss': versionOf(fromWeb, '@tailwindcss/postcss'),
  postcss: versionOf(fromWeb, 'postcss'),
  tailwindcss: versionOf(fromWeb, 'tailwindcss'),
  'tailwindcss-animate': versionOf(fromWeb, 'tailwindcss-animate'),
};
if (JSON.stringify(installed) !== JSON.stringify(toolchain.packages)) {
  fail(
    `the installed CSS toolchain ${JSON.stringify(installed)} is not the merge base's ` +
      `${JSON.stringify(toolchain.packages)} (pnpm install first)`,
  );
}
if (readFileSync(join(WEB, 'postcss.config.mjs'), 'utf8') !== toolchain.postcssConfig) {
  fail("apps/web/postcss.config.mjs is not the merge base's text");
}
const tailwindNode = fromTailwind('@tailwindcss/node');
const tmp = mkdtempSync(join(tmpdir(), 'classic-css-pin-'));
let tokens;
let imports;
try {
  const archive = execFileSync('git', ['archive', '--format=tar', base, 'apps/web'], {
    cwd: ROOT,
    maxBuffer: 1 << 30,
  });
  execFileSync('tar', ['-x', '-C', tmp], { input: archive });
  tokens = new Scanner({
    sources: [{ base: join(tmp, 'apps', 'web'), pattern: '**/*', negated: false }],
  }).scan();
  imports = stylesheetImports(join(tmp, 'apps', 'web', 'src'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
// Kept: every token the merge base's globals.css builds a rule for, and every
// custom property name (Tailwind emits a theme variable the source names). The
// kept list must build exactly what the whole token list builds, or nothing is
// written.
const globals = texts.get('apps/web/src/app/globals.css').toString('utf8');
const appDir = join(WEB, 'src', 'app');
const system = await tailwindNode.__unstable__loadDesignSystem(globals, { base: appDir });
const built = system.candidatesToCss(tokens);
const candidates = [
  ...new Set(tokens.filter((t, i) => built[i] != null || /^--[\w-]+$/.test(t))),
].sort();
const input = globals.replace("@import 'tailwindcss';", "@import 'tailwindcss' source(none);");
const compile = async (list) =>
  (await tailwindNode.compile(input, { base: appDir, onDependency() {} })).build(list);
if ((await compile(tokens)) !== (await compile(candidates))) {
  fail('the kept tokens do not build what every token builds (Tailwind changed?)');
}

const FILES_DIR = join(HERE, 'files');
rmSync(FILES_DIR, { recursive: true, force: true });
for (const [path, text] of texts) {
  const out = join(FILES_DIR, path.slice(SRC_PREFIX.length));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
}
writeFileSync(join(HERE, 'candidates.dat'), `${candidates.join('\n')}\n`);
writeFileSync(
  join(HERE, 'manifest.json'),
  `${JSON.stringify(
    {
      mergeBase: base,
      files: files.map((p) => p.slice(SRC_PREFIX.length)),
      stylesheetImports: imports,
      candidates: candidates.length,
      toolchain,
    },
    null,
    2,
  )}\n`,
);
console.info(
  `classic-css-pin: ${files.length} stylesheets and ${candidates.length} class tokens from ${base}`,
);
