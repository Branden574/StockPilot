/**
 * EXPORT EVENTS ARE RECORDED ONLY BY THE SERVER'S ONE HELPER (S67a).
 *
 * Security invariant (listed in scripts/security-test.sh).
 *
 * Connector export events (outbox_events, drained to QuickBooks, Sage Intacct
 * and Zendesk) are written by the database function publish_outbox. The app
 * calls it in exactly one place, apps/web/src/server/lib/outbox-events.ts,
 * which writes through the service client (createAdminClient()), in the
 * organization of the checked service context or the one the server resolved
 * for a requester's return or a public request, after the action the event
 * reports. This file holds the code to that.
 *
 * WHAT IS SCANNED. Every source file of the repository (.ts .tsx .js .jsx
 * .mjs .cjs .mts .cts) under its root, walked on disk: the web app (src,
 * scripts, tests' helpers), the phone (src, app, scripts, plugins, config),
 * packages (core, config), integrations/zapier, load-tests, scripts and the
 * design prototypes. Left out, each for a reason (SCAN_EXCLUDES): node_modules
 * and build output (dist, build, out, coverage, and every dot directory such
 * as .next, .expo, .turbo, .git), which are not source; declaration files
 * (.d.ts .d.mts .d.cts), which hold no code that runs; and test and spec
 * files, which never ship and run against stubs or a local lab. The SQL under
 * supabase/ is not JavaScript; its own pgTAP tests hold the database side.
 *
 * THE RULES
 *   Rule 1. No scanned file names publish_outbox but the helper: not in a
 *   string, a template, a raw /rest/v1/rpc/ URL or a constant handed around.
 *   Rule 2. Every `.rpc(` call names its function as a literal, so a name
 *   built at run time ('publish_' + 'outbox', a variable) cannot reach
 *   publish_outbox unseen; and `rpc` is never read off a client except to
 *   call it there (no `client['rpc']`, `const { rpc } = client`,
 *   `client.rpc.call(...)`).
 *   Rule 3. No scanned file names the table outbox_events in a string or a
 *   template (a direct write through any client), and every insert, upsert,
 *   update or delete on a `.from(` whose table is not a literal is listed in
 *   DYNAMIC_FROM_WRITES with the tables it can name.
 *   Rule 4. In the helper, publish_outbox is called once, directly on
 *   `createAdminClient()` imported from '@/lib/supabase/admin', and the
 *   module exports only HELPER_EXPORTS.
 *   Rule 5. The helper module is imported only by the files that hold a site,
 *   and only by a plain named import with no alias (no default, no namespace,
 *   no `as`); never re-exported, never loaded by `import(...)`, `require(...)`
 *   or `import x = require(...)`. A load whose path is not a literal is
 *   listed in DYNAMIC_LOADS. The helper's two functions are referenced only
 *   as the callee of a call (never kept in a variable or handed on).
 *   Rule 6. The helper is called only at the sites in SITES, each with its
 *   topic. The event is an object literal with exactly topic, aggregateId and
 *   payload (no spread, no computed key), or a call of a named builder in the
 *   same file that returns one. A member site passes `this.ctx` and runs its
 *   permission check (the gate) before the event, in the same member or, for
 *   a private member, in its one caller before the call. A site with no
 *   signed-in member passes the first argument written in SITES, and every
 *   binding that argument reads is pinned to where it comes from (the link
 *   resolved by its token hash; the database function's answer).
 *
 * IF THIS FAILS
 *   - "names publish_outbox" / "names outbox_events": record the event with
 *     publishOutboxEvent(this.ctx, ...) after the action and its permission
 *     check; never call the function or write the table.
 *   - "is not a literal" / "reads rpc off a client": name the function in the
 *     `.rpc(` call itself.
 *   - "imports" / "loads" / "references": import the two functions by name,
 *     in a file with a site, and call them directly.
 *   - "new export-event site" / "moved" / "binding": read the new code. It
 *     must run after the service's own permission check and after the action
 *     it reports, and take its organization from the checked context or the
 *     server's own resolution; then update SITES with what it reads.
 *   - "before its gate": the event moved above the permission check, or the
 *     check was removed. Put the check back first.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../../..');

const HELPER = 'apps/web/src/server/lib/outbox-events.ts';
const HELPER_EXPORTS = [
  'MemberOutboxTopic',
  'OutboxEventInput',
  'OutboxTopic',
  'ResolvedOrganization',
  'ResolvedOutboxTopic',
  'publishOutboxEvent',
  'publishOutboxEventForResolvedOrganization',
];
const FN = 'publish_outbox';
const TABLE = 'outbox_events';

/** Directory names never walked, and why. */
const SCAN_EXCLUDES: Record<string, string> = {
  node_modules: 'installed packages, not this repository',
  dist: 'build output',
  build: 'build output',
  out: 'build output',
  coverage: 'test coverage output',
};
const SOURCE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;
const DECLARATION = /\.d\.(ts|mts|cts)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Writes on a `.from(` whose table is not a literal: `<path>#<member>` and why. */
const DYNAMIC_FROM_WRITES: Record<string, string> = {
  'apps/web/src/server/services/recovery.ts#RecoveryService.restore':
    "ENTITY_TABLE[entity]: 'inventory_items', 'categories', 'locations' or 'suppliers' (also listed in rpc-active-organization.guard.test.ts).",
  'apps/web/src/server/services/restore-points.ts#ensureRefMap':
    "table is typed 'categories' | 'suppliers'; the insert carries the context's organization.",
  'apps/web/scripts/perf-lab/lib.mjs#orgScope':
    "The owner-run Perf Lab tooling's insert, update and delete, each held to the Perf Lab organization; every table name is a literal at its call site in the seed scripts.",
  'apps/web/scripts/seed-demo-org.mjs#findOrCreate':
    "The owner-run Demo Co seed script's find-or-create; every table name is a literal at its call site.",
};

/** `import(...)` or `require(...)` whose path is not a literal: `<path>` and why. */
const DYNAMIC_LOADS: Record<string, string> = {
  'apps/web/tests/e2e/appearance/kill-switch-compare.mjs':
    'Loads stage5a-records.ts beside it (a local release check).',
  'apps/web/tests/e2e/appearance/rehearsal-compare.mjs':
    'Loads stage5a-records.ts beside it (a local release check).',
  'apps/web/tests/e2e/appearance/route-table-compare.mjs':
    'Loads stage5a-records.ts beside it (a local release check).',
};

type Site =
  | {
      kind: 'member';
      /** The topic literal, or `<builder>():<topic>` when a named builder makes the event. */
      topic: string;
      /** The permission check, as written, that runs before the event. */
      gate: string;
      /** For a private member: the one member that calls it, after the gate. */
      gateIn?: string;
    }
  | {
      kind: 'resolved';
      topic: string;
      /** The first argument, white space removed. */
      firstArg: string;
      /** Every write of each binding the first argument reads, in the member, white space removed. */
      bindings: Record<string, string[]>;
    };

const ROUTE = 'apps/web/src/app/api/v1/public/order-requests/route.ts';
const RETURNS = 'apps/web/src/server/services/returns.ts';
const PO = 'apps/web/src/server/services/purchase-orders.ts';

/** Every call of the helper: `<path>#<member>` (one call each). */
const SITES: Record<string, Site> = {
  [`${PO}#PurchaseOrdersService.updateStatus`]: {
    kind: 'member',
    topic: 'purchase_order.ordered',
    gate: "assertPermission(this.ctx, 'purchase_orders:manage')",
  },
  'apps/web/src/server/services/receiving.ts#ReceivingService.postReceipt': {
    kind: 'member',
    topic: 'receipt.posted',
    gate: "assertPermission(this.ctx, 'stock:adjust')",
  },
  [`${RETURNS}#RMAService.createFromOrder`]: {
    kind: 'member',
    topic: 'returnCreatedEvent():return.created',
    gate: 'this.gate()',
  },
  [`${RETURNS}#RMAService.publishReturnClosed`]: {
    kind: 'member',
    topic: 'return.closed',
    gate: 'this.gate()',
    gateIn: 'RMAService.close',
  },
  'apps/web/src/server/services/order-requests.ts#OrderRequestsService.deny': {
    kind: 'member',
    topic: 'order.problem',
    gate: "assertPermission(this.ctx, 'orders:approve')",
  },
  [`${RETURNS}#createRequesterRpc`]: {
    kind: 'resolved',
    topic: 'returnCreatedEvent():return.created',
    firstArg: "{organizationId:result.organizationId,resolvedBy:'requester_return'}",
    bindings: {
      // The organization the database function answered with, else the one
      // the server resolved for the order (token, portal or member; the
      // callers are pinned in rpc-active-organization.guard.test.ts).
      result: [
        'const:{id,returnNumber,organizationId:str(answer.organizationId)??ctx.organizationId,replay:answer.replay===true,}',
      ],
      answer: ['const:asObject(data)'],
      data: [
        "data<-awaitadmin.rpc('create_requester_return_request',{p_order_id:ctx.orderRequestId,p_request:{reasonCode:body.reasonCode??null,notes:body.notes??null,lines:body.lines.map((l)=>({orderRequestLineId:l.orderRequestLineId,quantity:l.quantity,...(l.exchange!==undefined&&l.exchange!==null?{exchange:l.exchange}:{}),})),},p_key:key,p_actor:{channel:actor.channel,userId:actor.userId},})",
      ],
      ctx: ['param:RequesterOrderRef'],
    },
  },
  [`${ROUTE}#POST`]: {
    kind: 'resolved',
    topic: 'public_request.created',
    firstArg: "{organizationId,resolvedBy:'public_request_link'}",
    bindings: {
      // The organization of the open link found by the token's hash, else of
      // the legacy organization token's hash; never a field of the body.
      organizationId: [
        'let:<no value>',
        'organizationId=link.organization_id',
        'organizationId=(orgas{id:string}).id',
      ],
      link: ['const:(linkRowRawasPublicLinkRow|null)??null'],
      linkRowRaw: [
        "data<-awaitadmin.from('public_request_links').select('id,organization_id,active,expires_at,available_from,available_until,default_max_qty',).eq('token_hash',sha256Hex(body.token)).maybeSingle()",
      ],
      org: [
        "data<-awaitadmin.from('organizations').select('id').eq('public_request_token_hash',sha256Hex(body.token)).maybeSingle()",
      ],
      admin: ['const:createAdminClient()'],
    },
  },
};

const SITE_FILES = new Set(Object.keys(SITES).map((k) => k.split('#')[0]!));

/** The gate a private member's caller holds: RMAService.gate() checks returns:manage. */
const GATE_MEANING = {
  'this.gate()':
    "RMAService.gate(): assertModuleEnabled(returns) and assertPermission(this.ctx, 'returns:manage')",
} as const;

/* ---- the tree ---- */

interface Tree {
  files: string[];
  read(file: string): string;
}

function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name in SCAN_EXCLUDES) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), relPath));
    else if (SOURCE.test(e.name) && !DECLARATION.test(e.name) && !TEST_FILE.test(e.name))
      out.push(relPath);
  }
  return out.sort();
}

function diskTree(root: string): Tree {
  const cache = new Map<string, string>();
  return {
    files: listFiles(root),
    read(f) {
      let text = cache.get(f);
      if (text === undefined) {
        text = readFileSync(path.join(root, f), 'utf8');
        cache.set(f, text);
      }
      return text;
    },
  };
}

const REAL = diskTree(REPO);

function withFile(tree: Tree, file: string, source: string): Tree {
  return {
    files: tree.files.includes(file) ? tree.files : [...tree.files, file].sort(),
    read: (f) => (f === file ? source : tree.read(f)),
  };
}

function parse(file: string, source: string): ts.SourceFile {
  const kind = /x$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.[cm]?js$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  const u = unwrap(node);
  return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : null;
}

/** The text of a node with its white space removed, to compare shapes. */
function flat(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, '');
}

/** `<Class>.<member>` or the top-level function or const a node sits in. */
function memberOf(node: ts.Node): string {
  let n: ts.Node | undefined = node;
  while (n) {
    if (
      (ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n) || ts.isGetAccessor(n)) &&
      ts.isClassLike(n.parent)
    ) {
      const cls = n.parent.name?.text ?? '<anonymous class>';
      return `${cls}.${n.name.getText()}`;
    }
    if (ts.isFunctionDeclaration(n) && ts.isSourceFile(n.parent))
      return n.name?.text ?? '<default>';
    if (
      ts.isVariableDeclaration(n) &&
      ts.isVariableStatement(n.parent.parent) &&
      ts.isSourceFile(n.parent.parent.parent)
    ) {
      return n.name.getText();
    }
    if (ts.isSourceFile(n)) return '<top-level>';
    n = n.parent;
  }
  return '<top-level>';
}

/** The member a key names. */
function findMember(sf: ts.SourceFile, key: string): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) &&
      n.name &&
      memberOf(n) === key
    ) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The start of the first call in `body` whose flat text is `call`, or -1. */
function callStart(body: ts.Node, sf: ts.SourceFile, call: string): number {
  let at = -1;
  const want = call.replace(/\s+/g, '');
  const visit = (n: ts.Node) => {
    if (at >= 0) return;
    if (ts.isCallExpression(n) && flat(n, sf) === want) {
      at = n.getStart(sf);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return at;
}

/** The identifier a left-hand side starts from (`a` for `a.b[c]`). */
function rootName(node: ts.Node): string | null {
  let n = unwrap(node);
  while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))
    n = unwrap(n.expression);
  return ts.isIdentifier(n) ? n.text : null;
}

const ASSIGN = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** Every write of `name` inside a member: declarations, destructuring, parameters, assignments. */
function writesOf(member: ts.Node, sf: ts.SourceFile, name: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      const kind = n.parent.flags & ts.NodeFlags.Const ? 'const' : 'let';
      out.push(`${kind}:${n.initializer ? flat(n.initializer, sf) : '<no value>'}`);
    } else if (ts.isBindingElement(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      let decl: ts.Node = n.parent;
      while (decl && !ts.isVariableDeclaration(decl) && !ts.isParameter(decl)) decl = decl.parent;
      const from =
        decl && ts.isVariableDeclaration(decl) && decl.initializer
          ? flat(decl.initializer, sf)
          : '<parameter>';
      out.push(`${(n.propertyName ?? n.name).getText(sf)}<-${from}`);
    } else if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      out.push(`param:${n.type ? flat(n.type, sf) : '<untyped>'}`);
    } else if (
      ts.isBinaryExpression(n) &&
      ASSIGN.has(n.operatorToken.kind) &&
      rootName(n.left) === name
    ) {
      out.push(`${flat(n.left, sf)}${n.operatorToken.getText(sf)}${flat(n.right, sf)}`);
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken) &&
      rootName(n.operand) === name
    ) {
      out.push(flat(n, sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(member);
  return out;
}

/* ---- the scan ---- */

const HELPER_NAMES = new Set(['publishOutboxEvent', 'publishOutboxEventForResolvedOrganization']);
const HELPER_PATH = /(^|\/)outbox-events(\.[cm]?[jt]sx?)?$/;

interface HelperCall {
  key: string;
  fn: string;
  firstArg: string;
  topic: string;
  start: number;
}

/**
 * The event's topic as the scan reads it: the literal of an object literal
 * with exactly topic, aggregateId and payload, or `<builder>():<topic>` for a
 * builder in the same file that returns such a literal. Anything else is a
 * `<...>` that matches no site.
 */
function eventTopic(event: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (!event) return '<none>';
  const u = unwrap(event);
  if (ts.isObjectLiteralExpression(u)) return literalEventTopic(u, sf);
  if (ts.isCallExpression(u) && ts.isIdentifier(u.expression)) {
    const builder = sf.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === (u.expression as ts.Identifier).text,
    );
    const body = builder?.body?.statements ?? [];
    const ret =
      body.length === 1 && ts.isReturnStatement(body[0]!) ? body[0].expression : undefined;
    const lit = ret ? unwrap(ret) : undefined;
    const topic =
      lit && ts.isObjectLiteralExpression(lit)
        ? literalEventTopic(lit, sf)
        : '<builder not a literal>';
    return `${u.expression.text}():${topic}`;
  }
  return '<not a literal>';
}

function literalEventTopic(o: ts.ObjectLiteralExpression, sf: ts.SourceFile): string {
  const keys: string[] = [];
  let topic: string | null = null;
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) return '<spread>';
    if (p.name && ts.isComputedPropertyName(p.name)) return '<computed key>';
    const name = p.name?.getText(sf) ?? '<?>';
    keys.push(name);
    if (name === 'topic') {
      topic = ts.isPropertyAssignment(p) ? literalText(p.initializer) : null;
    }
  }
  if ([...keys].sort().join(',') !== 'aggregateId,payload,topic') return `<keys ${keys.join(',')}>`;
  return topic ?? '<not a literal>';
}

const scans = new Map<string, { source: string; scan: ReturnType<typeof scanFileUncached> }>();

/** Everything the rules need from one file (kept per file while its text is unchanged). */
function scanFile(file: string, source: string) {
  const hit = scans.get(file);
  if (hit && hit.source === source) return hit.scan;
  const scan = scanFileUncached(file, source);
  scans.set(file, { source, scan });
  return scan;
}

function scanFileUncached(file: string, source: string) {
  const sf = parse(file, source);
  const named: string[] = [];
  const tableNamed: string[] = [];
  const dynamicRpc: string[] = [];
  const looseRpc: string[] = [];
  const fromWrites: string[] = [];
  const badImports: string[] = [];
  const helperImports: string[] = [];
  const dynamicLoads: string[] = [];
  const looseHelper: string[] = [];
  const helperCalls: HelperCall[] = [];
  const outboxRpcs: Array<{ receiver: string; line: number }> = [];
  const where = (n: ts.Node) =>
    `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const isHelperPath = (n: ts.Node | undefined) => HELPER_PATH.test(literalText(n) ?? '');

  const visit = (n: ts.Node) => {
    // Rules 1 and 3: any string or template piece naming the function or the table.
    if (
      ts.isStringLiteralLike(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      const text = (n as ts.LiteralLikeNode).text;
      if (text.includes(FN)) named.push(where(n));
      if (text.includes(TABLE)) tableNamed.push(where(n));
    }
    // Rule 2: `rpc` read off anything is called right there, on a literal name.
    const rpcRead =
      (ts.isPropertyAccessExpression(n) && n.name.text === 'rpc') ||
      (ts.isElementAccessExpression(n) && literalText(n.argumentExpression) === 'rpc');
    if (rpcRead) {
      const parent = n.parent;
      if (ts.isCallExpression(parent) && parent.expression === n) {
        const name = literalText(parent.arguments[0]);
        if (name === null) dynamicRpc.push(where(n));
        if (ts.isElementAccessExpression(n)) looseRpc.push(where(n));
        if (name === FN)
          outboxRpcs.push({
            receiver: flat(n.expression, sf),
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          });
      } else {
        looseRpc.push(where(n));
      }
    }
    if (ts.isBindingElement(n) && (n.propertyName ?? n.name).getText(sf) === 'rpc')
      looseRpc.push(where(n));
    // Rule 3: a write on a `.from(` whose table is not a literal.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'from' &&
      n.arguments.length === 1 &&
      literalText(n.arguments[0]) === null
    ) {
      let top: ts.Node = n;
      const ops: string[] = [];
      while (ts.isPropertyAccessExpression(top.parent) && ts.isCallExpression(top.parent.parent)) {
        ops.push(top.parent.name.text);
        top = top.parent.parent;
      }
      if (ops.some((o) => o === 'insert' || o === 'upsert' || o === 'update' || o === 'delete'))
        fromWrites.push(`${file}#${memberOf(n)}`);
    }
    // Rule 5: how the helper module is reached.
    if (ts.isImportDeclaration(n) && isHelperPath(n.moduleSpecifier)) {
      const clause = n.importClause;
      const bindings = clause?.namedBindings;
      const plain =
        clause !== undefined &&
        !clause.name &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.every((e) => !e.propertyName);
      if (!plain || !SITE_FILES.has(file)) badImports.push(where(n));
      else helperImports.push(where(n));
    }
    if (ts.isExportDeclaration(n) && isHelperPath(n.moduleSpecifier)) badImports.push(where(n));
    if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      isHelperPath(n.moduleReference.expression)
    ) {
      badImports.push(where(n));
    }
    if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
    ) {
      if (isHelperPath(n.arguments[0])) badImports.push(where(n));
      else if (literalText(n.arguments[0]) === null) dynamicLoads.push(file);
    }
    // Rules 5 and 6: the helper's functions, called directly or not at all.
    if (ts.isIdentifier(n) && HELPER_NAMES.has(n.text)) {
      const p = n.parent;
      const callee = ts.isCallExpression(p) && p.expression === n;
      const specifier = ts.isImportSpecifier(p);
      const declared = ts.isFunctionDeclaration(p) && p.name === n;
      if (callee) {
        helperCalls.push({
          key: `${file}#${memberOf(n)}`,
          fn: n.text,
          firstArg: p.arguments[0] ? flat(p.arguments[0], sf) : '<none>',
          topic: eventTopic(p.arguments[1], sf),
          start: p.getStart(sf),
        });
      } else if (!specifier && !declared) {
        looseHelper.push(where(n));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return {
    named,
    tableNamed,
    dynamicRpc,
    looseRpc,
    fromWrites,
    badImports,
    helperImports,
    dynamicLoads,
    looseHelper,
    helperCalls,
    outboxRpcs,
  };
}

/** The helper module's own shape: its exports and its service-client import. */
function helperShape(source: string) {
  const sf = parse(HELPER, source);
  const exportsList: string[] = [];
  let adminImported = false;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && literalText(st.moduleSpecifier) === '@/lib/supabase/admin') {
      const named = st.importClause?.namedBindings;
      if (
        named &&
        ts.isNamedImports(named) &&
        named.elements.some((e) => e.name.text === 'createAdminClient' && !e.propertyName)
      ) {
        adminImported = true;
      }
    }
    const exported =
      ts.canHaveModifiers(st) &&
      (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) {
      if (ts.isExportDeclaration(st) || ts.isExportAssignment(st))
        exportsList.push(`<${st.getText(sf).slice(0, 40)}>`);
      continue;
    }
    if (
      ts.isFunctionDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isClassDeclaration(st)
    ) {
      exportsList.push(st.name?.text ?? '<default>');
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) exportsList.push(d.name.getText(sf));
    } else {
      exportsList.push(`<${ts.SyntaxKind[st.kind]}>`);
    }
  }
  return { exports: exportsList.sort(), adminImported };
}

/** The words a file must hold for the scan to need its syntax tree. */
const WORTH_PARSING = [
  'rpc',
  FN,
  TABLE,
  'outbox-events',
  'publishOutboxEvent',
  'import(',
  'require(',
  '.from(',
];

/** Every rule over a tree; the list of failures. */
function verdict(tree: Tree): string[] {
  const failures: string[] = [];
  const seen = new Map<string, HelperCall[]>();
  const fromWrites = new Set<string>();
  const loads = new Set<string>();
  let helperRpcs: Array<{ receiver: string; line: number }> = [];

  for (const file of tree.files) {
    const source = tree.read(file);
    if (!WORTH_PARSING.some((w) => source.includes(w))) continue;
    const scan = scanFile(file, source);
    if (file === HELPER) {
      helperRpcs = scan.outboxRpcs;
      if (scan.named.length !== 1)
        failures.push(
          `${HELPER} names ${FN} ${scan.named.length} times (want once, in its one .rpc( call)`,
        );
    } else {
      for (const at of scan.named) failures.push(`${at} names ${FN} outside ${HELPER}`);
    }
    for (const at of scan.tableNamed) failures.push(`${at} names ${TABLE}`);
    for (const at of scan.dynamicRpc)
      failures.push(`${at} calls .rpc( with a function name that is not a literal`);
    for (const at of scan.looseRpc)
      failures.push(`${at} reads rpc off a client without calling it there by name`);
    for (const w of new Set(scan.fromWrites)) {
      fromWrites.add(w);
      if (!(w in DYNAMIC_FROM_WRITES))
        failures.push(`${w} writes through .from( a table that is not a literal`);
    }
    for (const at of scan.badImports)
      failures.push(
        `${at} imports or loads ${HELPER} other than by a plain named import in a site's file`,
      );
    for (const f of scan.dynamicLoads) {
      loads.add(f);
      if (!(f in DYNAMIC_LOADS)) failures.push(`${f} loads a module whose path is not a literal`);
    }
    for (const at of scan.looseHelper)
      failures.push(`${at} references the helper other than by calling it`);
    for (const call of scan.helperCalls) {
      const list = seen.get(call.key) ?? [];
      list.push(call);
      seen.set(call.key, list);
    }
  }
  for (const w of Object.keys(DYNAMIC_FROM_WRITES))
    if (!fromWrites.has(w)) failures.push(`stale: DYNAMIC_FROM_WRITES ${w} makes no such write`);
  for (const f of Object.keys(DYNAMIC_LOADS))
    if (!loads.has(f)) failures.push(`stale: DYNAMIC_LOADS ${f} makes no such load`);

  // Rule 4.
  if (helperRpcs.length !== 1) {
    failures.push(`${HELPER} calls ${FN} ${helperRpcs.length} times (want once)`);
  } else if (helperRpcs[0]!.receiver !== 'createAdminClient()') {
    failures.push(
      `${HELPER}:${helperRpcs[0]!.line} calls ${FN} on ${helperRpcs[0]!.receiver}, not on createAdminClient()`,
    );
  }
  if (tree.files.includes(HELPER)) {
    const shape = helperShape(tree.read(HELPER));
    if (!shape.adminImported)
      failures.push(`${HELPER} does not import createAdminClient from '@/lib/supabase/admin'`);
    if (JSON.stringify(shape.exports) !== JSON.stringify([...HELPER_EXPORTS].sort())) {
      failures.push(
        `${HELPER} exports ${shape.exports.join(', ')} (want ${[...HELPER_EXPORTS].sort().join(', ')})`,
      );
    }
  } else {
    failures.push(`${HELPER} is missing`);
  }

  // Rule 6.
  for (const [key, calls] of seen) {
    const site = SITES[key];
    if (!site) {
      failures.push(
        `new export-event site ${key} (${calls.map((c) => c.topic).join(', ')}): review it and add it to SITES`,
      );
      continue;
    }
    if (calls.length !== 1) failures.push(`${key} records ${calls.length} export events (want 1)`);
    const call = calls[0]!;
    const wantFn =
      site.kind === 'member' ? 'publishOutboxEvent' : 'publishOutboxEventForResolvedOrganization';
    if (call.fn !== wantFn) failures.push(`${key} calls ${call.fn} (want ${wantFn})`);
    if (call.topic !== site.topic)
      failures.push(`${key} records ${call.topic} (want ${site.topic})`);
    const [file, member] = key.split('#') as [string, string];
    const sf = parse(file, tree.read(file));
    if (site.kind === 'resolved') {
      if (call.firstArg !== site.firstArg)
        failures.push(`${key} passes ${call.firstArg} (want ${site.firstArg})`);
      const body = findMember(sf, member);
      if (!body) {
        failures.push(`${key} moved`);
        continue;
      }
      for (const [name, want] of Object.entries(site.bindings)) {
        const got = writesOf(body, sf, name);
        if (JSON.stringify(got) !== JSON.stringify(want))
          failures.push(
            `${key} binding ${name} is ${JSON.stringify(got)} (want ${JSON.stringify(want)})`,
          );
      }
      continue;
    }
    if (call.firstArg !== 'this.ctx')
      failures.push(`${key} passes ${call.firstArg} as the context (want this.ctx)`);
    if (site.gateIn) {
      // A private member: its one caller runs the gate, then calls it.
      const caller = findMember(sf, site.gateIn);
      const simple = member.split('.').pop()!;
      const callers = (tree.read(file).match(new RegExp(String.raw`this\.${simple}\(`, 'g')) ?? [])
        .length;
      if (callers !== 1)
        failures.push(`${key} is called ${callers} times (want once, from ${site.gateIn})`);
      if (!caller) {
        failures.push(`${key}: its caller ${site.gateIn} moved`);
        continue;
      }
      const gateAt = callStart(caller, sf, site.gate);
      let callAt = -1;
      const find = (n: ts.Node) => {
        if (callAt >= 0) return;
        if (ts.isCallExpression(n) && flat(n.expression, sf) === `this.${simple}`)
          callAt = n.getStart(sf);
        else ts.forEachChild(n, find);
      };
      find(caller);
      if (gateAt < 0) failures.push(`${site.gateIn} has no ${site.gate}`);
      else if (callAt < 0) failures.push(`${site.gateIn} no longer calls ${member}`);
      else if (callAt < gateAt)
        failures.push(`${site.gateIn} calls ${member} before its gate ${site.gate}`);
      continue;
    }
    const body = findMember(sf, member);
    if (!body) {
      failures.push(`${key} moved`);
      continue;
    }
    const gateAt = callStart(body, sf, site.gate);
    if (gateAt < 0) failures.push(`${key} has no ${site.gate}`);
    else if (call.start < gateAt)
      failures.push(`${key} records its event before its gate ${site.gate}`);
  }
  for (const key of Object.keys(SITES)) {
    if (!seen.has(key)) failures.push(`stale: SITES ${key} records no export event`);
  }
  return failures;
}

/* ---- the tests ---- */

describe('export events are recorded only by the server helper, on the service client (S67a)', () => {
  it('scans every source root of the repository, and nothing that is not source', () => {
    const roots = new Set(REAL.files.map((f) => f.split('/').slice(0, 2).join('/')));
    for (const root of [
      'apps/web',
      'apps/mobile',
      'packages/core',
      'packages/config',
      'integrations/zapier',
      'load-tests/k6',
      'scripts/postgrest-embeds',
    ]) {
      expect(roots).toContain(root);
    }
    expect(REAL.files).toContain(HELPER);
    expect(REAL.files).toContain('commitlint.config.cjs');
    expect(REAL.files.some((f) => f.startsWith('apps/web/scripts/'))).toBe(true);
    expect(REAL.files.some((f) => f.startsWith('apps/mobile/app/'))).toBe(true);
    expect(REAL.files.some((f) => f.startsWith('apps/web/tests/'))).toBe(true);
    expect(REAL.files.some((f) => /\.mjs$/.test(f))).toBe(true);
    expect(REAL.files.filter((f) => f.startsWith('apps/web/src/')).length).toBeGreaterThan(500);
    expect(REAL.files.some((f) => /(^|\/)node_modules\//.test(f))).toBe(false);
    expect(REAL.files.some((f) => /(^|\/)\./.test(f))).toBe(false);
    expect(REAL.files.some((f) => TEST_FILE.test(f) || DECLARATION.test(f))).toBe(false);
  });

  it('holds every rule today', () => {
    expect(verdict(REAL)).toEqual([]);
  });

  it('every member site names what its gate checks', () => {
    for (const site of Object.values(SITES)) {
      if (site.kind !== 'member') continue;
      expect(site.gate.startsWith('assertPermission(this.ctx,') || site.gate in GATE_MEANING).toBe(
        true,
      );
    }
  });
});

describe('the guard can fail (planted probes)', () => {
  const NEW_FILE = 'apps/web/src/server/services/planted-probe.ts';
  const planted = (source: string, file = NEW_FILE) => verdict(withFile(REAL, file, source));
  /** The real tree with one file's text changed by `change`, which must change it. */
  const changed = (file: string, change: (s: string) => string) => {
    const real = REAL.read(file);
    const next = change(real);
    expect(next).not.toBe(real);
    return verdict(withFile(REAL, file, next));
  };

  it.each([
    [
      'a direct call on the member client',
      "export async function f(ctx) { await ctx.supabase.rpc('publish_outbox', {}); }",
    ],
    [
      'a direct call on the service client',
      "export async function f(admin) { await admin.rpc('publish_outbox', {}); }",
    ],
    [
      'a template literal name',
      'export async function f(c) { await c.rpc(`publish_outbox`, {}); }',
    ],
    ['a constant holding the name', "export const NAME = 'publish_outbox';"],
    [
      'a raw PostgREST URL',
      'export const u = (base: string) => `${base}/rest/v1/rpc/publish_outbox`;',
    ],
  ])('names publish_outbox outside the helper: %s', (_label, source) => {
    expect(planted(source).some((f) => f.includes(`${NEW_FILE}:1 names ${FN} outside`))).toBe(true);
  });

  it.each([
    [
      'a name built from pieces',
      "export async function f(c) { await c.rpc('publish_' + 'outbox', {}); }",
    ],
    ['a name in a variable', 'export async function f(c, name: string) { await c.rpc(name, {}); }'],
    [
      'a template with a piece',
      'export async function f(c, t: string) { await c.rpc(`publish_${t}`, {}); }',
    ],
  ])('a function name that is not a literal fails: %s', (_label, source) => {
    expect(planted(source)).toContain(
      `${NEW_FILE}:1 calls .rpc( with a function name that is not a literal`,
    );
  });

  it.each([
    ['element access', "export async function f(c) { await c['rpc']('x', {}); }"],
    ['destructured', 'export async function f(c) { const { rpc } = c; await rpc(n(), {}); }'],
    ['kept in a variable', 'export async function f(c) { const r = c.rpc; await r(n(), {}); }'],
    ['through call()', "export async function f(c) { await c.rpc.call(c, 'x', {}); }"],
  ])('rpc read off a client without a named call there fails: %s', (_label, source) => {
    expect(planted(source)).toContain(
      `${NEW_FILE}:1 reads rpc off a client without calling it there by name`,
    );
  });

  it.each([
    [
      'an insert on the service client',
      "import { createAdminClient } from '@/lib/supabase/admin';\nexport async function f() { await createAdminClient().from('outbox_events').insert({}); }",
      2,
    ],
    [
      'a raw PostgREST URL',
      'export const u = (base: string) => `${base}/rest/v1/outbox_events`;',
      1,
    ],
  ])('naming the table fails: %s', (_label, source, line) => {
    expect(planted(source)).toContain(`${NEW_FILE}:${line} names ${TABLE}`);
  });

  it('a write through a table name built at run time fails', () => {
    expect(
      planted(
        "export async function f(c) { const t = 'outbox_' + 'events'; await c.from(t).insert({}); }",
      ),
    ).toContain(`${NEW_FILE}#f writes through .from( a table that is not a literal`);
  });

  it.each([
    ['packages/config', 'packages/config/probe.cjs'],
    ['integrations/zapier', 'integrations/zapier/probe.js'],
    ['scripts', 'scripts/probe.mts'],
    ['apps/web/scripts', 'apps/web/scripts/probe.cts'],
    ['the phone outside src and app', 'apps/mobile/plugins/probe.mjs'],
    ['the phone', 'apps/mobile/src/lib/probe.ts'],
  ])('naming the function or the table in %s fails', (_label, file) => {
    const failures = planted(
      "module.exports = (c) => c.rpc('publish_outbox', {}).then(() => c.from('outbox_events'));",
      file,
    );
    expect(failures).toContain(`${file}:1 names ${FN} outside ${HELPER}`);
    expect(failures).toContain(`${file}:1 names ${TABLE}`);
  });

  it('a module loaded by a path built at run time fails unless listed', () => {
    expect(planted('export const load = (p: string) => import(p);')).toContain(
      `${NEW_FILE} loads a module whose path is not a literal`,
    );
  });

  // Rule 5: every way to reach the helper other than a plain named import in a site's file.
  it.each([
    [
      'an aliased import in a site file',
      ROUTE,
      (s: string) =>
        s.replace(
          "import { publishOutboxEventForResolvedOrganization } from '@/server/lib/outbox-events';",
          "import { publishOutboxEventForResolvedOrganization as rec } from '@/server/lib/outbox-events';",
        ),
    ],
    [
      'a namespace import in a site file',
      ROUTE,
      (s: string) =>
        s.replace(
          "import { publishOutboxEventForResolvedOrganization } from '@/server/lib/outbox-events';",
          "import * as ob from '@/server/lib/outbox-events';",
        ),
    ],
  ])('%s fails', (_label, file, change) => {
    expect(
      changed(file, change).some(
        (f) => f.startsWith(`${file}:`) && f.includes(`imports or loads ${HELPER}`),
      ),
    ).toBe(true);
  });

  it.each([
    [
      'a plain import in a file with no site',
      "import { publishOutboxEvent } from '@/server/lib/outbox-events';\nexport const x = 1;",
    ],
    [
      'an aliased import, called under its new name',
      "import { publishOutboxEventForResolvedOrganization as rec } from '@/server/lib/outbox-events';\nexport async function f() { await rec({ organizationId: 'x', resolvedBy: 'public_request_link' }, { topic: 'public_request.created', aggregateId: 'x', payload: {} }); }",
    ],
    [
      'a namespace import',
      "import * as ob from '@/server/lib/outbox-events';\nexport async function f(ctx) { await ob.publishOutboxEvent(ctx, { topic: 'order.problem', aggregateId: 'x', payload: {} }); }",
    ],
    ['a default import', "import ob from '@/server/lib/outbox-events';\nexport const x = ob;"],
    ['a relative path', "import * as ob from '../lib/outbox-events';\nexport const x = ob;"],
    [
      'a dynamic import',
      "export async function f() { const ob = await import('@/server/lib/outbox-events'); return ob; }",
    ],
    ['a require', "export const ob = require('@/server/lib/outbox-events');"],
    [
      'an import-equals',
      "import ob = require('@/server/lib/outbox-events');\nexport const x = ob;",
    ],
    [
      'a named re-export',
      "export { publishOutboxEvent as record } from '@/server/lib/outbox-events';",
    ],
    ['a star re-export', "export * from '@/server/lib/outbox-events';"],
  ])('%s fails', (_label, source) => {
    expect(
      planted(source).some(
        (f) => f.startsWith(`${NEW_FILE}:`) && f.includes(`imports or loads ${HELPER}`),
      ),
    ).toBe(true);
  });

  it('the helper kept in a variable in a site file fails', () => {
    const failures = changed(ROUTE, (s) =>
      s.replace(
        '  await publishOutboxEventForResolvedOrganization(\n',
        '  const rec = publishOutboxEventForResolvedOrganization;\n  await rec(\n',
      ),
    );
    expect(failures.some((f) => f.includes('references the helper other than by calling it'))).toBe(
      true,
    );
    expect(failures).toContain(`stale: SITES ${ROUTE}#POST records no export event`);
  });

  it('a new caller of the helper fails until it is reviewed', () => {
    const failures = changed(PO, (s) =>
      s.replace(
        '  async updateStatus(',
        "  async other(id: string) {\n    await publishOutboxEvent(this.ctx, { topic: 'order.problem', aggregateId: id, payload: {} });\n  }\n\n  async updateStatus(",
      ),
    );
    expect(failures).toContain(
      `new export-event site ${PO}#PurchaseOrdersService.other (order.problem): review it and add it to SITES`,
    );
  });

  it('the helper on the member client, or on a client kept in a variable, fails', () => {
    expect(
      changed(HELPER, (s) => s.replace('createAdminClient().rpc(', 'ctx.supabase.rpc(')).some((f) =>
        f.includes(`calls ${FN} on ctx.supabase, not on createAdminClient()`),
      ),
    ).toBe(true);
    expect(
      changed(HELPER, (s) => s.replace('createAdminClient().rpc(', 'client.rpc(')).some((f) =>
        f.includes(`calls ${FN} on client, not on createAdminClient()`),
      ),
    ).toBe(true);
  });

  it('a second export from the helper (a bare-organization writer) fails', () => {
    expect(
      changed(
        HELPER,
        (s) =>
          `${s}\nexport async function anyOrganization(organizationId: string) { await write(organizationId, { topic: 'order.problem', aggregateId: 'x', payload: {} }); }\n`,
      ).some((f) => f.startsWith(`${HELPER} exports`)),
    ).toBe(true);
  });

  const poKey = `${PO}#PurchaseOrdersService.updateStatus`;

  it('an event recorded before its permission check fails', () => {
    const head =
      "  async updateStatus(id: string, status: 'draft' | 'ordered' | 'cancelled') {\n    assertModuleEnabled(this.ctx, 'purchase_orders');\n";
    const gate = "    assertPermission(this.ctx, 'purchase_orders:manage');\n";
    const tail = '      await this.archiveOrphanedCustomItems(id);\n    }\n  }\n';
    const real = REAL.read(PO);
    expect(real.split(head + gate)).toHaveLength(2);
    expect(real.split(tail)).toHaveLength(2);
    // The gate moved to the end of updateStatus: the event now comes first.
    expect(
      changed(PO, (s) =>
        s
          .replace(head + gate, head)
          .replace(tail, `      await this.archiveOrphanedCustomItems(id);\n    }\n${gate}  }\n`),
      ),
    ).toContain(
      `${poKey} records its event before its gate assertPermission(this.ctx, 'purchase_orders:manage')`,
    );
    expect(changed(PO, (s) => s.replace(head + gate, head))).toContain(
      `${poKey} has no assertPermission(this.ctx, 'purchase_orders:manage')`,
    );
  });

  it('a context that is not the checked one fails', () => {
    expect(
      changed(PO, (s) =>
        s.replace(
          'await publishOutboxEvent(this.ctx, {',
          'await publishOutboxEvent({ ...this.ctx, organizationId: input }, {',
        ),
      ),
    ).toContain(
      `${poKey} passes {...this.ctx,organizationId:input} as the context (want this.ctx)`,
    );
  });

  it.each([
    [
      'a spread after the topic',
      'payload: { poId: id },\n',
      'payload: { poId: id },\n        ...extra,\n',
      '<spread>',
    ],
    [
      'a computed key',
      "topic: 'purchase_order.ordered',",
      "['topic']: 'purchase_order.ordered',",
      '<computed key>',
    ],
    [
      'an extra key',
      "topic: 'purchase_order.ordered',",
      "topic: 'purchase_order.ordered',\n        organizationId: input,",
      '<keys topic,organizationId,aggregateId,payload>',
    ],
  ])('an event literal with %s fails', (_label, from, to, got) => {
    expect(changed(PO, (s) => s.replace(from, to))).toContain(
      `${poKey} records ${got} (want purchase_order.ordered)`,
    );
  });

  it('a builder that spreads into its event fails', () => {
    expect(
      changed(RETURNS, (s) =>
        s.replace(
          '    payload: { returnId, returnNumber, orderRequestId },\n  };',
          '    payload: { returnId, returnNumber, orderRequestId },\n    ...extra,\n  };',
        ),
      ),
    ).toContain(
      `${RETURNS}#RMAService.createFromOrder records returnCreatedEvent():<spread> (want returnCreatedEvent():return.created)`,
    );
  });

  it('a private site called before its caller runs the gate fails', () => {
    const call = '      await this.publishReturnClosed(id, facts);\n';
    expect(
      changed(RETURNS, (s) =>
        s
          .replace(call, '')
          .replace(
            '  ): Promise<ReturnCloseAnswer> {\n    this.gate();\n',
            `  ): Promise<ReturnCloseAnswer> {\n    const facts = await this.factsInActiveOrg(id);\n${call}    this.gate();\n`,
          ),
      ),
    ).toContain(
      'RMAService.close calls RMAService.publishReturnClosed before its gate this.gate()',
    );
  });

  // Rule 6 for the two member-free sites: the first argument and where it comes from.
  const routeKey = `${ROUTE}#POST`;
  const requesterKey = `${RETURNS}#createRequesterRpc`;

  it.each([
    [
      'a field of the request body',
      "    { organizationId, resolvedBy: 'public_request_link' },\n",
      "    { organizationId: body.organizationId, resolvedBy: 'public_request_link' },\n",
    ],
    [
      'a spread over the resolved organization',
      "    { organizationId, resolvedBy: 'public_request_link' },\n",
      "    { organizationId, resolvedBy: 'public_request_link', ...override },\n",
    ],
    [
      'another label',
      "    { organizationId, resolvedBy: 'public_request_link' },\n",
      "    { organizationId, resolvedBy: 'requester_return' },\n",
    ],
  ])('the public route passing %s fails', (_label, from, to) => {
    expect(
      changed(ROUTE, (s) => s.replace(from, to)).some((f) => f.startsWith(`${routeKey} passes `)),
    ).toBe(true);
  });

  it.each([
    [
      'a request field renamed to organizationId just before the event',
      '  const header = headerRow as OrderRequestRow;\n',
      '  const header = headerRow as OrderRequestRow;\n  {\n    const { organizationId } = body as unknown as { organizationId: string };\n    void organizationId;\n  }\n',
    ],
    [
      'the link organization overridden by the body',
      '    organizationId = link.organization_id;\n',
      '    organizationId = (body as unknown as { organizationId?: string }).organizationId ?? link.organization_id;\n',
    ],
    [
      'the link looked up by something other than the token hash',
      ".eq('token_hash', sha256Hex(body.token))",
      ".eq('id', body.warehouseId)",
    ],
  ])('the public route with %s fails', (_label, from, to) => {
    expect(
      changed(ROUTE, (s) => s.replace(from, to)).some((f) => f.startsWith(`${routeKey} binding `)),
    ).toBe(true);
  });

  it.each([
    [
      'a first argument other than the answered organization',
      "      { organizationId: result.organizationId, resolvedBy: 'requester_return' },\n",
      "      { organizationId: ctx.orderRequestId, resolvedBy: 'requester_return' },\n",
      'passes ',
    ],
    [
      'the organization taken from the request body',
      '    organizationId: str(answer.organizationId) ?? ctx.organizationId,\n',
      '    organizationId: (body as unknown as { organizationId: string }).organizationId,\n',
      'binding result',
    ],
    [
      'the result changed after it was built',
      '  if (answer.changed === true) {\n    // RX-3',
      '  result.organizationId = (body as unknown as { org: string }).org;\n  if (answer.changed === true) {\n    // RX-3',
      'binding result',
    ],
  ])('the requester return with %s fails', (_label, from, to, what) => {
    expect(
      changed(RETURNS, (s) => s.replace(from, to)).some((f) =>
        f.startsWith(`${requesterKey} ${what}`),
      ),
    ).toBe(true);
  });

  it('a removed site is stale', () => {
    expect(
      changed(ROUTE, (real) => {
        const start = real.indexOf('  await publishOutboxEventForResolvedOrganization(');
        const end = real.indexOf('  );\n', start) + '  );\n'.length;
        return real.slice(0, start) + real.slice(end);
      }),
    ).toContain(`stale: SITES ${routeKey} records no export event`);
  });
});
