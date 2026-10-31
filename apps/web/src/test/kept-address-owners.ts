import ts from 'typescript';

/**
 * Finds every write that could leave a maintenance request or a support
 * ticket without its owner. Used by
 * `src/server/lib/kept-address.guard.test.ts`, which says why that matters
 * (server/lib/kept-address.ts reads an emptied owner column as "this person
 * deleted their account").
 *
 * TypeScript (findTsWrites, findCalls): every `.from(table)` chain that calls
 * `.insert(…)`, `.upsert(…)` or `.update(…)`, with the columns it writes when
 * they can be read: an object literal (or an array of them), or a local object
 * whose every write in its function uses a literal key. `.from()` with a table
 * that is not a literal, or a const of one, is reported with a null table, so
 * a write the scan cannot place is never skipped. Storage buckets
 * (`.storage.from(…)`) are not tables and are left out.
 *
 * SQL (findSqlWrites, findTriggerFunctions, latestFunctionBodies,
 * findNewRowAssignments): INSERT, MERGE and COPY into either table; UPDATE of
 * either table whose SET assigns an owner column; and, in a function a trigger
 * on either table runs, an assignment to NEW's owner column or to NEW itself.
 * Comments are blanked first (positions kept, so line numbers hold); string
 * and function bodies are read as written.
 *
 * Also findFromChains (every `.from(…)` chain with the methods called on it,
 * so a delete can be placed) for the guard's gap-note checks, and the parsing
 * helpers the senders scan (./kept-address-senders.ts) reuses.
 *
 * Parsed with the TypeScript compiler, so a call split over several lines is
 * still one call.
 */

export const OWNER_COLUMNS = {
  maintenance_requests: ['requester_user_id'],
  support_tickets: ['organization_id', 'submitted_by'],
} as const;

export type OwnerTable = keyof typeof OWNER_COLUMNS;

export const OWNER_TABLES = Object.keys(OWNER_COLUMNS) as OwnerTable[];

export function isOwnerTable(name: string): name is OwnerTable {
  return (OWNER_TABLES as string[]).includes(name);
}

export type WriteMethod = 'insert' | 'upsert' | 'update';

export interface TsWrite {
  file: string;
  line: number;
  /** The table, or null when `.from()` was given something the scan cannot
   *  read (not a literal, nor a const of one). */
  table: OwnerTable | null;
  /** The `.from()` argument as written. */
  tableExpression: string;
  method: WriteMethod;
  /** The enclosing function's or method's name, '' at the top level. */
  enclosing: string;
  /** Each written column and its value as written, or null when the columns
   *  cannot be read (a parameter, a computed key, a spread the scan cannot
   *  follow). */
  columns: Record<string, string> | null;
  /** The object literal's spreads, as written (`supportTicketOwner(input)`). */
  spreads: string[];
}

export interface TsCall {
  file: string;
  line: number;
  enclosing: string;
  /** The first argument's keys and values when it is an object literal
   *  without spreads, else null. */
  args: Record<string, string> | null;
}

const WRITE_METHODS = new Set<string>(['insert', 'upsert', 'update']);

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

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

/** The nearest enclosing function's or method's name. */
function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n)) {
      return n.name ? (propertyName(n.name) ?? '') : '';
    }
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      n.parent &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text;
    }
  }
  return '';
}

function enclosingBody(node: ts.Node): ts.Node {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) return n;
  }
  return node.getSourceFile();
}

/** `const NAME = 'literal'` anywhere in the file: the literal, when there is
 *  exactly one such declaration. */
function constString(sf: ts.SourceFile, name: string): string | null {
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const init = unwrap(n.initializer);
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))
        found.push(init.text);
      else found.push('\u0000');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found.length === 1 && found[0] !== '\u0000' ? (found[0] ?? null) : null;
}

function tableOf(sf: ts.SourceFile, arg: ts.Expression): string | null {
  const a = unwrap(arg);
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return a.text;
  if (ts.isIdentifier(a)) return constString(sf, a.text);
  return null;
}

interface ReadColumns {
  columns: Record<string, string> | null;
  spreads: string[];
}

function objectColumns(sf: ts.SourceFile, obj: ts.ObjectLiteralExpression): ReadColumns {
  const columns: Record<string, string> = {};
  const spreads: string[] = [];
  let readable = true;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p)) {
      const key = propertyName(p.name);
      if (key === null) readable = false;
      else columns[key] = squash(p.initializer.getText(sf));
    } else if (ts.isShorthandPropertyAssignment(p)) {
      columns[p.name.text] = p.name.text;
    } else if (ts.isSpreadAssignment(p)) {
      spreads.push(squash(p.expression.getText(sf)));
    } else {
      readable = false;
    }
  }
  return { columns: readable ? columns : null, spreads };
}

/**
 * The columns written through a local object: its object-literal initializer
 * plus every `id.key = …` / `id['key'] = …` in the same function. Anything
 * else that could add a key (a computed key, `Object.assign(id, …)`, the
 * object passed to a call, a spread into it) makes it unreadable.
 */
function localObjectColumns(sf: ts.SourceFile, id: ts.Identifier): ReadColumns {
  const scope = enclosingBody(id);
  let decl: ts.VariableDeclaration | null = null;
  const visitDecl = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id.text) decl = n;
    ts.forEachChild(n, visitDecl);
  };
  visitDecl(scope);
  const d = decl as ts.VariableDeclaration | null;
  if (!d || !d.initializer) return { columns: null, spreads: [] };
  const init = unwrap(d.initializer);
  if (!ts.isObjectLiteralExpression(init)) return { columns: null, spreads: [] };
  const base = objectColumns(sf, init);
  if (base.columns === null || base.spreads.length > 0)
    return { columns: null, spreads: base.spreads };
  const columns = { ...base.columns };
  let readable = true;
  const visitUse = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === id.text && n !== d.name) {
      const parent = n.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === n) {
        const assign = parent.parent;
        if (
          ts.isBinaryExpression(assign) &&
          assign.left === parent &&
          assign.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          columns[parent.name.text] = squash(assign.right.getText(sf));
        }
      } else if (ts.isElementAccessExpression(parent) && parent.expression === n) {
        const key = unwrap(parent.argumentExpression);
        const assign = parent.parent;
        const isWrite =
          ts.isBinaryExpression(assign) &&
          assign.left === parent &&
          assign.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        if (isWrite && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) {
          columns[key.text] = squash((assign as ts.BinaryExpression).right.getText(sf));
        } else if (isWrite) {
          readable = false;
        }
      } else if (
        ts.isCallExpression(parent) &&
        parent.arguments.some((a) => a === n) &&
        !(
          ts.isPropertyAccessExpression(parent.expression) &&
          WRITE_METHODS.has(parent.expression.name.text)
        )
      ) {
        // Handed to some other function, which could add keys to it.
        readable = false;
      } else if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) {
        // Spread INTO something else is a read, harmless.
      }
    }
    ts.forEachChild(n, visitUse);
  };
  visitUse(scope);
  return { columns: readable ? columns : null, spreads: [] };
}

function writtenColumns(sf: ts.SourceFile, arg: ts.Expression | undefined): ReadColumns {
  if (!arg) return { columns: null, spreads: [] };
  const a = unwrap(arg);
  if (ts.isObjectLiteralExpression(a)) return objectColumns(sf, a);
  if (ts.isArrayLiteralExpression(a)) {
    const columns: Record<string, string> = {};
    const spreads: string[] = [];
    for (const el of a.elements) {
      const e = unwrap(el as ts.Expression);
      if (!ts.isObjectLiteralExpression(e)) return { columns: null, spreads };
      const read = objectColumns(sf, e);
      spreads.push(...read.spreads);
      if (read.columns === null) return { columns: null, spreads };
      Object.assign(columns, read.columns);
    }
    return { columns, spreads };
  }
  if (ts.isIdentifier(a)) return localObjectColumns(sf, a);
  return { columns: null, spreads: [] };
}

/** A cheap check before parsing: false only when the file cannot hold a
 *  write through `.from(…)`. */
export function mayHoldWrite(text: string): boolean {
  return text.includes('.from(') && /\.(insert|upsert|update)\(/.test(text);
}

/**
 * Every write through `.from(table)` in one source file that may reach one of
 * the two tables: the literal ones, and every one whose table the scan cannot
 * read (table null).
 */
export function findTsWrites(file: string, text: string): TsWrite[] {
  const sf = parse(file, text);
  const out: TsWrite[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'from' &&
      n.arguments.length >= 1
    ) {
      const receiver = unwrap(n.expression.expression);
      const isStorage = ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'storage';
      const table = tableOf(sf, n.arguments[0]!);
      if (!isStorage && (table === null || isOwnerTable(table))) {
        let cur: ts.Expression = n;
        while (
          cur.parent &&
          ts.isPropertyAccessExpression(cur.parent) &&
          cur.parent.expression === cur &&
          cur.parent.parent &&
          ts.isCallExpression(cur.parent.parent) &&
          cur.parent.parent.expression === cur.parent
        ) {
          const method = cur.parent.name.text;
          const call: ts.CallExpression = cur.parent.parent;
          if (WRITE_METHODS.has(method)) {
            const read = writtenColumns(sf, call.arguments[0]);
            out.push({
              file,
              line: lineOf(sf, n),
              table: table === null ? null : (table as OwnerTable),
              tableExpression: squash(n.arguments[0]!.getText(sf)),
              method: method as WriteMethod,
              enclosing: enclosingName(n),
              columns: read.columns,
              spreads: read.spreads,
            });
          }
          cur = call;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every call of `callee(…)` (or `x.callee(…)`) in one source file. */
export function findCalls(file: string, text: string, callee: string): TsCall[] {
  if (!text.includes(callee)) return [];
  const sf = parse(file, text);
  const out: TsCall[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const c = unwrap(n.expression);
      const name = ts.isIdentifier(c)
        ? c.text
        : ts.isPropertyAccessExpression(c)
          ? c.name.text
          : null;
      if (name === callee) {
        const first = n.arguments[0] ? unwrap(n.arguments[0]) : undefined;
        let args: Record<string, string> | null = null;
        if (first && ts.isObjectLiteralExpression(first)) {
          const read = objectColumns(sf, first);
          args = read.spreads.length === 0 ? read.columns : null;
        }
        out.push({ file, line: lineOf(sf, n), enclosing: enclosingName(n), args });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export interface FromChain {
  file: string;
  line: number;
  /** The table, or null when `.from()` was given something the scan cannot
   *  read (not a literal, nor a const of one). */
  table: string | null;
  /** The `.from()` argument as written. */
  tableExpression: string;
  /** The enclosing function's or method's name, '' at the top level. */
  enclosing: string;
  /** The methods called on it, in order (`['delete', 'eq']`). */
  methods: string[];
}

/**
 * Every `.from(…)` chain in one source file, whatever its table, with the
 * methods called on it. Storage buckets (`.storage.from(…)`) are left out, as
 * in findTsWrites. The kept-address guards read reads and deletes with it.
 */
export function findFromChains(file: string, text: string): FromChain[] {
  if (!text.includes('.from(')) return [];
  const sf = parse(file, text);
  const out: FromChain[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'from' &&
      n.arguments.length >= 1
    ) {
      const receiver = unwrap(n.expression.expression);
      const isStorage = ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'storage';
      if (!isStorage) {
        const methods: string[] = [];
        let cur: ts.Expression = n;
        while (
          cur.parent &&
          ts.isPropertyAccessExpression(cur.parent) &&
          cur.parent.expression === cur &&
          cur.parent.parent &&
          ts.isCallExpression(cur.parent.parent) &&
          cur.parent.parent.expression === cur.parent
        ) {
          methods.push(cur.parent.name.text);
          cur = cur.parent.parent;
        }
        out.push({
          file,
          line: lineOf(sf, n),
          table: tableOf(sf, n.arguments[0]!),
          tableExpression: squash(n.arguments[0]!.getText(sf)),
          enclosing: enclosingName(n),
          methods,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The string values of `const NAME = { key: 'value', … }` in one file, or
 *  null when it is not an object literal of string literals. */
export function constObjectStringValues(file: string, text: string, name: string): string[] | null {
  const sf = parse(file, text);
  let values: string[] | null = null;
  let found = 0;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found += 1;
      const init = n.initializer ? unwrap(n.initializer) : undefined;
      if (init && ts.isObjectLiteralExpression(init)) {
        const out: string[] = [];
        for (const p of init.properties) {
          if (!ts.isPropertyAssignment(p)) return;
          const v = unwrap(p.initializer);
          if (!ts.isStringLiteral(v) && !ts.isNoSubstitutionTemplateLiteral(v)) return;
          out.push(v.text);
        }
        values = out;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found === 1 ? values : null;
}

/** The parsing helpers above, for the senders scan in ./kept-address-senders.ts. */
export {
  lineOf as nodeLine,
  parse as parseSource,
  propertyName as literalPropertyName,
  squash as squashText,
  tableOf as fromTable,
  unwrap as unwrapExpression,
};

// ── SQL ─────────────────────────────────────────────────────────────────────

/**
 * The text with every comment blanked to spaces, newlines kept, so offsets
 * and line numbers still match the file. `--` runs to the end of its line and
 * `/* … *\/` nests, as in Postgres; neither starts inside a quoted string or
 * identifier. Dollar-quoted text is read as code: it is almost always a
 * function body, whose comments are comments too.
 */
export function blankSqlComments(text: string): string {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && next === '*') {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
    } else if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(text[i - 1] ?? '') && !/[\w$]/.test(text[i - 2] ?? '');
      let j = i + 1;
      while (j < n) {
        if (escapes && text[j] === '\\') j += 2;
        else if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j++;
      }
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1;
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

export type SqlWriteKind = 'insert' | 'merge' | 'copy' | 'update';

export interface SqlWrite {
  file: string;
  line: number;
  table: OwnerTable;
  kind: SqlWriteKind;
  /** For an update: the owner columns its SET assigns. */
  columns: string[];
}

const TABLE_REF = String.raw`(?:only\s+)?(?:"?public"?\s*\.\s*)?"?(maintenance_requests|support_tickets)"?(?![\w$"])`;

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

/** An UPDATE's SET list ends at the first of these, outside parentheses. */
const SET_LIST_END = /(?:where|from|returning)(?![\w$])/iy;

/** From `from`, the text up to the end of an UPDATE's SET list: `;`, a `)`
 *  that closes a parenthesis opened before it, or SET_LIST_END as a whole
 *  word, each outside parentheses. */
function setListAt(text: string, from: number): string {
  let depth = 0;
  for (let k = from; k < text.length; k++) {
    const c = text[k];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return text.slice(from, k);
      depth--;
    } else if (depth === 0) {
      if (c === ';') return text.slice(from, k);
      if (!/[\w$]/.test(text[k - 1] ?? '')) {
        SET_LIST_END.lastIndex = k;
        if (SET_LIST_END.test(text)) return text.slice(from, k);
      }
    }
  }
  return text.slice(from);
}

/** The assignment targets of an UPDATE's SET list (column names, lowercase). */
function setTargets(setList: string): string[] {
  const targets: string[] = [];
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let k = 0; k < setList.length; k++) {
    const c = setList[k];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(setList.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(setList.slice(start));
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const target = part
      .slice(0, eq)
      .trim()
      .replace(/^\(|\)$/g, '');
    for (const t of target.split(',')) {
      const name = t.trim().replace(/"/g, '').split('.').pop()?.toLowerCase();
      if (name) targets.push(name);
    }
  }
  return targets;
}

/** INSERT, MERGE and COPY into either table, and UPDATEs that assign an owner
 *  column, in one migration file. */
export function findSqlWrites(file: string, text: string): SqlWrite[] {
  const code = blankSqlComments(text);
  const out: SqlWrite[] = [];
  const into = new RegExp(String.raw`\b(insert|merge)\s+into\s+${TABLE_REF}`, 'gi');
  for (const m of code.matchAll(into)) {
    out.push({
      file,
      line: lineAt(code, m.index ?? 0),
      table: m[2]!.toLowerCase() as OwnerTable,
      kind: m[1]!.toLowerCase() as SqlWriteKind,
      columns: [],
    });
  }
  const copy = new RegExp(String.raw`\bcopy\s+${TABLE_REF}`, 'gi');
  for (const m of code.matchAll(copy)) {
    out.push({
      file,
      line: lineAt(code, m.index ?? 0),
      table: m[1]!.toLowerCase() as OwnerTable,
      kind: 'copy',
      columns: [],
    });
  }
  const update = new RegExp(
    String.raw`\bupdate\s+${TABLE_REF}(?:\s+(?:as\s+)?(?!set\b)[\w$]+)?\s+set\b`,
    'gi',
  );
  for (const m of code.matchAll(update)) {
    const table = m[1]!.toLowerCase() as OwnerTable;
    const setList = setListAt(code, (m.index ?? 0) + m[0].length);
    const owners = OWNER_COLUMNS[table] as readonly string[];
    const columns = setTargets(setList).filter((t) => owners.includes(t));
    if (columns.length > 0) {
      out.push({ file, line: lineAt(code, m.index ?? 0), table, kind: 'update', columns });
    }
  }
  return out;
}

export interface TriggerOnOwnerTable {
  file: string;
  line: number;
  trigger: string;
  table: OwnerTable;
  /** The function it runs (lowercase, schema dropped), or null when unread. */
  fn: string | null;
}

/** Every CREATE TRIGGER on either table in one migration file. */
export function findTriggerFunctions(file: string, text: string): TriggerOnOwnerTable[] {
  const code = blankSqlComments(text);
  const out: TriggerOnOwnerTable[] = [];
  const re = /\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+("?[\w$]+"?)([^;]*);/gi;
  for (const m of code.matchAll(re)) {
    const rest = m[2] ?? '';
    const on = new RegExp(String.raw`\bon\s+${TABLE_REF}`, 'i').exec(rest);
    if (!on) continue;
    const fn =
      /\bexecute\s+(?:function|procedure)\s+(?:"?public"?\s*\.\s*)?"?([\w$]+)"?\s*\(/i.exec(rest);
    out.push({
      file,
      line: lineAt(code, m.index ?? 0),
      trigger: (m[1] ?? '').replace(/"/g, ''),
      table: on[1]!.toLowerCase() as OwnerTable,
      fn: fn ? fn[1]!.toLowerCase() : null,
    });
  }
  return out;
}

export interface FunctionBody {
  file: string;
  line: number;
  body: string;
}

/**
 * The body each public function has after every migration ran: for each
 * CREATE [OR REPLACE] FUNCTION, the text between its dollar quotes; a later
 * file (in the order given) replaces an earlier one. Keyed by the lowercase
 * name without its schema.
 */
export function latestFunctionBodies(
  files: Array<{ file: string; text: string }>,
): Map<string, FunctionBody> {
  const out = new Map<string, FunctionBody>();
  for (const { file, text } of files) {
    const code = blankSqlComments(text);
    const re =
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\s*\.\s*)?"?([\w$]+)"?\s*\(/gi;
    const matches = [...code.matchAll(re)];
    for (const [i, m] of matches.entries()) {
      const start = (m.index ?? 0) + m[0].length;
      // Only up to the next CREATE FUNCTION: a body that is not dollar-quoted
      // (BEGIN ATOMIC, a quoted string) must not borrow the next one's.
      const end = matches[i + 1]?.index ?? code.length;
      const as = /\bas\s+(\$[\w]*\$)/i.exec(code.slice(start, end));
      if (!as) continue;
      const open = start + as.index + as[0].length;
      const close = code.indexOf(as[1]!, open);
      if (close === -1) continue;
      out.set(m[1]!.toLowerCase(), {
        file,
        line: lineAt(code, m.index ?? 0),
        body: code.slice(open, close),
      });
    }
  }
  return out;
}

/**
 * In a trigger function's body: assignments to NEW's owner columns
 * (`new.col := …` or `new.col = …` as a statement, `select … into new.col`)
 * and to NEW as a whole (`new := …`). A comparison (`if new.col = …`) is not
 * an assignment and is not reported.
 */
export function findNewRowAssignments(body: string, columns: readonly string[]): string[] {
  const found: string[] = [];
  const statementStart = String.raw`(?:^|;|\bbegin\b|\bthen\b|\belse\b|\bloop\b|\bdeclare\b)\s*`;
  for (const col of columns) {
    const assign = new RegExp(String.raw`${statementStart}new\s*\.\s*"?${col}"?\s*:?=(?!=)`, 'gi');
    if (assign.test(body)) found.push(`new.${col} :=`);
    const into = new RegExp(
      String.raw`\binto\s+(?:strict\s+)?(?:[\w$."]+\s*,\s*)*new\s*\.\s*"?${col}"?\b`,
      'gi',
    );
    if (into.test(body)) found.push(`into new.${col}`);
  }
  const whole = new RegExp(String.raw`${statementStart}new\s*:?=(?!=)`, 'gi');
  if (whole.test(body)) found.push('new :=');
  return found;
}
