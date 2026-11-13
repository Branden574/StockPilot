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
 * reports. This file holds the code to that:
 *
 *   Rule 1. No file in apps/web/src (tests left out) names publish_outbox but
 *   the helper: not in a string, a template, a raw /rest/v1/rpc/ URL or a
 *   constant handed around. apps/mobile and packages name it nowhere.
 *   Rule 2. Every `.rpc(` call in apps/web/src names its function as a
 *   literal, so a name built at run time ('publish_' + 'outbox', a variable)
 *   cannot reach publish_outbox unseen; and `rpc` is never read off a client
 *   except to call it there (no `client['rpc']`, `const { rpc } = client`,
 *   `client.rpc.call(...)`), so no call escapes the scan.
 *   Rule 3. In the helper, publish_outbox is called once, directly on
 *   `createAdminClient()` imported from '@/lib/supabase/admin'.
 *   Rule 4. Nothing re-exports the helper module, and it exports only the
 *   names below.
 *   Rule 5. The helper is called only at the sites in SITES, each with its
 *   topic: a member action passes `this.ctx` and runs its permission check
 *   (the gate) before the event, in the same member or, for a private
 *   member, in its one caller before the call; the two sites with no
 *   signed-in member name how the organization was resolved.
 *
 * IF THIS FAILS
 *   - "names publish_outbox": record the event with publishOutboxEvent(this.ctx,
 *     ...) after the action and its permission check; never call the function.
 *   - "is not a literal" / "reads rpc off a client": name the function in the
 *     `.rpc(` call itself.
 *   - "new export-event site" / "moved": read the new site. It must run after
 *     the service's own permission check and after the action it reports;
 *     then add it to SITES with its gate.
 *   - "before its gate": the event moved above the permission check, or the
 *     check was removed. Put the check back first.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '..');
const REPO = path.resolve(__dirname, '../../../..');
const OTHER_ROOTS = ['apps/mobile/src', 'apps/mobile/app', 'packages/core/src'];

const HELPER = 'server/lib/outbox-events.ts';
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

type Site =
  | {
      kind: 'member';
      /** The topic literal, or `<builder>()` when the event comes from a named builder. */
      topic: string;
      /** The permission check, as written, that runs before the event. */
      gate: string;
      /** For a private member: the one member that calls it, after the gate. */
      gateIn?: string;
    }
  | { kind: 'resolved'; topic: string; resolvedBy: 'requester_return' | 'public_request_link' };

/** Every call of the helper: `<path>#<member>` (one call each). */
const SITES: Record<string, Site> = {
  'server/services/purchase-orders.ts#PurchaseOrdersService.updateStatus': {
    kind: 'member',
    topic: 'purchase_order.ordered',
    gate: "assertPermission(this.ctx, 'purchase_orders:manage')",
  },
  'server/services/receiving.ts#ReceivingService.postReceipt': {
    kind: 'member',
    topic: 'receipt.posted',
    gate: "assertPermission(this.ctx, 'stock:adjust')",
  },
  'server/services/returns.ts#RMAService.createFromOrder': {
    kind: 'member',
    topic: 'returnCreatedEvent()',
    gate: 'this.gate()',
  },
  'server/services/returns.ts#RMAService.publishReturnClosed': {
    kind: 'member',
    topic: 'return.closed',
    gate: 'this.gate()',
    gateIn: 'RMAService.close',
  },
  'server/services/order-requests.ts#OrderRequestsService.deny': {
    kind: 'member',
    topic: 'order.problem',
    gate: "assertPermission(this.ctx, 'orders:approve')",
  },
  'server/services/returns.ts#createRequesterRpc': {
    kind: 'resolved',
    topic: 'returnCreatedEvent()',
    resolvedBy: 'requester_return',
  },
  'app/api/v1/public/order-requests/route.ts#POST': {
    kind: 'resolved',
    topic: 'public_request.created',
    resolvedBy: 'public_request_link',
  },
};

/** The gate each private member's caller holds: RMAService.gate() checks returns:manage. */
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
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), relPath));
    else if (
      /\.(tsx?|jsx?|mjs)$/.test(e.name) &&
      !/\.test\.(tsx?|jsx?)$/.test(e.name) &&
      !/\.d\.ts$/.test(e.name)
    )
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

const WEB = diskTree(SRC_DIR);

function withFile(tree: Tree, file: string, source: string): Tree {
  return {
    files: tree.files.includes(file) ? tree.files : [...tree.files, file].sort(),
    read: (f) => (f === file ? source : tree.read(f)),
  };
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
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

/** The text of a node with its white space removed, to compare call shapes. */
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

/** The body a member key names, for a gate search. */
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

/* ---- the scan ---- */

const HELPER_NAMES = new Set(['publishOutboxEvent', 'publishOutboxEventForResolvedOrganization']);

interface HelperCall {
  key: string;
  fn: string;
  firstArg: string;
  topic: string;
  resolvedBy: string | null;
  start: number;
}

function topicOf(event: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (!event) return '<none>';
  const u = unwrap(event);
  if (ts.isObjectLiteralExpression(u)) {
    for (const p of u.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'topic')
        return literalText(p.initializer) ?? '<not a literal>';
    }
    return '<no topic>';
  }
  if (ts.isCallExpression(u) && ts.isIdentifier(u.expression)) return `${u.expression.text}()`;
  return '<not a literal>';
}

function resolvedByOf(arg: ts.Expression | undefined, sf: ts.SourceFile): string | null {
  if (!arg) return null;
  const u = unwrap(arg);
  if (!ts.isObjectLiteralExpression(u)) return '<not a literal>';
  for (const p of u.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'resolvedBy')
      return literalText(p.initializer) ?? '<not a literal>';
  }
  return '<none>';
}

const scans = new Map<string, { source: string; scan: ReturnType<typeof scanFileUncached> }>();

/** Everything the rules need from one web file (kept per file while its text is unchanged). */
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
  const dynamicRpc: string[] = [];
  const looseRpc: string[] = [];
  const reexports: string[] = [];
  const helperCalls: HelperCall[] = [];
  const outboxRpcs: Array<{ receiver: string; line: number }> = [];
  const where = (n: ts.Node) =>
    `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  const visit = (n: ts.Node) => {
    // Rule 1: any string or template piece that names the function.
    if (
      ts.isStringLiteralLike(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      if ((n as ts.LiteralLikeNode).text.includes(FN)) named.push(where(n));
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
    // Rule 4: a re-export of the helper module.
    if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      /outbox-events$/.test(literalText(n.moduleSpecifier) ?? '')
    ) {
      reexports.push(where(n));
    }
    // Rule 5: a call of the helper.
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      HELPER_NAMES.has(n.expression.text)
    ) {
      helperCalls.push({
        key: `${file}#${memberOf(n)}`,
        fn: n.expression.text,
        firstArg: n.arguments[0] ? flat(n.arguments[0], sf) : '<none>',
        topic: topicOf(n.arguments[1], sf),
        resolvedBy:
          n.expression.text === 'publishOutboxEventForResolvedOrganization'
            ? resolvedByOf(n.arguments[0], sf)
            : null,
        start: n.getStart(sf),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sf, named, dynamicRpc, looseRpc, reexports, helperCalls, outboxRpcs };
}

/** The helper module's own shape: its exports and how it calls the function. */
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

/** Every rule over a web tree and the other roots; the list of failures. */
function verdict(web: Tree, others: Array<{ root: string; tree: Tree }> = OTHERS): string[] {
  const failures: string[] = [];
  const seen = new Map<string, HelperCall[]>();
  let helperRpcs: Array<{ receiver: string; line: number }> = [];

  for (const file of web.files) {
    const source = web.read(file);
    if (
      !source.includes('rpc') &&
      !source.includes(FN) &&
      !source.includes('outbox-events') &&
      !source.includes('publishOutboxEvent')
    ) {
      continue;
    }
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
    for (const at of scan.dynamicRpc)
      failures.push(`${at} calls .rpc( with a function name that is not a literal`);
    for (const at of scan.looseRpc)
      failures.push(`${at} reads rpc off a client without calling it there by name`);
    for (const at of scan.reexports) failures.push(`${at} re-exports ${HELPER}`);
    for (const call of scan.helperCalls) {
      const list = seen.get(call.key) ?? [];
      list.push(call);
      seen.set(call.key, list);
    }
  }

  // Rule 3.
  if (helperRpcs.length !== 1) {
    failures.push(`${HELPER} calls ${FN} ${helperRpcs.length} times (want once)`);
  } else if (helperRpcs[0]!.receiver !== 'createAdminClient()') {
    failures.push(
      `${HELPER}:${helperRpcs[0]!.line} calls ${FN} on ${helperRpcs[0]!.receiver}, not on createAdminClient()`,
    );
  }
  if (web.files.includes(HELPER)) {
    const shape = helperShape(web.read(HELPER));
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

  // Rule 5.
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
    if (site.kind === 'resolved') {
      if (call.resolvedBy !== site.resolvedBy)
        failures.push(`${key} names resolvedBy ${call.resolvedBy} (want ${site.resolvedBy})`);
      continue;
    }
    if (call.firstArg !== 'this.ctx')
      failures.push(`${key} passes ${call.firstArg} as the context (want this.ctx)`);
    const [file, member] = key.split('#') as [string, string];
    const sf = parse(file, web.read(file));
    if (site.gateIn) {
      // A private member: its one caller runs the gate, then calls it.
      const caller = findMember(sf, site.gateIn);
      const simple = member.split('.').pop()!;
      const callers = (web.read(file).match(new RegExp(String.raw`this\.${simple}\(`, 'g')) ?? [])
        .length;
      if (callers !== 1)
        failures.push(`${key} is called ${callers} times (want once, from ${site.gateIn})`);
      if (!caller) {
        failures.push(`${key}: its caller ${site.gateIn} moved`);
        continue;
      }
      const gateAt = callStart(caller, sf, site.gate);
      const callAt = (() => {
        let at = -1;
        const visit = (n: ts.Node) => {
          if (at >= 0) return;
          if (ts.isCallExpression(n) && flat(n.expression, sf) === `this.${simple}`)
            at = n.getStart(sf);
          else ts.forEachChild(n, visit);
        };
        visit(caller);
        return at;
      })();
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

  // Rule 1, the phone and the packages.
  for (const { root, tree } of others) {
    for (const file of tree.files) {
      if (tree.read(file).includes(FN)) failures.push(`${root}/${file} names ${FN}`);
    }
  }
  return failures;
}

const OTHERS = OTHER_ROOTS.map((root) => ({ root, tree: diskTree(path.join(REPO, root)) }));

/* ---- the tests ---- */

describe('export events are recorded only by the server helper, on the service client (S67a)', () => {
  it('scans a real tree: the web app, the phone and core', () => {
    expect(WEB.files.length).toBeGreaterThan(500);
    expect(WEB.files).toContain(HELPER);
    expect(WEB.files).toContain('server/services/returns.ts');
    expect(OTHERS.every((o) => o.tree.files.length > 0)).toBe(true);
  });

  it('holds every rule today', () => {
    expect(verdict(WEB)).toEqual([]);
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
  const NEW_FILE = 'server/services/planted-probe.ts';
  const planted = (source: string) => verdict(withFile(WEB, NEW_FILE, source));

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

  it('a re-export of the helper fails', () => {
    expect(
      planted("export { publishOutboxEvent as record } from '@/server/lib/outbox-events';"),
    ).toContain(`${NEW_FILE}:1 re-exports ${HELPER}`);
    expect(planted("export * from '@/server/lib/outbox-events';")).toContain(
      `${NEW_FILE}:1 re-exports ${HELPER}`,
    );
  });

  it('a new caller of the helper fails until it is reviewed', () => {
    const failures = planted(
      "import { publishOutboxEvent } from '@/server/lib/outbox-events';\nexport async function f(ctx) { await publishOutboxEvent(ctx, { topic: 'order.problem', aggregateId: 'x', payload: {} }); }",
    );
    expect(failures).toContain(
      `new export-event site ${NEW_FILE}#f (order.problem): review it and add it to SITES`,
    );
  });

  it('the helper on the member client, or on a client kept in a variable, fails', () => {
    const real = WEB.read(HELPER);
    expect(real).toContain('createAdminClient().rpc(');
    const member = real.replace('createAdminClient().rpc(', 'ctx.supabase.rpc(');
    expect(
      verdict(withFile(WEB, HELPER, member)).some((f) =>
        f.includes(`calls ${FN} on ctx.supabase, not on createAdminClient()`),
      ),
    ).toBe(true);
    const held = real.replace('createAdminClient().rpc(', 'client.rpc(');
    expect(
      verdict(withFile(WEB, HELPER, held)).some((f) =>
        f.includes(`calls ${FN} on client, not on createAdminClient()`),
      ),
    ).toBe(true);
  });

  it('a second export from the helper (a bare-organization writer) fails', () => {
    const real = WEB.read(HELPER);
    const extra = `${real}\nexport async function anyOrganization(organizationId: string) { await write(organizationId, { topic: 'order.problem', aggregateId: 'x', payload: {} }); }\n`;
    expect(
      verdict(withFile(WEB, HELPER, extra)).some((f) => f.startsWith(`${HELPER} exports`)),
    ).toBe(true);
  });

  const PO = 'server/services/purchase-orders.ts';
  const poKey = `${PO}#PurchaseOrdersService.updateStatus`;

  it('an event recorded before its permission check fails', () => {
    const real = WEB.read(PO);
    const head =
      "  async updateStatus(id: string, status: 'draft' | 'ordered' | 'cancelled') {\n    assertModuleEnabled(this.ctx, 'purchase_orders');\n";
    const gate = "    assertPermission(this.ctx, 'purchase_orders:manage');\n";
    const tail = '      await this.archiveOrphanedCustomItems(id);\n    }\n  }\n';
    expect(real.split(head + gate)).toHaveLength(2);
    expect(real.split(tail)).toHaveLength(2);
    // The gate moved to the end of updateStatus: the event now comes first.
    const moved = real
      .replace(head + gate, head)
      .replace(tail, `      await this.archiveOrphanedCustomItems(id);\n    }\n${gate}  }\n`);
    expect(verdict(withFile(WEB, PO, moved))).toContain(
      `${poKey} records its event before its gate assertPermission(this.ctx, 'purchase_orders:manage')`,
    );
    expect(verdict(withFile(WEB, PO, real.replace(head + gate, head)))).toContain(
      `${poKey} has no assertPermission(this.ctx, 'purchase_orders:manage')`,
    );
  });

  it('a context that is not the checked one fails', () => {
    const real = WEB.read(PO);
    const swapped = real.replace(
      'await publishOutboxEvent(this.ctx, {',
      'await publishOutboxEvent({ ...this.ctx, organizationId: input }, {',
    );
    expect(swapped).not.toBe(real);
    expect(verdict(withFile(WEB, PO, swapped))).toContain(
      `${poKey} passes {...this.ctx,organizationId:input} as the context (want this.ctx)`,
    );
  });

  it('a private site called before its caller runs the gate fails', () => {
    const RET = 'server/services/returns.ts';
    const real = WEB.read(RET);
    const call = '      await this.publishReturnClosed(id, facts);\n';
    expect(real).toContain(call);
    const early = real
      .replace(call, '')
      .replace(
        '  ): Promise<ReturnCloseAnswer> {\n    this.gate();\n',
        `  ): Promise<ReturnCloseAnswer> {\n    const facts = await this.factsInActiveOrg(id);\n${call}    this.gate();\n`,
      );
    expect(early).not.toBe(real);
    expect(verdict(withFile(WEB, RET, early))).toContain(
      'RMAService.close calls RMAService.publishReturnClosed before its gate this.gate()',
    );
  });

  it('a requester site that changes how its organization was resolved fails', () => {
    const ROUTE = 'app/api/v1/public/order-requests/route.ts';
    const real = WEB.read(ROUTE);
    const changed = real.replace(
      "resolvedBy: 'public_request_link'",
      "resolvedBy: 'requester_return'",
    );
    expect(changed).not.toBe(real);
    expect(verdict(withFile(WEB, ROUTE, changed))).toContain(
      `${ROUTE}#POST names resolvedBy requester_return (want public_request_link)`,
    );
  });

  it('the phone or core naming the function fails', () => {
    const phone = {
      root: 'apps/mobile/src',
      tree: { files: ['lib/probe.ts'], read: () => "client.rpc('publish_outbox', {})" },
    };
    expect(verdict(WEB, [phone])).toContain(`apps/mobile/src/lib/probe.ts names ${FN}`);
  });

  it('a removed site is stale', () => {
    const ROUTE = 'app/api/v1/public/order-requests/route.ts';
    const real = WEB.read(ROUTE);
    const start = real.indexOf('  await publishOutboxEventForResolvedOrganization(');
    const end = real.indexOf('  );\n', start) + '  );\n'.length;
    const gone = real.slice(0, start) + real.slice(end);
    expect(verdict(withFile(WEB, ROUTE, gone))).toContain(
      `stale: SITES ${ROUTE}#POST records no export event`,
    );
  });
});
