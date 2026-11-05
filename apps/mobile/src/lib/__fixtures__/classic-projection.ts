import { createHash } from 'node:crypto';

import ts from 'typescript';

/**
 * THE CLASSIC PROJECTION OF A SOURCE FILE (Liquid Glass stage 4).
 *
 * The phone's test suite has no React Native renderer, so Classic cannot be
 * proved unchanged by rendering a screen before and after. This proves it on
 * the code instead, which is stronger for what it covers: the projection
 * evaluates every Liquid Glass branch of a file as Classic and what is left
 * must be the very code the file held before Liquid Glass (compared as a
 * syntax tree, so formatting, comments and import order do not count, and
 * everything else does: every element, prop, style value, string and
 * expression).
 *
 * A component reads the look once as `const lg = useGlass();` (null in
 * Classic; components/ui/glass/use-glass.ts) and writes each difference in
 * one of these forms, which the projection folds with `lg` = null:
 *
 *   lg ? glass : classic        -> classic
 *   !lg ? classic : glass       -> classic
 *   lg && glass                 -> nothing
 *   if (lg) A else B            -> B (no else: nothing)
 *   [x, lg]  (a hook's deps)    -> [x]
 *
 * "Nothing" (also a `classic` branch that is null, false or undefined) is
 * then dropped where it stands: a JSX child, a JSX prop, an object property
 * or spread, or a style-array entry; a style array left with one entry is
 * that entry again (`style={[a, lg && b]}` is `style={a}`). The `lg`
 * declaration goes, and so does every import and file-local declaration
 * nothing uses any more (the glass-only parts), on both sides.
 *
 * Any other use of `lg` survives the projection and is reported by
 * `projectionLeaks`, so glass logic can never reach Classic in a form this
 * proof does not see.
 */
export const GLASS_BINDING = 'lg';

function strip(e: ts.Expression): ts.Expression {
  let s = e;
  while (ts.isParenthesizedExpression(s)) s = s.expression;
  return s;
}

function isLg(e: ts.Expression): boolean {
  const s = strip(e);
  return ts.isIdentifier(s) && s.text === GLASS_BINDING;
}

function isNotLg(e: ts.Expression): boolean {
  const s = strip(e);
  return (
    ts.isPrefixUnaryExpression(s) &&
    s.operator === ts.SyntaxKind.ExclamationToken &&
    isLg(s.operand)
  );
}

function isEmptyValue(e: ts.Expression): boolean {
  const s = strip(e);
  return (
    s.kind === ts.SyntaxKind.NullKeyword ||
    s.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(s) && s.text === 'undefined')
  );
}

function projector(nothingSet: WeakSet<ts.Node>): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    const f = context.factory;
    const nothing = (): ts.Expression => {
      const n = f.createFalse();
      nothingSet.add(n);
      return n;
    };
    const isNothing = (n: ts.Node | undefined): boolean => {
      if (!n) return false;
      if (nothingSet.has(n)) return true;
      return ts.isParenthesizedExpression(n) ? isNothing(n.expression) : false;
    };
    const asExpression = (n: ts.Node | undefined): ts.Expression => n as ts.Expression;

    const folded = (e: ts.Expression): ts.Expression => {
      const out = asExpression(ts.visitNode(e, visit));
      return isEmptyValue(out) ? (nothingSet.add(out), out) : out;
    };

    const visit = (node: ts.Node): ts.VisitResult<ts.Node | undefined> => {
      if (ts.isVariableStatement(node)) {
        const decls = node.declarationList.declarations;
        const kept = decls.filter(
          (d) => !(ts.isIdentifier(d.name) && d.name.text === GLASS_BINDING),
        );
        if (kept.length === 0) return undefined;
        const next =
          kept.length === decls.length
            ? node
            : f.updateVariableStatement(
                node,
                node.modifiers,
                f.updateVariableDeclarationList(node.declarationList, kept),
              );
        return ts.visitEachChild(next, visit, context);
      }
      if (ts.isIfStatement(node)) {
        // The kept arm stands where the `if` stood; a block's statements are
        // spliced in, so `if (lg) {...} else { x }` is exactly `x`.
        const arm = (st: ts.Statement | undefined): ts.VisitResult<ts.Node | undefined> => {
          if (!st) return undefined;
          const out = ts.visitNode(st, visit) as ts.Statement;
          return ts.isBlock(out) ? [...out.statements] : out;
        };
        if (isLg(node.expression)) return arm(node.elseStatement);
        if (isNotLg(node.expression)) return arm(node.thenStatement);
      }
      if (ts.isConditionalExpression(node)) {
        if (isLg(node.condition)) return folded(node.whenFalse);
        if (isNotLg(node.condition)) return folded(node.whenTrue);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        isLg(node.left)
      ) {
        return nothing();
      }
      if (ts.isArrayLiteralExpression(node)) {
        let removedEntry = false;
        const kept: ts.Expression[] = [];
        for (const el of node.elements) {
          if (isLg(el)) continue; // a hook's dependency list
          const out = asExpression(ts.visitNode(el, visit));
          if (isNothing(out)) {
            removedEntry = true;
            continue;
          }
          kept.push(out);
        }
        if (removedEntry && kept.length === 0) return nothing();
        if (removedEntry && kept.length === 1 && !ts.isSpreadElement(kept[0])) return kept[0];
        return f.updateArrayLiteralExpression(node, kept);
      }
      if (ts.isObjectLiteralExpression(node)) {
        const kept: ts.ObjectLiteralElementLike[] = [];
        for (const p of node.properties) {
          const out = ts.visitNode(p, visit) as ts.ObjectLiteralElementLike | undefined;
          if (!out) continue;
          if (ts.isPropertyAssignment(out) && isNothing(out.initializer)) continue;
          if (ts.isSpreadAssignment(out) && isNothing(out.expression)) continue;
          kept.push(out);
        }
        return f.updateObjectLiteralExpression(node, kept);
      }
      if (ts.isJsxAttributes(node)) {
        const kept: ts.JsxAttributeLike[] = [];
        for (const p of node.properties) {
          const out = ts.visitNode(p, visit) as ts.JsxAttributeLike | undefined;
          if (!out) continue;
          if (
            ts.isJsxAttribute(out) &&
            out.initializer &&
            ts.isJsxExpression(out.initializer) &&
            isNothing(out.initializer.expression)
          ) {
            continue;
          }
          if (ts.isJsxSpreadAttribute(out) && isNothing(out.expression)) continue;
          kept.push(out);
        }
        return f.updateJsxAttributes(node, kept);
      }
      if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
        const children: ts.JsxChild[] = [];
        for (const ch of node.children) {
          const out = ts.visitNode(ch, visit) as ts.JsxChild | undefined;
          if (!out) continue;
          if (ts.isJsxExpression(out) && isNothing(out.expression)) continue;
          children.push(out);
        }
        return ts.isJsxElement(node)
          ? f.updateJsxElement(
              node,
              ts.visitNode(node.openingElement, visit) as ts.JsxOpeningElement,
              children,
              node.closingElement,
            )
          : f.updateJsxFragment(node, node.openingFragment, children, node.closingFragment);
      }
      return ts.visitEachChild(node, visit, context);
    };

    return (sf) => ts.visitNode(sf, visit) as ts.SourceFile;
  };
}

/** Babel's JSX whitespace rule (cleanJSXElementLiteralChild): what React actually receives. */
function cleanJsxText(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  lines.forEach((line, i) => {
    if (/[^ \t]/.test(line)) lastNonEmpty = i;
  });
  let out = '';
  lines.forEach((line, i) => {
    let t = line.replace(/\t/g, ' ');
    if (i !== 0) t = t.replace(/^[ ]+/, '');
    if (i !== lines.length - 1) t = t.replace(/[ ]+$/, '');
    if (t) {
      if (i !== lastNonEmpty) t += ' ';
      out += t;
    }
  });
  return out;
}

/** JSX whitespace React drops, and empty `{}` / `{/* comment *\/}` children, removed. */
function jsxWhitespace(): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    const f = context.factory;
    const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
      if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
        const visited = ts.visitEachChild(node, visit, context);
        const children: ts.JsxChild[] = [];
        for (const ch of visited.children) {
          if (ts.isJsxText(ch)) {
            const clean = cleanJsxText(ch.text);
            if (clean) children.push(f.createJsxText(clean));
            continue;
          }
          if (ts.isJsxExpression(ch) && !ch.expression) continue;
          children.push(ch);
        }
        return ts.isJsxElement(visited)
          ? f.updateJsxElement(visited, visited.openingElement, children, visited.closingElement)
          : f.updateJsxFragment(
              visited,
              visited.openingFragment,
              children,
              visited.closingFragment,
            );
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (sf) => ts.visitNode(sf, visit) as ts.SourceFile;
  };
}

function hasExport(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function declaredNames(st: ts.Statement): string[] {
  if (
    (ts.isFunctionDeclaration(st) ||
      ts.isClassDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isEnumDeclaration(st)) &&
    st.name
  ) {
    return [st.name.text];
  }
  if (ts.isVariableStatement(st)) {
    return st.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : [],
    );
  }
  return [];
}

function identifiersIn(node: ts.Node, out: Set<string>, skip: ReadonlySet<ts.Node>): void {
  if (skip.has(node)) return;
  if (ts.isIdentifier(node)) out.add(node.text);
  ts.forEachChild(node, (ch) => identifiersIn(ch, out, skip));
}

/**
 * Drops what nothing uses: import bindings, and file-local (never exported)
 * functions, variables, classes, types and enums, until nothing changes.
 * Then sorts the imports, so a reordering by a formatter does not count.
 */
function prune(sf: ts.SourceFile): ts.SourceFile {
  const f = ts.factory;
  let statements = [...sf.statements];
  for (;;) {
    const used = new Set<string>();
    for (const st of statements) {
      if (ts.isImportDeclaration(st)) continue;
      const own = new Set<ts.Node>();
      if (
        (ts.isFunctionDeclaration(st) ||
          ts.isClassDeclaration(st) ||
          ts.isInterfaceDeclaration(st) ||
          ts.isTypeAliasDeclaration(st) ||
          ts.isEnumDeclaration(st)) &&
        st.name
      ) {
        own.add(st.name);
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) own.add(d.name);
      }
      identifiersIn(st, used, own);
    }
    let changed = false;
    const next: ts.Statement[] = [];
    for (const st of statements) {
      if (ts.isImportDeclaration(st)) {
        const clause = st.importClause;
        if (!clause) {
          next.push(st); // a side-effect import
          continue;
        }
        const keepDefault = clause.name && used.has(clause.name.text) ? clause.name : undefined;
        let bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings) && !used.has(bindings.name.text)) {
          bindings = undefined;
        } else if (bindings && ts.isNamedImports(bindings)) {
          const kept = bindings.elements.filter((e) => used.has(e.name.text));
          if (kept.length === 0) bindings = undefined;
          else if (kept.length !== bindings.elements.length) {
            bindings = f.updateNamedImports(bindings, kept);
          }
        }
        if (!keepDefault && !bindings) {
          changed = true;
          continue;
        }
        if (keepDefault !== clause.name || bindings !== clause.namedBindings) {
          changed = true;
          next.push(
            f.updateImportDeclaration(
              st,
              st.modifiers,
              f.updateImportClause(clause, clause.isTypeOnly, keepDefault, bindings),
              st.moduleSpecifier,
              st.attributes,
            ),
          );
          continue;
        }
        next.push(st);
        continue;
      }
      const names = declaredNames(st);
      if (names.length > 0 && !hasExport(st) && names.every((n) => !used.has(n))) {
        changed = true;
        continue;
      }
      next.push(st);
    }
    statements = next;
    if (!changed) break;
  }
  const specifier = (st: ts.ImportDeclaration) =>
    ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : '';
  const imports = statements
    .filter(ts.isImportDeclaration)
    .map((st) => {
      const b = st.importClause?.namedBindings;
      if (!b || !ts.isNamedImports(b)) return st;
      const sorted = [...b.elements].sort((a, z) => a.name.text.localeCompare(z.name.text));
      return f.updateImportDeclaration(
        st,
        st.modifiers,
        f.updateImportClause(
          st.importClause as ts.ImportClause,
          (st.importClause as ts.ImportClause).isTypeOnly,
          (st.importClause as ts.ImportClause).name,
          f.updateNamedImports(b, sorted),
        ),
        st.moduleSpecifier,
        st.attributes,
      );
    })
    .sort((a, z) => specifier(a).localeCompare(specifier(z)));
  const rest = statements.filter((st) => !ts.isImportDeclaration(st));
  return f.updateSourceFile(sf, [...imports, ...rest]);
}

/** An unambiguous, formatting-free serialisation of the syntax tree. */
function serialise(node: ts.Node): string {
  if (ts.isParenthesizedExpression(node)) return serialise(node.expression);
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return `#${node.text}`;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return `S${JSON.stringify(node.text)}`;
  }
  if (ts.isNumericLiteral(node)) return `N${Number(node.text)}`;
  if (ts.isBigIntLiteral(node)) return `B${node.text}`;
  if (ts.isRegularExpressionLiteral(node)) return `R${node.text}`;
  if (ts.isJsxText(node)) return `T${JSON.stringify(node.text)}`;
  if (
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail
  ) {
    return `Q${JSON.stringify((node as ts.TemplateLiteralLikeNode).text)}`;
  }
  let extra = '';
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    extra = `:${ts.tokenToString(node.operator)}`;
  } else if (ts.isVariableDeclarationList(node)) {
    extra =
      node.flags & ts.NodeFlags.Const ? ':const' : node.flags & ts.NodeFlags.Let ? ':let' : ':var';
  } else if (ts.isTypeOperatorNode(node)) {
    extra = `:${node.operator}`;
  } else if (ts.isHeritageClause(node)) {
    extra = `:${node.token}`;
  } else if (ts.isMetaProperty(node)) {
    extra = `:${node.keywordToken}`;
  } else if (ts.isImportClause(node) && node.isTypeOnly) {
    extra = ':type';
  }
  const kids: string[] = [];
  ts.forEachChild(node, (child) => {
    kids.push(serialise(child));
  });
  return `${ts.SyntaxKind[node.kind]}${extra}(${kids.join(',')})`;
}

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function transform(
  sf: ts.SourceFile,
  factories: ts.TransformerFactory<ts.SourceFile>[],
): ts.SourceFile {
  const result = ts.transform(sf, factories);
  const out = result.transformed[0];
  result.dispose();
  return out;
}

/** The file with every Liquid Glass branch folded to Classic, normalised. */
export function classicTree(source: string, fileName: string): ts.SourceFile {
  const projected = transform(parse(source, fileName), [projector(new WeakSet()), jsxWhitespace()]);
  return prune(projected);
}

/** The serialised classic projection (what the pins hash). */
export function classicSerialisation(source: string, fileName: string): string {
  return serialise(classicTree(source, fileName));
}

/** SHA-256 of the classic projection: a file before Liquid Glass hashes to its own value. */
export function classicHash(source: string, fileName: string): string {
  return createHash('sha256').update(classicSerialisation(source, fileName)).digest('hex');
}

/** Every `lg` the projection could not fold (a glass branch in a form it does not see). */
export function projectionLeaks(source: string, fileName: string): string[] {
  const tree = classicTree(source, fileName);
  const leaks: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === GLASS_BINDING) {
      const parent = node.parent ? ts.SyntaxKind[node.parent.kind] : 'unknown';
      leaks.push(`lg inside ${parent}`);
    }
    ts.forEachChild(node, walk);
  };
  walk(tree);
  return leaks;
}

/** Readable classic projection, for finding why a pin no longer matches. */
export function printClassic(source: string, fileName: string): string {
  return ts
    .createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
    .printFile(classicTree(source, fileName));
}
