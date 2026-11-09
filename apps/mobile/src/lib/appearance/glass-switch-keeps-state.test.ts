import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { CLASSIC_PINS } from './glass-classic-pins.test';

/**
 * SWITCHING THE APPEARANCE KEEPS WHAT IS ON SCREEN (plan 8.2, case 8).
 *
 * React keeps a component's state while the same element type stays at the
 * same place. Every Liquid Glass difference is a branch on `lg`, so a switch
 * re-renders the same tree with other styles; a branch that put a DIFFERENT
 * element in place of a stateful one (a field, a list, a scroll, a sheet, a
 * camera) would unmount it and lose what it held: the typed text, the scroll,
 * the open sheet, the camera session. This fails when any branch on `lg` in a
 * pinned file swaps a stateful element for something else; a branch may add
 * or remove a stateless decoration (`lg ? <SceneBackground /> : null`) or
 * restyle the same element, which keeps every slot where it was.
 *
 * A branch is `lg ? a : b`, `!lg ? a : b`, `lg && a` and `if (lg) return a;`
 * (the rest of the function is the Classic arm). The check follows custom
 * components: a component declared in the file, or imported from it through
 * `@/` or a relative path (re-exports included), counts as stateful when
 * anything it renders is. Two arms whose outermost element is the same type
 * keep that element (a restyle), so only what differs below it is checked.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(MOBILE_ROOT, 'src');

/** Elements that hold state a person would lose if they were remounted. */
const STATEFUL = new Set([
  'TextInput',
  'Field',
  'FlatList',
  'SectionList',
  'ScrollView',
  'KeyboardAvoidingView',
  'Modal',
  'CameraView',
  'WebView',
  'Animated.View',
  'Animated.ScrollView',
  'Animated.FlatList',
]);

/**
 * Stateful elements left out by name, per file, each with the reason it holds
 * nothing a person put there. Keep this list short and every entry argued.
 */
const EXEMPT: Record<string, readonly string[]> = {
  // The Face ID pulse ring: Liquid Glass draws the board's tile instead. Its
  // animated values live in the screen, which stays mounted.
  'src/components/biometric-lock-screen.tsx': ['Animated.View'],
  // The size run: the board's grid of receive boxes against Classic's rows,
  // two layouts whose boxes cannot share a place in the tree. The boxes are
  // controlled: every quantity lives in the screen's `draft`, which stays
  // mounted, so nothing typed is lost; and a Design adopted from another
  // device is held while anything is typed (useHoldUpdatePrompt 'receive',
  // appearance/holds.ts). A switch can drop the keyboard from an empty box.
  'app/po/[id].tsx': ['GlassSizeRunCard', 'SizeRunCard'],
};

const sfCache = new Map<string, ts.SourceFile>();
function sourceOf(abs: string, text?: string): ts.SourceFile {
  if (text !== undefined) {
    return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  }
  let sf = sfCache.get(abs);
  if (!sf) {
    const kind = abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, kind);
    sfCache.set(abs, sf);
  }
  return sf;
}

function resolveModule(fromAbs: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC_ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromAbs), spec);
  else return null; // a package: only the STATEFUL names above count
  for (const cand of [
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
    base,
  ]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const hasExport = (n: ts.Node) =>
  ts.canHaveModifiers(n) &&
  (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hasDefault = (n: ts.Node) =>
  ts.canHaveModifiers(n) &&
  (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

/** The top-level declaration of `name` in a file (a function, a const, a class). */
function localDecl(sf: ts.SourceFile, name: string): ts.Node | undefined {
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === name) {
      return st;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
      }
    }
  }
  return undefined;
}

type Found = { abs: string; sf: ts.SourceFile; node: ts.Node };

/** What a local name in a file refers to: its declaration there, or through its import. */
function resolveLocal(abs: string, sf: ts.SourceFile, name: string, depth = 0): Found | null {
  if (depth > 12) return null;
  const decl = localDecl(sf, name);
  if (decl) return { abs, sf, node: decl };
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const spec = (st.moduleSpecifier as ts.StringLiteral).text;
    const clause = st.importClause;
    let imported: string | null = null;
    if (clause.name?.text === name) imported = 'default';
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.name.text === name) imported = el.propertyName?.text ?? name;
      }
    }
    if (imported === null) continue;
    const target = resolveModule(abs, spec);
    return target ? resolveExport(target, imported, depth + 1) : null;
  }
  return null;
}

/** What a module exports under `name`, following re-exports. */
function resolveExport(abs: string, name: string, depth = 0): Found | null {
  if (depth > 12) return null;
  const sf = sourceOf(abs);
  for (const st of sf.statements) {
    if (name === 'default') {
      if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) {
        return resolveLocal(abs, sf, st.expression.text, depth + 1);
      }
      if (ts.isFunctionDeclaration(st) && hasExport(st) && hasDefault(st)) {
        return { abs, sf, node: st };
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) &&
      hasExport(st) &&
      st.name?.text === name
    ) {
      return { abs, sf, node: st };
    }
    if (ts.isVariableStatement(st) && hasExport(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
          return { abs, sf, node: d.initializer };
        }
      }
    }
    if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier ? (st.moduleSpecifier as ts.StringLiteral).text : null;
      const clause = st.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          if (el.name.text !== name) continue;
          const inner = el.propertyName?.text ?? name;
          if (spec === null) return resolveLocal(abs, sf, inner, depth + 1);
          const target = resolveModule(abs, spec);
          return target ? resolveExport(target, inner, depth + 1) : null;
        }
      } else if (!clause && spec) {
        const target = resolveModule(abs, spec);
        const hit = target ? resolveExport(target, name, depth + 1) : null;
        if (hit) return hit;
      }
    }
  }
  return null;
}

function tagsIn(node: ts.Node, sf: ts.SourceFile, out: string[] = []): string[] {
  if (ts.isJsxElement(node)) out.push(node.openingElement.tagName.getText(sf));
  else if (ts.isJsxSelfClosingElement(node)) out.push(node.tagName.getText(sf));
  ts.forEachChild(node, (n) => void tagsIn(n, sf, out));
  return out;
}

const isCustom = (tag: string) => /^[A-Z]/.test(tag);

/** What a tag written in a file refers to (a local, an import, or `Ns.Member`). */
function resolveTag(abs: string, sf: ts.SourceFile, tag: string): Found | null {
  const dot = tag.indexOf('.');
  if (dot < 0) return resolveLocal(abs, sf, tag);
  const ns = tag.slice(0, dot);
  const member = tag.slice(dot + 1);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamespaceImport(nb) && nb.name.text === ns) {
      const target = resolveModule(abs, (st.moduleSpecifier as ts.StringLiteral).text);
      return target ? resolveExport(target, member) : null;
    }
  }
  return null;
}

const renderMemo = new Map<string, boolean>();
/** Whether a tag is stateful itself, or a component that renders anything stateful. */
function isStateful(
  abs: string,
  sf: ts.SourceFile,
  tag: string,
  seen = new Set<string>(),
): boolean {
  if (STATEFUL.has(tag)) return true;
  if (!isCustom(tag)) return false;
  const found = resolveTag(abs, sf, tag);
  if (!found) return false;
  const key = `${found.abs}#${found.node.pos}`;
  const memo = renderMemo.get(key);
  if (memo !== undefined) return memo;
  if (seen.has(key)) return false;
  seen.add(key);
  const inner = [...new Set(tagsIn(found.node, found.sf))];
  const hit = inner.some((t) => isStateful(found.abs, found.sf, t, seen));
  renderMemo.set(key, hit);
  return hit;
}

function unwrap(e: ts.Node): ts.Node {
  let n = e;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}
function rootTag(n: ts.Node | undefined, sf: ts.SourceFile): string | null {
  if (!n) return null;
  const u = unwrap(n);
  if (ts.isJsxElement(u)) return u.openingElement.tagName.getText(sf);
  if (ts.isJsxSelfClosingElement(u)) return u.tagName.getText(sf);
  return null;
}

/** `lg` (glass first) or `!lg` (Classic first); null for any other condition. */
function lgPolarity(e: ts.Expression): 'lg' | 'not' | null {
  const u = unwrap(e) as ts.Expression;
  if (ts.isIdentifier(u) && u.text === 'lg') return 'lg';
  if (
    ts.isPrefixUnaryExpression(u) &&
    u.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(unwrap(u.operand)) &&
    (unwrap(u.operand) as ts.Identifier).text === 'lg'
  ) {
    return 'not';
  }
  return null;
}

/** The returned expressions in a statement, not descending into nested functions. */
function returnsIn(node: ts.Node, out: ts.Expression[] = []): ts.Expression[] {
  if (ts.isReturnStatement(node)) {
    if (node.expression) out.push(node.expression);
    return out;
  }
  if (ts.isFunctionLike(node)) return out;
  ts.forEachChild(node, (n) => void returnsIn(n, out));
  return out;
}

/** Every branch on the look in a source whose arms hold a stateful element. */
function swapsIn(src: string, file: string): string[] {
  const abs = path.join(MOBILE_ROOT, file);
  const sf = sourceOf(abs, src);
  const exempt = new Set(EXEMPT[file] ?? []);
  const found: string[] = [];
  const statefulIn = (nodes: readonly ts.Node[], skipRoot: string | null): string[] => {
    const out: string[] = [];
    for (const n of nodes) {
      const tags = tagsIn(n, sf);
      // The shared outermost element stays in place; only what is under it can differ.
      if (skipRoot !== null && tags[0] === skipRoot) tags.shift();
      for (const t of tags) {
        if (!exempt.has(t) && isStateful(abs, sf, t) && !out.includes(t)) out.push(t);
      }
    }
    return out;
  };
  const report = (node: ts.Node, glassArm: readonly ts.Node[], classicArm: readonly ts.Node[]) => {
    const gRoot = rootTag(glassArm[0], sf);
    const shared = glassArm.length === 1 && gRoot !== null && gRoot === rootTag(classicArm[0], sf);
    const skip = shared && classicArm.length === 1 ? gRoot : null;
    const glass = statefulIn(glassArm, skip);
    const classic = statefulIn(classicArm, skip);
    if (glass.length > 0 || classic.length > 0) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      found.push(`${file}:${line} glass[${glass.join(',')}] classic[${classic.join(',')}]`);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isConditionalExpression(node)) {
      const p = lgPolarity(node.condition);
      if (p === 'lg') report(node, [node.whenTrue], [node.whenFalse]);
      if (p === 'not') report(node, [node.whenFalse], [node.whenTrue]);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      const p = lgPolarity(node.left);
      if (p === 'lg') report(node, [node.right], []);
      if (p === 'not') report(node, [], [node.right]);
    }
    if (ts.isIfStatement(node)) {
      const p = lgPolarity(node.expression);
      const thenReturns = returnsIn(node.thenStatement);
      if (p !== null && thenReturns.length > 0) {
        // The rest of the enclosing block (and any else) is the other arm.
        const rest: ts.Expression[] = node.elseStatement ? returnsIn(node.elseStatement) : [];
        const parent = node.parent;
        if (ts.isBlock(parent)) {
          const i = parent.statements.indexOf(node as ts.Statement);
          for (const st of parent.statements.slice(i + 1)) returnsIn(st, rest);
        }
        if (p === 'lg') report(node, thenReturns, rest);
        else report(node, rest, thenReturns);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function swaps(file: string): string[] {
  return swapsIn(readFileSync(path.join(MOBILE_ROOT, file), 'utf8'), file);
}

describe('switching the appearance never remounts a stateful element', () => {
  for (const file of Object.keys(CLASSIC_PINS)) {
    it(`${file}: no branch on the look swaps a field, list, scroll, sheet or camera`, () => {
      expect(swaps(file)).toEqual([]);
    });
  }

  // The probes run through the same function as the pinned files.
  const PROBE = 'src/components/__switch_probe__.tsx';
  const probe = (body: string) =>
    swapsIn(
      [
        "import { TextInput, View } from 'react-native';",
        "import { Field } from '@/components/ui/field';",
        'function Box({ v }: { v: string }) { return <View><TextInput value={v} /></View>; }',
        'function Plain() { return <View />; }',
        body,
      ].join('\n'),
      PROBE,
    );

  it('catches a swap of a stateful element written in the branch', () => {
    expect(probe('const a = lg ? <View /> : <TextInput value={v} />;')).toEqual([
      `${PROBE}:5 glass[] classic[TextInput]`,
    ]);
    expect(probe('const a = !lg ? <TextInput value={v} /> : <View />;')).toEqual([
      `${PROBE}:5 glass[] classic[TextInput]`,
    ]);
  });

  it('catches a stateful element added by `lg &&`', () => {
    expect(probe('const a = lg && <TextInput value={v} />;')).toEqual([
      `${PROBE}:5 glass[TextInput] classic[]`,
    ]);
    expect(probe('const a = !lg && <Box v={v} />;')).toEqual([`${PROBE}:5 glass[] classic[Box]`]);
  });

  it('follows a component declared in the file and one imported from the app', () => {
    expect(probe('const a = lg ? <Box v={v} /> : <Plain />;')).toEqual([
      `${PROBE}:5 glass[Box] classic[]`,
    ]);
    expect(probe('const a = lg ? <Plain /> : <Field label="x" value={v} />;')).toEqual([
      `${PROBE}:5 glass[] classic[Field]`,
    ]);
  });

  it('follows an imported component that renders a field under its own name', () => {
    // GlassSizeRunCard draws TextInputs; it is only exempt in the PO screen.
    const src = [
      "import { GlassSizeRunCard } from '@/components/ui/glass/screens/po';",
      'function SizeRunCard() { return <TextInput />; }',
      'const a = lg ? <GlassSizeRunCard /> : <SizeRunCard />;',
    ].join('\n');
    expect(swapsIn(src, PROBE)).toEqual([
      `${PROBE}:3 glass[GlassSizeRunCard] classic[SizeRunCard]`,
    ]);
  });

  it('catches an early return on the look', () => {
    expect(probe('function Row() { if (lg) { return <Plain />; } return <Box v={v} />; }')).toEqual(
      [`${PROBE}:5 glass[] classic[Box]`],
    );
  });

  it('lets a restyle of the same element through, and a stateless decoration', () => {
    expect(probe('const a = lg ? <Box v={v} /> : <Box v={w} />;')).toEqual([]);
    expect(probe('const a = lg ? <TextInput style={s} /> : <TextInput />;')).toEqual([]);
    expect(probe('const a = lg ? <Plain /> : null;')).toEqual([]);
  });
});
