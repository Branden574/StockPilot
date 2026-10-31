import ts from 'typescript';

import {
  fromTable,
  literalPropertyName,
  nodeLine,
  parseSource,
  squashText,
  unwrapExpression,
} from './kept-address-owners';

/**
 * The senders scan for `src/server/lib/kept-address-senders.guard.test.ts`,
 * which says why it matters. analyzeSenderFiles reads the source files, each
 * against what the others' functions return (RETURNS below), until nothing
 * changes; linkSenderFiles then resolves the calls between files.
 *
 * UNITS. Every function with a body is its own unit, named by its path in the
 * file: `name` (a function declaration, or a function or arrow assigned to a
 * variable), `Class.member` (a method, accessor, constructor or function-valued
 * property; a setter is `Class.name=`), `object.key` (a function in an object
 * literal assigned to a variable) and `outer>inner` for one declared inside
 * another. Any other function (a callback, a wrapped handler, a method of an
 * object handed to a call) belongs to the unit it sits in; '' is the file's
 * top level. Two units with the same path in one file are reported
 * (duplicates), since nothing could tell their calls apart. Sends, calls and
 * answers keep the functions they sit in (`fns`, `home`), so an answer guards
 * only what sits in the function it is called in, not a sibling function of
 * the unit.
 *
 * For each unit:
 *   - READS: a kept column named in its code (a select list, `row.column`,
 *     `row['column']`, a destructured `{ column }`; never an object key being
 *     written), for a table whose kept column has a name of its own; an alias
 *     of a kept address where the alias can be seen (the file that makes it,
 *     or a file that imports that file, statically or with `import()`), or
 *     read off a row the unit holds (`detail.requesterEmail` of a row a call
 *     returned, in any file); a `.from(table)` chain with a select, the chain
 *     followed back through the variables it is kept in, each by its own
 *     declaration (`let q = db.from(t); q = q.select(…)`); a kept address (or
 *     a row holding it) handed to it by a function of the same file that does
 *     not ask around the call (RECEIVED); and, for a table read by its
 *     chains (READ_BY_RETURN), a call of a function that returns its kept
 *     address or a row holding it (`gets it from listSupportTickets()`). For
 *     a table read by its chains (its column has a common name), any select
 *     counts but an insert's or upsert's that names no kept column; for every
 *     table, selecting `*`, nothing, or a list the scan cannot read counts.
 *   - RETURNS: for each table, whether the unit returns its kept address
 *     ('value') or a row holding it ('row'): what its `return`s (or an
 *     arrow's body) carry. Calls of another file's functions use what those
 *     return, so analyzeSenderFiles reads a file again when that changes.
 *   - SENDS: sendEmail(…) under any receiver (`x.sendEmail`, `x['sendEmail']`),
 *     `.emails.send(…)` (`x.emails.send`, `x['emails']['send']`, or `emails`
 *     taken off the client) and a fetch to the Resend API.
 *   - CALLS, each with the tables whose kept address (or a row holding it) an
 *     argument carries: of the file's own units (an identifier resolved to
 *     the nearest enclosing declaration of that name, `this.m(…)` in a class,
 *     a member of a local class or object, or of an instance made from a
 *     local class), and of imports (a named, default or namespace import,
 *     static or dynamic: `const { f } = await import('m')`, `const m = await
 *     import('m')`, `(await import('m')).f(…)`; a member of an imported class
 *     or object, or of an instance made from an imported class with
 *     `new X(…)` or `X.factory(…)`, made in place, or another name for one).
 *     A name the file declares again around the call (a parameter, variable,
 *     function or class) is that local one, not the import. An import is
 *     resolved to `Class.member` or `object.key` in the file that declares
 *     it, through re-exports (`export { a as b } from`, `export * from`,
 *     import then export). A call into a file of the scan that reaches no
 *     unit is marked unresolved. `new X(…)` is a call of X's constructor.
 *   - UNKNOWN CALLS: a call carrying a kept address (or a row holding it) to
 *     a callee the scan cannot place at all: a function kept in a variable
 *     or a parameter, a method of an object it cannot place (a parameter, a
 *     field, what an unknown call returned), a global, a query builder's
 *     write, a store into an array, set or map that is not the function's
 *     own. Not one: a send primitive (a send), PURE_GLOBAL_CALLS, a store
 *     into the function's own array, object, set or map (STORE_METHODS), and
 *     `Object.assign` into a variable of the function (the variable then
 *     holds the row).
 *   - ANSWERS: the answer functions it calls, each with the function the
 *     call sits in: a call that resolves, as above, to the function of that
 *     name the answer file (kept-address.ts) exports, whatever it is called
 *     where it is imported (named, aliased, namespace, dynamic or
 *     re-exported). A function of another file, or of the caller's own file,
 *     that only has the same name is not an answer.
 *   - ALIAS SITES: a key a kept address itself (not a row that holds it) is
 *     put under: an object key wherever the object is, but in the arguments
 *     of an answer function or of a send primitive (sendEmail, `.emails.send`,
 *     a fetch to the Resend API); `o.key = address`; `this.key = address`. A
 *     computed key is read when it is a literal (`{ ['to']: a }`); otherwise
 *     it is an UNREADABLE KEY (`{ [k]: a }`, `o[k] = a`).
 *   - ESCAPES: a row holding a kept address put into an object that outlives
 *     the function (`this.row = r`, `param.row = r`, an object at the file's
 *     top level), where the scan does not follow it.
 *   - DYNAMIC READS: a select through a `.from()` whose table the scan cannot
 *     read (a variable, an imported constant), and a `.select(…)` whose chain
 *     cannot be traced back to a `.from()` at all.
 * Carrying is followed through the unit's own variables, assignments (`=`,
 * `??=`, `||=`, `&&=`, `+=`), `for … of` loops and inline array callbacks: a
 * value read off a row, or made from one by a call, `new`, a method, a
 * conditional, `??`, `||`, `+` or a template, carries the address; a read's
 * result, its `data`, an element of it and objects or arrays built from it
 * (an object literal, `o.key = …` and STORE_METHODS on a variable of the
 * function, `Object.assign` into one) carry the row. A call carries what the
 * function it reaches returns (in the file or in another one), what it is
 * called on and handed, and what an inline callback handed to it returns
 * (`ids.map((id) => load(id))`). A unit's parameters carry what a caller in
 * the same file hands them where that caller does not ask around the call; a
 * caller in another file is checked at its own call (a hand-off).
 */

/** One kept address: the table, its column, how a read of it is found, the
 *  aliases that carry it out of a row, and the kept-address.ts function that
 *  answers whether its owner deleted their account (null: none yet). */
export interface KeptAddressSpec {
  table: string;
  column: string;
  /** 'column': the column's name is this table's alone, so naming it reads
   *  it; 'table': the name is common (email), so only a `.from(table)` read
   *  counts. */
  readBy: 'column' | 'table';
  /** Each property that carries the address out of a row: its name, and the
   *  file and unit that make it. */
  aliases: Array<{ name: string; file: string; enclosing: string }>;
  answer: string | null;
}

export interface SendSite {
  line: number;
  how: string;
  /** The functions it sits in, innermost first, by start offset (-1: the file). */
  fns: number[];
}

/** An imported name to look up: the file the import resolves to, the name it
 *  exports there, and the member called on it (null: the export is called). */
export interface ImportRef {
  file: string;
  exportName: string;
  member: string | null;
}

export interface CallSite {
  line: number;
  /** The name called (the member's name for `x.m(…)`). */
  name: string;
  /** For a call into an import: the module as written and the file it
   *  resolves to (null when it is outside the scan, such as a package). */
  module?: string;
  resolved?: string | null;
  /** The unit the call reaches (`file#path`), or null. */
  target: string | null;
  /** A call into a file of the scan that reaches no unit of it. */
  unresolved: boolean;
  /** The tables whose kept address, or a row holding it, an argument carries. */
  carries: string[];
  /** The functions it sits in, innermost first, by start offset (-1: the file). */
  fns: number[];
  /** Before linking: where an imported call is looked up. */
  ref?: ImportRef;
}

export interface SenderUnit {
  file: string;
  /** The unit's path in its file (see UNITS; '' for the top level). */
  name: string;
  line: number;
  reads: Array<{ table: string; line: number; how: string }>;
  sends: SendSite[];
  localCalls: CallSite[];
  importCalls: CallSite[];
  /** Calls carrying a kept address (or a row holding it) to a callee the scan
   *  cannot place (`name` is the callee as written). */
  unknownCalls: CallSite[];
  /** Answer functions it calls. */
  answers: string[];
  /** Each answer call, with the function it sits in (start offset; -1: the file). */
  answerSites: Array<{ answer: string; home: number }>;
  /** Its own function's start offset (-1 for the top level). */
  start: number;
  aliasSites: Array<{ table: string; name: string; line: number }>;
  /** A kept address put under a key the scan cannot read (`{ [k]: a }`, `o[k] = a`). */
  unreadableKeys: Array<{ table: string; key: string; line: number }>;
  /** A row holding a kept address put into an object that outlives the
   *  function (`this.row = r`, `param.row = r`, an object of the file's top). */
  escapes: Array<{ table: string; target: string; line: number; fns: number[] }>;
  dynamicReads: Array<{ line: number; what: string }>;
  /** By table: it returns the kept address ('value') or a row holding it ('row'). */
  returns: Record<string, 'value' | 'row'>;
}

export interface SenderScanOptions {
  /** The file whose exported functions answer (KeptAddressSpec.answer). */
  answerFile: string;
  /** Files read before (the repository, when plants are added): their exports
   *  and what their functions return are used as they are, and they are not
   *  read again. A source of the same path takes the place of one. */
  known?: SenderFile[];
}

type Decl =
  | { kind: 'function' | 'container'; path: string }
  /** `const x = new Imported(…)`: x is an instance of an import. */
  | { kind: 'via'; file: string | null; name: string };

/** What a file offers to its importers. */
export interface FileExports {
  /** Top-level declarations by local name. */
  decls: Map<string, Decl>;
  /** Exported name → local name. */
  local: Map<string, string>;
  /** Exported name → the file and name it re-exports. */
  reexports: Map<string, { file: string | null; name: string }>;
  /** `export * from …`: the files. */
  stars: Array<string | null>;
  /** Imported local name → the file and name it imports (import, then export). */
  imports: Map<string, { file: string | null; name: string }>;
}

export interface SenderFile {
  file: string;
  units: SenderUnit[];
  exports: FileExports;
  /** Paths two or more units share, with each one's line. */
  duplicates: Array<{ name: string; lines: number[] }>;
  /** A 'use client' module: it runs in the browser. */
  client: boolean;
}

type Carry = 'value' | 'row' | null;

interface ImportBinding {
  module: string;
  file: string | null;
  imported: string;
  namespace: boolean;
  typeOnly: boolean;
}

interface ChainInfo {
  table: string | null;
  tableExpression: string;
  methods: string[];
  /** Each select's first argument: its text when a literal, '*' when there is
   *  none, null when the scan cannot read it. */
  selectArgs: Array<string | null>;
  /** False when the chain could not be followed back to a `.from()`. */
  traced: boolean;
}

interface UnitInfo {
  path: string;
  /** The enclosing unit's path ('' at the top level). */
  scope: string;
  line: number;
  /** Its function's start offset. */
  start: number;
  params: readonly ts.ParameterDeclaration[];
}

/** A class or object a member call can land on: a unit path prefix here, an
 *  import to look up, or a module outside the scan (a package). */
type Owner = { local: string } | { ref: Omit<ImportRef, 'member'> } | { pkg: string };

type Target =
  | { local: string; name: string }
  | { ref: ImportRef; module: string; name: string }
  | { pkg: string; name: string };

/** `a ??= b`, `a ||= b`, `a &&= b`, `a += b`: a keeps what it had and gains what b carries. */
const COMPOUND_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
]);

/** An assignment: `=` or one of COMPOUND_ASSIGNMENTS. */
function isAssignment(n: ts.Node): n is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
      COMPOUND_ASSIGNMENTS.has(n.operatorToken.kind))
  );
}

/**
 * Calls that only compute a value from what they are handed (global
 * functions, members of global objects, global classes with `new`), when the
 * file neither declares nor imports the name: a kept address handed to one
 * goes nowhere but into its result, which carries it on. Anything else whose
 * callee the scan cannot place is reported (unknownCalls).
 */
const PURE_GLOBAL_CALLS: ReadonlySet<string> = new Set([
  'String',
  'Number',
  'Boolean',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  'parseInt',
  'parseFloat',
  'structuredClone',
  'JSON.stringify',
  'JSON.parse',
  'Object.keys',
  'Object.values',
  'Object.entries',
  'Object.fromEntries',
  'Object.freeze',
  'Array.from',
  'Array.isArray',
  'Array.of',
  'Promise.all',
  'Promise.allSettled',
  'Promise.race',
  'Promise.any',
  'Promise.resolve',
  'new Set',
  'new Map',
  'new Date',
  'new Error',
  'new URL',
  'new URLSearchParams',
]);

/** Methods that keep what they are handed in the array, set or map they are
 *  called on: on a local one (made with `[]`, `{}`, `new Set`, `new Map` or
 *  `new Array`), the variable then holds a row. */
const STORE_METHODS: ReadonlySet<string> = new Set(['push', 'unshift', 'splice', 'add', 'set']);

const ARRAY_CALLBACK_METHODS = new Set([
  'map',
  'flatMap',
  'forEach',
  'filter',
  'find',
  'findLast',
  'some',
  'every',
]);

function unwrapAll(node: ts.Expression): ts.Expression {
  let n = unwrapExpression(node);
  while (ts.isAwaitExpression(n)) n = unwrapExpression(n.expression);
  return n;
}

/** `import('m')`: a dynamic import. */
function isImportCall(e: ts.Expression): e is ts.CallExpression {
  return ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function pick(a: Carry, b: Carry): Carry {
  if (a === 'value' || b === 'value') return 'value';
  if (a === 'row' || b === 'row') return 'row';
  return null;
}

function wordIn(text: string, word: string): boolean {
  return new RegExp(`(^|[^\\w$])${word}([^\\w$]|$)`).test(text);
}

const join = (scope: string, name: string) => (scope ? `${scope}>${name}` : name);

function isFunctionValue(e: ts.Expression): e is ts.ArrowFunction | ts.FunctionExpression {
  const x = unwrapExpression(e);
  return ts.isArrowFunction(x) || ts.isFunctionExpression(x);
}

/** The names a binding (a name, or a destructuring pattern) binds. */
function boundNames(b: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(b)) {
    out.add(b.text);
    return;
  }
  for (const el of b.elements) if (ts.isBindingElement(el)) boundNames(el.name, out);
}

/** The names a `var` binds in a function body or a file (not in a function
 *  or class inside it): a `var` belongs to the whole function. */
function hoistedVars(body: ts.Node, out: Set<string>): void {
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.BlockScoped) === 0) {
      for (const d of n.declarations) boundNames(d.name, out);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(body, walk);
}

/** The names a scope node declares itself (an import does not count). */
const declaredNamesMemo = new WeakMap<ts.Node, Set<string>>();
function declaredNames(scope: ts.Node): Set<string> {
  const memo = declaredNamesMemo.get(scope);
  if (memo) return memo;
  const out = new Set<string>();
  if (ts.isFunctionLike(scope)) {
    if (ts.isFunctionExpression(scope) && scope.name) out.add(scope.name.text);
    for (const p of scope.parameters) boundNames(p.name, out);
    const body = (scope as { body?: ts.Node }).body;
    if (body && ts.isBlock(body)) hoistedVars(body, out);
  }
  if (ts.isClassExpression(scope) && scope.name) out.add(scope.name.text);
  if (
    ts.isBlock(scope) ||
    ts.isSourceFile(scope) ||
    ts.isModuleBlock(scope) ||
    ts.isCaseClause(scope) ||
    ts.isDefaultClause(scope)
  ) {
    for (const st of scope.statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) boundNames(d.name, out);
      }
      if (
        (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) &&
        st.name
      ) {
        out.add(st.name.text);
      }
    }
    if (ts.isSourceFile(scope)) hoistedVars(scope, out);
  }
  if (
    (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    for (const d of scope.initializer.declarations) boundNames(d.name, out);
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    boundNames(scope.variableDeclaration.name, out);
  }
  declaredNamesMemo.set(scope, out);
  return out;
}

/** What a function gives back: its expression body, or each `return`'s
 *  expression that is its own (not one of a function inside it). */
function returnedExpressions(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = (fn as { body?: ts.Node }).body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body as ts.Expression];
  const out: ts.Expression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(body, walk);
  return out;
}

function importsOf(
  sf: ts.SourceFile,
  file: string,
  resolveModule: (fromFile: string, specifier: string) => string | null,
): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (!clause) continue;
    const specifier = st.moduleSpecifier.text;
    const resolved = resolveModule(file, specifier);
    const typeOnly = clause.isTypeOnly;
    if (clause.name) {
      out.set(clause.name.text, {
        module: specifier,
        file: resolved,
        imported: 'default',
        namespace: false,
        typeOnly,
      });
    }
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) {
      out.set(nb.name.text, {
        module: specifier,
        file: resolved,
        imported: '*',
        namespace: true,
        typeOnly,
      });
    } else if (nb) {
      for (const el of nb.elements) {
        out.set(el.name.text, {
          module: specifier,
          file: resolved,
          imported: (el.propertyName ?? el.name).text,
          namespace: false,
          typeOnly: typeOnly || el.isTypeOnly,
        });
      }
    }
  }
  return out;
}

/** The file's units, the node each starts at, and its classes and objects. */
function collectUnits(sf: ts.SourceFile) {
  const units: UnitInfo[] = [];
  const unitOf = new Map<ts.Node, UnitInfo>();
  const byPath = new Map<string, UnitInfo>();
  const classes = new Map<ts.Node, string>();
  const containers = new Set<string>();
  const seen = new Map<string, number[]>();

  const add = (path: string, scope: string, fn: ts.SignatureDeclaration, at: ts.Node) => {
    const lines = seen.get(path) ?? [];
    lines.push(nodeLine(sf, at));
    seen.set(path, lines);
    const unique = lines.length === 1 ? path : `${path}#${lines.length}`;
    const u: UnitInfo = {
      path: unique,
      scope,
      line: nodeLine(sf, at),
      start: fn.getStart(sf),
      params: fn.parameters,
    };
    units.push(u);
    unitOf.set(fn, u);
    byPath.set(unique, u);
    return u;
  };
  const memberName = (name: ts.PropertyName) => literalPropertyName(name) ?? '?';

  const walkClass = (cls: ts.ClassLikeDeclaration, name: string, scope: string) => {
    const prefix = join(scope, name);
    classes.set(cls, prefix);
    containers.add(prefix);
    for (const m of cls.members) {
      if (
        (ts.isMethodDeclaration(m) ||
          ts.isGetAccessor(m) ||
          ts.isSetAccessor(m) ||
          ts.isConstructorDeclaration(m)) &&
        m.body
      ) {
        const base = ts.isConstructorDeclaration(m) ? 'constructor' : memberName(m.name);
        const u = add(`${prefix}.${ts.isSetAccessor(m) ? `${base}=` : base}`, scope, m, m);
        ts.forEachChild(m, (c) => walk(c, u.path));
      } else if (ts.isPropertyDeclaration(m) && m.initializer && isFunctionValue(m.initializer)) {
        const fn = unwrapExpression(m.initializer) as ts.ArrowFunction | ts.FunctionExpression;
        const u = add(`${prefix}.${memberName(m.name)}`, scope, fn, m);
        ts.forEachChild(fn, (c) => walk(c, u.path));
      } else {
        ts.forEachChild(m, (c) => walk(c, scope));
      }
    }
  };

  const walk = (n: ts.Node, scope: string): void => {
    if (ts.isFunctionDeclaration(n)) {
      if (!n.body) return; // an overload signature
      const u = add(join(scope, n.name?.text ?? 'default'), scope, n, n);
      ts.forEachChild(n, (c) => walk(c, u.path));
      return;
    }
    if (ts.isClassDeclaration(n)) {
      walkClass(n, n.name?.text ?? 'default', scope);
      return;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrapExpression(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const u = add(join(scope, n.name.text), scope, init, n);
        ts.forEachChild(init, (c) => walk(c, u.path));
        return;
      }
      if (ts.isClassExpression(init)) {
        walkClass(init, n.name.text, scope);
        return;
      }
      if (ts.isObjectLiteralExpression(init)) {
        const prefix = join(scope, n.name.text);
        containers.add(prefix);
        for (const p of init.properties) {
          if (ts.isMethodDeclaration(p) && p.body) {
            const u = add(`${prefix}.${memberName(p.name)}`, scope, p, p);
            ts.forEachChild(p, (c) => walk(c, u.path));
          } else if (ts.isPropertyAssignment(p) && isFunctionValue(p.initializer)) {
            const fn = unwrapExpression(p.initializer) as ts.ArrowFunction | ts.FunctionExpression;
            const u = add(`${prefix}.${memberName(p.name)}`, scope, fn, p);
            ts.forEachChild(fn, (c) => walk(c, u.path));
          } else {
            walk(p, scope);
          }
        }
        return;
      }
    }
    if (ts.isClassExpression(n)) {
      walkClass(n, n.name?.text ?? '(class)', scope);
      return;
    }
    ts.forEachChild(n, (c) => walk(c, scope));
  };
  walk(sf, '');

  const duplicates = [...seen.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([name, lines]) => ({ name, lines }));
  return { units, unitOf, byPath, classes, containers, duplicates };
}

/** The `.from(…)` chain a call ends (followed back through a variable when
 *  `originOf` knows the variable's declaration), an untraced chain when it
 *  selects but reaches no `.from()`, or null. */
function chainOf(
  sf: ts.SourceFile,
  call: ts.CallExpression,
  originOf: (variable: ts.Identifier) => ChainInfo | null,
): ChainInfo | null {
  const methods: string[] = [];
  const selectArgs: Array<string | null> = [];
  let cur: ts.Expression = call;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const name = cur.expression.name.text;
    if (name === 'from') {
      const receiver = unwrapExpression(cur.expression.expression);
      const isStorage = ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'storage';
      const arg = cur.arguments[0];
      if (isStorage || !arg) return null;
      return {
        table: fromTable(sf, arg),
        tableExpression: squashText(arg.getText(sf)),
        methods: methods.reverse(),
        selectArgs: selectArgs.reverse(),
        traced: true,
      };
    }
    // A database function's answer, not a table's rows.
    if (name === 'rpc') return null;
    methods.push(name);
    if (name === 'select') {
      const a = cur.arguments[0] ? unwrapExpression(cur.arguments[0]) : undefined;
      selectArgs.push(
        a === undefined
          ? '*'
          : ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)
            ? a.text
            : null,
      );
    }
    cur = unwrapAll(cur.expression.expression);
  }
  if (ts.isIdentifier(cur)) {
    const origin = originOf(cur);
    if (origin) {
      return {
        ...origin,
        methods: [...origin.methods, ...methods.reverse()],
        selectArgs: [...origin.selectArgs, ...selectArgs.reverse()],
      };
    }
  }
  if (!methods.includes('select')) return null;
  return {
    table: null,
    tableExpression: squashText(cur.getText(sf)),
    methods: methods.reverse(),
    selectArgs: selectArgs.reverse(),
    traced: false,
  };
}

/** Whether a call is the last one of its chain (`a.b().c()` is, `a.b()` in it is not). */
function endsChain(call: ts.CallExpression): boolean {
  const p = call.parent;
  return !(
    p &&
    ts.isPropertyAccessExpression(p) &&
    p.expression === call &&
    p.parent &&
    ts.isCallExpression(p.parent) &&
    p.parent.expression === p
  );
}

/** Whether a chain reads the table's kept address. */
export function chainReadsKeptAddress(chain: ChainInfo, spec: KeptAddressSpec): boolean {
  if (chain.table !== spec.table || !chain.methods.includes('select')) return false;
  const everything = chain.selectArgs.some(
    (a) => a === null || a.trim() === '' || /(^|[\s,(])\*/.test(a),
  );
  const names = chain.selectArgs.some((a) => a !== null && wordIn(a, spec.column));
  if (spec.readBy === 'table') {
    const writes = chain.methods[0] === 'insert' || chain.methods[0] === 'upsert';
    return writes ? everything || names : true;
  }
  return everything || names;
}

interface Taint {
  value: Set<string>;
  row: Set<string>;
}

interface CarryContext {
  sf: ts.SourceFile;
  spec: KeptAddressSpec;
  /** The spec's aliases this file can see. */
  aliases: Set<string>;
  /** Every alias of the spec: read off a row the unit holds, one is the address. */
  allAliases: Set<string>;
  /** The answer a call asks (it reaches the answer file's function), or null. */
  answerOf: (call: ts.CallExpression) => string | null;
  /** What the function a call reaches returns for the spec's table. */
  returnOf: (call: ts.CallExpression) => Carry;
  taint: Taint;
  originOf: (variable: ts.Identifier) => ChainInfo | null;
}

function keyOf(e: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  const k = unwrapExpression(e.argumentExpression);
  return ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k) ? k.text : null;
}

function carry(node: ts.Expression, c: CarryContext): Carry {
  const e = unwrapAll(node);
  if (ts.isIdentifier(e)) {
    if (c.taint.value.has(e.text)) return 'value';
    return c.taint.row.has(e.text) ? 'row' : null;
  }
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const key = keyOf(e);
    const inner = carry(e.expression, c);
    if (key === null) return inner === 'row' ? 'row' : null;
    if (c.spec.readBy === 'column' && key === c.spec.column) return 'value';
    if (c.aliases.has(key)) return 'value';
    if (inner === 'row' && (key === c.spec.column || c.allAliases.has(key))) return 'value';
    if (inner === 'row' && key === 'data') return 'row';
    if (ts.isElementAccessExpression(e) && inner === 'row' && /^\d+$/.test(key)) return 'row';
    return null;
  }
  if (ts.isCallExpression(e)) {
    const chain = endsChain(e) ? chainOf(c.sf, e, c.originOf) : null;
    if (chain && chainReadsKeptAddress(chain, c.spec)) return 'row';
    // An answer says yes or no; it carries nothing on.
    if (c.answerOf(e) !== null) return null;
    const callee = unwrapExpression(e.expression);
    // What the function returns, what it is called on, what it is handed,
    // and what an inline callback handed to it returns.
    let out: Carry = c.returnOf(e);
    if (ts.isPropertyAccessExpression(callee)) out = pick(out, carry(callee.expression, c));
    for (const a of e.arguments) {
      const x = unwrapExpression(a);
      if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) {
        for (const r of returnedExpressions(x)) out = pick(out, carry(r, c));
      } else {
        out = pick(out, carry(a, c));
      }
    }
    return out;
  }
  // What `new X(…)` makes from a kept address holds it, like a call's result.
  if (ts.isNewExpression(e)) {
    let out: Carry = null;
    for (const a of e.arguments ?? []) out = pick(out, carry(a, c));
    return out;
  }
  if (ts.isConditionalExpression(e)) return pick(carry(e.whenTrue, c), carry(e.whenFalse, c));
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.PlusToken ||
      op === ts.SyntaxKind.CommaToken
    ) {
      return pick(carry(e.left, c), carry(e.right, c));
    }
    if (op === ts.SyntaxKind.EqualsToken) return carry(e.right, c);
    if (COMPOUND_ASSIGNMENTS.has(op)) return pick(carry(e.left, c), carry(e.right, c));
    return null;
  }
  if (ts.isTemplateExpression(e)) {
    return e.templateSpans.some((s) => carry(s.expression, c) !== null) ? 'value' : null;
  }
  if (ts.isObjectLiteralExpression(e)) {
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p) && carry(p.initializer, c)) return 'row';
      if (ts.isShorthandPropertyAssignment(p) && carry(p.name, c)) return 'row';
      if (ts.isSpreadAssignment(p) && carry(p.expression, c)) return 'row';
    }
    return null;
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.some((el) => carry(ts.isSpreadElement(el) ? el.expression : el, c))
      ? 'row'
      : null;
  }
  return null;
}

/** Taints the names a binding binds, from what its initializer carries. */
function bind(name: ts.BindingName, init: Carry, c: CarryContext, out: Taint): void {
  if (ts.isIdentifier(name)) {
    if (init === 'value') out.value.add(name.text);
    else if (init === 'row') out.row.add(name.text);
    return;
  }
  if (ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) bind(el.name, init === 'row' ? 'row' : null, c, out);
    }
    return;
  }
  for (const el of name.elements) {
    const key = el.propertyName
      ? literalPropertyName(el.propertyName)
      : ts.isIdentifier(el.name)
        ? el.name.text
        : null;
    let k: Carry = null;
    if (key !== null) {
      if (c.spec.readBy === 'column' && key === c.spec.column) k = 'value';
      else if (c.aliases.has(key)) k = 'value';
      else if (init === 'row' && (key === c.spec.column || c.allAliases.has(key))) k = 'value';
      else if (init === 'row' && key === 'data') k = 'row';
    }
    bind(el.name, k, c, out);
  }
}

/** The member a property or element access names (`x.m`, `x['m']`), or null. */
function memberOf(e: ts.Expression): string | null {
  const x = unwrapExpression(e);
  return ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x) ? keyOf(x) : null;
}

const isSendEmail = (callee: ts.Expression) =>
  (ts.isIdentifier(callee) && callee.text === 'sendEmail') || memberOf(callee) === 'sendEmail';

/** `x.emails.send(…)`, `x['emails']['send'](…)`, or `emails.send(…)` on an
 *  `emails` taken off the client (`const { emails } = resend`). */
const isEmailsSend = (callee: ts.Expression) => {
  const c = unwrapExpression(callee);
  if (memberOf(c) !== 'send') return false;
  const recv = unwrapAll(
    (c as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression,
  );
  return (ts.isIdentifier(recv) && recv.text === 'emails') || memberOf(recv) === 'emails';
};

/** A fetch to the Resend API (its URL is written in the call). */
const isResendFetch = (sf: ts.SourceFile, call: ts.CallExpression) => {
  const callee = unwrapExpression(call.expression);
  return (
    ts.isIdentifier(callee) &&
    callee.text === 'fetch' &&
    call.arguments[0] !== undefined &&
    call.arguments[0].getText(sf).includes('api.resend.com')
  );
};

/** The call (or `new`) whose arguments hold an object literal, through the
 *  objects, arrays and operators around it; null when there is none. */
function argumentOf(obj: ts.ObjectLiteralExpression): ts.CallExpression | ts.NewExpression | null {
  let child: ts.Node = obj;
  for (let n: ts.Node | undefined = obj.parent; n; child = n, n = n.parent) {
    if (
      (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
      n.arguments?.some((a) => a === child)
    ) {
      return n;
    }
    if (
      ts.isObjectLiteralExpression(n) ||
      ts.isArrayLiteralExpression(n) ||
      ts.isPropertyAssignment(n) ||
      ts.isShorthandPropertyAssignment(n) ||
      ts.isSpreadAssignment(n) ||
      ts.isSpreadElement(n) ||
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isSatisfiesExpression(n) ||
      ts.isConditionalExpression(n) ||
      ts.isBinaryExpression(n)
    ) {
      continue;
    }
    return null;
  }
  return null;
}

/** Where a file's calls into other files land, and what those functions return. */
interface SenderEnv {
  answerFile: string;
  /** The unit an import call reaches (`file#path`), through re-exports, or null. */
  resolveImport: (ref: ImportRef) => string | null;
  /** What a unit of another file returns, by table (undefined: no kept address). */
  returnsOf: (id: string) => Record<string, 'value' | 'row'> | undefined;
}

/** For a table read by its chains (readBy 'table'), a call of a function
 *  that returns its kept address or a row holding it is a read of it. */
const READ_BY_RETURN: ReadonlySet<KeptAddressSpec['readBy']> = new Set(['table']);

/** How many times one file's facts are worked out again before the scan gives up. */
const MAX_ROUNDS = 50;

/** One source file, parsed, with what does not depend on other files. */
interface PreparedSenderFile {
  file: string;
  exports: FileExports;
  duplicates: Array<{ name: string; lines: number[] }>;
  unitPaths: string[];
  /** Every import a call of the file lands on, to look up. */
  importRefs: ImportRef[];
  /** The file's units, read with what other files' functions return. */
  evaluate: (env: SenderEnv) => SenderFile;
}

function prepareSenderFile(
  file: string,
  text: string,
  specs: KeptAddressSpec[],
  resolveModule: (fromFile: string, specifier: string) => string | null,
): PreparedSenderFile {
  const sf = parseSource(file, text);
  const imports = importsOf(sf, file, resolveModule);
  const collected = collectUnits(sf);
  const { unitOf, byPath, classes, containers } = collected;
  const answers = new Set(specs.map((s) => s.answer).filter((a): a is string => a !== null));
  // A 'use client' module (its directive prologue says so) runs in the browser.
  let client = false;
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
    if (st.expression.text === 'use client') client = true;
  }

  /** The node that declares `name` where `at` is (a function for a parameter
   *  or a `var`, a block or the file for the rest), or null for a global or
   *  an import. */
  const declaringScope = (at: ts.Node, name: string): ts.Node | null => {
    for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
      if (declaredNames(n).has(name)) return n;
    }
    return null;
  };

  // `const { a, b: c } = await import('m')` and `const m = await import('m')`:
  // import bindings of the scope that declares them.
  const dynamicImports = new Map<ts.Node, Map<string, ImportBinding>>();
  const findDynamicImports = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = unwrapAll(n.initializer);
      const arg = isImportCall(init) ? init.arguments[0] : undefined;
      if (arg && ts.isStringLiteralLike(arg)) {
        const bindName = (name: string, imported: string, namespace: boolean) => {
          const scope = declaringScope(n, name);
          if (!scope) return;
          if (!dynamicImports.has(scope)) dynamicImports.set(scope, new Map());
          dynamicImports.get(scope)!.set(name, {
            module: arg.text,
            file: resolveModule(file, arg.text),
            imported,
            namespace,
            typeOnly: false,
          });
        };
        if (ts.isIdentifier(n.name)) bindName(n.name.text, '*', true);
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
            const imported = el.propertyName ? literalPropertyName(el.propertyName) : el.name.text;
            if (imported !== null) bindName(el.name.text, imported, false);
          }
        }
      }
    }
    ts.forEachChild(n, findDynamicImports);
  };
  findDynamicImports(sf);
  const importedFiles = new Set<string>();
  for (const b of imports.values()) if (b.file) importedFiles.add(b.file);
  for (const m of dynamicImports.values()) {
    for (const b of m.values()) if (b.file) importedFiles.add(b.file);
  }

  /** What an identifier names where it is used: an import (a static one, or
   *  a dynamic import's binding), 'local' (a parameter, variable, function or
   *  class the file declares around it), or null (a global). */
  const bindingAt = (id: ts.Identifier): ImportBinding | 'local' | null => {
    const scope = declaringScope(id, id.text);
    if (scope) return dynamicImports.get(scope)?.get(id.text) ?? 'local';
    return imports.get(id.text) ?? null;
  };
  /** The import an identifier names where it is used (not a type-only one). */
  const importAt = (id: ts.Identifier): ImportBinding | null => {
    const b = bindingAt(id);
    return b !== null && b !== 'local' && !b.typeOnly ? b : null;
  };
  /** A module a receiver is the namespace of: a namespace import (static or
   *  dynamic) or `import('m')` itself (`(await import('m')).f(…)`). */
  const namespaceAt = (e: ts.Expression): { module: string; file: string | null } | null => {
    if (ts.isIdentifier(e)) {
      const b = importAt(e);
      return b?.namespace ? b : null;
    }
    const arg = isImportCall(e) ? e.arguments[0] : undefined;
    return arg && ts.isStringLiteralLike(arg)
      ? { module: arg.text, file: resolveModule(file, arg.text) }
      : null;
  };

  /** The unit a node sits in ('' for the top level). */
  const unitAt = (node: ts.Node): string => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      const u = unitOf.get(n);
      if (u) return u.path;
    }
    return '';
  };
  /** Whether a variable lives only in the unit where `at` is: declared in its
   *  function (not a parameter, which is the caller's object, and not at the
   *  top of the file, which every function shares). */
  const unitLocal = (id: ts.Identifier, owner: string): boolean => {
    const scope = declaringScope(id, id.text);
    if (!scope || ts.isSourceFile(scope)) return false;
    if (ts.isFunctionLike(scope)) {
      const params = new Set<string>();
      for (const p of scope.parameters) boundNames(p.name, params);
      if (params.has(id.text)) return false;
    }
    return unitOf.get(scope)?.path === owner || unitAt(scope) === owner;
  };
  /** The functions a node sits in, innermost first, by start offset, then -1
   *  for the file: an answer guards what sits in the function it is called in. */
  const fnsMemo = new Map<ts.Node, number[]>();
  const fnsAt = (node: ts.Node): number[] => {
    let out = fnsMemo.get(node);
    if (!out) {
      out = [];
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if (ts.isFunctionLike(n)) out.push(n.getStart(sf));
      }
      out.push(-1);
      fnsMemo.set(node, out);
    }
    return out;
  };
  /** A unit's path, then each enclosing unit's, then the top level. */
  const scopeChain = (path: string): string[] => {
    const out: string[] = [];
    for (let p: string | undefined = path; p !== undefined;) {
      out.push(p);
      if (p === '') break;
      p = byPath.get(p)?.scope ?? '';
    }
    return out;
  };
  /** The nearest declaration of a name seen from a unit, among `known`. */
  const lookup = (from: string, name: string, known: (p: string) => boolean): string | null => {
    for (const s of scopeChain(from)) {
      const p = join(s, name);
      if (known(p)) return p;
    }
    return null;
  };
  const classOf = (node: ts.Node): string | null => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      const c = classes.get(n);
      if (c) return c;
    }
    return null;
  };

  // Variables made from an import or a local class (`new X(…)`, `X.factory(…)`).
  const instances = new Map<string, Map<string, Owner>>();
  const ownerOfId = (from: string, id: ts.Identifier): Owner | null => {
    for (const s of scopeChain(from)) {
      const o = instances.get(s)?.get(id.text);
      if (o) return o;
    }
    const b = bindingAt(id);
    if (b !== null && b !== 'local') {
      if (b.typeOnly || b.namespace) return null;
      return b.file ? { ref: { file: b.file, exportName: b.imported } } : { pkg: b.module };
    }
    const local = lookup(from, id.text, (p) => containers.has(p));
    return local ? { local } : null;
  };
  const madeFrom = (from: string, e: ts.Expression): Owner | null => {
    const x = unwrapAll(e);
    let base: ts.Expression | null = null;
    if (ts.isNewExpression(x)) base = unwrapAll(x.expression);
    else if (
      ts.isCallExpression(x) &&
      ts.isPropertyAccessExpression(unwrapExpression(x.expression))
    )
      base = unwrapAll((unwrapExpression(x.expression) as ts.PropertyAccessExpression).expression);
    if (!base) return null;
    if (ts.isIdentifier(base)) return ownerOfId(from, base);
    // ns.Service: a member of a namespace (a namespace import, or import('m')).
    if (ts.isPropertyAccessExpression(base)) {
      const ns = namespaceAt(unwrapAll(base.expression));
      if (ns) {
        return ns.file
          ? { ref: { file: ns.file, exportName: base.name.text } }
          : { pkg: ns.module };
      }
    }
    return null;
  };
  const findInstances = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const owner = unitAt(n);
      const init = unwrapAll(n.initializer);
      // Made from a class (`new X(…)`, `X.factory(…)`), or another name for
      // an instance the file already knows (`const mailer = svc`).
      const o = ts.isIdentifier(init)
        ? (scopeChain(owner)
            .map((s) => instances.get(s)?.get(init.text))
            .find((x) => x !== undefined) ?? null)
        : madeFrom(owner, init);
      if (o) {
        if (!instances.has(owner)) instances.set(owner, new Map());
        instances.get(owner)!.set(n.name.text, o);
      }
    }
    ts.forEachChild(n, findInstances);
  };
  findInstances(sf);

  /** Where a call lands: a local unit, an import to look up, or nowhere. */
  const callTarget = (from: string, call: ts.CallExpression | ts.NewExpression): Target | null => {
    const memberTarget = (o: Owner, member: string, name: string): Target | null => {
      if ('local' in o) {
        const p = `${o.local}.${member}`;
        return byPath.has(p) ? { local: p, name } : null;
      }
      if ('pkg' in o) return { pkg: o.pkg, name };
      const imp = [...imports.values()].find((b) => b.file === o.ref.file);
      return {
        ref: { ...o.ref, member },
        module: imp?.module ?? o.ref.file,
        name,
      };
    };
    if (ts.isNewExpression(call)) {
      const o = madeFrom(from, call);
      return o ? memberTarget(o, 'constructor', 'constructor') : null;
    }
    const callee = unwrapExpression(call.expression);
    if (ts.isIdentifier(callee)) {
      const imp = importAt(callee);
      if (imp && !imp.namespace) {
        return imp.file
          ? {
              ref: { file: imp.file, exportName: imp.imported, member: null },
              module: imp.module,
              name: callee.text,
            }
          : { pkg: imp.module, name: callee.text };
      }
      const local = lookup(from, callee.text, (p) => byPath.has(p));
      return local ? { local, name: callee.text } : null;
    }
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const member = callee.name.text;
    const recv = unwrapAll(callee.expression);
    if (recv.kind === ts.SyntaxKind.ThisKeyword) {
      const cls = classOf(call);
      if (!cls) return null;
      const p = `${cls}.${member}`;
      return byPath.has(p) ? { local: p, name: member } : null;
    }
    // A member of a namespace: a namespace import (static or dynamic), or
    // `(await import('m')).f(…)`.
    const ns = namespaceAt(recv);
    if (ns) {
      return ns.file
        ? {
            ref: { file: ns.file, exportName: member, member: null },
            module: ns.module,
            name: member,
          }
        : { pkg: ns.module, name: member };
    }
    const o = ts.isIdentifier(recv) ? ownerOfId(from, recv) : madeFrom(from, recv);
    return o ? memberTarget(o, member, member) : null;
  };
  /** callTarget from the unit the call sits in, worked out once per call. */
  const targets = new Map<ts.Node, Target | null>();
  const targetOf = (call: ts.CallExpression | ts.NewExpression): Target | null => {
    if (!targets.has(call)) targets.set(call, callTarget(unitAt(call), call));
    return targets.get(call)!;
  };
  /** The parameters of a local unit. */
  const paramsOf = (path: string) => byPath.get(path)?.params ?? [];

  // Query builders kept in variables (`let q = db.from(t)`, `q = q.eq(…)`),
  // by the declaration of each variable, so two variables of one name in two
  // functions of a unit stay apart.
  const origins = new Map<ts.Node, Map<string, ChainInfo[]>>();
  const originOf = (variable: ts.Identifier): ChainInfo | null => {
    const scope = declaringScope(variable, variable.text);
    const list = scope ? origins.get(scope)?.get(variable.text) : undefined;
    if (!list || list.length === 0) return null;
    const tables = new Set(list.map((o) => o.table));
    const last = list[list.length - 1]!;
    return tables.size === 1 ? last : { ...last, table: null };
  };
  const recordOrigins = (n: ts.Node) => {
    let name: ts.Identifier | null = null;
    let init: ts.Expression | null = null;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      name = n.name;
      init = n.initializer;
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left)
    ) {
      name = n.left;
      init = n.right;
    }
    if (name !== null && init !== null) {
      const e = unwrapAll(init);
      const chain = ts.isCallExpression(e) ? chainOf(sf, e, originOf) : null;
      const scope = declaringScope(name, name.text);
      if (chain?.traced && scope) {
        if (!origins.has(scope)) origins.set(scope, new Map());
        const m = origins.get(scope)!;
        m.set(name.text, [...(m.get(name.text) ?? []), chain]);
      }
    }
    ts.forEachChild(n, recordOrigins);
  };
  recordOrigins(sf);

  const importRefs: ImportRef[] = [];
  const findImportRefs = (n: ts.Node) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const t = targetOf(n);
      if (t && 'ref' in t) importRefs.push(t.ref);
    }
    ts.forEachChild(n, findImportRefs);
  };
  findImportRefs(sf);

  const exports = exportsOf(sf, file, resolveModule, collected.units, containers, imports, (e) =>
    madeFrom('', e),
  );

  // Local arrays, objects, sets and maps (`const out = []`, `new Set()`): a
  // store into one (STORE_METHODS) leaves what it is handed in the variable.
  const localContainers = new Map<ts.Node, Set<string>>();
  const findLocalContainers = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrapExpression(n.initializer);
      const made =
        ts.isArrayLiteralExpression(init) ||
        ts.isObjectLiteralExpression(init) ||
        (ts.isNewExpression(init) &&
          ts.isIdentifier(init.expression) &&
          ['Set', 'Map', 'Array'].includes(init.expression.text) &&
          bindingAt(init.expression) === null);
      const scope = made ? declaringScope(n, n.name.text) : null;
      if (scope) {
        if (!localContainers.has(scope)) localContainers.set(scope, new Set());
        localContainers.get(scope)!.add(n.name.text);
      }
    }
    ts.forEachChild(n, findLocalContainers);
  };
  findLocalContainers(sf);
  /** The local container a STORE_METHODS call stores into (`out.push(…)`), or null. */
  const storeInto = (call: ts.CallExpression): ts.Identifier | null => {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || !STORE_METHODS.has(callee.name.text)) return null;
    const recv = unwrapAll(callee.expression);
    if (!ts.isIdentifier(recv)) return null;
    const scope = declaringScope(recv, recv.text);
    return scope && localContainers.get(scope)?.has(recv.text) && unitLocal(recv, unitAt(call))
      ? recv
      : null;
  };
  /** The local variable `Object.assign(x, …)` copies into, or null. */
  const assignInto = (call: ts.CallExpression): ts.Identifier | null => {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'assign') return null;
    const obj = unwrapExpression(callee.expression);
    if (!ts.isIdentifier(obj) || obj.text !== 'Object' || bindingAt(obj) !== null) return null;
    const target = call.arguments[0] ? unwrapAll(call.arguments[0]) : undefined;
    return target && ts.isIdentifier(target) && unitLocal(target, unitAt(call)) ? target : null;
  };
  /** A call of PURE_GLOBAL_CALLS whose name the file neither declares nor imports. */
  const pureGlobal = (call: ts.CallExpression | ts.NewExpression): boolean => {
    const callee = unwrapExpression(call.expression);
    const prefix = ts.isNewExpression(call) ? 'new ' : '';
    if (ts.isIdentifier(callee)) {
      return PURE_GLOBAL_CALLS.has(prefix + callee.text) && bindingAt(callee) === null;
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      return (
        PURE_GLOBAL_CALLS.has(`${prefix}${callee.expression.text}.${callee.name.text}`) &&
        bindingAt(callee.expression) === null
      );
    }
    return false;
  };

  const evaluate = (env: SenderEnv): SenderFile => {
    /** The answer a call asks: the answer file's function of that name it
     *  reaches (in that file itself, or imported however), else null. */
    const answerOf = (call: ts.CallExpression): string | null => {
      const t = targetOf(call);
      if (!t) return null;
      if ('local' in t) return file === env.answerFile && answers.has(t.local) ? t.local : null;
      if (!('ref' in t) || t.ref.member !== null) return null;
      const id = env.resolveImport(t.ref);
      const at = id === null ? -1 : id.indexOf('#');
      if (id === null || id.slice(0, at) !== env.answerFile) return null;
      const name = id.slice(at + 1);
      return answers.has(name) ? name : null;
    };

    const units = new Map<string, SenderUnit>();
    const unit = (path: string): SenderUnit => {
      let u = units.get(path);
      if (!u) {
        u = {
          file,
          name: path,
          line: byPath.get(path)?.line ?? 1,
          reads: [],
          sends: [],
          localCalls: [],
          importCalls: [],
          unknownCalls: [],
          answers: [],
          answerSites: [],
          start: byPath.get(path)?.start ?? -1,
          aliasSites: [],
          unreadableKeys: [],
          escapes: [],
          dynamicReads: [],
          returns: {},
        };
        units.set(path, u);
      }
      return u;
    };
    for (const u of collected.units) unit(u.path);

    // Where each unit asks, before carrying: by answer, the functions its
    // answer calls sit in. An answer guards what sits in the function it is
    // called in (and in the functions inside that one), not a send or a
    // hand-off in another function of the unit.
    const askedIn = new Map<string, Map<string, Set<number>>>();
    const findAnswers = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = answerOf(n);
        if (name !== null) {
          const owner = unitAt(n);
          if (!askedIn.has(owner)) askedIn.set(owner, new Map());
          const homes = askedIn.get(owner)!;
          if (!homes.has(name)) homes.set(name, new Set());
          homes.get(name)!.add(fnsAt(n)[0]!);
        }
      }
      ts.forEachChild(n, findAnswers);
    };
    findAnswers(sf);
    /** Whether `answer` is asked in a function `n` sits in, in its unit. */
    const guardedAt = (owner: string, answer: string | null, n: ts.Node): boolean => {
      const homes = answer === null ? undefined : askedIn.get(owner)?.get(answer);
      return homes !== undefined && fnsAt(n).some((f) => homes.has(f));
    };

    const contexts = specs.map((spec) => ({
      spec,
      aliases: new Set(
        spec.aliases.filter((a) => a.file === file || importedFiles.has(a.file)).map((a) => a.name),
      ),
      allAliases: new Set(spec.aliases.map((a) => a.name)),
      taint: new Map<string, Taint>(),
    }));
    /** What each unit of the file returns, by spec (index of `specs`). */
    const localReturns = new Map<string, Carry[]>();
    const returnOf = (i: number, call: ts.CallExpression): Carry => {
      const t = targetOf(call);
      if (!t) return null;
      if ('local' in t) return localReturns.get(t.local)?.[i] ?? null;
      if (!('ref' in t)) return null;
      const id = env.resolveImport(t.ref);
      return (id === null ? undefined : env.returnsOf(id)?.[specs[i]!.table]) ?? null;
    };
    const ctxFor = (i: number, path: string): CarryContext => {
      const c = contexts[i]!;
      let t = c.taint.get(path);
      if (!t) {
        t = { value: new Set(), row: new Set() };
        c.taint.set(path, t);
      }
      return {
        sf,
        spec: c.spec,
        aliases: c.aliases,
        allAliases: c.allAliases,
        answerOf,
        returnOf: (call) => returnOf(i, call),
        taint: t,
        originOf,
      };
    };
    /** Units handed a kept address by a caller of the file that does not ask. */
    const received = new Map<string, Map<string, Set<string>>>();
    const returned = (path: string, i: number, got: Carry) => {
      if (!got) return;
      const r = localReturns.get(path) ?? specs.map((): Carry => null);
      r[i] = pick(r[i] ?? null, got);
      localReturns.set(path, r);
    };

    // Taint: each unit's own variables, the parameters its callers in this
    // file hand a kept address, and what each unit returns, to a fixpoint.
    const sizes = () =>
      contexts.reduce(
        (n, c) => n + [...c.taint.values()].reduce((m, t) => m + t.value.size + t.row.size, 0),
        0,
      ) +
      [...localReturns.values()].reduce(
        (n, r) => n + r.reduce((m, x) => m + (x === 'value' ? 2 : x === 'row' ? 1 : 0), 0),
        0,
      );
    let settled = false;
    for (let round = 0; round < MAX_ROUNDS && !settled; round++) {
      const before = sizes();
      const visit = (n: ts.Node) => {
        const owner = unitAt(n);
        contexts.forEach((cx, i) => {
          const c = ctxFor(i, owner);
          if (ts.isVariableDeclaration(n) && n.initializer) {
            bind(n.name, carry(n.initializer, c), c, c.taint);
          } else if (isAssignment(n) && ts.isIdentifier(n.left)) {
            bind(n.left, carry(n, c), c, c.taint);
          } else if (
            isAssignment(n) &&
            (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left))
          ) {
            // `o.key = address` on a variable of the unit: o holds it now.
            const base = unwrapAll(n.left.expression);
            if (ts.isIdentifier(base) && unitLocal(base, owner) && carry(n.right, c)) {
              bind(base, 'row', c, c.taint);
            }
          } else if (
            ts.isForOfStatement(n) &&
            ts.isVariableDeclarationList(n.initializer) &&
            n.initializer.declarations[0]
          ) {
            bind(
              n.initializer.declarations[0].name,
              carry(n.expression, c) === 'row' ? 'row' : null,
              c,
              c.taint,
            );
          } else if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            ARRAY_CALLBACK_METHODS.has(n.expression.name.text) &&
            carry(n.expression.expression, c) === 'row'
          ) {
            // An inline callback over rows gets a row (it is part of this
            // unit: anonymous callbacks belong to the unit they sit in).
            const fn = n.arguments[0] ? unwrapExpression(n.arguments[0]) : undefined;
            const param =
              fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
                ? fn.parameters[0]
                : undefined;
            if (param) bind(param.name, 'row', c, c.taint);
          }
          // `out.push(row)`, `Object.assign(x, row)`: the variable holds it now.
          if (ts.isCallExpression(n)) {
            const store = storeInto(n);
            const assign = store ? null : assignInto(n);
            const handed = assign ? n.arguments.slice(1) : n.arguments;
            const into = store ?? assign;
            if (into && handed.some((a) => carry(a, c) !== null)) bind(into, 'row', c, c.taint);
          }
          // What a unit gives back: an arrow's body, or a `return` of its own.
          const self = unitOf.get(n);
          if (self && ts.isArrowFunction(n) && !ts.isBlock(n.body)) {
            returned(self.path, i, carry(n.body, ctxFor(i, self.path)));
          }
          if (ts.isReturnStatement(n) && n.expression) {
            let fn: ts.Node | undefined = n.parent;
            while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
            const u = fn ? unitOf.get(fn) : undefined;
            if (u) returned(u.path, i, carry(n.expression, c));
          }
          if (
            (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
            !guardedAt(owner, cx.spec.answer, n)
          ) {
            const t = targetOf(n);
            if (t && 'local' in t) {
              const params = paramsOf(t.local);
              (n.arguments ?? []).forEach((a, k) => {
                const got = carry(a, c);
                const p = params[k];
                if (!got || !p) return;
                bind(p.name, got, c, ctxFor(i, t.local).taint);
                if (!received.has(t.local)) received.set(t.local, new Map());
                const r = received.get(t.local)!;
                if (!r.has(cx.spec.table)) r.set(cx.spec.table, new Set());
                r.get(cx.spec.table)!.add(owner);
              });
            }
          }
        });
        ts.forEachChild(n, visit);
      };
      visit(sf);
      settled = sizes() === before;
    }
    if (!settled) throw new Error(`the senders scan did not settle in ${file}`);

    // What each unit reads, sends, calls, asks and passes on.
    const visit = (n: ts.Node) => {
      const owner = unitAt(n);
      const u = unit(owner);
      const line = () => nodeLine(sf, n);

      contexts.forEach((cx, i) => {
        const c = ctxFor(i, owner);
        const { spec } = cx;
        if (spec.readBy === 'column') {
          if (
            (ts.isStringLiteral(n) ||
              ts.isNoSubstitutionTemplateLiteral(n) ||
              ts.isTemplateHead(n) ||
              ts.isTemplateMiddle(n) ||
              ts.isTemplateTail(n)) &&
            wordIn(n.text, spec.column) &&
            !(n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n) &&
            !(n.parent && ts.isImportDeclaration(n.parent))
          ) {
            u.reads.push({ table: spec.table, line: line(), how: 'names the column' });
          }
        }
        if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
          const key = keyOf(n);
          if (key !== null && spec.readBy === 'column' && key === spec.column) {
            u.reads.push({ table: spec.table, line: line(), how: 'reads the column' });
          } else if (
            key !== null &&
            (cx.aliases.has(key) || (cx.allAliases.has(key) && carry(n.expression, c) === 'row'))
          ) {
            u.reads.push({ table: spec.table, line: line(), how: `reads the alias ${key}` });
          }
        }
        if (ts.isBindingElement(n)) {
          const key = n.propertyName
            ? literalPropertyName(n.propertyName)
            : ts.isIdentifier(n.name)
              ? n.name.text
              : null;
          // `const { alias } = row`: an alias read off a row the unit holds.
          const decl = n.parent.parent;
          const offRow =
            ts.isVariableDeclaration(decl) &&
            decl.initializer !== undefined &&
            carry(decl.initializer, c) === 'row';
          if (key !== null && spec.readBy === 'column' && key === spec.column) {
            u.reads.push({ table: spec.table, line: line(), how: 'destructures the column' });
          } else if (key !== null && (cx.aliases.has(key) || (cx.allAliases.has(key) && offRow))) {
            u.reads.push({ table: spec.table, line: line(), how: `destructures the alias ${key}` });
          }
        }
        if (ts.isCallExpression(n) && endsChain(n)) {
          const chain = chainOf(sf, n, c.originOf);
          if (chain && chainReadsKeptAddress(chain, spec)) {
            u.reads.push({ table: spec.table, line: line(), how: `selects from ${spec.table}` });
          }
        }
        if (ts.isCallExpression(n) && READ_BY_RETURN.has(spec.readBy) && returnOf(i, n)) {
          u.reads.push({
            table: spec.table,
            line: line(),
            how: `gets it from ${targetOf(n)!.name}()`,
          });
        }
        // The arguments of a send primitive or of an answer: the address there
        // is sent (the unit is checked for that) or asked about, not renamed.
        const safeSink = (obj: ts.ObjectLiteralExpression) => {
          const call = argumentOf(obj);
          if (!call || !ts.isCallExpression(call)) return false;
          const callee = unwrapExpression(call.expression);
          return (
            isSendEmail(callee) ||
            isEmailsSend(callee) ||
            isResendFetch(sf, call) ||
            answerOf(call) !== null
          );
        };
        if (ts.isPropertyAssignment(n) && ts.isObjectLiteralExpression(n.parent)) {
          // `{ [k]: address }`: a computed key is read when it is a literal.
          const computed = ts.isComputedPropertyName(n.name)
            ? unwrapExpression(n.name.expression)
            : null;
          const key =
            computed === null
              ? literalPropertyName(n.name)
              : ts.isStringLiteralLike(computed)
                ? computed.text
                : null;
          if (key !== spec.column && carry(n.initializer, c) === 'value' && !safeSink(n.parent)) {
            if (key !== null) u.aliasSites.push({ table: spec.table, name: key, line: line() });
            else {
              u.unreadableKeys.push({
                table: spec.table,
                key: squashText(n.name.getText(sf)),
                line: line(),
              });
            }
          }
        }
        if (
          ts.isShorthandPropertyAssignment(n) &&
          ts.isObjectLiteralExpression(n.parent) &&
          n.name.text !== spec.column &&
          c.taint.value.has(n.name.text) &&
          !safeSink(n.parent)
        ) {
          u.aliasSites.push({ table: spec.table, name: n.name.text, line: line() });
        }
        // A row holding a kept address put into an object that outlives the
        // function (`this.row = r`, `param.row = r`, a module's object): the
        // scan does not follow it there.
        if (
          isAssignment(n) &&
          (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left)) &&
          carry(n.right, c) === 'row'
        ) {
          const base = unwrapAll(n.left.expression);
          if (!(ts.isIdentifier(base) && unitLocal(base, owner))) {
            u.escapes.push({
              table: spec.table,
              target: squashText(n.left.getText(sf)),
              line: line(),
              fns: fnsAt(n),
            });
          }
        }
        // `o.key = address`, `o[k] = address`, `this.key = address`.
        if (
          isAssignment(n) &&
          (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left)) &&
          carry(n.right, c) === 'value'
        ) {
          const key = keyOf(n.left);
          if (key === null) {
            u.unreadableKeys.push({
              table: spec.table,
              key: squashText(n.left.getText(sf)),
              line: line(),
            });
          } else if (key !== spec.column) {
            u.aliasSites.push({ table: spec.table, name: key, line: line() });
          }
        }
      });

      if (ts.isCallExpression(n) && endsChain(n)) {
        const chain = chainOf(sf, n, originOf);
        if (chain && chain.table === null && chain.methods.includes('select')) {
          u.dynamicReads.push({
            line: line(),
            what: chain.traced
              ? `.from(${chain.tableExpression}), a table the scan cannot read`
              : `${chain.tableExpression}, which the scan cannot trace to a .from()`,
          });
        }
      }
      let sendPrimitive = false;
      if (ts.isCallExpression(n)) {
        const callee = unwrapExpression(n.expression);
        const fns = fnsAt(n);
        if (isSendEmail(callee)) u.sends.push({ line: line(), how: 'sendEmail', fns });
        if (isEmailsSend(callee)) u.sends.push({ line: line(), how: '.emails.send', fns });
        if (isResendFetch(sf, n))
          u.sends.push({ line: line(), how: 'fetch to the Resend API', fns });
        sendPrimitive = isSendEmail(callee) || isEmailsSend(callee) || isResendFetch(sf, n);
        const answer = answerOf(n);
        if (answer !== null) {
          u.answers.push(answer);
          u.answerSites.push({ answer, home: fns[0]! });
        }
      }
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const fns = fnsAt(n);
        const carries = contexts
          .filter((_, i) => (n.arguments ?? []).some((a) => carry(a, ctxFor(i, owner)) !== null))
          .map((cx) => cx.spec.table);
        const t = targetOf(n);
        if (t && 'local' in t) {
          u.localCalls.push({
            line: line(),
            name: t.name,
            target: `${file}#${t.local}`,
            unresolved: false,
            carries,
            fns,
          });
        } else if (t && 'ref' in t) {
          u.importCalls.push({
            line: line(),
            name: t.name,
            module: t.module,
            resolved: t.ref.file,
            target: null,
            unresolved: false,
            carries,
            fns,
            ref: t.ref,
          });
        } else if (t) {
          // A module outside the scan (a package): never sending, never asking.
          u.importCalls.push({
            line: line(),
            name: t.name,
            module: t.pkg,
            resolved: null,
            target: null,
            unresolved: false,
            carries,
            fns,
          });
        } else if (
          carries.length > 0 &&
          !sendPrimitive &&
          !pureGlobal(n) &&
          !(ts.isCallExpression(n) && (storeInto(n) ?? assignInto(n)))
        ) {
          // A callee the scan cannot place: a function kept in a variable or
          // a parameter, a method of an object it cannot place (one a
          // parameter, a field or an unknown call holds), a global.
          const text = squashText(n.expression.getText(sf));
          u.unknownCalls.push({
            line: line(),
            name: `${ts.isNewExpression(n) ? 'new ' : ''}${text.length > 60 ? `${text.slice(0, 57)}...` : text}`,
            target: null,
            unresolved: false,
            carries,
            fns,
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);

    for (const [path, tables] of received) {
      const u = unit(path);
      for (const [table, from] of tables) {
        const callers = [...from].map((f) => (f ? `${f}()` : 'its top level')).sort();
        u.reads.push({ table, line: u.line, how: `is handed it by ${callers.join(', ')}` });
      }
    }
    for (const [path, r] of localReturns) {
      const u = unit(path);
      r.forEach((x, i) => {
        if (x) u.returns[specs[i]!.table] = x;
      });
    }

    return { file, units: [...units.values()], exports, duplicates: collected.duplicates, client };
  };

  return {
    file,
    exports,
    duplicates: collected.duplicates,
    unitPaths: collected.units.map((u) => u.path),
    importRefs,
    evaluate,
  };
}

/** The unit an import reaches (`file#path`), through re-exports, among the
 *  files' exports and units; null when it reaches none. */
function exportResolver(
  exportsByFile: Map<string, FileExports>,
  ids: Set<string>,
): (ref: ImportRef) => string | null {
  const resolveExport = (
    file: string | null,
    name: string,
    seen: Set<string>,
  ): { file: string; kind: 'function' | 'container'; path: string } | null => {
    if (file === null || seen.has(`${file}#${name}`)) return null;
    seen.add(`${file}#${name}`);
    const ex = exportsByFile.get(file);
    if (!ex) return null;
    const localName = ex.local.get(name) ?? (name === 'default' ? null : name);
    if (localName !== null) {
      const d = ex.decls.get(localName);
      if (d && d.kind !== 'via') return { file, kind: d.kind, path: d.path };
      if (d) return resolveExport(d.file, d.name, seen);
      const imp = ex.imports.get(localName);
      if (imp) return resolveExport(imp.file, imp.name, seen);
    }
    const re = ex.reexports.get(name);
    if (re) return resolveExport(re.file, re.name, seen);
    if (name !== 'default') {
      for (const s of ex.stars) {
        const r = resolveExport(s, name, seen);
        if (r) return r;
      }
    }
    return null;
  };
  const memo = new Map<string, string | null>();
  return (ref) => {
    const k = `${ref.file}\n${ref.exportName}\n${ref.member ?? ''}`;
    if (memo.has(k)) return memo.get(k)!;
    let target: string | null = null;
    if (exportsByFile.has(ref.file)) {
      const d = resolveExport(ref.file, ref.exportName, new Set());
      if (d && ref.member === null && d.kind === 'function') target = `${d.file}#${d.path}`;
      if (d && ref.member !== null && d.kind === 'container') {
        target = `${d.file}#${d.path}.${ref.member}`;
      }
      if (target !== null && !ids.has(target)) target = null;
    }
    memo.set(k, target);
    return target;
  };
}

function sameReturns(
  a: Record<string, 'value' | 'row'> | undefined,
  b: Record<string, 'value' | 'row'>,
): boolean {
  const keys = Object.keys(b);
  return Object.keys(a ?? {}).length === keys.length && keys.every((k) => a?.[k] === b[k]);
}

/**
 * Every unit of the given source files, with what it reads, sends, calls,
 * asks, passes on and returns (see the module comment), and what each file
 * exports. A file is read again when a function of another file it calls
 * returns more than before, until nothing changes. Calls into imports are
 * resolved by linkSenderFiles.
 */
export function analyzeSenderFiles(
  sources: ReadonlyArray<{ file: string; text: string }>,
  specs: KeptAddressSpec[],
  resolveModule: (fromFile: string, specifier: string) => string | null,
  options: SenderScanOptions,
): SenderFile[] {
  const paths = new Set(sources.map((s) => s.file));
  const known = (options.known ?? []).filter((f) => !paths.has(f.file));
  const prepared = sources.map((s) => prepareSenderFile(s.file, s.text, specs, resolveModule));
  const exportsByFile = new Map<string, FileExports>();
  for (const f of known) exportsByFile.set(f.file, f.exports);
  for (const p of prepared) exportsByFile.set(p.file, p.exports);
  const ids = new Set<string>([
    ...known.flatMap((f) => f.units.map((u) => `${f.file}#${u.name}`)),
    ...prepared.flatMap((p) => p.unitPaths.map((n) => `${p.file}#${n}`)),
  ]);
  const resolveImport = exportResolver(exportsByFile, ids);
  const summaries = new Map<string, Record<string, 'value' | 'row'>>();
  for (const f of known) {
    for (const u of f.units) {
      if (Object.keys(u.returns).length > 0) summaries.set(`${f.file}#${u.name}`, u.returns);
    }
  }
  const env: SenderEnv = {
    answerFile: options.answerFile,
    resolveImport,
    returnsOf: (id) => summaries.get(id),
  };
  const deps = new Map(
    prepared.map((p) => [
      p,
      new Set(p.importRefs.map(resolveImport).filter((id): id is string => id !== null)),
    ]),
  );
  const results = new Map<string, SenderFile>();
  let pending = prepared;
  for (let round = 0; pending.length > 0; round++) {
    if (round === MAX_ROUNDS) throw new Error('the senders scan did not settle across files');
    const changed = new Set<string>();
    for (const p of pending) {
      const r = p.evaluate(env);
      results.set(p.file, r);
      for (const u of r.units) {
        const id = `${p.file}#${u.name}`;
        if (!sameReturns(summaries.get(id), u.returns)) {
          summaries.set(id, u.returns);
          changed.add(id);
        }
      }
    }
    pending = prepared.filter((p) => [...deps.get(p)!].some((id) => changed.has(id)));
  }
  return prepared.map((p) => results.get(p.file)!);
}

/** What a file offers its importers (top-level declarations and exports). */
function exportsOf(
  sf: ts.SourceFile,
  file: string,
  resolveModule: (fromFile: string, specifier: string) => string | null,
  units: UnitInfo[],
  containers: Set<string>,
  imports: Map<string, ImportBinding>,
  madeFrom: (e: ts.Expression) => Owner | null,
): FileExports {
  const decls = new Map<string, Decl>();
  for (const u of units) {
    if (u.scope === '' && !u.path.includes('.') && !u.path.includes('#')) {
      decls.set(u.path, { kind: 'function', path: u.path });
    }
  }
  for (const c of containers) if (!c.includes('>')) decls.set(c, { kind: 'container', path: c });
  const local = new Map<string, string>();
  const reexports = new Map<string, { file: string | null; name: string }>();
  const stars: Array<string | null> = [];
  const hasExport = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) {
      const name = st.name?.text ?? 'default';
      if (isDefault(st)) local.set('default', name);
      else if (hasExport(st)) local.set(name, name);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (hasExport(st)) local.set(d.name.text, d.name.text);
        if (d.initializer && !decls.has(d.name.text)) {
          const o = madeFrom(d.initializer);
          if (o && 'local' in o) decls.set(d.name.text, { kind: 'container', path: o.local });
          else if (o && 'ref' in o) {
            decls.set(d.name.text, { kind: 'via', file: o.ref.file, name: o.ref.exportName });
          }
        }
      }
    } else if (ts.isExportAssignment(st) && !st.isExportEquals) {
      const e = unwrapExpression(st.expression);
      if (ts.isIdentifier(e)) local.set('default', e.text);
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      const from =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? resolveModule(file, st.moduleSpecifier.text)
          : undefined;
      if (!st.exportClause) {
        if (from !== undefined) stars.push(from);
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          if (el.isTypeOnly) continue;
          const exported = el.name.text;
          const inner = (el.propertyName ?? el.name).text;
          if (from !== undefined) reexports.set(exported, { file: from, name: inner });
          else local.set(exported, inner);
        }
      }
    }
  }
  const importMap = new Map<string, { file: string | null; name: string }>();
  for (const [name, b] of imports) {
    if (!b.typeOnly && !b.namespace) importMap.set(name, { file: b.file, name: b.imported });
  }
  return { decls, local, reexports, stars, imports: importMap };
}

/**
 * Every unit of the given files, with each call into an import resolved to
 * the unit it reaches (`target`), or marked unresolved when it lands in a
 * file of the scan on nothing the scan knows. The files are not changed.
 */
export function linkSenderFiles(files: SenderFile[]): SenderUnit[] {
  const exportsByFile = new Map(files.map((f) => [f.file, f.exports]));
  const ids = new Set(files.flatMap((f) => f.units.map((u) => `${f.file}#${u.name}`)));
  const resolve = exportResolver(exportsByFile, ids);
  const link = (c: CallSite): CallSite => {
    if (!c.ref) return c;
    if (!exportsByFile.has(c.ref.file)) return { ...c, target: null, unresolved: false };
    const target = resolve(c.ref);
    return target !== null
      ? { ...c, target, unresolved: false }
      : { ...c, target: null, unresolved: true };
  };
  return files.flatMap((f) => f.units.map((u) => ({ ...u, importCalls: u.importCalls.map(link) })));
}
