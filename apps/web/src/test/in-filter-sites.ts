import ts from 'typescript';

/**
 * Finds every PostgREST `.in()` / `.notIn()` filter and every `in.(${…})`
 * filter string in a source file, and decides whether its value list is known
 * to stay short. Used by `src/lib/supabase/in-filter-sites.guard.test.ts`.
 *
 * A value list rides in the request URL; past about 215 uuids the local
 * gateway answers 414 and past about 395 production fails (see
 * `@/lib/supabase/in-filter`). A site is EXEMPT when its values are:
 *   - an array literal of plain literals (`['a', 'b']`), not `[...set]`;
 *   - a SCREAMING_CASE constant (`AUDIENCE_PERMISSIONS`);
 *   - the `batch` parameter of a helper from `fetch-by-ids` / `in-filter`,
 *     in a file that imports one of them;
 *   - annotated on the call's line or one of the three above it with
 *     `in-list-bound: <why it stays under 100 values>` (10+ characters).
 * Everything else is counted against a ratchet baseline, per file, by
 * FINGERPRINT (`in:<column> <- <values expression>`), so converting one site
 * and adding a different unbounded one in the same file does not net to zero.
 *
 * Parsed with the TypeScript compiler, not a regex, so a call split over
 * several lines is still one call.
 */

export interface InFilterSite {
  line: number;
  kind: 'in' | 'notIn' | 'template';
  /** Line-independent identity: `<kind>:<column> <- <values expression>`,
   *  whitespace collapsed. Stable when code above it moves. */
  fingerprint: string;
  /** Why the site is exempt, or null when it counts against the baseline. */
  exempt: 'literal-array' | 'constant' | 'batch' | 'annotated' | null;
}

const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;
const ANNOTATION = /in-list-bound:\s*(.{10,})/;
const HELPER_MODULE = /(?:fetch-by-ids|in-filter)$/;

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isAsExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function isPlainLiteral(node: ts.Expression): boolean {
  const n = unwrap(node);
  return (
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isNumericLiteral(n) ||
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword
  );
}

/** `batch`, `batch.join(',')`, `batch.map(q).join(',')`: the leftmost name. */
function rootIdentifier(node: ts.Expression): string | null {
  let n = unwrap(node);
  for (;;) {
    if (ts.isIdentifier(n)) return n.text;
    if (ts.isCallExpression(n)) n = unwrap(n.expression);
    else if (ts.isPropertyAccessExpression(n)) n = unwrap(n.expression);
    else return null;
  }
}

function importsHelper(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      HELPER_MODULE.test(s.moduleSpecifier.text),
  );
}

export function classifyInFilterSites(fileName: string, text: string): InFilterSite[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split('\n');
  const helper = importsHelper(sf);
  const sites: InFilterSite[] = [];

  function annotated(line: number): boolean {
    for (let l = Math.max(0, line - 3); l <= line; l += 1) {
      if (ANNOTATION.test(lines[l] ?? '')) return true;
    }
    return false;
  }

  function classifyValues(values: ts.Expression, line: number): InFilterSite['exempt'] {
    const v = unwrap(values);
    if (ts.isArrayLiteralExpression(v) && v.elements.every((e) => isPlainLiteral(e))) {
      return 'literal-array';
    }
    if (ts.isIdentifier(v) && CONSTANT_NAME.test(v.text)) return 'constant';
    if (helper && rootIdentifier(v) === 'batch') return 'batch';
    return annotated(line) ? 'annotated' : null;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'in' || node.expression.name.text === 'notIn') &&
      node.arguments.length === 2
    ) {
      const [column, values] = node.arguments as unknown as [ts.Expression, ts.Expression];
      const col = unwrap(column);
      if (ts.isStringLiteral(col) || ts.isNoSubstitutionTemplateLiteral(col)) {
        // The line of `.in` itself, which is where a reader looks.
        const line = sf.getLineAndCharacterOfPosition(node.expression.name.getStart(sf)).line;
        const kindName = node.expression.name.text === 'in' ? 'in' : 'notIn';
        sites.push({
          line: line + 1,
          kind: kindName,
          fingerprint: `${kindName}:${col.text} <- ${squash(values.getText(sf))}`,
          exempt: classifyValues(values, line),
        });
      }
    }
    if (ts.isTemplateExpression(node)) {
      // `in.(` in one literal part, followed directly by a substitution.
      const parts: Array<{ text: string; next: ts.Expression | null }> = [
        { text: node.head.text, next: node.templateSpans[0]?.expression ?? null },
        ...node.templateSpans.map((span, i) => ({
          text: span.literal.text,
          next: node.templateSpans[i + 1]?.expression ?? null,
        })),
      ];
      for (const part of parts) {
        if (part.next && /in\.\("?$/.test(part.text)) {
          const line = sf.getLineAndCharacterOfPosition(part.next.getStart(sf)).line;
          const root = rootIdentifier(part.next);
          const exempt: InFilterSite['exempt'] =
            helper && root === 'batch' ? 'batch' : annotated(line) ? 'annotated' : null;
          sites.push({
            line: line + 1,
            kind: 'template',
            fingerprint: `template:${squash(part.text)} <- ${squash(part.next.getText(sf))}`,
            exempt,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return sites;
}
