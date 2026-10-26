import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * RECURRENCE GUARD (docket B39, integrator decision of 2026-10-25): the
 * session-fragment scrub is mounted once, in the root layout, and nowhere else.
 *
 * A link Supabase verifies itself lands its session in the URL fragment of
 * whatever page its redirect names, and the redirects after it keep the
 * fragment: /signin, /dashboard and the landing page among them
 * (layout.session-fragment-scrub.test.tsx). The scrub was first mounted on
 * /signin alone, which left the live tokens in the address bar everywhere
 * else. In the root layout it runs on every page, so no landing can be
 * forgotten; on one page again, a landing would be.
 *
 * This reads the app's source, from the AST so comments never count: the root
 * layout is the only module that loads components/auth/session-fragment-scrub
 * (by an import, a re-export, import() or require(), under any path that
 * reaches it), and the layout renders the component its import binds.
 * layout.session-fragment-scrub.test.tsx renders the layout and checks what
 * the scrub does there.
 */

const WEB_SRC = path.resolve(__dirname, '..');
const ROOT_LAYOUT = path.join(WEB_SRC, 'app/layout.tsx');
const SCRUB_MODULE = path.join(WEB_SRC, 'components/auth/session-fragment-scrub');
const SCRUB_EXPORT = 'SessionFragmentScrub';

interface ScanFile {
  path: string;
  text: string;
}

function parse(file: ScanFile): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** The module a specifier names inside src, without extension or /index; null for a package. */
function moduleOf(from: string, specifier: string): string | null {
  let full: string;
  if (specifier.startsWith('@/')) full = path.join(WEB_SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) full = path.resolve(path.dirname(from), specifier);
  else return null;
  return full.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '').replace(/[\\/]index$/, '');
}

/** Every module a file loads or re-exports: import and export declarations, import() and require(). */
function specifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The files that load the scrub's module, by path. */
function scrubLoaders(files: readonly ScanFile[]): string[] {
  return files
    .filter((file) => specifiers(parse(file)).some((s) => moduleOf(file.path, s) === SCRUB_MODULE))
    .map((file) => file.path);
}

/** Whether the file renders the scrub: a JSX element named by the file's import of it. */
function rendersScrub(file: ScanFile): boolean {
  const source = parse(file);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      moduleOf(file.path, statement.moduleSpecifier.text) !== SCRUB_MODULE
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === SCRUB_EXPORT) {
        names.add(element.name.text);
      }
    }
  }
  let rendered = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      names.has(node.tagName.text)
    ) {
      rendered = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return rendered;
}

/** The app's own modules: tests and the test helpers are not the app. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && full !== path.join(WEB_SRC, 'test')) sourceFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/* ─────────────────────────────── self-test ─────────────────────────────── */

const file = (relative: string, ...lines: string[]): ScanFile => ({
  path: path.join(WEB_SRC, relative),
  text: lines.join('\n'),
});

const LAYOUT_WITH_SCRUB = file(
  'app/layout.tsx',
  `import { SessionFragmentScrub } from '@/components/auth/session-fragment-scrub';`,
  `export default function RootLayout({ children }: { children: React.ReactNode }) {`,
  `  return <html><body><SessionFragmentScrub />{children}</body></html>;`,
  `}`,
);

describe('the scrub wiring scanner (self-test on planted files)', () => {
  it('finds every way a module can load the scrub, and nothing in a comment', () => {
    const planted = [
      LAYOUT_WITH_SCRUB,
      file(
        'app/(auth)/signin/page.tsx',
        `import { SessionFragmentScrub } from '@/components/auth/session-fragment-scrub';`,
        `export default function Page() { return <SessionFragmentScrub />; }`,
      ),
      file(
        'components/auth/neighbour.tsx',
        `import { SessionFragmentScrub as Scrub } from './session-fragment-scrub.tsx';`,
        `export const Neighbour = () => <Scrub />;`,
      ),
      file(
        'components/auth/index.ts',
        `export { SessionFragmentScrub } from './session-fragment-scrub';`,
      ),
      file(
        'app/dashboard/page.tsx',
        `import dynamic from 'next/dynamic';`,
        `const Scrub = dynamic(() => import('../../components/auth/session-fragment-scrub').then((m) => m.SessionFragmentScrub));`,
        `export default function Page() { return <Scrub />; }`,
      ),
      file(
        'lib/legacy.ts',
        `const { SessionFragmentScrub } = require('@/components/auth/session-fragment-scrub/index');`,
        `export default SessionFragmentScrub;`,
      ),
      file(
        'app/(marketing)/page.tsx',
        `// <SessionFragmentScrub /> from '@/components/auth/session-fragment-scrub' is in the root layout.`,
        `/* import { SessionFragmentScrub } from '@/components/auth/session-fragment-scrub'; */`,
        `import { AuthCard } from '@/components/auth/auth-card';`,
        `export default function Page() { return <AuthCard />; }`,
      ),
    ];
    expect(scrubLoaders(planted).map((p) => path.relative(WEB_SRC, p))).toEqual([
      'app/layout.tsx',
      'app/(auth)/signin/page.tsx',
      'components/auth/neighbour.tsx',
      'components/auth/index.ts',
      'app/dashboard/page.tsx',
      'lib/legacy.ts',
    ]);
  });

  it('sees the layout render the scrub only through its import of it, and never in a comment', () => {
    expect(rendersScrub(LAYOUT_WITH_SCRUB)).toBe(true);
    expect(
      rendersScrub(
        file(
          'app/layout.tsx',
          `import { SessionFragmentScrub as Scrub } from './../components/auth/session-fragment-scrub';`,
          `export default function RootLayout() { return <html><body><Scrub></Scrub></body></html>; }`,
        ),
      ),
    ).toBe(true);
    // Imported, but the element is only in a comment.
    expect(
      rendersScrub(
        file(
          'app/layout.tsx',
          `import { SessionFragmentScrub } from '@/components/auth/session-fragment-scrub';`,
          `export default function RootLayout() { return <html><body>{/* <SessionFragmentScrub /> */}</body></html>; }`,
        ),
      ),
    ).toBe(false);
    // An element of that name that is not the scrub.
    expect(
      rendersScrub(
        file(
          'app/layout.tsx',
          `function SessionFragmentScrub() { return null; }`,
          `export default function RootLayout() { return <html><body><SessionFragmentScrub /></body></html>; }`,
        ),
      ),
    ).toBe(false);
  });
});

/* ───────────────────────────── the app's source ───────────────────────────── */

describe('the session-fragment scrub is mounted once, in the root layout', () => {
  it('no page, layout or component but the root layout loads it', () => {
    const files = sourceFiles(WEB_SRC).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
    expect(scrubLoaders(files).map((p) => path.relative(WEB_SRC, p))).toEqual(['app/layout.tsx']);
  });

  it('the root layout renders it', () => {
    expect(rendersScrub({ path: ROOT_LAYOUT, text: readFileSync(ROOT_LAYOUT, 'utf8') })).toBe(true);
  });
});
