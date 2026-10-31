import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Security invariant: only a platform admin creates a workspace or makes an
 * account the owner of one (owner decision b.9, docket S20).
 *
 * The database refuses a signed-in or anonymous insert into organizations (no
 * INSERT policy since 0138; supabase/tests/0138_organizations_insert_denied.test.sql
 * pins it), and a signed-in caller can never write an owner membership (the
 * 0220 guard as 0393 redefined it). So every workspace and every owner seat is
 * written by app code on the service role, and that code is the only gate.
 * createOrganizationAction checked only that its caller was signed in, so any
 * account could create workspaces by posting the action. This holds every
 * such write to the platform-admin check:
 *
 *   Rule 1. Every `.from('organizations')` chained to `.insert(` or `.upsert(`
 *   sits in a function that first runs
 *   `const <gate> = await checkPlatformAdmin({ requireStepUp: true })`
 *   (imported from lib/auth/platform-admin) and then refuses when
 *   `!<gate>.ok`, both as statements of the function's own body that end
 *   before the write. The set is pinned to exactly createOrganizationAction
 *   and createOrgForCustomerAction.
 *
 *   Rule 2. Every `.from('organization_members')` insert or upsert whose row
 *   can seat an owner (role 'owner', or a role this scan cannot read) is gated
 *   the same way or is a REVIEWED entry. startActingAs (the Act as seat) has no
 *   check of its own, so every call of it must sit in a function gated the
 *   same way. Invite acceptance writes the invite's role, which 0001's check
 *   on organization_invites.role never lets be owner. The sets are pinned and
 *   a stale entry fails.
 *
 * Parsed with the TypeScript compiler, like the action-catch scanner
 * (src/test/action-catch-scan.ts): comments and strings never count, a chain
 * split over lines or held in a variable is still one write, and a table named
 * by a constant is read. A table the scan cannot read at all fails until it is
 * reviewed. Not followed: rows built in another function and passed in (they
 * read as an unknown role, so they need review), and code outside apps/web/src
 * (operator scripts that run with the service-role key in the operator's own
 * shell, which no user can reach).
 */

// ── The scan ────────────────────────────────────────────────────────────────

interface ScanFile {
  /** Relative to apps/web/src, with forward slashes. */
  path: string;
  text: string;
}

type Table = 'organizations' | 'organization_members';
/** What a membership row writes as its role: an owner, a fixed other role, or a value the scan cannot read. */
type SeatRole = 'owner' | 'other' | 'unknown';

interface WriteSite {
  /** `<file>#<nearest named function>`. */
  key: string;
  file: string;
  line: number;
  table: Table;
  verb: 'insert' | 'upsert';
  /** organization_members only. */
  role: SeatRole | null;
  gated: boolean;
}

interface Reference {
  key: string;
  file: string;
  line: number;
  /** A call the scan can check, or a use it cannot follow (passed as a value, a dynamic import). */
  how: 'call' | 'value';
  gated: boolean;
}

interface Scan {
  writes: WriteSite[];
  /** Inserts and upserts through `.from(<something the scan cannot read>)`. */
  unreadTables: Array<{ key: string; line: number }>;
  /** References to each watched function, outside its own module, by `<module>#<name>`. */
  references: Map<string, Reference[]>;
}

const GATE = { module: 'lib/auth/platform-admin', name: 'checkPlatformAdmin' };
const TABLES: ReadonlySet<string> = new Set<Table>(['organizations', 'organization_members']);
const WRITE_VERBS: ReadonlySet<string> = new Set(['insert', 'upsert']);

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function enclosingFunction(node: ts.Node): FunctionLike | null {
  for (let n = node.parent; n; n = n.parent) if (isFunctionLike(n)) return n;
  return null;
}

/** A function's own name, or the name it is bound to (`const f = cache(async () => ...)`). */
function functionName(fn: FunctionLike): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  if (
    ts.isMethodDeclaration(fn) ||
    ts.isGetAccessorDeclaration(fn) ||
    ts.isSetAccessorDeclaration(fn)
  ) {
    const cls = fn.parent;
    const own = ts.isIdentifier(fn.name) ? fn.name.text : fn.name.getText();
    return ts.isClassLike(cls) && cls.name ? `${cls.name.text}.${own}` : own;
  }
  let p: ts.Node = fn.parent;
  while (ts.isCallExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p))
    p = p.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

/** The nearest NAMED enclosing function (callbacks are skipped), for reporting and pinning. */
function siteName(node: ts.Node): string {
  for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) {
    const name = functionName(fn);
    if (name) return name;
  }
  return '(top level)';
}

/** Module path relative to src for an import specifier, or null for a package. */
function resolveModule(fromFile: string, spec: string): string | null {
  let target: string;
  if (spec.startsWith('@/')) target = spec.slice(2);
  else if (spec.startsWith('.')) target = path.posix.join(path.posix.dirname(fromFile), spec);
  else return null;
  return target.replace(/\.(ts|tsx)$/, '').replace(/\/index$/, '');
}

function moduleOf(file: string): string {
  return file.replace(/\.(ts|tsx)$/, '').replace(/\/index$/, '');
}

function unwrap(e: ts.Expression): ts.Expression {
  let n = e;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))
    n = n.expression;
  return n;
}

function stringValue(e: ts.Expression, constants: Map<string, string>): string | null {
  const n = unwrap(e);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isIdentifier(n)) return constants.get(n.text) ?? null;
  return null;
}

/** `const <id> = await checkPlatformAdmin({ requireStepUp: true })`, the gate bound to <id>. */
function gateBinding(stmt: ts.Statement, gateNames: ReadonlySet<string>): string | null {
  if (!ts.isVariableStatement(stmt)) return null;
  if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) return null;
  const [decl, ...rest] = stmt.declarationList.declarations;
  if (!decl || rest.length > 0 || !ts.isIdentifier(decl.name) || !decl.initializer) return null;
  const init = unwrap(decl.initializer);
  if (!ts.isAwaitExpression(init)) return null;
  const call = unwrap(init.expression);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
  if (!gateNames.has(call.expression.text)) return null;
  const opts = call.arguments[0];
  if (!opts || !ts.isObjectLiteralExpression(opts)) return null;
  const stepUp = opts.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === 'requireStepUp' &&
      p.initializer.kind === ts.SyntaxKind.TrueKeyword,
  );
  return stepUp ? decl.name.text : null;
}

function exits(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true;
  if (ts.isBlock(stmt)) {
    const last = stmt.statements[stmt.statements.length - 1];
    return last !== undefined && exits(last);
  }
  return false;
}

/** `if (!<id>.ok) <return or throw>`. */
function refusesUnlessOk(stmt: ts.Statement, id: string): boolean {
  if (!ts.isIfStatement(stmt)) return false;
  const cond = unwrap(stmt.expression);
  if (!ts.isPrefixUnaryExpression(cond) || cond.operator !== ts.SyntaxKind.ExclamationToken)
    return false;
  const operand = unwrap(cond.operand);
  return (
    ts.isPropertyAccessExpression(operand) &&
    ts.isIdentifier(operand.expression) &&
    operand.expression.text === id &&
    operand.name.text === 'ok' &&
    exits(stmt.thenStatement)
  );
}

/**
 * Whether a function enclosing `site` refuses a non-admin first: its own body
 * binds the gate and refuses unless it passed, in statements that both end
 * before the site starts. A check in a branch, after the write, with its
 * answer ignored, without the step-up, or of a function not imported from
 * lib/auth/platform-admin does not count.
 */
function gatedBefore(site: ts.Node, gateNames: ReadonlySet<string>): boolean {
  if (gateNames.size === 0) return false;
  const at = site.getStart();
  for (let fn = enclosingFunction(site); fn; fn = enclosingFunction(fn)) {
    if (!fn.body || !ts.isBlock(fn.body)) continue;
    const stmts = fn.body.statements;
    for (let i = 0; i < stmts.length && stmts[i]!.getEnd() <= at; i += 1) {
      const id = gateBinding(stmts[i]!, gateNames);
      if (!id) continue;
      for (let j = i + 1; j < stmts.length && stmts[j]!.getEnd() <= at; j += 1) {
        if (refusesUnlessOk(stmts[j]!, id)) return true;
      }
    }
  }
  return false;
}

function propertyName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  return null;
}

/** The role a membership row writes. `role` is NOT NULL with no default (0001), so a row without one is refused. */
function seatRole(row: ts.Expression | undefined): SeatRole {
  if (!row) return 'unknown';
  const n = unwrap(row);
  if (ts.isArrayLiteralExpression(n)) {
    const roles = n.elements.map((e) => seatRole(e));
    if (roles.includes('owner')) return 'owner';
    return roles.includes('unknown') ? 'unknown' : 'other';
  }
  if (!ts.isObjectLiteralExpression(n)) return 'unknown';
  let role: SeatRole | null = null;
  let spread = false;
  for (const p of n.properties) {
    if (ts.isSpreadAssignment(p)) spread = true;
    else if (propertyName(p) === 'role') {
      if (ts.isPropertyAssignment(p)) {
        const v = unwrap(p.initializer);
        role =
          ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)
            ? v.text === 'owner'
              ? 'owner'
              : 'other'
            : 'unknown';
      } else role = 'unknown';
    }
  }
  if (role === 'owner') return 'owner';
  if (spread) return 'unknown';
  return role ?? 'other';
}

interface Watched {
  /** Module path relative to src, without extension. */
  module: string;
  name: string;
}

function scanSources(files: readonly ScanFile[], watched: readonly Watched[]): Scan {
  const writes: WriteSite[] = [];
  const unreadTables: Scan['unreadTables'] = [];
  const references = new Map<string, Reference[]>(
    watched.map((w) => [`${w.module}#${w.name}`, []]),
  );

  for (const file of files) {
    const sf = ts.createSourceFile(
      file.path,
      file.text,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const here = moduleOf(file.path);

    // Imports: the gate's local names, and the watched functions' local and namespace names.
    const gateNames = new Set<string>();
    const watchedLocals = new Map<string, string>();
    const watchedNamespaces = new Map<string, Watched[]>();
    const constants = new Map<string, string>();
    // A watched function's own module may call it too (an ungated wrapper there
    // would be a way around the rule), so its own name is watched there.
    for (const w of watched)
      if (w.module === here) watchedLocals.set(w.name, `${w.module}#${w.name}`);
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const target = resolveModule(file.path, stmt.moduleSpecifier.text);
        const bindings = stmt.importClause?.namedBindings;
        if (!target || !bindings) continue;
        if (ts.isNamespaceImport(bindings)) {
          const inModule = watched.filter((w) => w.module === target);
          if (inModule.length > 0) watchedNamespaces.set(bindings.name.text, inModule);
          continue;
        }
        for (const el of bindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (target === GATE.module && imported === GATE.name) gateNames.add(el.name.text);
          const w = watched.find((x) => x.module === target && x.name === imported);
          if (w) watchedLocals.set(el.name.text, `${w.module}#${w.name}`);
        }
      }
      if (ts.isVariableStatement(stmt) && stmt.declarationList.flags & ts.NodeFlags.Const) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer) {
            const v = unwrap(d.initializer);
            if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))
              constants.set(d.name.text, v.text);
          }
        }
      }
    }

    const reference = (node: ts.Node, watchedKey: string, how: Reference['how']) => {
      references.get(watchedKey)!.push({
        key: `${file.path}#${siteName(node)}`,
        file: file.path,
        line: lineOf(node),
        how,
        gated: how === 'call' && gatedBefore(node, gateNames),
      });
    };

    const recordWrite = (
      fromCall: ts.CallExpression,
      verbCall: ts.CallExpression,
      verb: string,
    ) => {
      const table = stringValue(fromCall.arguments[0]!, constants);
      if (table === null) {
        unreadTables.push({ key: `${file.path}#${siteName(verbCall)}`, line: lineOf(verbCall) });
        return;
      }
      if (!TABLES.has(table)) return;
      writes.push({
        key: `${file.path}#${siteName(verbCall)}`,
        file: file.path,
        // The line of `.from(`, which a chain split over lines puts below its receiver.
        line: lineOf((fromCall.expression as ts.PropertyAccessExpression).name),
        table: table as Table,
        verb: verb as WriteSite['verb'],
        role: table === 'organization_members' ? seatRole(verbCall.arguments[0]) : null,
        gated: gatedBefore(verbCall, gateNames),
      });
    };

    const visit = (node: ts.Node): void => {
      // `<x>.from(<table>)`, then up its chain to an insert or upsert.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'from' &&
        node.arguments.length === 1
      ) {
        let cur: ts.Node = node;
        let found = false;
        for (;;) {
          const p: ts.Node = cur.parent;
          if (ts.isPropertyAccessExpression(p) && p.expression === cur) {
            if (
              WRITE_VERBS.has(p.name.text) &&
              ts.isCallExpression(p.parent) &&
              p.parent.expression === p
            ) {
              recordWrite(node, p.parent, p.name.text);
              found = true;
              break;
            }
            cur = p;
          } else if (
            (ts.isCallExpression(p) && p.expression === cur) ||
            ts.isParenthesizedExpression(p) ||
            ts.isNonNullExpression(p) ||
            ts.isAsExpression(p)
          ) {
            cur = p;
          } else break;
        }
        // Held in a variable (`const q = admin.from(t); await q.insert(row)`): every
        // insert or upsert on that name in the same function.
        const holder = cur.parent;
        if (
          !found &&
          ts.isVariableDeclaration(holder) &&
          holder.initializer === cur &&
          ts.isIdentifier(holder.name)
        ) {
          const name = holder.name.text;
          const scope: ts.Node = enclosingFunction(holder) ?? sf;
          const find = (n: ts.Node): void => {
            if (
              ts.isCallExpression(n) &&
              ts.isPropertyAccessExpression(n.expression) &&
              ts.isIdentifier(n.expression.expression) &&
              n.expression.expression.text === name &&
              WRITE_VERBS.has(n.expression.name.text)
            ) {
              recordWrite(node, n, n.expression.name.text);
            }
            ts.forEachChild(n, find);
          };
          find(scope);
        }
      }

      // References to a watched function outside its own module.
      if (ts.isIdentifier(node) && watchedLocals.has(node.text)) {
        const p = node.parent;
        const declaration =
          ts.isImportSpecifier(p) ||
          ts.isImportClause(p) ||
          ts.isNamespaceImport(p) ||
          ((ts.isFunctionDeclaration(p) ||
            ts.isVariableDeclaration(p) ||
            ts.isPropertyAssignment(p) ||
            ts.isMethodDeclaration(p)) &&
            p.name === node);
        const member = ts.isPropertyAccessExpression(p) && p.name === node;
        if (!declaration && !member) {
          const how = ts.isCallExpression(p) && p.expression === node ? 'call' : 'value';
          reference(node, watchedLocals.get(node.text)!, how);
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        watchedNamespaces.has(node.expression.text)
      ) {
        const w = watchedNamespaces
          .get(node.expression.text)!
          .find((x) => x.name === node.name.text);
        if (w) {
          const how =
            ts.isCallExpression(node.parent) && node.parent.expression === node ? 'call' : 'value';
          reference(node, `${w.module}#${w.name}`, how);
        }
      }
      // A dynamic import of a watched module cannot be followed: it counts as a use.
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const target = resolveModule(file.path, node.arguments[0].text);
        for (const w of watched) {
          if (w.module === target && w.module !== here)
            reference(node, `${w.module}#${w.name}`, 'value');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { writes, unreadTables, references };
}

// ── The rules ───────────────────────────────────────────────────────────────

interface ReviewedSeat {
  key: string;
  role: SeatRole;
  why: string;
  /** The function whose every call must be gated, when the seat has no check of its own. */
  callers?: { watched: Watched; keys: string[] };
}

/** Rule 1: the only places that create a workspace, each gated. */
const WORKSPACE_CREATORS = [
  'server/actions/organization.ts#createOrganizationAction',
  'server/actions/platform-admin.ts#createOrgForCustomerAction',
];

/** Rule 2, gated: the owner seats written by those same two functions. */
const GATED_OWNER_SEATS = [
  'server/actions/organization.ts#createOrganizationAction',
  'server/actions/platform-admin.ts#createOrgForCustomerAction',
];

/** Rule 2, reviewed: membership writes that can seat an owner and carry no check of their own. */
const REVIEWED_SEATS: ReviewedSeat[] = [
  {
    key: 'server/services/platform/impersonation.ts#startActingAs',
    role: 'owner',
    why: 'The Act as seat: a temporary owner row for the platform admin, with no check of its own. Every caller must run the platform-admin check first.',
    callers: {
      watched: { module: 'server/services/platform/impersonation', name: 'startActingAs' },
      keys: ['server/actions/platform/impersonation.ts#startActingAsAction'],
    },
  },
  {
    key: 'server/services/team.ts#acceptInviteWithToken',
    role: 'unknown',
    why: "Invite acceptance writes the invite's own role, and organization_invites.role is checked to admin, manager, staff or viewer (0001_init.sql, never altered), so it never seats an owner. The invite token gates it.",
  },
];

/** Inserts and upserts through a table the scan cannot read, each checked by hand. */
const REVIEWED_UNREAD_TABLES: Array<{ key: string; why: string }> = [
  {
    key: 'server/services/restore-points.ts#ensureRefMap',
    why: "`table` is typed 'categories' | 'suppliers', and the write goes through the caller's own client, so RLS decides.",
  },
];

const describeSite = (s: { key: string; line: number }) => `${s.key} (line ${s.line})`;

function ungatedWorkspaceCreators(scan: Scan): string[] {
  return scan.writes.filter((w) => w.table === 'organizations' && !w.gated).map(describeSite);
}

function unreviewedOwnerSeats(scan: Scan, reviewed: readonly ReviewedSeat[]): string[] {
  return scan.writes
    .filter(
      (w) =>
        w.table === 'organization_members' &&
        w.role !== 'other' &&
        !w.gated &&
        !reviewed.some((r) => r.key === w.key && r.role === w.role),
    )
    .map((w) => `${describeSite(w)} role ${w.role}`);
}

function ungatedCallers(scan: Scan, reviewed: readonly ReviewedSeat[]): string[] {
  const out: string[] = [];
  for (const r of reviewed) {
    if (!r.callers) continue;
    const refs = scan.references.get(`${r.callers.watched.module}#${r.callers.watched.name}`) ?? [];
    for (const ref of refs) {
      if (ref.how !== 'call')
        out.push(
          `${describeSite(ref)} uses ${r.callers.watched.name} as a value (cannot be followed)`,
        );
      else if (!ref.gated)
        out.push(`${describeSite(ref)} calls ${r.callers.watched.name} without the check`);
    }
  }
  return out;
}

// ── The real sources ────────────────────────────────────────────────────────

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string, out: ScanFile[] = []): ScanFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '__tests__' ||
        full === path.join(SRC, 'test')
      )
        continue;
      sourceFiles(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push({
        path: path.relative(SRC, full).split(path.sep).join('/'),
        text: readFileSync(full, 'utf8'),
      });
    }
  }
  return out;
}

const WATCHED = REVIEWED_SEATS.flatMap((r) => (r.callers ? [r.callers.watched] : []));
const real = scanSources(sourceFiles(SRC), WATCHED);

describe('who creates a workspace or an owner seat (apps/web/src)', () => {
  it('Rule 1: every insert or upsert into organizations runs after the platform-admin check, in exactly the two known functions', () => {
    expect(ungatedWorkspaceCreators(real)).toEqual([]);
    const creators = [
      ...new Set(real.writes.filter((w) => w.table === 'organizations').map((w) => w.key)),
    ];
    expect(creators.sort()).toEqual([...WORKSPACE_CREATORS].sort());
  });

  it('Rule 2: every membership write that can seat an owner is gated the same way or reviewed, and the sets are pinned', () => {
    expect(unreviewedOwnerSeats(real, REVIEWED_SEATS)).toEqual([]);
    const seats = real.writes.filter(
      (w) => w.table === 'organization_members' && w.role !== 'other',
    );
    const gated = [...new Set(seats.filter((w) => w.gated).map((w) => w.key))];
    expect(gated.sort()).toEqual([...GATED_OWNER_SEATS].sort());
    expect(
      seats.filter((w) => w.key.endsWith('#createOrganizationAction')).map((w) => w.role),
    ).toEqual(['owner']);
  });

  it('Rule 2: every use of startActingAs is a call that runs after the platform-admin check, from the pinned functions only', () => {
    expect(ungatedCallers(real, REVIEWED_SEATS)).toEqual([]);
    for (const r of REVIEWED_SEATS) {
      if (!r.callers) continue;
      const refs = real.references.get(`${r.callers.watched.module}#${r.callers.watched.name}`)!;
      expect([...new Set(refs.map((x) => x.key))].sort(), r.key).toEqual(
        [...r.callers.keys].sort(),
      );
    }
  });

  it('no reviewed entry is stale: each still names a write of that role, ungated', () => {
    for (const r of REVIEWED_SEATS) {
      const hits = real.writes.filter((w) => w.table === 'organization_members' && w.key === r.key);
      expect(hits.length, r.key).toBeGreaterThan(0);
      expect(
        hits.every((w) => w.role === r.role && !w.gated),
        `${r.key}: ${JSON.stringify(hits.map((w) => ({ role: w.role, gated: w.gated })))}`,
      ).toBe(true);
    }
  });

  it('every insert or upsert names its table in a way the scan can read (or is reviewed)', () => {
    expect(real.unreadTables.map((u) => u.key).sort()).toEqual(
      REVIEWED_UNREAD_TABLES.map((r) => r.key).sort(),
    );
  });
});

// ── The scan itself, on planted sources ─────────────────────────────────────

const PLANTED: ScanFile[] = [
  {
    path: 'server/actions/planted-gated.ts',
    text: [
      `'use server';`,
      `import { checkPlatformAdmin } from '@/lib/auth/platform-admin';`,
      `export async function gatedCreate(admin: any) {`,
      `  const gate = await checkPlatformAdmin({ requireStepUp: true });`,
      `  if (!gate.ok) {`,
      `    return null;`,
      `  }`,
      `  const { data } = await admin`,
      `    .from('organizations')`,
      ``,
      `    .insert({ name: 'x' })`,
      `    .select('id')`,
      `    .single();`,
      `  await admin.from('organization_members').insert({ organization_id: data.id, user_id: 'u', role: 'owner' });`,
      `  return data;`,
      `}`,
    ].join('\n'),
  },
  {
    path: 'server/actions/planted-ungated.ts',
    text: [
      `'use server';`,
      `import { checkPlatformAdmin } from '@/lib/auth/platform-admin';`,
      `export async function ungatedCreate(admin: any) {`,
      `  await admin.from('organizations').insert({ name: 'x' });`,
      `}`,
      `// A comment that mentions admin.from('organizations').insert({}) is not a write.`,
      `export const note = "admin.from('organizations').upsert({}) in a string is not one either";`,
      `export async function viaVariable(admin: any) {`,
      `  const q = admin.from('organizations');`,
      `  await q.upsert({ name: 'x' });`,
      `}`,
      `const ORGS = 'organizations';`,
      `export async function viaConstant(admin: any) {`,
      `  await admin.from(ORGS).insert({ name: 'x' });`,
      `}`,
      `export async function viaUnknownTable(admin: any, table: string) {`,
      `  await admin.from(table).insert({ name: 'x' });`,
      `}`,
      `export async function answerIgnored(admin: any) {`,
      `  await checkPlatformAdmin({ requireStepUp: true });`,
      `  await admin.from('organizations').insert({ name: 'x' });`,
      `}`,
      `export async function checkedAfter(admin: any) {`,
      `  await admin.from('organizations').insert({ name: 'x' });`,
      `  const gate = await checkPlatformAdmin({ requireStepUp: true });`,
      `  if (!gate.ok) return null;`,
      `}`,
      `export async function noStepUp(admin: any) {`,
      `  const gate = await checkPlatformAdmin();`,
      `  if (!gate.ok) return null;`,
      `  await admin.from('organizations').insert({ name: 'x' });`,
      `}`,
      `export async function checkedInABranch(admin: any, x: boolean) {`,
      `  if (x) {`,
      `    const gate = await checkPlatformAdmin({ requireStepUp: true });`,
      `    if (!gate.ok) return null;`,
      `  }`,
      `  await admin.from('organizations').insert({ name: 'x' });`,
      `}`,
    ].join('\n'),
  },
  {
    path: 'server/actions/planted-impostor.ts',
    text: [
      `'use server';`,
      `async function checkPlatformAdmin(_o: unknown) { return { ok: true }; }`,
      `export async function localCheck(admin: any) {`,
      `  const gate = await checkPlatformAdmin({ requireStepUp: true });`,
      `  if (!gate.ok) return null;`,
      `  await admin.from('organizations').insert({ name: 'x' });`,
      `}`,
    ].join('\n'),
  },
  {
    path: 'server/services/planted-seats.ts',
    text: [
      `export async function ownerSeat(admin: any) {`,
      `  await admin.from('organization_members').insert({ user_id: 'u', role: 'owner' });`,
      `}`,
      `export async function staffSeat(admin: any) {`,
      `  await admin.from('organization_members').insert({ user_id: 'u', role: 'staff' });`,
      `}`,
      `export async function roleFromInput(admin: any, role: string) {`,
      `  await admin.from('organization_members').upsert({ user_id: 'u', role });`,
      `}`,
      `export async function spreadRow(admin: any, extra: object) {`,
      `  await admin.from('organization_members').insert({ user_id: 'u', ...extra });`,
      `}`,
      `export async function ownerInAList(admin: any) {`,
      `  await admin.from('organization_members').insert([{ role: 'staff' }, { role: 'owner' }]);`,
      `}`,
      `export async function grantSeat(admin: any) {`,
      `  await admin.from('organization_members').upsert({ user_id: 'u', role: 'owner' });`,
      `}`,
      `export async function wrapsGrant(admin: any) {`,
      `  return grantSeat(admin);`,
      `}`,
    ].join('\n'),
  },
  {
    path: 'server/actions/planted-callers.ts',
    text: [
      `'use server';`,
      `import { checkPlatformAdmin } from '@/lib/auth/platform-admin';`,
      `import { grantSeat } from '@/server/services/planted-seats';`,
      `import * as seats from '../services/planted-seats';`,
      `export async function gatedCaller() {`,
      `  const gate = await checkPlatformAdmin({ requireStepUp: true });`,
      `  if (!gate.ok) return null;`,
      `  try {`,
      `    await grantSeat({});`,
      `  } catch {}`,
      `}`,
      `export async function ungatedCaller() {`,
      `  await grantSeat({});`,
      `}`,
      `export async function namespaceCaller() {`,
      `  await seats.grantSeat({});`,
      `}`,
      `export function handOn() { return [grantSeat]; }`,
      `export async function lateImport() {`,
      `  const m = await import('@/server/services/planted-seats');`,
      `  return m;`,
      `}`,
    ].join('\n'),
  },
];

const PLANTED_SEAT: ReviewedSeat = {
  key: 'server/services/planted-seats.ts#grantSeat',
  role: 'owner',
  why: 'planted',
  callers: {
    watched: { module: 'server/services/planted-seats', name: 'grantSeat' },
    keys: ['server/actions/planted-callers.ts#gatedCaller'],
  },
};

const planted = scanSources(PLANTED, [PLANTED_SEAT.callers!.watched]);
const plantedWrite = (key: string) => planted.writes.filter((w) => w.key === key);

describe('the scan, on planted sources', () => {
  it('a gated function passes, and a write chain split over lines is still found', () => {
    const writes = plantedWrite('server/actions/planted-gated.ts#gatedCreate');
    expect(writes.map((w) => [w.table, w.verb, w.role, w.gated])).toEqual([
      ['organizations', 'insert', null, true],
      ['organization_members', 'insert', 'owner', true],
    ]);
    expect(writes[0]!.line).toBe(9);
  });

  it('an ungated function fails, through a variable and through a constant too; comments and strings are not writes', () => {
    expect(ungatedWorkspaceCreators(planted)).toEqual([
      'server/actions/planted-ungated.ts#ungatedCreate (line 4)',
      'server/actions/planted-ungated.ts#viaVariable (line 9)',
      'server/actions/planted-ungated.ts#viaConstant (line 14)',
      'server/actions/planted-ungated.ts#answerIgnored (line 21)',
      'server/actions/planted-ungated.ts#checkedAfter (line 24)',
      'server/actions/planted-ungated.ts#noStepUp (line 31)',
      'server/actions/planted-ungated.ts#checkedInABranch (line 38)',
      'server/actions/planted-impostor.ts#localCheck (line 6)',
    ]);
  });

  it('a table the scan cannot read is reported', () => {
    expect(planted.unreadTables.map((u) => u.key)).toEqual([
      'server/actions/planted-ungated.ts#viaUnknownTable',
    ]);
  });

  it('a membership row reads as owner, another role, or unknown (a variable or a spread)', () => {
    const roleOf = (fn: string) =>
      plantedWrite(`server/services/planted-seats.ts#${fn}`).map((w) => w.role);
    expect(roleOf('ownerSeat')).toEqual(['owner']);
    expect(roleOf('staffSeat')).toEqual(['other']);
    expect(roleOf('roleFromInput')).toEqual(['unknown']);
    expect(roleOf('spreadRow')).toEqual(['unknown']);
    expect(roleOf('ownerInAList')).toEqual(['owner']);
    expect(unreviewedOwnerSeats(planted, [PLANTED_SEAT])).toEqual([
      'server/services/planted-seats.ts#ownerSeat (line 2) role owner',
      'server/services/planted-seats.ts#roleFromInput (line 8) role unknown',
      'server/services/planted-seats.ts#spreadRow (line 11) role unknown',
      'server/services/planted-seats.ts#ownerInAList (line 14) role owner',
    ]);
  });

  it('a reviewed seat whose function is called without the check fails, from its own module too, as does a use the scan cannot follow', () => {
    expect(ungatedCallers(planted, [PLANTED_SEAT])).toEqual([
      'server/services/planted-seats.ts#wrapsGrant (line 20) calls grantSeat without the check',
      'server/actions/planted-callers.ts#ungatedCaller (line 13) calls grantSeat without the check',
      'server/actions/planted-callers.ts#namespaceCaller (line 16) calls grantSeat without the check',
      'server/actions/planted-callers.ts#handOn (line 18) uses grantSeat as a value (cannot be followed)',
      'server/actions/planted-callers.ts#lateImport (line 20) uses grantSeat as a value (cannot be followed)',
    ]);
    const gatedRef = planted.references
      .get('server/services/planted-seats#grantSeat')!
      .find((r) => r.key === 'server/actions/planted-callers.ts#gatedCaller');
    expect(gatedRef).toMatchObject({ how: 'call', gated: true });
  });
});
