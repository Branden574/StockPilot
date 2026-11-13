import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * B68 guard: the Items and Books table shows Export (its toolbar menu and the
 * bulk bar's button) only when its page passes canExport, and the flag is the
 * member's EFFECTIVE items:export, the permission the export, its sample and
 * export.csv answer. The table defaults to false, so a page that forgets the
 * prop hides Export from everyone who may export, and a page that passes
 * something else shows it to members whose export is refused.
 *
 * Read from the TypeScript syntax tree: every <InventoryTable> and
 * <BooksInventoryTable> in a non-test source file under src is listed below
 * with what it must pass, so a new mount fails here until someone decides.
 */

const SRC = path.resolve(__dirname, '../../..');
const TABLES = new Set(['InventoryTable', 'BooksInventoryTable']);

/** What a mount passes as canExport. */
type Passes =
  /** canExport={canExport}, declared in the same function as can(sessionCtx, 'items:export'). */
  | 'the page flag'
  /** No canExport: Export is hidden for everyone. */
  | 'nothing'
  /** {...props}: whatever its own caller passed. */
  | 'its props';

/** Every mount site: file (from src), the tag, how many, what each passes, why. */
const MOUNTS: Array<{ file: string; tag: string; count: number; passes: Passes; why: string }> = [
  {
    file: 'app/(dashboard)/dashboard/inventory/page.tsx',
    tag: 'InventoryTable',
    count: 2,
    passes: 'the page flag',
    why: 'Items: the instant table (a deep link) and the server-mode table',
  },
  {
    file: 'app/(dashboard)/dashboard/books/page.tsx',
    tag: 'BooksInventoryTable',
    count: 2,
    passes: 'the page flag',
    why: 'Books: the instant table and the server-mode table',
  },
  {
    file: 'app/(dashboard)/dashboard/rentals/items/page.tsx',
    tag: 'InventoryTable',
    count: 1,
    passes: 'nothing',
    why: 'every export reads only non-rental items, so Export on Rentals saved the wrong rows (plans/B68.md, R1)',
  },
  {
    file: 'components/books/books-inventory-table.tsx',
    tag: 'InventoryTable',
    count: 1,
    passes: 'its props',
    why: "the Books page's wrapper: it hands the page's props (canExport included) to the table",
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
  });
}

interface Mount {
  file: string;
  tag: string;
  line: number;
  passes: Passes | 'something else';
}

/** The `canExport` const declared in the function that holds `node`, as written. */
function enclosingCanExport(node: ts.Node, sf: ts.SourceFile): string | null {
  let fn: ts.Node | undefined = node.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn) return null;
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'canExport' &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      found = n.initializer?.getText(sf) ?? null;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return found;
}

function mountsIn(file: string): Mount[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Mount[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      TABLES.has(node.tagName.getText(sf))
    ) {
      const props = node.attributes.properties;
      const attr = props.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === 'canExport',
      );
      const spread = props.some((p) => ts.isJsxSpreadAttribute(p));
      let passes: Mount['passes'];
      if (attr) {
        passes =
          attr.initializer?.getText(sf) === '{canExport}' &&
          enclosingCanExport(node, sf) === "can(sessionCtx, 'items:export')"
            ? 'the page flag'
            : 'something else';
      } else {
        passes = spread ? 'its props' : 'nothing';
      }
      out.push({
        file: path.relative(SRC, file).split(path.sep).join('/'),
        tag: node.tagName.getText(sf),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        passes,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const ALL_MOUNTS = sourceFiles(SRC).flatMap(mountsIn);

describe('Export on the Items and Books table follows items:export (B68)', () => {
  it('finds the mounts it guards (the census is read, not empty)', () => {
    expect(ALL_MOUNTS.length).toBeGreaterThanOrEqual(6);
  });

  it('every mount of the table is listed, with how many and what it passes', () => {
    const seen = new Map<string, { count: number; passes: Set<string> }>();
    for (const m of ALL_MOUNTS) {
      const key = `${m.file} <${m.tag}>`;
      const entry = seen.get(key) ?? { count: 0, passes: new Set<string>() };
      entry.count += 1;
      entry.passes.add(m.passes);
      seen.set(key, entry);
    }
    const actual = [...seen.entries()]
      .map(([key, v]) => ({ key, count: v.count, passes: [...v.passes].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const expected = MOUNTS.map((m) => ({
      key: `${m.file} <${m.tag}>`,
      count: m.count,
      passes: [m.passes],
    })).sort((a, b) => a.key.localeCompare(b.key));
    expect(actual).toEqual(expected);
  });

  it("the Items and Books pages pass canExport={canExport}, declared as can(sessionCtx, 'items:export'), at every mount", () => {
    for (const file of [
      'app/(dashboard)/dashboard/inventory/page.tsx',
      'app/(dashboard)/dashboard/books/page.tsx',
    ]) {
      const mounts = ALL_MOUNTS.filter((m) => m.file === file);
      expect(mounts, file).toHaveLength(2);
      for (const m of mounts) expect(m.passes, `${file}:${m.line}`).toBe('the page flag');
    }
  });

  it('Rentals items passes none, so Export is hidden there for everyone', () => {
    const mounts = ALL_MOUNTS.filter(
      (m) => m.file === 'app/(dashboard)/dashboard/rentals/items/page.tsx',
    );
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.passes).toBe('nothing');
  });

  it("the Books wrapper hands the page's props to the table", () => {
    const wrapper = readFileSync(
      path.join(SRC, 'components/books/books-inventory-table.tsx'),
      'utf8',
    );
    expect(wrapper).toContain("props: Omit<InventoryTableProps, 'onScanRequest'>");
    expect(wrapper).toContain('<InventoryTable {...props}');
  });
});
