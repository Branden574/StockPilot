import ts from 'typescript';

/**
 * One piece of copy in a source file. `start` and `end` say where it sits:
 * for a JSX element or fragment (`jsx`), the span of its children, from the
 * end of the opening tag to the start of the closing tag, so its attributes
 * fall outside; for a string or template literal, the literal itself.
 */
export type Copy = { line: number; text: string; jsx: boolean; start: number; end: number };

export type CopyOptions = {
  /** An object literal this returns true for is skipped, with all it holds. */
  skipObject?: (node: ts.ObjectLiteralExpression) => boolean;
};

/**
 * Every piece of copy in a file, as written: string and template literals (a
 * template's substitutions read "${…}") and the text of each JSX element with
 * its children joined (an expression child reads "${…}" unless it is a string,
 * a nested element contributes its own text, whitespace collapses). Comments
 * and import paths are not copy and are skipped. The web guards that read copy
 * share it: lib/on-record-wording.guard.test.ts and
 * test/customer-names-in-copy.guard.test.ts.
 */
export function copyInSource(file: string, text: string, options: CopyOptions = {}): Copy[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Copy[] = [];
  const at = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = (node: ts.Node, text: string): Copy => ({
    line: at(node),
    text,
    jsx: false,
    start: node.getStart(source),
    end: node.getEnd(),
  });

  const jsxText = new Map<ts.Node, string>();
  const flatten = (node: ts.JsxElement | ts.JsxFragment): string => {
    const known = jsxText.get(node);
    if (known !== undefined) return known;
    const parts = node.children.map((child): string => {
      if (ts.isJsxText(child)) return child.text;
      if (ts.isJsxExpression(child)) {
        const e = child.expression;
        if (!e) return '';
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
        return '${…}';
      }
      if (ts.isJsxElement(child) || ts.isJsxFragment(child)) return ` ${flatten(child)} `;
      return ' ';
    });
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    jsxText.set(node, text);
    return text;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (options.skipObject && ts.isObjectLiteralExpression(node) && options.skipObject(node)) {
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(literal(node, node.text));
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((s) => '${…}' + s.literal.text).join('');
      out.push(literal(node, text));
      node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const text = flatten(node);
      if (text) {
        const [open, close] = ts.isJsxElement(node)
          ? [node.openingElement, node.closingElement]
          : [node.openingFragment, node.closingFragment];
        out.push({
          line: at(node),
          text,
          jsx: true,
          start: open.getEnd(),
          end: close.getStart(source),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}
