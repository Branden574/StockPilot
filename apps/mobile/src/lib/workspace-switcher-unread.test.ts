import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { parseTsx, readSource, walkJsx } from './__fixtures__/jsx-touch-audit';

/**
 * THE WAREHOUSE LIST THAT HAS NOT LOADED IS NOT AN EMPTY ONE (B24).
 *
 * A slow or failed warehouse read leaves the workspace's list unread
 * (use-workspace.ts warehousesUnread: a first load that kept the saved
 * warehouse by its name, a switch still reading, a read that failed). The
 * switcher said "No warehouses in this org yet." under any empty list, so an
 * organization whose list had not loaded looked like one with no warehouses,
 * and the saved warehouse kept by name looked like its only one.
 *
 * No React Native renderer here: the note under the warehouse rows is taken
 * from the sheet's own source, compiled, and evaluated for each state of the
 * list with stand-in elements, so what it shows is checked, not its spelling.
 */

const FILE = 'src/components/workspace-switcher.tsx';
const sf = parseTsx(readSource(path.resolve(__dirname, '../..', FILE)), FILE);

const UNREAD_WORDS =
  'The full list of warehouses has not loaded yet. The app tries again while it is open and online.';
const EMPTY_WORDS = 'No warehouses in this org yet.';

function sheetFunction(): ts.FunctionDeclaration {
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && s.name?.text === 'WorkspaceSwitcherSheet',
  );
  expect(fn).toBeDefined();
  return fn!;
}

const isRows = (ch: ts.JsxChild): ch is ts.JsxExpression =>
  ts.isJsxExpression(ch) &&
  !!ch.expression &&
  ch.expression.getText(sf).startsWith('warehouses.map(');

/** The `{...}` slot right after the warehouse rows, in the element holding them. */
function noteSlot(): ts.Expression {
  const groups: ts.JsxElement[] = [];
  walkJsx(sheetFunction(), (el) => {
    if (ts.isJsxElement(el) && el.children.some(isRows)) groups.push(el);
  });
  expect(groups).toHaveLength(1);
  const slots = groups[0]!.children.filter(
    (ch): ch is ts.JsxExpression => ts.isJsxExpression(ch) && !!ch.expression,
  );
  const rowsAt = slots.findIndex(isRows);
  // The rows, then exactly one slot: the note.
  expect(slots).toHaveLength(rowsAt + 2);
  return slots[rowsAt + 1]!.expression!;
}

/** A top-level constant of the file, its value compiled from its own source. */
function constant(name: string): unknown {
  const decl = sf.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) => [...s.declarationList.declarations])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === name);
  expect(decl?.initializer, name).toBeDefined();
  const js = ts.transpileModule(`(${decl!.initializer!.getText(sf)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext({});
}

type Drawn = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };

/** The note for one state of the list, drawn with stand-in elements. */
function noteFor(warehousesUnread: boolean, warehouses: { id: string; name: string }[]) {
  const js = ts.transpileModule(`(${noteSlot().getText(sf)});`, {
    fileName: 'slot.tsx',
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' },
  }).outputText;
  return new vm.Script(js).runInNewContext({
    h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Drawn => ({
      type,
      props,
      children: children.flat(),
    }),
    Body: 'Body',
    warehousesUnread,
    warehouses,
    WORKSPACE_WAREHOUSES_UNREAD_COPY: constant('WORKSPACE_WAREHOUSES_UNREAD_COPY'),
  }) as Drawn | null | undefined | false;
}

/** Every word a drawn note shows. */
function wordsOf(node: unknown): string[] {
  if (typeof node === 'string') return node.trim() ? [node.replace(/\s+/g, ' ').trim()] : [];
  if (!node || typeof node !== 'object') return [];
  return (node as Drawn).children.flatMap(wordsOf);
}

const MAIN = { id: 'wh-1', name: 'Main' };
const ANNEX = { id: 'wh-2', name: 'Annex' };

describe('the workspace switcher: a list that has not loaded says so', () => {
  it('reads the unread flag from the workspace', () => {
    const bindings: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isObjectBindingPattern(n.name) &&
        n.initializer?.getText(sf) === 'useWorkspace()'
      ) {
        for (const el of n.name.elements) bindings.push(el.name.getText(sf));
      }
      ts.forEachChild(n, visit);
    };
    visit(sheetFunction());
    expect(bindings).toContain('warehousesUnread');
    expect(bindings).toContain('warehouses');
  });

  it('the words are the same', () => {
    expect(constant('WORKSPACE_WAREHOUSES_UNREAD_COPY')).toBe(UNREAD_WORDS);
  });

  // Mutation caught: the old `warehouses.length === 0` test alone, or the
  // unread branch dropped (a list that never loaded said "No warehouses").
  it('unread with no rows (a switch still reading, or a failed read): the unread note, never "No warehouses"', () => {
    expect(wordsOf(noteFor(true, []))).toEqual([UNREAD_WORDS]);
  });

  it('unread with the saved warehouse kept by name: the unread note, so it does not look like the only one', () => {
    expect(wordsOf(noteFor(true, [ANNEX]))).toEqual([UNREAD_WORDS]);
  });

  it('read and empty: "No warehouses in this org yet."', () => {
    expect(wordsOf(noteFor(false, []))).toEqual([EMPTY_WORDS]);
  });

  it('read with rows: no note', () => {
    expect(wordsOf(noteFor(false, [MAIN, ANNEX]))).toEqual([]);
  });

  it('each note is the muted small body text', () => {
    for (const drawn of [noteFor(true, []), noteFor(false, [])]) {
      expect(drawn && typeof drawn === 'object' ? drawn.type : null).toBe('Body');
      expect(drawn && typeof drawn === 'object' ? drawn.props : null).toEqual({
        size: 12.5,
        muted: true,
      });
    }
  });
});
