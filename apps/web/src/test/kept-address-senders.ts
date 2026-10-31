import ts from 'typescript';

import {
  enclosingFunctionName,
  fromTable,
  literalPropertyName,
  nodeLine,
  parseSource,
  squashText,
  unwrapExpression,
} from './kept-address-owners';

/**
 * The senders scan for `src/server/lib/kept-address-senders.guard.test.ts`,
 * which says why it matters. For one source file it reports, for each named
 * function (the unit enclosingFunctionName names: a function declaration, a
 * method, or a function assigned to a variable; an anonymous callback belongs
 * to the function it sits in, and '' is the file's top level):
 *   - READS: the kept addresses it reads. A kept column named in its code (a
 *     select list, `row.column`, `row['column']`, a destructured `{ column }`;
 *     never an object key being written), for a table whose kept column has
 *     a name of its own; an alias of a kept address where the alias can be
 *     seen (the file that makes it, or a file that imports that file); and a
 *     `.from(table)` chain with a select. For a table read by its chains (its
 *     column has a common name), any select counts but an insert's or
 *     upsert's that names no kept column; for every table, selecting `*`,
 *     nothing, or a list the scan cannot read counts.
 *   - SENDS: its calls that send directly: sendEmail(…) under any receiver,
 *     a `.emails.send(…)` member call, and a fetch to the Resend API.
 *   - its calls of functions of the same file (by name, and `this.name(…)`)
 *     and of imported functions (named and namespace imports), each with the
 *     tables whose kept address, or a row holding it, an argument carries;
 *   - the answer functions it calls (by name);
 *   - ALIAS SITES: an object key whose value is a kept address (the address
 *     itself, not a row that holds it), outside every call's arguments;
 *   - its selects through a `.from()` whose table the scan cannot read.
 * Carrying is followed through the function's own variables, assignments,
 * `for … of` loops and inline array callbacks: a value read off a row, or
 * made from one by a call, a method, a conditional, `??`, `||`, `+` or a
 * template, carries the address; a read's result, its `data`, an element of
 * it and objects or arrays built from it carry the row. A function's own
 * parameters carry nothing: the caller that hands a kept address over is the
 * one checked.
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
   *  file and function that make it. */
  aliases: Array<{ name: string; file: string; enclosing: string }>;
  answer: string | null;
}

export interface SendSite {
  line: number;
  how: string;
}

export interface CallSite {
  line: number;
  /** The name called (the local name of an import). */
  name: string;
  /** For an import: the module as written, the file it resolves to (null
   *  when it is outside the scan, such as a package) and the imported name. */
  module?: string;
  resolved?: string | null;
  imported?: string;
  /** The tables whose kept address, or a row holding it, an argument carries. */
  carries: string[];
}

export interface SenderUnit {
  file: string;
  /** The function's name ('' for the top level). */
  name: string;
  line: number;
  reads: Array<{ table: string; line: number; how: string }>;
  sends: SendSite[];
  localCalls: CallSite[];
  importCalls: CallSite[];
  /** Answer functions it calls. */
  answers: string[];
  aliasSites: Array<{ table: string; name: string; line: number }>;
  dynamicReads: Array<{ line: number; tableExpression: string }>;
}

type Carry = 'value' | 'row' | null;

interface ImportBinding {
  module: string;
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
}

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

function importsOf(sf: ts.SourceFile): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (!clause) continue;
    const specifier = st.moduleSpecifier.text;
    const typeOnly = clause.isTypeOnly;
    if (clause.name) {
      out.set(clause.name.text, {
        module: specifier,
        imported: 'default',
        namespace: false,
        typeOnly,
      });
    }
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) {
      out.set(nb.name.text, { module: specifier, imported: '*', namespace: true, typeOnly });
    } else if (nb) {
      for (const el of nb.elements) {
        out.set(el.name.text, {
          module: specifier,
          imported: (el.propertyName ?? el.name).text,
          namespace: false,
          typeOnly: typeOnly || el.isTypeOnly,
        });
      }
    }
  }
  return out;
}

/** The names of the file's own functions (the units), with where each starts. */
function unitDeclarations(sf: ts.SourceFile): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (n: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n)) &&
      n.name
    ) {
      const name = literalPropertyName(n.name);
      if (name && !out.has(name)) out.set(name, nodeLine(sf, n));
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(unwrapExpression(n.initializer)) ||
        ts.isFunctionExpression(unwrapExpression(n.initializer)))
    ) {
      if (!out.has(n.name.text)) out.set(n.name.text, nodeLine(sf, n));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The `.from(…)` chain a call ends, or null when it ends none. */
function chainOf(sf: ts.SourceFile, call: ts.CallExpression): ChainInfo | null {
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
      };
    }
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
    cur = unwrapExpression(cur.expression.expression);
  }
  return null;
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
    const chain = endsChain(e) ? chainOf(c.sf, e) : null;
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

/** Whether an object literal sits in some call's (or `new`'s) arguments. */
function inCallArguments(obj: ts.ObjectLiteralExpression): boolean {
  let child: ts.Node = obj;
  for (let n: ts.Node | undefined = obj.parent; n; child = n, n = n.parent) {
    if (
      (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
      n.arguments?.some((a) => a === child)
    ) {
      return true;
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
    return false;
  }
  return false;
}

/**
 * Every named function of one source file, with what it reads, sends, calls,
 * asks and passes on (see the module comment).
 */
export function analyzeSenderFile(
  file: string,
  text: string,
  specs: KeptAddressSpec[],
  resolveModule: (fromFile: string, specifier: string) => string | null,
): SenderUnit[] {
  const sf = parseSource(file, text);
  const imports = importsOf(sf);
  const declared = unitDeclarations(sf);
  const importedFiles = new Set<string>();
  for (const b of imports.values()) {
    const r = resolveModule(file, b.module);
    if (r) importedFiles.add(r);
  }
  const answers = new Set(specs.map((s) => s.answer).filter((a): a is string => a !== null));
  const units = new Map<string, SenderUnit>();
  const unit = (name: string): SenderUnit => {
    let u = units.get(name);
    if (!u) {
      u = {
        file,
        name,
        line: declared.get(name) ?? 1,
        reads: [],
        sends: [],
        localCalls: [],
        importCalls: [],
        answers: [],
        aliasSites: [],
        dynamicReads: [],
      };
      units.set(name, u);
    }
    return u;
  };
  for (const name of declared.keys()) unit(name);

  const contexts = specs.map((spec) => ({
    spec,
    aliases: new Set(
      spec.aliases.filter((a) => a.file === file || importedFiles.has(a.file)).map((a) => a.name),
    ),
    taint: new Map<string, Taint>(),
  }));
  const ctxFor = (i: number, unitName: string): CarryContext => {
    const c = contexts[i]!;
    let t = c.taint.get(unitName);
    if (!t) {
      t = { value: new Set(), row: new Set() };
      c.taint.set(unitName, t);
    }
    return { sf, spec: c.spec, aliases: c.aliases, answers, taint: t };
  };

  // Taint: the function's own variables, to a fixpoint.
  const sizes = () =>
    contexts.reduce(
      (n, c) => n + [...c.taint.values()].reduce((m, t) => m + t.value.size + t.row.size, 0),
      0,
    );
  for (let round = 0; round < 20; round++) {
    const before = sizes();
    const visit = (n: ts.Node) => {
      const owner = enclosingFunctionName(n);
      contexts.forEach((_, i) => {
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
          // function: enclosingFunctionName folds anonymous callbacks in).
          const fn = n.arguments[0] ? unwrapExpression(n.arguments[0]) : undefined;
          const param =
            fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
              ? fn.parameters[0]
              : undefined;
          if (param) bind(param.name, 'row', c, c.taint);
        }
      });
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (sizes() === before) break;
  }

  // What each function reads, sends, calls, asks and passes on.
  const visit = (n: ts.Node) => {
    const owner = enclosingFunctionName(n);
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
        const chain = chainOf(sf, n);
        if (chain && chainReadsKeptAddress(chain, spec)) {
          u.reads.push({ table: spec.table, line: line(), how: `selects from ${spec.table}` });
        }
      }
      if (ts.isPropertyAssignment(n) && ts.isObjectLiteralExpression(n.parent)) {
        const key = literalPropertyName(n.name);
        if (
          key !== null &&
          key !== spec.column &&
          carry(n.initializer, c) === 'value' &&
          !inCallArguments(n.parent)
        ) {
          u.aliasSites.push({ table: spec.table, name: key, line: line() });
        }
      }
      if (
        ts.isShorthandPropertyAssignment(n) &&
        ts.isObjectLiteralExpression(n.parent) &&
        n.name.text !== spec.column &&
        c.taint.value.has(n.name.text) &&
        !inCallArguments(n.parent)
      ) {
        u.aliasSites.push({ table: spec.table, name: n.name.text, line: line() });
      }
    });

    if (ts.isCallExpression(n)) {
      if (endsChain(n)) {
        const chain = chainOf(sf, n);
        if (chain && chain.table === null && chain.methods.includes('select')) {
          u.dynamicReads.push({ line: line(), tableExpression: chain.tableExpression });
        }
      }
      const callee = unwrapExpression(n.expression);
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (calleeName === 'sendEmail') u.sends.push({ line: line(), how: 'sendEmail' });
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'send' &&
        ts.isPropertyAccessExpression(unwrapExpression(callee.expression)) &&
        (unwrapExpression(callee.expression) as ts.PropertyAccessExpression).name.text === 'emails'
      ) {
        u.sends.push({ line: line(), how: '.emails.send' });
      }
      if (
        calleeName === 'fetch' &&
        n.arguments[0] &&
        n.arguments[0].getText(sf).includes('api.resend.com')
      ) {
        u.sends.push({ line: line(), how: 'fetch to the Resend API' });
      }
      if (calleeName !== null && answers.has(calleeName)) u.answers.push(calleeName);

      const carries = contexts
        .filter((_, i) => n.arguments.some((a) => carry(a, ctxFor(i, owner)) !== null))
        .map((cx) => cx.spec.table);
      if (ts.isIdentifier(callee)) {
        const imp = imports.get(callee.text);
        if (imp && !imp.namespace && !imp.typeOnly) {
          u.importCalls.push({
            line: line(),
            name: callee.text,
            module: imp.module,
            resolved: resolveModule(file, imp.module),
            imported: imp.imported,
            carries,
          });
        } else if (!imp && declared.has(callee.text)) {
          u.localCalls.push({ line: line(), name: callee.text, carries });
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const recv = unwrapExpression(callee.expression);
        if (recv.kind === ts.SyntaxKind.ThisKeyword) {
          u.localCalls.push({ line: line(), name: callee.name.text, carries });
        } else if (ts.isIdentifier(recv)) {
          const imp = imports.get(recv.text);
          if (imp && imp.namespace && !imp.typeOnly) {
            u.importCalls.push({
              line: line(),
              name: callee.name.text,
              module: imp.module,
              resolved: resolveModule(file, imp.module),
              imported: callee.name.text,
              carries,
            });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...units.values()];
}
