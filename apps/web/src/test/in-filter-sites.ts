import ts from 'typescript';

/**
 * Finds every PostgREST id-list filter in a source file and decides whether
 * its value list is known to stay short. Used by
 * `src/lib/supabase/in-filter-sites.guard.test.ts`. The shapes it finds:
 *   - `.in(column, values)` / `.notIn(column, values)`, whatever the column;
 *   - `.filter(column, 'in', values)` / `.not(column, 'in', values)`;
 *   - an `in.(` filter string followed by a value: a template substitution
 *     (`in.(${…})`), a `+` concatenation (`'id.in.(' + …`) or the next
 *     element of an array (`['id.in.(', …].join('')`).
 *
 * A value list rides in the request URL; past about 215 uuids the local
 * gateway answers 414 and past about 395 production fails (see
 * `@/lib/supabase/in-filter`). A site is EXEMPT when its values are:
 *   - literal: an array of plain literals (`['a', 'b']`, not `[...set]`) or a
 *     literal PostgREST list string (`'(a,b)'`);
 *   - built from a SCREAMING_CASE constant (`AUDIENCE_PERMISSIONS`,
 *     `KNOWN.join(',')`);
 *   - built from `batch` where `batch` is the parameter of a callback passed
 *     straight to fetchAllRowsByIds / mapIdBatches / writeInIdBatches, or the
 *     loop variable of `for (const batch of chunkInFilterValues(…))`, in a file
 *     that imports one of them. Any other `batch` (a local, some other
 *     function's parameter) is just a name;
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
  kind: 'in' | 'notIn' | 'filter' | 'not' | 'template';
  /** Line-independent identity: `<kind>:<column> <- <values expression>`,
   *  whitespace collapsed. Stable when code above it moves. */
  fingerprint: string;
  /** Why the site is exempt, or null when it counts against the baseline. */
  exempt: 'literal-array' | 'constant' | 'batch' | 'annotated' | null;
}

const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;
const ANNOTATION = /in-list-bound:\s*(.{10,})/;
const HELPER_MODULE = /(?:fetch-by-ids|in-filter)$/;
/** Helpers whose callback receives one batch as its parameter. */
const BATCH_CALLBACK_HELPERS = new Set(['fetchAllRowsByIds', 'mapIdBatches', 'writeInIdBatches']);
/** A literal part that ends where an `in.(` list's values begin. */
const IN_LIST_OPEN = /in\.\("?$/;

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

function stringText(node: ts.Expression): string | null {
  const n = unwrap(node);
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
}

/** The name a call is made through: `f(…)`, `obj.f(…)`, `f<T>(…)`. */
function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function declaresName(list: ts.VariableDeclarationList, name: string): boolean {
  return list.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name);
}

/**
 * Whether the nearest binding of `batch` visible at `use` is one of the
 * batching helpers' batches. Walks outward and stops at the FIRST scope that
 * declares the name, so a shadowing local or a parameter of an unrelated
 * function is not mistaken for the helper's batch.
 */
function isHelperBatch(use: ts.Node): boolean {
  for (let n: ts.Node | undefined = use.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      const declares = n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === 'batch');
      if (!declares) continue;
      const call = n.parent;
      return (
        (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
        call !== undefined &&
        ts.isCallExpression(call) &&
        call.arguments.some((a) => a === n) &&
        BATCH_CALLBACK_HELPERS.has(calleeName(call) ?? '')
      );
    }
    if (
      (ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n)) &&
      n.initializer &&
      ts.isVariableDeclarationList(n.initializer) &&
      declaresName(n.initializer, 'batch')
    ) {
      const source = ts.isForOfStatement(n) ? unwrap(n.expression) : null;
      return (
        source !== null &&
        ts.isCallExpression(source) &&
        calleeName(source) === 'chunkInFilterValues'
      );
    }
    if (ts.isCatchClause(n) && n.variableDeclaration) {
      const d = n.variableDeclaration;
      if (ts.isIdentifier(d.name) && d.name.text === 'batch') return false;
    }
    if (
      (ts.isBlock(n) ||
        ts.isSourceFile(n) ||
        ts.isModuleBlock(n) ||
        ts.isCaseClause(n) ||
        ts.isDefaultClause(n)) &&
      n.statements.some(
        (st) =>
          (ts.isVariableStatement(st) && declaresName(st.declarationList, 'batch')) ||
          ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) &&
            st.name?.text === 'batch'),
      )
    ) {
      return false;
    }
  }
  return false;
}

/** `batch`, `batch.join(',')`, `batch.map(q).join(',')`: the leftmost name. */
function rootIdentifierNode(node: ts.Expression): ts.Identifier | null {
  let n = unwrap(node);
  for (;;) {
    if (ts.isIdentifier(n)) return n;
    if (ts.isCallExpression(n)) n = unwrap(n.expression);
    else if (ts.isPropertyAccessExpression(n)) n = unwrap(n.expression);
    else return null;
  }
}

/** For `a + b + c`, the rightmost operand of the left side chain. */
function rightmostOperand(node: ts.Expression): ts.Expression {
  let n = unwrap(node);
  while (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    n = unwrap(n.right);
  }
  return n;
}

/** The text a string-ish expression ENDS with, when that is known statically. */
function trailingText(node: ts.Expression): string | null {
  const n = rightmostOperand(node);
  const text = stringText(n);
  if (text !== null) return text;
  if (ts.isTemplateExpression(n)) {
    const last = n.templateSpans[n.templateSpans.length - 1];
    return last ? last.literal.text : n.head.text;
  }
  return null;
}

function importsHelper(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      HELPER_MODULE.test(s.moduleSpecifier.text),
  );
}

/**
 * A cheap check before parsing a file: false only when the text cannot hold
 * any of the shapes above. `.filter(col, 'in', …)` and `.not(col, 'in', …)`
 * carry neither `.in(` nor `in.(`, hence the quoted `'in'`.
 */
export function mayHoldInFilter(text: string): boolean {
  return /\.in\(|\.notIn\(|in\.\(|['"`]in['"`]/.test(text);
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

  /** Exempt by what the values are built from, before any annotation. */
  function builtFrom(values: ts.Expression): Exclude<InFilterSite['exempt'], 'annotated'> {
    const v = unwrap(values);
    if (ts.isArrayLiteralExpression(v) && v.elements.every((e) => isPlainLiteral(e))) {
      return 'literal-array';
    }
    // A literal PostgREST list, `'(a,b)'`.
    if (stringText(v) !== null) return 'literal-array';
    if (ts.isTemplateExpression(v) || (ts.isBinaryExpression(v) && isConcat(v))) {
      // `(${X.join(',')})` or `'(' + X.join(',') + ')'`: exempt when every
      // non-literal part is.
      const parts = ts.isTemplateExpression(v)
        ? v.templateSpans.map((span) => span.expression)
        : concatOperands(v).filter((o) => stringText(o) === null);
      const kinds = parts.map((p) => builtFrom(p));
      if (kinds.length > 0 && kinds.every((k) => k !== null)) return kinds[0] ?? null;
      return null;
    }
    const root = rootIdentifierNode(v);
    if (root && CONSTANT_NAME.test(root.text)) return 'constant';
    if (helper && root && root.text === 'batch' && isHelperBatch(root)) return 'batch';
    return null;
  }

  function classifyValues(values: ts.Expression, line: number): InFilterSite['exempt'] {
    return builtFrom(values) ?? (annotated(line) ? 'annotated' : null);
  }

  function lineOf(node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  }

  function columnText(column: ts.Expression): string {
    return stringText(column) ?? squash(column.getText(sf));
  }

  /** A site whose values follow an `in.(` literal: `<open> <- <values>`. */
  function pushOpenList(open: string, values: ts.Expression): void {
    const line = lineOf(values);
    sites.push({
      line: line + 1,
      kind: 'template',
      fingerprint: `template:${squash(open)} <- ${squash(values.getText(sf))}`,
      exempt: classifyValues(values, line),
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      // The line of the method name itself, which is where a reader looks.
      const line = lineOf(node.expression.name);
      if ((method === 'in' || method === 'notIn') && node.arguments.length === 2) {
        const [column, values] = node.arguments as unknown as [ts.Expression, ts.Expression];
        sites.push({
          line: line + 1,
          kind: method,
          fingerprint: `${method}:${columnText(column)} <- ${squash(values.getText(sf))}`,
          exempt: classifyValues(values, line),
        });
      }
      if ((method === 'filter' || method === 'not') && node.arguments.length === 3) {
        const [column, operator, values] = node.arguments as unknown as [
          ts.Expression,
          ts.Expression,
          ts.Expression,
        ];
        if (stringText(operator) === 'in') {
          sites.push({
            line: line + 1,
            kind: method,
            fingerprint: `${method}:${columnText(column)} <- ${squash(values.getText(sf))}`,
            exempt: classifyValues(values, line),
          });
        }
      }
    }
    if (ts.isTemplateExpression(node)) {
      // `in.(` at the end of one literal part, followed by a substitution.
      const parts: Array<{ text: string; next: ts.Expression | null }> = [
        { text: node.head.text, next: node.templateSpans[0]?.expression ?? null },
        ...node.templateSpans.map((span, i) => ({
          text: span.literal.text,
          next: node.templateSpans[i + 1]?.expression ?? null,
        })),
      ];
      for (const part of parts) {
        if (part.next && IN_LIST_OPEN.test(part.text)) pushOpenList(part.text, part.next);
      }
    }
    if (ts.isBinaryExpression(node) && isConcat(node)) {
      // `… + 'id.in.(' + values`: the left side ends with `in.(`.
      const open = trailingText(node.left);
      if (open !== null && IN_LIST_OPEN.test(open)) pushOpenList(open, node.right);
    }
    if (ts.isArrayLiteralExpression(node)) {
      // `['id.in.(', values, ')'].join('')`.
      node.elements.forEach((el, i) => {
        const open = ts.isSpreadElement(el) ? null : trailingText(el);
        const next = node.elements[i + 1];
        if (open !== null && IN_LIST_OPEN.test(open) && next && !ts.isSpreadElement(next)) {
          pushOpenList(open, next);
        }
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return sites;
}

function isConcat(node: ts.BinaryExpression): boolean {
  return node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** Every operand of a `+` chain, left to right. */
function concatOperands(node: ts.Expression): ts.Expression[] {
  const n = unwrap(node);
  if (ts.isBinaryExpression(n) && isConcat(n)) {
    return [...concatOperands(n.left), ...concatOperands(n.right)];
  }
  return [n];
}
