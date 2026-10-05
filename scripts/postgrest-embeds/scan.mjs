/**
 * Static scan of supabase-js PostgREST selects: which table every
 * `.from(table)...select(columns)` reads, what `columns` can be, and how
 * PostgREST will resolve each embed in it.
 *
 * WHAT IT FOLLOWS, so a select assembled from constants is seen whole:
 *   - string and template literals, `+` concatenation, `a ? b : c`, `a ?? b`;
 *   - identifiers bound to a const or let (any scope), including an imported
 *     one (relative paths, `@/` in apps/web and apps/mobile, @stockpilot/core,
 *     `export *` and `export { x } from` chains);
 *   - `obj.key` / `obj['key']` on an object literal, `[...].join(sep)`
 *     (spreads included) and `Object.keys(obj)`;
 *   - a call to a function whose body returns an expression (the call's
 *     arguments are bound to its parameters);
 *   - a parameter of the function holding the select: every call site of
 *     that function is followed (same file, or a file importing it), so a
 *     helper like `read(client, table, columns)` is checked per caller. A
 *     method (a class or object method, or an arrow function held in a
 *     property) is followed through `this.name(...)` in its own class and
 *     through EVERY `.name(...)` call with a fitting number of arguments
 *     anywhere: the scan cannot tell which class an expression is, and
 *     following a call that is not this method only adds paths to check;
 *   - a query builder kept in a variable (`const q = sb.from('t'); q.select()`).
 * A part it cannot resolve becomes a placeholder name (`__dyn0__`), so the
 * rest of the select is still checked.
 *
 * WHAT IT REPORTS INSTEAD OF SKIPPING. A call path whose table, select or
 * builder it cannot resolve is reported as unchecked when an embed could
 * travel it: its own select has one, or its select is unknown while another
 * path of the same `.select()` carries one. A select with more alternatives
 * than it follows (MAX_ALTERNATIVES) is reported as truncated.
 *
 * COVERAGE. Every string literal that parses as a select containing an embed
 * of a known table (a "select fragment"), alone or with the literals it is
 * concatenated with, must be reached from a `.select()` whose table is known.
 * One that is not is reported as unattributed, unless a comment on it or on
 * its declaration names its table:
 *     // postgrest-from: cycle_count_lines
 * so a select that travels a way the scan cannot follow is still checked. The
 * same comment on a `.select()` call names the table of a path whose builder
 * the scan cannot follow (an rpc, a builder returned by a call).
 *
 * Plain ESM; `typescript` is the only dependency.
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { listEmbeds, parseSelect, PLACEHOLDER_RE } from './select-parser.mjs';

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.turbo',
  '.expo',
  'dist',
  'build',
  'coverage',
  'ios',
  'android',
  '__mocks__',
]);
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
export const TEST_FILE = /(\.test|\.spec)\.[cm]?[jt]sx?$|\/__tests__\/|\/src\/test\//;
// A select with more alternatives than this (conditionals multiply) is
// checked on the first MAX_ALTERNATIVES only, and reported as truncated so
// the guard fails; none comes close today.
const MAX_ALTERNATIVES = 64;
const MAX_DEPTH = 6;
export const ANNOTATION_RE = /postgrest-from:\s*([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)/;

/** Every source file under `dir`, skipping build output and native folders. */
export function listSourceFiles(dir, { includeTests = false } = {}) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name));
      } else if (SOURCE_FILE.test(e.name) && !DECLARATION_FILE.test(e.name)) {
        const full = path.join(d, e.name);
        if (includeTests || !TEST_FILE.test(full.split(path.sep).join('/'))) out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function unwrap(node) {
  let n = node;
  while (
    n &&
    (ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isTypeAssertionExpression(n) ||
      ts.isSatisfiesExpression(n))
  ) {
    n = n.expression;
  }
  return n;
}

const isFunctionNode = (n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

/** Where `name` is bound inside a binding name: [] for the name itself, or
 *  the property / index path into a destructuring pattern. */
function bindingPath(nameNode, name) {
  if (ts.isIdentifier(nameNode)) return nameNode.text === name ? [] : null;
  if (ts.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.elements) {
      const key = el.propertyName
        ? ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)
          ? el.propertyName.text
          : null
        : ts.isIdentifier(el.name)
          ? el.name.text
          : null;
      const inner = bindingPath(el.name, name);
      if (inner) return key === null ? ['?'] : [key, ...inner];
    }
  }
  if (ts.isArrayBindingPattern(nameNode)) {
    for (const [i, el] of nameNode.elements.entries()) {
      if (ts.isOmittedExpression(el)) continue;
      const inner = bindingPath(el.name, name);
      if (inner) return [i, ...inner];
    }
  }
  return null;
}

function declInStatements(statements, name) {
  for (const st of statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const p = bindingPath(d.name, name);
        if (p) {
          return {
            kind: 'var',
            decl: d,
            path: p,
            isConst: (st.declarationList.flags & ts.NodeFlags.Const) !== 0,
          };
        }
      }
    } else if (ts.isFunctionDeclaration(st) && st.name?.text === name) {
      return { kind: 'function', decl: st, path: [] };
    } else if (ts.isClassDeclaration(st) && st.name?.text === name) {
      return { kind: 'class', decl: st, path: [] };
    }
  }
  return null;
}

/**
 * A scanner over the files it loads. `repoRoot` anchors the `@/` and
 * `@stockpilot/core` aliases and the paths it reports.
 * @param {{ repoRoot: string }} options
 */
export function createScanner({ repoRoot }) {
  /** @type {Map<string, any>} */
  const modules = new Map();
  let placeholderCount = 0;
  // Set when product() or union() drops alternatives past MAX_ALTERNATIVES.
  let truncated = false;

  function aliasBase(fromFile, spec) {
    const rel = path.relative(repoRoot, fromFile).split(path.sep).join('/');
    if (spec.startsWith('@/')) {
      if (rel.startsWith('apps/web/')) return path.join(repoRoot, 'apps/web/src', spec.slice(2));
      if (rel.startsWith('apps/mobile/'))
        return path.join(repoRoot, 'apps/mobile/src', spec.slice(2));
      return null;
    }
    if (spec === '@stockpilot/core') return path.join(repoRoot, 'packages/core/src/index');
    if (spec.startsWith('@stockpilot/core/'))
      return path.join(repoRoot, 'packages/core/src', spec.slice(17));
    if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec);
    return null;
  }

  function resolveSpecifier(fromFile, spec) {
    const base = aliasBase(fromFile, spec);
    if (!base) return null;
    const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
    const candidates = [
      base,
      `${stripped}.ts`,
      `${stripped}.tsx`,
      `${stripped}.mts`,
      `${stripped}.js`,
      `${stripped}.mjs`,
      `${stripped}.jsx`,
      path.join(stripped, 'index.ts'),
      path.join(stripped, 'index.tsx'),
      path.join(stripped, 'index.js'),
    ];
    for (const c of candidates) {
      try {
        if (fs.statSync(c).isFile() && SOURCE_FILE.test(c) && !DECLARATION_FILE.test(c)) return c;
      } catch {
        /* next */
      }
    }
    return null;
  }

  function load(file) {
    if (modules.has(file)) return modules.get(file);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      modules.set(file, null);
      return null;
    }
    const kind = /\.tsx$|\.jsx$/.test(file)
      ? ts.ScriptKind.TSX
      : /\.[cm]?js$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const mod = { file, sf, text, imports: new Map(), exports: new Map(), stars: [] };
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
        const spec = st.moduleSpecifier.text;
        const ic = st.importClause;
        if (ic.name) mod.imports.set(ic.name.text, { spec, imported: 'default' });
        const nb = ic.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) mod.imports.set(nb.name.text, { spec, imported: '*' });
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            mod.imports.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text });
          }
        }
      } else if (ts.isExportDeclaration(st)) {
        const spec =
          st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
            ? st.moduleSpecifier.text
            : null;
        if (!st.exportClause) {
          if (spec) mod.stars.push(spec);
        } else if (ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            const local = (el.propertyName ?? el.name).text;
            mod.exports.set(
              el.name.text,
              spec ? { kind: 'reexport', spec, name: local } : { kind: 'local', name: local },
            );
          }
        }
      } else if (
        (ts.isVariableStatement(st) || ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) &&
        st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (ts.isIdentifier(d.name))
              mod.exports.set(d.name.text, { kind: 'local', name: d.name.text });
          }
        } else if (st.name) {
          const isDefault = st.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
          mod.exports.set(isDefault ? 'default' : st.name.text, {
            kind: 'local',
            name: st.name.text,
          });
        }
      }
    }
    modules.set(file, mod);
    return mod;
  }

  /** The declaration an export resolves to: { mod, binding } or null. */
  function resolveExport(mod, name, seen = new Set()) {
    if (!mod) return null;
    const key = `${mod.file}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const e = mod.exports.get(name);
    if (e?.kind === 'local') {
      const b = declInStatements(mod.sf.statements, e.name);
      if (b) return { mod, binding: { ...b, module: mod } };
      const imp = mod.imports.get(e.name);
      if (imp) return resolveImport(mod, imp, seen);
      return null;
    }
    if (e?.kind === 'reexport') {
      const target = resolveSpecifier(mod.file, e.spec);
      return target ? resolveExport(load(target), e.name, seen) : null;
    }
    for (const spec of mod.stars) {
      const target = resolveSpecifier(mod.file, spec);
      const hit = target ? resolveExport(load(target), name, seen) : null;
      if (hit) return hit;
    }
    return null;
  }

  function resolveImport(mod, imp, seen = new Set()) {
    const target = resolveSpecifier(mod.file, imp.spec);
    if (!target) return null;
    const tmod = load(target);
    if (!tmod) return null;
    if (imp.imported === '*')
      return { mod: tmod, binding: { kind: 'namespace', module: tmod, path: [] } };
    return resolveExport(tmod, imp.imported, seen);
  }

  /** The binding of identifier `name` as seen from `fromNode` in `mod`. */
  function findBinding(name, fromNode, mod) {
    let node = fromNode;
    while (node) {
      if (isFunctionNode(node)) {
        for (const [index, p] of node.parameters.entries()) {
          const bp = bindingPath(p.name, name);
          if (bp) return { kind: 'param', fn: node, index, path: bp, decl: p, module: mod };
        }
        if (ts.isFunctionExpression(node) && node.name?.text === name) {
          return { kind: 'function', decl: node, path: [], module: mod };
        }
      }
      if (
        ts.isBlock(node) ||
        ts.isSourceFile(node) ||
        ts.isModuleBlock(node) ||
        ts.isCaseClause(node) ||
        ts.isDefaultClause(node)
      ) {
        const found = declInStatements(node.statements, name);
        if (found) return { ...found, module: mod };
        if (ts.isSourceFile(node)) {
          const imp = mod.imports.get(name);
          if (imp) return { kind: 'import', imp, module: mod, path: [] };
        }
      }
      if (
        (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.initializer)
      ) {
        for (const d of node.initializer.declarations) {
          if (bindingPath(d.name, name))
            return { kind: 'loop', decl: d, stmt: node, module: mod, path: [] };
        }
      }
      if (
        ts.isCatchClause(node) &&
        node.variableDeclaration &&
        bindingPath(node.variableDeclaration.name, name)
      ) {
        return { kind: 'catch', module: mod, path: [] };
      }
      node = node.parent;
    }
    return null;
  }

  /** Follow an import binding to its declaration. */
  function settle(binding) {
    let b = binding;
    for (let i = 0; i < 10 && b?.kind === 'import'; i += 1) {
      const hit = resolveImport(b.module, b.imp);
      b = hit ? hit.binding : null;
    }
    return b;
  }

  function newCtx(mod, extra = {}) {
    return {
      mod,
      bindings: new Map(),
      seen: new Set(),
      used: new Set(),
      missing: new Set(),
      opaque: new Map(),
      depth: 0,
      ...extra,
    };
  }

  function placeholder(ctx, node) {
    const name = `__dyn${placeholderCount++}__`;
    ctx.opaque.set(name, node ? node.getText(ctx.mod.sf).slice(0, 120) : '?');
    return name;
  }

  function product(a, b) {
    const out = [];
    for (const x of a)
      for (const y of b) {
        if (out.length >= MAX_ALTERNATIVES) {
          truncated = true;
          return out;
        }
        out.push(x + y);
      }
    return out;
  }

  function union(...lists) {
    const all = [...new Set(lists.flat())];
    if (all.length > MAX_ALTERNATIVES) truncated = true;
    return all.slice(0, MAX_ALTERNATIVES);
  }

  /** Whether alternatives were dropped since the last call (and reset). */
  function takeTruncated() {
    const was = truncated;
    truncated = false;
    return was;
  }

  /** The context an argument is read in: the caller's module, with the
   *  bindings of the current call path (so a caller's own parameters bound
   *  later on the same path resolve too). */
  function callerContext(bound, ctx) {
    return {
      ...newCtx(bound.mod),
      bindings: ctx.bindings,
      used: ctx.used,
      missing: ctx.missing,
      opaque: ctx.opaque,
      seen: ctx.seen,
      depth: ctx.depth,
    };
  }

  /** The expression a param binding stands for, in the caller's context. */
  function boundArgument(binding, ctx) {
    const bound = ctx.bindings.get(binding.fn);
    if (!bound) {
      ctx.missing.add(binding.fn);
      return null;
    }
    let expr = bound.args[binding.index];
    if (!expr) {
      expr = binding.decl.initializer ?? null; // default value
      if (!expr) return null;
      return { expr, ctx };
    }
    let cctx = callerContext(bound, ctx);
    for (const key of binding.path) {
      const obj = resolveObject(expr, cctx);
      if (!obj) return null;
      const prop = objectProperty(obj.node, String(key), obj.ctx);
      if (!prop) return null;
      expr = prop.expr;
      cctx = prop.ctx;
    }
    return { expr, ctx: cctx };
  }

  /** Resolve an identifier to the expression it stands for. */
  function identifierValue(id, ctx) {
    const raw = findBinding(id.text, id, ctx.mod);
    if (!raw) return null;
    if (raw.kind === 'param') return boundArgument(raw, ctx);
    const b = settle(raw);
    if (!b) return null;
    if (b.kind === 'var' && b.decl.initializer) {
      const vctx =
        b.module === ctx.mod
          ? ctx
          : {
              ...newCtx(b.module),
              bindings: ctx.bindings,
              used: ctx.used,
              missing: ctx.missing,
              opaque: ctx.opaque,
              seen: ctx.seen,
              depth: ctx.depth,
            };
      let expr = b.decl.initializer;
      let ectx = vctx;
      for (const key of b.path) {
        const obj = typeof key === 'number' ? null : resolveObject(expr, ectx);
        if (!obj) return null;
        const prop = objectProperty(obj.node, String(key), obj.ctx);
        if (!prop) return null;
        expr = prop.expr;
        ectx = prop.ctx;
      }
      // A `let` may be reassigned: every `name = expr` in scope is a value.
      if (!b.isConst && b.path.length === 0) {
        const extra = assignmentsTo(id.text, b.decl, b.module);
        if (extra.length > 0)
          return { expr, ctx: ectx, alternatives: extra.map((e) => ({ expr: e, ctx: ectx })) };
      }
      return { expr, ctx: ectx };
    }
    if (b.kind === 'namespace') return { namespace: b.module, ctx };
    if (b.kind === 'function')
      return {
        fn: b.decl,
        ctx:
          b.module === ctx.mod
            ? ctx
            : {
                ...newCtx(b.module),
                used: ctx.used,
                missing: ctx.missing,
                opaque: ctx.opaque,
                seen: ctx.seen,
                depth: ctx.depth,
              },
      };
    return null;
  }

  function assignmentsTo(name, decl, mod) {
    const scope = decl.parent?.parent?.parent ?? mod.sf;
    const out = [];
    const visit = (n) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        n.left.text === name
      ) {
        out.push(n.right);
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return out;
  }

  /** An object literal an expression evaluates to: { node, ctx } or null. */
  function resolveObject(expr, ctx, depth = 0) {
    if (depth > MAX_DEPTH) return null;
    const e = unwrap(expr);
    if (!e) return null;
    if (ts.isObjectLiteralExpression(e)) return { node: e, ctx };
    if (ts.isIdentifier(e)) {
      const v = identifierValue(e, ctx);
      if (v?.expr) return resolveObject(v.expr, v.ctx, depth + 1);
      return null;
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const prop = memberValue(e, ctx, depth + 1);
      return prop ? resolveObject(prop.expr, prop.ctx, depth + 1) : null;
    }
    return null;
  }

  /** The value expression of `key` in an object literal (last write wins). */
  function objectProperty(obj, key, ctx) {
    for (let i = obj.properties.length - 1; i >= 0; i -= 1) {
      const p = obj.properties[i];
      if (ts.isPropertyAssignment(p)) {
        const n = p.name;
        const k =
          ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : null;
        if (k === key) return { expr: p.initializer, ctx };
      } else if (ts.isShorthandPropertyAssignment(p)) {
        if (p.name.text === key) return { expr: p.name, ctx };
      } else if (ts.isSpreadAssignment(p)) {
        const inner = resolveObject(p.expression, ctx);
        const hit = inner ? objectProperty(inner.node, key, inner.ctx) : null;
        if (hit) return hit;
      }
    }
    return null;
  }

  /** `obj.key`, `obj['key']`, `ns.export`: the expression it names. A
   *  computed key (`obj[k]`) on an object literal stands for every value. */
  function memberValue(e, ctx, depth = 0) {
    const key = ts.isPropertyAccessExpression(e)
      ? e.name.text
      : ts.isStringLiteral(e.argumentExpression) || ts.isNumericLiteral(e.argumentExpression)
        ? e.argumentExpression.text
        : null;
    if (key === null) {
      const obj = resolveObject(e.expression, ctx, depth + 1);
      if (!obj) return null;
      const values = obj.node.properties
        .filter((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
        .map((p) => ({ expr: ts.isPropertyAssignment(p) ? p.initializer : p.name, ctx: obj.ctx }));
      return values.length > 0
        ? { expr: values[0].expr, ctx: obj.ctx, alternatives: values.slice(1) }
        : null;
    }
    const base = unwrap(e.expression);
    if (ts.isIdentifier(base)) {
      const v = identifierValue(base, ctx);
      if (v?.namespace) {
        const hit = resolveExport(v.namespace, key);
        if (hit?.binding.kind === 'var' && hit.binding.decl.initializer) {
          return {
            expr: hit.binding.decl.initializer,
            ctx: {
              ...newCtx(hit.mod),
              used: ctx.used,
              missing: ctx.missing,
              opaque: ctx.opaque,
              seen: ctx.seen,
              depth: ctx.depth,
            },
          };
        }
        return null;
      }
    }
    const obj = resolveObject(e.expression, ctx, depth + 1);
    return obj ? objectProperty(obj.node, key, obj.ctx) : null;
  }

  /** Element expressions of an array an expression evaluates to. */
  function resolveArray(expr, ctx, depth = 0) {
    if (depth > MAX_DEPTH) return null;
    const e = unwrap(expr);
    if (!e) return null;
    if (ts.isArrayLiteralExpression(e)) {
      const out = [];
      for (const el of e.elements) {
        if (ts.isSpreadElement(el)) {
          const inner = resolveArray(el.expression, ctx, depth + 1);
          if (!inner) return null;
          out.push(...inner);
        } else {
          out.push({ expr: el, ctx });
        }
      }
      return out;
    }
    if (ts.isIdentifier(e)) {
      const v = identifierValue(e, ctx);
      return v?.expr ? resolveArray(v.expr, v.ctx, depth + 1) : null;
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const m = memberValue(e, ctx, depth + 1);
      return m ? resolveArray(m.expr, m.ctx, depth + 1) : null;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const method = e.expression.name.text;
      // `.filter(Boolean)` and friends keep a subset; reading every element
      // is the safe direction for a check (it can only add embeds).
      if (method === 'filter' || method === 'slice' || method === 'concat') {
        const base = resolveArray(e.expression.expression, ctx, depth + 1);
        if (!base) return null;
        if (method === 'concat') {
          for (const a of e.arguments) {
            const more = resolveArray(a, ctx, depth + 1);
            if (more) base.push(...more);
            else base.push({ expr: a, ctx });
          }
        }
        return base;
      }
      const callee = unwrap(e.expression.expression);
      if (
        method === 'keys' &&
        ts.isIdentifier(callee) &&
        callee.text === 'Object' &&
        e.arguments[0]
      ) {
        const obj = resolveObject(e.arguments[0], ctx, depth + 1);
        if (!obj) return null;
        return obj.node.properties
          .filter(
            (p) =>
              (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
              p.name &&
              (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)),
          )
          .map((p) => ({
            expr: ts.factory.createStringLiteral(p.name.text),
            ctx,
            synthetic: true,
          }));
      }
    }
    return null;
  }

  /**
   * Every string `expr` can evaluate to, or null. Unresolvable parts of a
   * template or concatenation become placeholder names.
   */
  function resolveStrings(expr, ctx) {
    if (ctx.depth > MAX_DEPTH * 3) return null;
    const e = unwrap(expr);
    if (!e) return null;
    if (ctx.seen.has(e)) return null;
    ctx.seen.add(e);
    try {
      ctx.depth += 1;
      return resolveStringsInner(e, ctx);
    } finally {
      ctx.depth -= 1;
      ctx.seen.delete(e);
    }
  }

  function orPlaceholder(res, ctx, node) {
    return res ?? [placeholder(ctx, node)];
  }

  function resolveStringsInner(e, ctx) {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      if (e.pos >= 0) ctx.used.add(e);
      return [e.text];
    }
    if (ts.isTemplateExpression(e)) {
      ctx.used.add(e);
      let alts = [e.head.text];
      for (const span of e.templateSpans) {
        const sub = orPlaceholder(resolveStrings(span.expression, ctx), ctx, span.expression);
        alts = product(alts, sub).map((s) => s + span.literal.text);
      }
      return alts;
    }
    if (ts.isNumericLiteral(e)) return [e.text];
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        const l = resolveStrings(e.left, ctx);
        const r = resolveStrings(e.right, ctx);
        if (!l && !r) return null;
        return product(orPlaceholder(l, ctx, e.left), orPlaceholder(r, ctx, e.right));
      }
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        const l = resolveStrings(e.left, ctx);
        const r = resolveStrings(e.right, ctx);
        if (!l && !r) return null;
        return union(orPlaceholder(l, ctx, e.left), orPlaceholder(r, ctx, e.right));
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        return resolveStrings(e.right, ctx);
      }
      return null;
    }
    if (ts.isConditionalExpression(e)) {
      const a = resolveStrings(e.whenTrue, ctx);
      const b = resolveStrings(e.whenFalse, ctx);
      if (!a && !b) return null;
      return union(orPlaceholder(a, ctx, e.whenTrue), orPlaceholder(b, ctx, e.whenFalse));
    }
    if (ts.isIdentifier(e)) {
      const v = identifierValue(e, ctx);
      if (!v?.expr) return null;
      const first = resolveStrings(v.expr, v.ctx);
      if (!v.alternatives) return first;
      const more = v.alternatives.map((a) => resolveStrings(a.expr, a.ctx));
      if (!first && more.every((m) => !m)) return null;
      return union(
        orPlaceholder(first, ctx, v.expr),
        ...more.map((m, i) => orPlaceholder(m, ctx, v.alternatives[i].expr)),
      );
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const m = memberValue(e, ctx);
      if (!m) return null;
      const first = resolveStrings(m.expr, m.ctx);
      if (!m.alternatives) return first;
      const more = m.alternatives.map((a) => resolveStrings(a.expr, a.ctx));
      if (!first && more.every((x) => !x)) return null;
      return union(
        orPlaceholder(first, ctx, m.expr),
        ...more.map((x, i) => orPlaceholder(x, ctx, m.alternatives[i].expr)),
      );
    }
    if (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'join') {
        const items = resolveArray(callee.expression, ctx);
        if (!items) return null;
        const sep = e.arguments[0] ? resolveStrings(e.arguments[0], ctx) : [','];
        if (!sep || sep.length !== 1) return null;
        let alts = [''];
        items.forEach((item, i) => {
          const v = item.synthetic
            ? [item.expr.text]
            : orPlaceholder(resolveStrings(item.expr, item.ctx), ctx, item.expr);
          alts = product(
            alts,
            v.map((x) => (i === 0 ? x : sep[0] + x)),
          );
        });
        return alts;
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'trim' || callee.name.text === 'toString')
      ) {
        const base = resolveStrings(callee.expression, ctx);
        return base ? base.map((s) => (callee.name.text === 'trim' ? s.trim() : s)) : null;
      }
      if (ts.isIdentifier(callee)) {
        const v = identifierValue(callee, ctx);
        const fn =
          v?.fn ??
          (v?.expr &&
          (ts.isArrowFunction(unwrap(v.expr)) || ts.isFunctionExpression(unwrap(v.expr)))
            ? unwrap(v.expr)
            : null);
        if (!fn) return null;
        const fctx = v.fn ? v.ctx : v.ctx;
        const returns = returnExpressions(fn);
        if (returns.length === 0) return null;
        const bindings = new Map(ctx.bindings);
        bindings.set(fn, { args: [...e.arguments], mod: ctx.mod });
        const inner = {
          ...fctx,
          bindings,
          used: ctx.used,
          missing: ctx.missing,
          opaque: ctx.opaque,
          seen: ctx.seen,
          depth: ctx.depth,
        };
        const all = returns.map((r) => resolveStrings(r, inner));
        if (all.every((x) => !x)) return null;
        return union(...all.map((x, i) => orPlaceholder(x, ctx, returns[i])));
      }
      return null;
    }
    return null;
  }

  function returnExpressions(fn) {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
    const out = [];
    const visit = (n) => {
      if (n !== fn && isFunctionNode(n)) return;
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    return out;
  }

  /** `Array.from(...)`, `Buffer.from(...)`, `x.storage.from(bucket)` are not tables. */
  function isNonTableFrom(receiver) {
    const r = unwrap(receiver);
    if (ts.isIdentifier(r))
      return ['Array', 'Buffer', 'Uint8Array', 'Object', 'Promise'].includes(r.text);
    return ts.isPropertyAccessExpression(r) && r.name.text === 'storage';
  }

  /** The `.from(x)` / `.rpc(x)` a builder chain starts at. */
  function chainSource(expr, ctx, hops = 0) {
    let e = unwrap(expr);
    for (let guard = 0; guard < 60 && e; guard += 1) {
      e = unwrap(e);
      if (ts.isAwaitExpression(e)) {
        e = e.expression;
        continue;
      }
      if (ts.isCallExpression(e)) {
        const callee = unwrap(e.expression);
        if (ts.isPropertyAccessExpression(callee)) {
          const m = callee.name.text;
          if (m === 'from') {
            if (isNonTableFrom(callee.expression)) return null;
            return { kind: 'from', arg: e.arguments[0], ctx };
          }
          if (m === 'rpc') return { kind: 'rpc', arg: e.arguments[0], ctx };
          e = callee.expression;
          continue;
        }
        return { kind: 'unknown', reason: 'builder returned by a call' };
      }
      if (ts.isIdentifier(e)) {
        if (hops > 4) return { kind: 'unknown', reason: 'builder variable chain too long' };
        const raw = findBinding(e.text, e, ctx.mod);
        if (raw?.kind === 'var' && raw.decl.initializer && raw.path.length === 0) {
          return chainSource(raw.decl.initializer, ctx, hops + 1);
        }
        if (raw?.kind === 'param') {
          const bound = boundArgument(raw, ctx);
          if (bound) return chainSource(bound.expr, bound.ctx, hops + 1);
          return { kind: 'unknown', reason: 'builder passed in as a parameter' };
        }
        return { kind: 'unknown', reason: 'builder from an unresolved name' };
      }
      return { kind: 'unknown', reason: `builder from ${ts.SyntaxKind[e.kind]}` };
    }
    return null;
  }

  /** Calls by callee name, per module: built once, on first use. */
  let callIndex = null;
  function buildCallIndex(allMods) {
    callIndex = new Map();
    for (const mod of allMods) {
      const byName = new Map();
      const visit = (n) => {
        if (ts.isCallExpression(n)) {
          const callee = unwrap(n.expression);
          let key = null;
          if (ts.isIdentifier(callee)) key = callee.text;
          else if (ts.isPropertyAccessExpression(callee)) key = `.${callee.name.text}`;
          if (key) {
            if (!byName.has(key)) byName.set(key, []);
            byName.get(key).push(n);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(mod.sf);
      callIndex.set(mod, byName);
    }
  }

  /** `fn` as a method: its name and the class or object literal holding
   *  it, or null. A method declaration, or an arrow / function expression
   *  held in a class field or an object property. */
  function methodOf(fn) {
    if (ts.isMethodDeclaration(fn) && fn.name && ts.isIdentifier(fn.name)) {
      return { name: fn.name.text, container: fn.parent };
    }
    if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      (ts.isPropertyDeclaration(fn.parent) || ts.isPropertyAssignment(fn.parent)) &&
      fn.parent.initializer === fn &&
      ts.isIdentifier(fn.parent.name)
    ) {
      return { name: fn.parent.name.text, container: fn.parent.parent };
    }
    return null;
  }

  /** How many arguments a call to `fn` can pass. */
  function arity(fn) {
    let required = 0;
    let max = 0;
    for (const p of fn.parameters) {
      if (p.dotDotDotToken) return { required, max: Infinity };
      max += 1;
      if (!p.initializer && !p.questionToken) required = max;
    }
    return { required, max };
  }

  /** Call sites of the function `fn` (a declaration node) across `mods`. */
  function callSitesOf(fn, fnMod, allMods) {
    if (!callIndex) buildCallIndex(allMods);
    const sites = [];
    let name = null;
    let declNode = fn;
    if (ts.isFunctionDeclaration(fn) && fn.name) name = fn.name.text;
    else if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      ts.isVariableDeclaration(fn.parent) &&
      ts.isIdentifier(fn.parent.name)
    ) {
      name = fn.parent.name.text;
      declNode = fn.parent;
    } else {
      const method = methodOf(fn);
      if (method) {
        // `this.name(...)` counts only inside the method's own class (or
        // object literal). Any other `.name(...)` is followed by name: the
        // scan cannot tell which class `new S(ctx)` or `svc` is, and a call
        // that is not this method only adds paths to check. The argument
        // count must fit, which leaves most unrelated calls out.
        const { required, max } = arity(fn);
        for (const mod of allMods) {
          for (const n of callIndex.get(mod)?.get(`.${method.name}`) ?? []) {
            const callee = unwrap(n.expression);
            if (n.arguments.length < required || n.arguments.length > max) continue;
            if (callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
              let inside = false;
              for (let p = n.parent; p; p = p.parent) {
                if (p === method.container) {
                  inside = true;
                  break;
                }
              }
              if (!inside) continue;
            }
            sites.push({ call: n, mod });
          }
        }
        return sites;
      }
    }
    if (!name) return sites;
    const isTarget = (decl) => decl === declNode || decl === fn;
    for (const mod of allMods) {
      const byName = callIndex.get(mod);
      if (!byName) continue;
      // Local names this module may call the function by.
      const locals = new Set();
      if (mod === fnMod) locals.add(name);
      for (const [local, imp] of mod.imports) {
        if (imp.imported === name || imp.imported === 'default') locals.add(local);
      }
      for (const local of locals) {
        for (const n of byName.get(local) ?? []) {
          const b = settle(findBinding(local, unwrap(n.expression), mod));
          if (b && isTarget(b.decl)) sites.push({ call: n, mod });
        }
      }
      // Namespace imports: ns.fn(...)
      for (const [local, imp] of mod.imports) {
        if (imp.imported !== '*') continue;
        for (const n of byName.get(`.${name}`) ?? []) {
          const callee = unwrap(n.expression);
          if (!ts.isIdentifier(callee.expression) || callee.expression.text !== local) continue;
          const target = resolveSpecifier(mod.file, imp.spec);
          const hit = target ? resolveExport(load(target), name) : null;
          if (hit && isTarget(hit.binding.decl)) sites.push({ call: n, mod });
        }
      }
    }
    return sites;
  }

  /**
   * Evaluate one `.select()` call: one result per resolved call path, each
   * { source, tables, selects, via, opaque, used }. When the table or the
   * select depends on a parameter, every call site of that function is
   * followed (up to four levels of callers).
   */
  function evaluateSite(
    selectCall,
    mod,
    allMods,
    bindings = new Map(),
    via = [],
    level = 0,
    shared = null,
  ) {
    const sh = shared ?? { opaque: new Map() };
    const ctx = newCtx(mod, { bindings, opaque: sh.opaque });
    const src = chainSource(selectCall.expression.expression, ctx);
    const selectArg = selectCall.arguments[0];
    const tables = src?.kind === 'from' && src.arg ? resolveStrings(src.arg, src.ctx) : null;
    const selects = selectArg ? resolveStrings(selectArg, ctx) : ['*'];
    const unbound = [...ctx.missing].filter((fn) => !bindings.has(fn));
    const incomplete =
      tables === null ||
      selects === null ||
      [...(tables ?? []), ...(selects ?? [])].some((t) => /__dyn\d+__/.test(t));
    if (incomplete && unbound.length > 0 && level < 4) {
      // The innermost unbound function first: the one holding the select,
      // then the callers that pass its arguments through.
      const order = [...unbound].sort((a, b) => b.getStart() - a.getStart());
      for (const fn of order) {
        const fnMod = [...allMods].find((m) => m.sf === fn.getSourceFile());
        if (!fnMod) continue;
        const callers = callSitesOf(fn, fnMod, allMods);
        if (callers.length === 0) continue;
        const results = [];
        for (const { call, mod: cmod } of callers) {
          const next = new Map(bindings);
          next.set(fn, { args: [...call.arguments], mod: cmod });
          const pos = cmod.sf.getLineAndCharacterOfPosition(call.getStart(cmod.sf));
          results.push(
            ...evaluateSite(
              selectCall,
              mod,
              allMods,
              next,
              [...via, `${rel(cmod.file)}:${pos.line + 1}`],
              level + 1,
              sh,
            ),
          );
        }
        return results;
      }
    }
    return [{ source: src, tables, selects, via, opaque: sh.opaque, used: ctx.used }];
  }

  function rel(file) {
    return path.relative(repoRoot, file).split(path.sep).join('/');
  }

  /** Every `.select(...)` call in `mod`. */
  function selectCalls(mod) {
    const out = [];
    const visit = (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'select'
      ) {
        out.push(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(mod.sf);
    return out;
  }

  /** String-ish literal nodes in `mod` (outermost template only). */
  function stringLiterals(mod) {
    const out = [];
    const visit = (n) => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
      if (
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateExpression(n)
      ) {
        if (ts.isPropertyAssignment(n.parent) && n.parent.name === n) return;
        if (ts.isTaggedTemplateExpression(n.parent)) return;
        out.push(n);
        if (!ts.isTemplateExpression(n)) return;
      }
      ts.forEachChild(n, visit);
    };
    visit(mod.sf);
    return out;
  }

  /** The annotation (`postgrest-from: t`) on a literal or its statement. */
  function annotationFor(node, mod) {
    const text = mod.text;
    for (let n = node; n && !ts.isSourceFile(n); n = n.parent) {
      const ranges = ts.getLeadingCommentRanges(text, n.getFullStart()) ?? [];
      for (const r of ranges) {
        const m = ANNOTATION_RE.exec(text.slice(r.pos, r.end));
        if (m) return m[1].split(',').map((s) => s.trim());
      }
      // Stop at the statement holding the literal: a comment further up
      // belongs to something else.
      if (ts.isStatement(n)) break;
    }
    return null;
  }

  return {
    load,
    rel,
    selectCalls,
    evaluateSite,
    stringLiterals,
    annotationFor,
    resolveStrings,
    newCtx,
    takeTruncated,
  };
}

/**
 * Check every embed of a select against the relationship model.
 * @returns {Array<object>} one entry per embed
 */
export function checkSelect(model, table, selectText, opaque = new Map()) {
  const isOpaque = (name) => PLACEHOLDER_RE.test(name);
  let fields;
  try {
    fields = parseSelect(selectText);
  } catch (err) {
    return [{ status: 'parse-error', message: err.message }];
  }
  const out = [];
  const walk = (list, parent, pathSoFar) => {
    for (const f of list) {
      if (f.type !== 'embed') continue;
      const label = f.alias ? `${f.alias}:${f.target}` : f.target;
      const where = [...pathSoFar, label];
      let res;
      if (parent === null) res = { status: 'unchecked', reason: 'parent unknown' };
      else res = model.resolveEmbed(parent, f.target, f.hints, isOpaque);
      out.push({
        path: where.join(' > '),
        parent,
        target: f.target,
        alias: f.alias,
        hints: f.hints,
        joinType: f.joinType,
        spread: f.spread,
        text: f.text,
        ...res,
        opaque:
          isOpaque(f.target) || f.hints.some(isOpaque)
            ? (opaque.get(f.target) ?? opaque.get(f.hints[0]))
            : undefined,
      });
      walk(f.children, res.status === 'ok' ? res.table : null, where);
    }
  };
  walk(fields, table, []);
  return out;
}

/**
 * Does a literal look like a select fragment with an embed of something the
 * schema knows (a table, a view, a foreign key column or constraint)?
 */
const knownNames = new WeakMap();
export function looksLikeEmbedFragment(model, text) {
  const trimmed = text.replace(/^[\s,]+|[\s,]+$/g, '');
  if (!trimmed.includes('(')) return false;
  let fields;
  try {
    fields = parseSelect(trimmed);
  } catch {
    return false;
  }
  if (!knownNames.has(model)) {
    knownNames.set(
      model,
      new Set([
        ...model.tables,
        ...model.views,
        ...model.fks.map((f) => f.name),
        ...model.fks.filter((f) => f.columns.length === 1).map((f) => f.columns[0]),
      ]),
    );
  }
  const known = knownNames.get(model);
  return listEmbeds(fields).some(({ embed }) => {
    if (PLACEHOLDER_RE.test(embed.target)) return false;
    return known.has(embed.target) || embed.hints.length > 0;
  });
}

/**
 * Scan every source file under `roots` (relative to repoRoot, tests left
 * out), check every embed of every select against `model`, and sort what it
 * finds. The guard (apps/web/src/test/postgrest-embeds.guard.test.ts) and the
 * sweep both run this.
 *
 * @param {{ repoRoot: string, roots?: string[], files?: string[], model: object }} options
 */
export function scanRepo({ repoRoot, roots = [], files = null, model }) {
  const list = files ?? roots.flatMap((r) => listSourceFiles(path.join(repoRoot, r)));
  const scanner = createScanner({ repoRoot });
  const mods = list.map((f) => scanner.load(f)).filter(Boolean);
  const out = {
    sites: [],
    ambiguous: [],
    noRelationship: [],
    unchecked: [],
    viewEmbeds: [],
    selfEmbeds: [],
    parseErrors: [],
    unattributed: [],
    annotated: [],
    truncated: [],
    stats: { files: mods.length, selectCalls: 0, sitesWithEmbeds: 0, embeds: 0 },
  };
  const attributed = new Set();
  const seenSites = new Set();
  const modOf = new Map(mods.map((m) => [m.sf, m]));
  /** `// postgrest-from:` on the `.select()` statement, or on a literal the
   *  path read (or its declaration). */
  const annotationOn = (call, mod, used) => {
    const own = scanner.annotationFor(call, mod);
    if (own) return own;
    for (const lit of used) {
      const litMod = modOf.get(lit.getSourceFile());
      const tables = litMod ? scanner.annotationFor(lit, litMod) : null;
      if (tables) return tables;
    }
    return null;
  };

  const record = (where, table, selectText, opaque) => {
    const embeds = checkSelect(model, table, selectText, opaque);
    if (embeds.length > 0 && !seenSites.has(`${where.file}:${where.line}`)) {
      seenSites.add(`${where.file}:${where.line}`);
      out.stats.sitesWithEmbeds += 1;
    }
    for (const e of embeds) {
      out.stats.embeds += 1;
      const finding = { ...where, table, select: selectText.replace(/\s+/g, ' ').trim(), ...e };
      if (e.status === 'ambiguous') out.ambiguous.push(finding);
      else if (e.status === 'no-relationship') out.noRelationship.push(finding);
      else if (e.status === 'parse-error') out.parseErrors.push(finding);
      else if (e.status === 'unchecked' && e.reason === 'view') out.viewEmbeds.push(finding);
      else if (e.status === 'unchecked' && e.reason !== 'parent unknown')
        out.unchecked.push(finding);
      // A table embedded from ITSELF by its name (`locations(...)`,
      // `locations!parent_id(...)`) returns the rows that point at this one,
      // the children, not the row this one points at: the "wrong rows with
      // HTTP 200" class. Listed for a hand check (see relationships.mjs).
      if (e.status === 'ok' && e.parent !== null && e.target === e.parent) {
        out.selfEmbeds.push(finding);
      }
    }
    out.sites.push({ ...where, table, select: selectText, embeds });
  };

  const hasEmbed = (texts) => (texts ?? []).some((t) => looksLikeEmbedFragment(model, t));
  const truncatedAt = new Set();
  /** Report a select whose alternatives were cut at MAX_ALTERNATIVES. */
  const noteTruncation = (where) => {
    if (!scanner.takeTruncated()) return;
    const key = `${where.file}:${where.line}`;
    if (truncatedAt.has(key)) return;
    truncatedAt.add(key);
    out.truncated.push(where);
  };

  for (const mod of mods) {
    for (const call of scanner.selectCalls(mod)) {
      out.stats.selectCalls += 1;
      // The line of `.select(`, not of the chain's first token.
      const pos = mod.sf.getLineAndCharacterOfPosition(call.expression.name.getStart(mod.sf));
      const site = { file: scanner.rel(mod.file), line: pos.line + 1 };
      scanner.takeTruncated();
      const paths = scanner.evaluateSite(call, mod, mods);
      noteTruncation({ ...site, via: [] });
      // An embed reaches this `.select()` on some path.
      const siteHasEmbed = paths.some((r) => hasEmbed(r.selects));
      for (const r of paths) {
        const at = { ...site, via: r.via };
        if (r.source?.kind === 'from' && r.tables && r.selects) {
          for (const lit of r.used) attributed.add(lit);
          for (const table of r.tables) {
            for (const sel of r.selects) record(at, table, sel, r.opaque);
          }
          continue;
        }
        // A path whose builder, table or select the scan cannot resolve.
        // Skipping it is safe only when no embed can travel it: its own
        // select has none, and its select is known or no other path of this
        // `.select()` carries one. (A DOM `input.select()`, a column list on
        // a table chosen at run time.)
        const own = hasEmbed(r.selects);
        if (!own && !(r.selects === null && siteHasEmbed)) continue;
        for (const lit of r.used) attributed.add(lit);
        // `// postgrest-from: <table>` on the statement, or on the select's
        // literal, names the table of a builder the scan cannot follow.
        const named = r.selects ? annotationOn(call, mod, r.used) : null;
        if (named) {
          out.annotated.push({ ...at, tables: named });
          for (const table of named) {
            for (const sel of r.selects) record(at, table, sel, r.opaque);
          }
          continue;
        }
        out.unchecked.push({
          ...at,
          scope: 'path',
          table: r.tables ? r.tables.join(' | ') : null,
          select: (r.selects ?? ['?']).join(' | ').replace(/\s+/g, ' ').trim().slice(0, 200),
          reason:
            r.source?.kind === 'rpc'
              ? 'the builder is an rpc()'
              : r.source?.kind === 'from'
                ? r.tables
                  ? 'its select is not static, and another path of this .select() carries an embed'
                  : 'its table is not static'
                : `its builder is not followed (${r.source?.reason ?? 'no .from() found'})`,
        });
      }
    }
  }

  // Literals no resolved path used. A fragment may be split over literals
  // joined with `+` (`'x:user_profiles(' + COLS + ')'`), so each literal is
  // read with the whole concatenation it sits in.
  const seenConcat = new Set();
  for (const mod of mods) {
    for (const lit of scanner.stringLiterals(mod)) {
      if (attributed.has(lit)) continue;
      const raw = lit.getText(mod.sf);
      if (!raw.includes('(')) continue;
      const whole = outermostConcatenation(lit);
      if (whole !== lit) {
        if (seenConcat.has(whole)) continue;
        seenConcat.add(whole);
        if (literalsWithin(whole).some((l) => attributed.has(l))) continue;
      }
      const ctx = scanner.newCtx(mod);
      const pos = mod.sf.getLineAndCharacterOfPosition(lit.getStart(mod.sf));
      const where = { file: scanner.rel(mod.file), line: pos.line + 1, via: [] };
      scanner.takeTruncated();
      const texts = scanner.resolveStrings(whole, ctx) ?? [];
      // Most of these are not selects at all (email markup, report copy),
      // where dropped alternatives do not matter; a cut select fragment does.
      const cut = scanner.takeTruncated();
      if (!texts.some((t) => looksLikeEmbedFragment(model, t))) continue;
      if (cut && !truncatedAt.has(`${where.file}:${where.line}`)) {
        truncatedAt.add(`${where.file}:${where.line}`);
        out.truncated.push(where);
      }
      const tables = scanner.annotationFor(lit, mod);
      if (!tables) {
        out.unattributed.push({
          ...where,
          text: whole.getText(mod.sf).replace(/\s+/g, ' ').slice(0, 160),
        });
        continue;
      }
      out.annotated.push({ ...where, tables });
      for (const table of tables) {
        for (const t of texts) record(where, table, t.replace(/^[\s,]+|[\s,]+$/g, ''), ctx.opaque);
      }
    }
  }
  return out;
}

/** The `+` concatenation (through parentheses) a literal is part of, or
 *  the literal itself. */
function outermostConcatenation(node) {
  let n = node;
  for (;;) {
    const p = n.parent;
    if (
      p &&
      (ts.isParenthesizedExpression(p) ||
        (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken))
    ) {
      n = p;
      continue;
    }
    return n;
  }
}

/** String-ish literal nodes inside `node` (itself included). */
function literalsWithin(node) {
  const out = [];
  const visit = (n) => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateExpression(n)
    ) {
      out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}
