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
 * which says why it matters. analyzeSenderFile reads one source file;
 * linkSenderFiles then resolves the calls between files.
 *
 * UNITS. Every function with a body is its own unit, named by its path in the
 * file: `name` (a function declaration, or a function or arrow assigned to a
 * variable), `Class.member` (a method, accessor, constructor or function-valued
 * property; a setter is `Class.name=`), `object.key` (a function in an object
 * literal assigned to a variable) and `outer>inner` for one declared inside
 * another. An anonymous callback belongs to the unit it sits in; '' is the
 * file's top level. Two units with the same path in one file are reported
 * (duplicates), since nothing could tell their calls apart.
 *
 * For each unit:
 *   - READS: a kept column named in its code (a select list, `row.column`,
 *     `row['column']`, a destructured `{ column }`; never an object key being
 *     written), for a table whose kept column has a name of its own; an alias
 *     of a kept address where the alias can be seen (the file that makes it,
 *     or a file that imports that file); a `.from(table)` chain with a
 *     select, the chain followed back through the unit's variables
 *     (`let q = db.from(t); q = q.select(…)`); and a kept address (or a row
 *     holding it) handed to it by a function of the same file that does not
 *     ask (RECEIVED). For a table read by its chains (its column has a common
 *     name), any select counts but an insert's or upsert's that names no kept
 *     column; for every table, selecting `*`, nothing, or a list the scan
 *     cannot read counts.
 *   - SENDS: sendEmail(…) under any receiver, a `.emails.send(…)` member call
 *     and a fetch to the Resend API.
 *   - CALLS, each with the tables whose kept address (or a row holding it) an
 *     argument carries: of the file's own units (an identifier resolved to
 *     the nearest enclosing declaration of that name, `this.m(…)` in a class,
 *     a member of a local class or object, or of an instance made from a
 *     local class), and of imports (a named, default or namespace import, a
 *     member of an imported class or object, or of an instance made from an
 *     imported class with `new X(…)` or `X.factory(…)`, or made in place).
 *     An import is resolved by linkSenderFiles to `Class.member` or
 *     `object.key` in the file that declares it, through re-exports
 *     (`export { a as b } from`, `export * from`, import then export). A call
 *     into a file of the scan that reaches no unit is marked unresolved.
 *     `new X(…)` is a call of X's constructor.
 *   - ANSWERS: the answer functions it calls (by name).
 *   - ALIAS SITES: an object key whose value is a kept address itself (not a
 *     row that holds it), wherever the object is, but in the arguments of an
 *     answer function or of a send primitive (sendEmail, `.emails.send`,
 *     fetch).
 *   - DYNAMIC READS: a select through a `.from()` whose table the scan cannot
 *     read (a variable, an imported constant), and a `.select(…)` whose chain
 *     cannot be traced back to a `.from()` at all.
 * Carrying is followed through the unit's own variables, assignments,
 * `for … of` loops and inline array callbacks: a value read off a row, or
 * made from one by a call, a method, a conditional, `??`, `||`, `+` or a
 * template, carries the address; a read's result, its `data`, an element of
 * it and objects or arrays built from it carry the row. A unit's parameters
 * carry what a caller in the same file that does not ask hands them;
 * a caller in another file is checked at its own call (a hand-off).
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
  /** Answer functions it calls. */
  answers: string[];
  aliasSites: Array<{ table: string; name: string; line: number }>;
  dynamicReads: Array<{ line: number; what: string }>;
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
  params: readonly ts.ParameterDeclaration[];
}

/** A class or object a member call can land on: a unit path prefix here, an
 *  import to look up, or a module outside the scan (a package). */
type Owner = { local: string } | { ref: Omit<ImportRef, 'member'> } | { pkg: string };

type Target =
  | { local: string; name: string }
  | { ref: ImportRef; module: string; name: string }
  | { pkg: string; name: string };

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
    const u: UnitInfo = { path: unique, scope, line: nodeLine(sf, at), params: fn.parameters };
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
 *  `originOf` knows it), an untraced chain when it selects but reaches no
 *  `.from()`, or null. */
function chainOf(
  sf: ts.SourceFile,
  call: ts.CallExpression,
  originOf: (name: string) => ChainInfo | null,
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
    const origin = originOf(cur.text);
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
  /** Every spec's answer function. */
  answers: Set<string>;
  taint: Taint;
  originOf: (name: string) => ChainInfo | null;
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
    if (inner === 'row' && key === c.spec.column) return 'value';
    if (inner === 'row' && key === 'data') return 'row';
    if (ts.isElementAccessExpression(e) && inner === 'row' && /^\d+$/.test(key)) return 'row';
    return null;
  }
  if (ts.isCallExpression(e)) {
    const chain = endsChain(e) ? chainOf(c.sf, e, c.originOf) : null;
    if (chain && chainReadsKeptAddress(chain, c.spec)) return 'row';
    const callee = unwrapExpression(e.expression);
    // An answer says yes or no; it carries nothing on.
    if (ts.isIdentifier(callee) && c.answers.has(callee.text)) return null;
    let out: Carry = null;
    if (ts.isPropertyAccessExpression(callee)) out = carry(callee.expression, c);
    for (const a of e.arguments) out = pick(out, carry(a, c));
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
      else if (init === 'row' && key === c.spec.column) k = 'value';
      else if (init === 'row' && key === 'data') k = 'row';
    }
    bind(el.name, k, c, out);
  }
}

const isSendEmail = (callee: ts.Expression) =>
  (ts.isIdentifier(callee) && callee.text === 'sendEmail') ||
  (ts.isPropertyAccessExpression(callee) && callee.name.text === 'sendEmail');

const isEmailsSend = (callee: ts.Expression) =>
  ts.isPropertyAccessExpression(callee) &&
  callee.name.text === 'send' &&
  ts.isPropertyAccessExpression(unwrapExpression(callee.expression)) &&
  (unwrapExpression(callee.expression) as ts.PropertyAccessExpression).name.text === 'emails';

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

/**
 * Every unit of one source file, with what it reads, sends, calls, asks and
 * passes on (see the module comment), and what the file exports. Calls into
 * imports are resolved by linkSenderFiles.
 */
export function analyzeSenderFile(
  file: string,
  text: string,
  specs: KeptAddressSpec[],
  resolveModule: (fromFile: string, specifier: string) => string | null,
): SenderFile {
  const sf = parseSource(file, text);
  const imports = importsOf(sf, file, resolveModule);
  const collected = collectUnits(sf);
  const { unitOf, byPath, classes, containers } = collected;
  const importedFiles = new Set<string>();
  for (const b of imports.values()) if (b.file) importedFiles.add(b.file);
  const answers = new Set(specs.map((s) => s.answer).filter((a): a is string => a !== null));

  /** The unit a node sits in ('' for the top level). */
  const unitAt = (node: ts.Node): string => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      const u = unitOf.get(n);
      if (u) return u.path;
    }
    return '';
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
        answers: [],
        aliasSites: [],
        dynamicReads: [],
      };
      units.set(path, u);
    }
    return u;
  };
  for (const u of collected.units) unit(u.path);

  // Who asks (by unit), before carrying: a unit that asks hands nothing on.
  const asked = new Map<string, Set<string>>();
  const findAnswers = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = unwrapExpression(n.expression);
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name !== null && answers.has(name)) {
        const owner = unitAt(n);
        if (!asked.has(owner)) asked.set(owner, new Set());
        asked.get(owner)!.add(name);
      }
    }
    ts.forEachChild(n, findAnswers);
  };
  findAnswers(sf);

  // Variables made from an import or a local class (`new X(…)`, `X.factory(…)`).
  const instances = new Map<string, Map<string, Owner>>();
  const ownerOfName = (from: string, name: string): Owner | null => {
    for (const s of scopeChain(from)) {
      const o = instances.get(s)?.get(name);
      if (o) return o;
    }
    const imp = imports.get(name);
    if (imp && !imp.typeOnly && !imp.namespace) {
      return imp.file ? { ref: { file: imp.file, exportName: imp.imported } } : { pkg: imp.module };
    }
    const local = lookup(from, name, (p) => containers.has(p));
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
    if (ts.isIdentifier(base)) return ownerOfName(from, base.text);
    // ns.Service: a member of a namespace import.
    if (ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.expression)) {
      const imp = imports.get(base.expression.text);
      if (imp?.namespace && !imp.typeOnly) {
        return imp.file
          ? { ref: { file: imp.file, exportName: base.name.text } }
          : { pkg: imp.module };
      }
    }
    return null;
  };
  const findInstances = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const owner = unitAt(n);
      const o = madeFrom(owner, n.initializer);
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
      const imp = imports.get(callee.text);
      if (imp && !imp.namespace && !imp.typeOnly) {
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
    if (ts.isIdentifier(recv)) {
      const imp = imports.get(recv.text);
      if (imp?.namespace && !imp.typeOnly) {
        return imp.file
          ? {
              ref: { file: imp.file, exportName: member, member: null },
              module: imp.module,
              name: member,
            }
          : { pkg: imp.module, name: member };
      }
      const o = ownerOfName(from, recv.text);
      return o ? memberTarget(o, member, member) : null;
    }
    const o = madeFrom(from, recv);
    return o ? memberTarget(o, member, member) : null;
  };
  /** The parameters of a local unit. */
  const paramsOf = (path: string) => byPath.get(path)?.params ?? [];

  const contexts = specs.map((spec) => ({
    spec,
    aliases: new Set(
      spec.aliases.filter((a) => a.file === file || importedFiles.has(a.file)).map((a) => a.name),
    ),
    taint: new Map<string, Taint>(),
  }));
  // Query builders kept in variables: `let q = db.from(t)`, `q = q.eq(…)`.
  const origins = new Map<string, Map<string, ChainInfo[]>>();
  const originOfIn =
    (from: string) =>
    (name: string): ChainInfo | null => {
      for (const s of scopeChain(from)) {
        const list = origins.get(s)?.get(name);
        if (list && list.length > 0) {
          const tables = new Set(list.map((o) => o.table));
          const last = list[list.length - 1]!;
          return tables.size === 1 ? last : { ...last, table: null };
        }
      }
      return null;
    };
  const recordOrigins = (n: ts.Node) => {
    let name: string | null = null;
    let init: ts.Expression | null = null;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      name = n.name.text;
      init = n.initializer;
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left)
    ) {
      name = n.left.text;
      init = n.right;
    }
    if (name !== null && init !== null) {
      const e = unwrapAll(init);
      const owner = unitAt(n);
      const chain = ts.isCallExpression(e) ? chainOf(sf, e, originOfIn(owner)) : null;
      if (chain?.traced) {
        if (!origins.has(owner)) origins.set(owner, new Map());
        const m = origins.get(owner)!;
        m.set(name, [...(m.get(name) ?? []), chain]);
      }
    }
    ts.forEachChild(n, recordOrigins);
  };
  recordOrigins(sf);

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
      answers,
      taint: t,
      originOf: originOfIn(path),
    };
  };
  /** Units handed a kept address by a caller of the file that does not ask. */
  const received = new Map<string, Map<string, Set<string>>>();

  // Taint: each unit's own variables, and the parameters its callers in this
  // file hand a kept address, to a fixpoint.
  const sizes = () =>
    contexts.reduce(
      (n, c) => n + [...c.taint.values()].reduce((m, t) => m + t.value.size + t.row.size, 0),
      0,
    );
  for (let round = 0; round < 20; round++) {
    const before = sizes();
    const visit = (n: ts.Node) => {
      const owner = unitAt(n);
      contexts.forEach((cx, i) => {
        const c = ctxFor(i, owner);
        if (ts.isVariableDeclaration(n) && n.initializer) {
          bind(n.name, carry(n.initializer, c), c, c.taint);
        } else if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left)
        ) {
          bind(n.left, carry(n.right, c), c, c.taint);
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
        if (
          (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
          !(cx.spec.answer && asked.get(owner)?.has(cx.spec.answer))
        ) {
          const t = callTarget(owner, n);
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
    if (sizes() === before) break;
  }

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
        } else if (key !== null && cx.aliases.has(key)) {
          u.reads.push({ table: spec.table, line: line(), how: `reads the alias ${key}` });
        }
      }
      if (ts.isBindingElement(n)) {
        const key = n.propertyName
          ? literalPropertyName(n.propertyName)
          : ts.isIdentifier(n.name)
            ? n.name.text
            : null;
        if (key !== null && spec.readBy === 'column' && key === spec.column) {
          u.reads.push({ table: spec.table, line: line(), how: 'destructures the column' });
        } else if (key !== null && cx.aliases.has(key)) {
          u.reads.push({ table: spec.table, line: line(), how: `destructures the alias ${key}` });
        }
      }
      if (ts.isCallExpression(n) && endsChain(n)) {
        const chain = chainOf(sf, n, c.originOf);
        if (chain && chainReadsKeptAddress(chain, spec)) {
          u.reads.push({ table: spec.table, line: line(), how: `selects from ${spec.table}` });
        }
      }
      const safeSink = (obj: ts.ObjectLiteralExpression) => {
        const call = argumentOf(obj);
        if (!call || !ts.isCallExpression(call)) return false;
        const callee = unwrapExpression(call.expression);
        return (
          isSendEmail(callee) ||
          isEmailsSend(callee) ||
          (ts.isIdentifier(callee) && (callee.text === 'fetch' || answers.has(callee.text)))
        );
      };
      if (ts.isPropertyAssignment(n) && ts.isObjectLiteralExpression(n.parent)) {
        const key = literalPropertyName(n.name);
        if (
          key !== null &&
          key !== spec.column &&
          carry(n.initializer, c) === 'value' &&
          !safeSink(n.parent)
        ) {
          u.aliasSites.push({ table: spec.table, name: key, line: line() });
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
    });

    if (ts.isCallExpression(n) && endsChain(n)) {
      const chain = chainOf(sf, n, originOfIn(owner));
      if (chain && chain.table === null && chain.methods.includes('select')) {
        u.dynamicReads.push({
          line: line(),
          what: chain.traced
            ? `.from(${chain.tableExpression}), a table the scan cannot read`
            : `${chain.tableExpression}, which the scan cannot trace to a .from()`,
        });
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrapExpression(n.expression);
      if (isSendEmail(callee)) u.sends.push({ line: line(), how: 'sendEmail' });
      if (isEmailsSend(callee)) u.sends.push({ line: line(), how: '.emails.send' });
      if (
        ts.isIdentifier(callee) &&
        callee.text === 'fetch' &&
        n.arguments[0] &&
        n.arguments[0].getText(sf).includes('api.resend.com')
      ) {
        u.sends.push({ line: line(), how: 'fetch to the Resend API' });
      }
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (calleeName !== null && answers.has(calleeName)) u.answers.push(calleeName);
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const carries = contexts
        .filter((_, i) => (n.arguments ?? []).some((a) => carry(a, ctxFor(i, owner)) !== null))
        .map((cx) => cx.spec.table);
      const t = callTarget(owner, n);
      if (t && 'local' in t) {
        u.localCalls.push({
          line: line(),
          name: t.name,
          target: `${file}#${t.local}`,
          unresolved: false,
          carries,
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

  return {
    file,
    units: [...units.values()],
    exports: exportsOf(sf, file, resolveModule, collected.units, containers, imports, (e) =>
      madeFrom('', e),
    ),
    duplicates: collected.duplicates,
  };
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
  const byFile = new Map(files.map((f) => [f.file, f]));
  const ids = new Set(files.flatMap((f) => f.units.map((u) => `${f.file}#${u.name}`)));
  const resolveExport = (
    file: string | null,
    name: string,
    seen: Set<string>,
  ): { file: string; kind: 'function' | 'container'; path: string } | null => {
    if (file === null || seen.has(`${file}#${name}`)) return null;
    seen.add(`${file}#${name}`);
    const f = byFile.get(file);
    if (!f) return null;
    const ex = f.exports;
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
  const link = (c: CallSite): CallSite => {
    if (!c.ref) return c;
    if (!byFile.has(c.ref.file)) return { ...c, target: null, unresolved: false };
    const d = resolveExport(c.ref.file, c.ref.exportName, new Set());
    let target: string | null = null;
    if (d && c.ref.member === null && d.kind === 'function') target = `${d.file}#${d.path}`;
    if (d && c.ref.member !== null && d.kind === 'container') {
      target = `${d.file}#${d.path}.${c.ref.member}`;
    }
    if (target !== null && ids.has(target)) return { ...c, target, unresolved: false };
    return { ...c, target: null, unresolved: true };
  };
  return files.flatMap((f) => f.units.map((u) => ({ ...u, importCalls: u.importCalls.map(link) })));
}
