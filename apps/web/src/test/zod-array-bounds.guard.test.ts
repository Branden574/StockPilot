import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Security invariant: every list and every keyed object a zod schema accepts
 * has an upper bound, and zod stops at that bound.
 *
 * zod answers a list longer than its .max() or .length() with one too_big
 * issue and does not validate the list's elements (zod 3.25.76 is patched to
 * do this: patches/zod@3.25.76.patch; zod 4.6.6 does it natively). A list with
 * no bound has nothing to stop at. A keyed object (z.record) has no .max() in
 * zod, so boundedRecord (packages/core/src/schemas/bounded-record.ts) refuses one with too many
 * keys before any key or value is validated.
 *
 * HOW THIS GUARD WORKS
 *   - It reads every non-test .ts/.tsx file under apps/web/src,
 *     packages/core/src, apps/mobile/src and apps/mobile/app on the
 *     TypeScript syntax tree (a comment or a string is never a schema).
 *   - Each `z.array(...)` (also written `z\n  .array(`) and each `<schema>.array()`
 *     must carry `.max(...)` or `.length(...)` in its own method chain.
 *   - Each `z.record(...)` must be written through boundedRecord instead,
 *     unless no key and no value can fail (a plain `z.string()` key and a
 *     `z.unknown()` or `z.any()` value): such a record can never produce an
 *     issue, however many keys it has.
 *   - A list inside a list multiplies their bounds, so a list whose element
 *     schema holds another list, at any depth and through keyed objects
 *     (followed through the consts it names), must
 *     sit behind the request entry budget (withEntryBudget,
 *     packages/core/src/schemas/entry-budget.ts): inside a withEntryBudget(...)
 *     call, or in a const that is only ever used inside one (every use in
 *     source; a type position such as `typeof x` is not a use).
 *   - ALLOWLIST and NESTED_ALLOWLIST name the few schemas that never see a
 *     request (our own static registry and our own responses), each with why.
 *     An entry that matches nothing fails, so the lists cannot go stale.
 *   - The patch itself is checked at run time: an over-long list of failing
 *     elements must give exactly one issue.
 *
 * IF THIS FAILS
 *   - "list with no bound": add `.max(N)` with N at least ten times the most
 *     the product's own screens, imports and phone app send for that field,
 *     and say where that number comes from next to it.
 *   - "keyed object with no bound": use `boundedRecord(key, value, maxKeys)`.
 *   - "list inside a list outside the entry budget": wrap the schema (or the
 *     schema derived from it, at the place named) in `withEntryBudget(...)`.
 *   - "allowlist entry matches nothing": remove the entry.
 *   - "the zod patch is not applied": run `pnpm install` and read its output.
 *     A zod version change must carry the patch over (or move to zod 4).
 */

const ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['apps/web/src', 'packages/core/src', 'apps/mobile/src', 'apps/mobile/app'];

/** The one file allowed to call z.record directly: the helper that bounds it. */
const BOUNDED_RECORD_HELPER = 'packages/core/src/schemas/bounded-record.ts';

/**
 * Lists that never hold request input, as `file#key` (key = the property or
 * variable the list is assigned to). Request schemas never go here.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/core/src/schemas/releases.ts#roles':
    'validates the release registry compiled into the app, never a request',
  'packages/core/src/schemas/releases.ts#anyPermission':
    'validates the release registry compiled into the app, never a request',
  'packages/core/src/schemas/releases.ts#modules':
    'validates the release registry compiled into the app, never a request',
  'packages/core/src/schemas/releases.ts#releaseRegistrySchema':
    'validates the release registry compiled into the app, never a request',
  'packages/core/src/schemas/releases.ts#entries':
    "parses our own server's release answer on the client, never a request",
  'packages/core/src/schemas/releases.ts#releases':
    "parses our own server's release answer on the client, never a request",
};

/** Lists inside lists that never hold request input, as `file#key`. */
const NESTED_ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/core/src/schemas/releases.ts#entries':
    'validates the release registry compiled into the app, never a request',
};

/** The wrapper that puts a schema behind the request entry budget. */
const BUDGET_WRAPPER = 'withEntryBudget';

interface BoundFinding {
  file: string;
  line: number;
  key: string;
  kind: 'array' | 'record';
}

/** True for source the guard reads: not a test, a test helper or a declaration file. */
function isSourceFile(rel: string): boolean {
  if (!/\.(ts|tsx)$/.test(rel) || rel.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.tsx?$/.test(rel)) return false;
  return !rel
    .split('/')
    .some((part) => part === '__tests__' || part === 'test' || part === 'testing');
}

function listSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        const rel = path.relative(ROOT, child).split(path.sep).join('/');
        if (isSourceFile(rel)) out.push(rel);
      }
    }
  };
  for (const root of ROOTS) walk(path.join(ROOT, root));
  return out.sort();
}

/** The property or variable a schema expression is assigned to, or ''. */
function assignedKey(node: ts.Node, sf: ts.SourceFile): string {
  let p: ts.Node | undefined = node.parent;
  while (p && !ts.isPropertyAssignment(p) && !ts.isVariableDeclaration(p) && !ts.isSourceFile(p)) {
    p = p.parent;
  }
  if (p && (ts.isPropertyAssignment(p) || ts.isVariableDeclaration(p))) return p.name.getText(sf);
  return '';
}

/** The method names chained onto `node`: `node.a(...).b(...)` gives ['a', 'b']. */
function chainAfter(node: ts.Expression): string[] {
  const chain: string[] = [];
  let cur: ts.Node = node;
  while (
    cur.parent &&
    ts.isPropertyAccessExpression(cur.parent) &&
    cur.parent.expression === cur &&
    cur.parent.parent &&
    ts.isCallExpression(cur.parent.parent)
  ) {
    chain.push(cur.parent.name.text);
    cur = cur.parent.parent;
  }
  return chain;
}

function isZCall(node: ts.CallExpression, method: string): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === method &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'z'
  );
}

/** `z.string()` with nothing chained inside the argument, or `z.unknown()` / `z.any()`. */
function isPlainZ(arg: ts.Expression | undefined, methods: readonly string[]): boolean {
  return (
    arg !== undefined &&
    ts.isCallExpression(arg) &&
    arg.arguments.length === 0 &&
    methods.some((m) => isZCall(arg, m))
  );
}

/** A record whose keys and values can never produce a validation issue. */
function recordCannotFail(node: ts.CallExpression): boolean {
  const [first, second] = node.arguments;
  if (node.arguments.length === 1) return isPlainZ(first, ['unknown', 'any']);
  return isPlainZ(first, ['string']) && isPlainZ(second, ['unknown', 'any']);
}

/** Every list or keyed object without an upper bound in one file's text. */
function findUnboundedSchemas(file: string, source: string): BoundFinding[] {
  if (!/\b(array|record)\s*\(/.test(source)) return [];
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const importsZod = /from\s+['"]zod['"]/.test(source);
  const found: BoundFinding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const isZArray = isZCall(node, 'array');
      // `<schema>.array()`: zod's own shorthand for z.array(<schema>).
      const isMethodArray =
        importsZod &&
        !isZArray &&
        node.expression.name.text === 'array' &&
        node.arguments.length === 0;
      if (isZArray || isMethodArray) {
        const chain = chainAfter(node);
        if (!chain.includes('max') && !chain.includes('length')) {
          found.push({ file, line, key: assignedKey(node, sf), kind: 'array' });
        }
      }
      if (isZCall(node, 'record') && file !== BOUNDED_RECORD_HELPER && !recordCannotFail(node)) {
        found.push({ file, line, key: assignedKey(node, sf), kind: 'record' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function scanRepo(): BoundFinding[] {
  return listSourceFiles().flatMap((rel) =>
    findUnboundedSchemas(rel, readFileSync(path.join(ROOT, rel), 'utf8')),
  );
}

interface SourceText {
  file: string;
  source: string;
}

interface NestedFinding {
  file: string;
  line: number;
  key: string;
  /** Where the list escapes the budget: the list itself, or a use of its const. */
  at: string;
}

/**
 * Each file's syntax tree, kept by path for the text it was made from, so a
 * second scan over the same texts (the receipt check below) parses only the
 * file whose text it changed. The trees are only read, never changed.
 */
const parsed = new Map<string, { source: string; sf: ts.SourceFile }>();

function parse(file: string, source: string): ts.SourceFile {
  const hit = parsed.get(file);
  if (hit && hit.source === source) return hit.sf;
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsed.set(file, { source, sf });
  return sf;
}

const lineOf = (sf: ts.SourceFile, node: ts.Node) =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** A list or keyed-object schema call: z.array, <schema>.array(), z.record, boundedRecord. */
function isListCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return node.expression.text === 'boundedRecord';
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  const onZ =
    ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'z';
  if (method === 'record') return onZ;
  return method === 'array' && (onZ || node.arguments.length === 0);
}

/** A list schema call: z.array(...) or <schema>.array(). */
function isArrayCall(node: ts.Node): boolean {
  return isListCall(node) && listElement(node) !== undefined;
}

/** The element schema of a list call: z.array(<element>) or <element>.array(). */
function listElement(node: ts.CallExpression): ts.Expression | undefined {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'array') {
    return undefined;
  }
  return node.arguments.length === 0 ? node.expression.expression : node.arguments[0];
}

function isInsideBudget(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (
      ts.isCallExpression(p) &&
      ts.isIdentifier(p.expression) &&
      p.expression.text === BUDGET_WRAPPER
    ) {
      return true;
    }
  }
  return false;
}

function isInTypePosition(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true;
    if (ts.isStatement(p)) return false;
  }
  return false;
}

/**
 * Every list whose element schema holds another list and that can be parsed
 * outside withEntryBudget, over a set of source files.
 */
function findNestedListsOutsideBudget(texts: readonly SourceText[]): NestedFinding[] {
  const files = texts.map((t) => ({ file: t.file, sf: parse(t.file, t.source) }));
  // Every const by name, in the file that declares it.
  const consts = new Map<string, Array<{ file: string; decl: ts.VariableDeclaration }>>();
  for (const { file, sf } of files) {
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const list = consts.get(n.name.text) ?? [];
        list.push({ file, decl: n });
        consts.set(n.name.text, list);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  const holdsList = (node: ts.Node, file: string, seen: Set<string>): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      // A keyed object's keys are not list entries: only a list counts here
      // (a list inside a keyed object inside a list is still found below).
      if (isArrayCall(n)) {
        found = true;
        return;
      }
      const isReference =
        ts.isIdentifier(n) &&
        !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
        !(ts.isPropertyAssignment(n.parent) && n.parent.name === n);
      if (isReference && !seen.has(n.text)) {
        seen.add(n.text);
        const candidates = consts.get(n.text) ?? [];
        const sameFile = candidates.filter((c) => c.file === file);
        const pick = sameFile.length > 0 ? sameFile : candidates.length === 1 ? candidates : [];
        if (pick.some((c) => holdsList(c.decl.initializer!, c.file, seen))) {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  /** Uses of a const outside withEntryBudget: its own file, and files that import it by name. */
  const usesOutsideBudget = (name: string, declFile: string, decl: ts.VariableDeclaration) => {
    const out: string[] = [];
    for (const { file, sf } of files) {
      if (file !== declFile) {
        let imports = false;
        const findImport = (n: ts.Node) => {
          if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === name) imports = true;
          ts.forEachChild(n, findImport);
        };
        findImport(sf);
        if (!imports) continue;
      }
      const visit = (n: ts.Node) => {
        if (
          ts.isIdentifier(n) &&
          n.text === name &&
          n !== decl.name &&
          !ts.isImportSpecifier(n.parent) &&
          !ts.isExportSpecifier(n.parent) &&
          !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
          !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) &&
          !isInTypePosition(n) &&
          !isInsideBudget(n)
        ) {
          out.push(`${file}:${lineOf(sf, n)}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return out;
  };

  const found: NestedFinding[] = [];
  for (const { file, sf } of files) {
    const visit = (n: ts.Node) => {
      if (isListCall(n)) {
        const element = listElement(n);
        if (element && holdsList(element, file, new Set()) && !isInsideBudget(n)) {
          const key = assignedKey(n, sf);
          const line = lineOf(sf, n);
          let decl: ts.Node | undefined = n.parent;
          while (decl && !ts.isVariableDeclaration(decl) && !ts.isSourceFile(decl))
            decl = decl.parent;
          if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
            for (const at of usesOutsideBudget(decl.name.text, file, decl)) {
              found.push({ file, line, key, at });
            }
          } else {
            found.push({ file, line, key, at: `${file}:${line}` });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}

const describeFinding = (f: BoundFinding) => `${f.file}:${f.line} ${f.key || '(unnamed)'}`;

describe('zod schemas bound every list and keyed object', () => {
  const findings = scanRepo();
  const allowlisted = (f: BoundFinding) =>
    f.kind === 'array' && Object.prototype.hasOwnProperty.call(ALLOWLIST, `${f.file}#${f.key}`);

  it('reads the source it is meant to (a scan that reads nothing cannot pass)', () => {
    const files = listSourceFiles();
    expect(files).toContain('packages/core/src/schemas/receipts.ts');
    expect(files).toContain('apps/web/src/server/services/purchase-orders.ts');
    expect(files.some((f) => f.startsWith('apps/mobile/'))).toBe(true);
    expect(files.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
  });

  it('finds no list with no bound outside the allowlist', () => {
    const unbounded = findings.filter((f) => f.kind === 'array' && !allowlisted(f));
    expect(unbounded.map(describeFinding), 'list with no bound').toEqual([]);
  });

  it('finds no keyed object with no bound', () => {
    const records = findings.filter((f) => f.kind === 'record');
    expect(records.map(describeFinding), 'keyed object with no bound').toEqual([]);
  });

  it('has no allowlist entry that matches nothing, and gives each one a reason', () => {
    const matched = new Set(findings.filter(allowlisted).map((f) => `${f.file}#${f.key}`));
    const stale = Object.keys(ALLOWLIST).filter((k) => !matched.has(k));
    expect(stale, 'allowlist entry matches nothing').toEqual([]);
    for (const [entry, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.trim().length, `${entry} has no reason`).toBeGreaterThan(10);
    }
  });
});

describe('a list inside a list sits behind the request entry budget', () => {
  const texts = listSourceFiles()
    .map((file) => ({ file, source: readFileSync(path.join(ROOT, file), 'utf8') }))
    .filter(
      (t) =>
        /from\s+['"](zod|@stockpilot\/core)['"]/.test(t.source) ||
        t.file.startsWith('packages/core/'),
    );
  const nested = findNestedListsOutsideBudget(texts);
  const allowlisted = (f: NestedFinding) =>
    Object.prototype.hasOwnProperty.call(NESTED_ALLOWLIST, `${f.file}#${f.key}`);
  // The same scan with the receipt schema taken out of the budget, run here
  // once like the one above, so no test scans the tree itself. Every other
  // file's tree is the one parsed above.
  const receipts = texts.find((t) => t.file === 'packages/core/src/schemas/receipts.ts');
  const unwrappedNested = findNestedListsOutsideBudget(
    texts.map((t) =>
      t.file === receipts?.file
        ? {
            ...t,
            source: t.source.replace(`${BUDGET_WRAPPER}(postReceiptFields)`, 'postReceiptFields'),
          }
        : t,
    ),
  );

  it('finds the receipt lines behind the budget (a scan that finds nothing cannot pass)', () => {
    expect(receipts?.source).toContain(`${BUDGET_WRAPPER}(postReceiptFields)`);
    // Unwrapped, the same receipt schema is reported.
    expect(unwrappedNested.map((f) => f.key)).toContain('lines');
  });

  it('finds no list inside a list outside the budget', () => {
    const outside = nested.filter((f) => !allowlisted(f));
    expect(
      outside.map((f) => `${f.file}:${f.line} ${f.key || '(unnamed)'} used at ${f.at}`),
      'list inside a list outside the entry budget',
    ).toEqual([]);
  });

  it('has no nested allowlist entry that matches nothing', () => {
    const matched = new Set(nested.filter(allowlisted).map((f) => `${f.file}#${f.key}`));
    expect(Object.keys(NESTED_ALLOWLIST).filter((k) => !matched.has(k))).toEqual([]);
  });
});

describe('the zod patch is applied', () => {
  it('answers an over-long list with its one too_big issue', () => {
    const result = z.array(z.number()).max(1).safeParse([1, 'a', 'b']);
    expect(result.success).toBe(false);
    expect(result.error?.issues, 'the zod patch is not applied').toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe('too_big');
  });

  it('does not validate the elements of a long over-long list', () => {
    const result = z
      .array(z.object({ id: z.string().uuid() }))
      .max(10)
      .safeParse(new Array(200_000).fill({}));
    expect(result.error?.issues, 'the zod patch is not applied').toHaveLength(1);
  });
});

describe('self-test: the scan catches what it is meant to', () => {
  const scan = (src: string, file = 'apps/web/src/planted.ts') =>
    findUnboundedSchemas(file, `import { z } from 'zod';\n${src}`).map((f) => `${f.kind}:${f.key}`);

  it('flags a list with no bound, on one line or across lines', () => {
    expect(scan('const a = z.object({ ids: z.array(z.string()).min(1) });')).toEqual(['array:ids']);
    expect(scan('const b = z\n  .array(z.number())\n  .optional();')).toEqual(['array:b']);
    expect(scan('const line = z.object({});\nconst c = line.array();')).toEqual(['array:c']);
  });

  it('passes a list bounded by .max() or .length() anywhere in its chain', () => {
    expect(scan('const a = z.array(z.string()).min(1).max(5).optional();')).toEqual([]);
    expect(scan('const b = z.array(z.number()).length(3);')).toEqual([]);
    expect(scan('const c = z.object({}).array().max(2);')).toEqual([]);
  });

  it('does not count a bound inside the element schema as the list bound', () => {
    expect(scan('const a = z.array(z.string().max(10));')).toEqual(['array:a']);
  });

  it('flags a keyed object whose keys or values can fail', () => {
    expect(scan('const a = z.record(z.string().uuid(), z.string());')).toEqual(['record:a']);
    expect(scan('const b = z.record(z.string(), z.number());')).toEqual(['record:b']);
    expect(scan('const c = z\n  .record(z.enum(["x"]), z.unknown());')).toEqual(['record:c']);
  });

  it('passes a keyed object that can never produce an issue, and the helper itself', () => {
    expect(scan('const a = z.record(z.string(), z.unknown());')).toEqual([]);
    expect(scan('const b = z.record(z.any());')).toEqual([]);
    expect(scan('const c = z.record(z.string(), z.string());', BOUNDED_RECORD_HELPER)).toEqual([]);
  });

  it('ignores schemas named only in comments and strings', () => {
    expect(scan('// z.array(z.string())\nconst s = "z.record(z.string(), z.number())";')).toEqual(
      [],
    );
  });

  it('flags a list inside a list outside the budget, and passes one inside it', () => {
    const nestedScan = (...texts: SourceText[]) =>
      findNestedListsOutsideBudget(texts).map((f) => `${f.key}@${f.at}`);
    const head = "import { z } from 'zod';\n";
    const line = 'const line = z.object({ serials: z.array(z.string()).max(5) });\n';
    expect(
      nestedScan({
        file: 'a.ts',
        source: `${head}${line}export const r = z.object({ lines: z.array(line).max(9) });\nr.parse(1);`,
      }),
    ).toEqual(['lines@a.ts:4']);
    expect(
      nestedScan({
        file: 'a.ts',
        source: `${head}${line}const r = withEntryBudget(z.object({ lines: z.array(line).max(9) }));`,
      }),
    ).toEqual([]);
    // Wrapped where it is used, and `typeof` is not a use.
    expect(
      nestedScan({
        file: 'a.ts',
        source: `${head}${line}export const f = z.object({ lines: z.array(line).max(9) });\nexport const s = withEntryBudget(f);\ntype T = z.infer<typeof f>;`,
      }),
    ).toEqual([]);
    // A schema derived from it in another file, outside the budget.
    expect(
      nestedScan(
        {
          file: 'a.ts',
          source: `${head}${line}export const f = z.object({ lines: z.array(line).max(9) });\nexport const s = withEntryBudget(f);`,
        },
        { file: 'b.ts', source: "import { f } from './a';\nconst body = f.omit({});" },
      ),
    ).toEqual(['lines@b.ts:2']);
    // A list of keyed objects of lists is nested; a list of keyed objects of strings is not.
    expect(
      nestedScan({
        file: 'a.ts',
        source: `${head}const r = z.array(boundedRecord(z.string(), z.array(z.number()).max(2), 3)).max(9);\nr.parse(1);`,
      }),
    ).toEqual(['r@a.ts:3']);
    expect(
      nestedScan({
        file: 'a.ts',
        source: `${head}const r = z.array(boundedRecord(z.string(), z.string(), 3)).max(9);\nr.parse(1);`,
      }),
    ).toEqual([]);
    // A list of plain objects is not nested.
    expect(
      nestedScan({
        file: 'a.ts',
        source: `${head}const r = z.array(z.object({ id: z.string() })).max(9);\nr.parse(1);`,
      }),
    ).toEqual([]);
  });

  it('skips test files and test helpers', () => {
    expect(isSourceFile('apps/web/src/lib/a.test.ts')).toBe(false);
    expect(isSourceFile('apps/web/src/test/helper.ts')).toBe(false);
    expect(isSourceFile('packages/core/src/testing/display-units.ts')).toBe(false);
    expect(isSourceFile('apps/web/src/lib/a.ts')).toBe(true);
  });
});
