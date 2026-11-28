// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Security invariant: release 4a of the security alerts is RECORD ONLY.
 *
 * Nothing in this build may send an alert, look up who would receive one, or
 * change a switch, a threshold or a planned check. This guard is an
 * ALLOW-LIST, not a list of senders to look for (a sender with a neutral name
 * would pass that):
 *
 *   1. every function of migration 0480 is called (named in a string literal
 *      of code, or in a concatenation or template whose parts are all
 *      written out; comments aside) from exactly the module this release
 *      gives it, and from nowhere else: the job's four, the daily job's
 *      baseline, the retention's purge, the console's list. The setter
 *      (platform_security_alert_set) and the recipients' lookup
 *      (platform_admin_user_ids) are called from nowhere. Anywhere under src,
 *      an .rpc( whose function is not one plain literal, and could be one of
 *      them, is refused: a name built from parts is not counted, so it may
 *      not be used;
 *   2. each module of the alerts (MODULES: the alert job, its report helper
 *      and its route, the daily job, the retention job, the console's
 *      service, action, section, client and page; every caller in CALLERS
 *      must be one of them) imports EXACTLY the modules listed for it; calls
 *      .rpc only with a function named on its list, and .from only with a
 *      table named on its list (a read: no insert, update, upsert or delete
 *      anywhere); never takes .rpc, .from or any of those as a value (bound,
 *      destructured, or with .call); touches no .functions, .storage,
 *      .channel, .auth, .schema, .realtime or .fetch; takes no property by
 *      a computed name (x[name], { [name]: v }); and names nothing it did not
 *      declare or import beyond the plain language globals in GLOBALS (so no
 *      fetch, globalThis, window, process, require or a sender that was
 *      never imported, under any name);
 *   3. ONE LEVEL DEEP: every module of the app a module of the alerts
 *      imports (that is not itself one of MODULES) is read too, and may
 *      import only what ONE_LEVEL_DEEP lists for it. A new helper is not on
 *      any list, so it fails here until it is judged and listed; a listed
 *      module that starts importing something new fails here as well (look
 *      at what the import does; if it can send, it does not belong here).
 * The self-tests at the bottom plant the ten senders the final review of 4a
 * planted into the job (and more), and each must be found, so this cannot
 * pass by reading nothing.
 *
 * @stockpilot/core is not followed: it is the pure half (no I/O).
 *
 * WHAT IT CANNOT SEE (so it is a check against mistakes and unreviewed
 * changes, not a proof): a name made at run time from data (a value read
 * from a file, a request, the database); a module beyond one level deep;
 * what a name holds (it reads names, not types, and is not scope-aware: a
 * variable called like an allowed one can hold anything); a call made by
 * an allowed module's own dependency; and anything outside apps/web/src.
 * The review of a change to these modules is still the control.
 *
 * STAGE 4b CHANGES THESE LISTS ON PURPOSE: the sending job will call the
 * recipients' lookup, import a mailer and a push sender, and the console
 * will call the setter. That change is made here, by name, module by
 * module, with its own review; never by widening a rule or a pattern.
 */

const WEB_SRC = path.resolve(__dirname, '../..');
const rel = (file: string) => path.relative(WEB_SRC, file).split(path.sep).join('/');

/** Where each of 0480's functions may be called from in this release. */
const CALLERS: Record<string, string[]> = {
  platform_security_alert_heartbeat: ['server/security/alerts-job.ts'],
  platform_security_alert_inputs: ['server/security/alerts-job.ts'],
  platform_security_alert_claim: ['server/security/alerts-job.ts'],
  platform_security_alert_result: ['server/security/alerts-job.ts'],
  platform_security_alert_baseline: ['app/api/cron/security-summary/route.ts'],
  platform_security_alert_purge: ['app/api/cron/security-events-retention/route.ts'],
  platform_security_alert_list: ['server/services/platform/security-alerts.ts'],
  platform_security_alert_set: [],
  platform_admin_user_ids: [],
};

interface ModuleRule {
  /** Exactly the modules it imports (type-only imports included). */
  imports: string[];
  /** The only database functions it may call, by exact name. */
  rpc: string[];
  /** The only tables it may read with .from(), by exact name. */
  tables: string[];
}

/** THE MODULES OF THE ALERTS: what each may import and call. */
const MODULES: Record<string, ModuleRule> = {
  'server/security/alerts-job.ts': {
    imports: [
      'server-only',
      '@/lib/env',
      '@/lib/supabase/admin',
      '@/server/security/alerts-reports',
      '@stockpilot/core',
    ],
    rpc: [
      'platform_security_alert_heartbeat',
      'platform_security_alert_inputs',
      'platform_security_alert_claim',
      'platform_security_alert_result',
    ],
    tables: [],
  },
  'server/security/alerts-reports.ts': {
    imports: ['server-only', '@/lib/error-reporter', '@stockpilot/core'],
    rpc: [],
    tables: [],
  },
  'app/api/cron/security-alerts/route.ts': {
    imports: [
      'next/server',
      '@/lib/env',
      '@/server/security/alerts-job',
      '@/server/services/lib/system-context',
    ],
    rpc: [],
    tables: [],
  },
  'app/api/cron/security-summary/route.ts': {
    imports: [
      'next/server',
      '@/lib/env',
      '@/lib/supabase/admin',
      '@/server/security/alerts-reports',
      '@/server/services/lib/system-context',
      '@stockpilot/core',
    ],
    rpc: ['platform_security_alert_baseline'],
    tables: [],
  },
  'app/api/cron/security-events-retention/route.ts': {
    imports: [
      'next/server',
      '@/lib/env',
      '@/lib/error-reporter',
      '@/lib/supabase/admin',
      '@/server/security/passkey-maintenance',
      '@/server/services/lib/system-context',
    ],
    rpc: [
      'purge_security_events',
      'purge_sign_in_alerts',
      'purge_security_event_samples',
      'platform_security_alert_purge',
    ],
    tables: [],
  },
  'server/services/platform/security-alerts.ts': {
    imports: [
      'server-only',
      '@/lib/error-reporter',
      '@/lib/supabase/admin',
      '@/server/services/lib/fetch-by-ids',
      '@stockpilot/core',
    ],
    rpc: ['platform_security_alert_list'],
    tables: ['user_profiles'],
  },
  'server/actions/platform/security-alerts.ts': {
    imports: [
      'zod',
      '@/lib/auth/platform-admin',
      '@/server/services/platform/security-alerts',
      '@stockpilot/core',
    ],
    rpc: [],
    tables: [],
  },
  'components/platform/platform-security-alerts-section.tsx': {
    imports: [
      '@/lib/platform/viewer-time-zone',
      '@/server/services/platform/security-alerts',
      './security-alerts/security-alerts-client',
    ],
    rpc: [],
    tables: [],
  },
  'components/platform/security-alerts/security-alerts-client.tsx': {
    imports: [
      'react',
      '@/components/patterns/state-panel',
      '@/components/platform/platform-table',
      '@/components/platform/security-response/security-response-button',
      '@/components/platform/security-response/security-response-host',
      '@/components/platform/zoned-time',
      '@/components/ui/button',
      '@/components/ui/table',
      '@/lib/control-flow',
      '@/lib/platform/dates',
      '@/lib/platform/last-active',
      '@/server/actions/platform/security-alerts',
      '@stockpilot/core',
    ],
    rpc: [],
    tables: [],
  },
  'app/(platform)/platform/security/alerts/page.tsx': {
    imports: [
      'next',
      'react',
      '@/components/patterns/page-header',
      '@/components/platform/platform-page',
      '@/components/platform/platform-security-alerts-section',
      '@/lib/auth/platform-admin',
      '@stockpilot/core',
    ],
    rpc: [],
    tables: [],
  },
};

/**
 * ONE LEVEL DEEP: each module of the app that a module of the alerts imports
 * (and that is not one itself), and the only modules it may import.
 */
const ONE_LEVEL_DEEP: Record<string, string[]> = {
  'components/patterns/page-header.tsx': ['next/link', 'react', '@/lib/utils'],
  'components/patterns/state-panel.tsx': ['lucide-react', 'react', '@/lib/utils'],
  'components/platform/platform-page.tsx': ['react', '@/lib/utils'],
  'components/platform/platform-table.tsx': ['react', '@/lib/utils'],
  'components/platform/security-response/security-response-button.tsx': [
    'react',
    '@/components/ui/button',
    '@stockpilot/core',
    './security-response-host',
    './security-response-level',
  ],
  'components/platform/security-response/security-response-host.tsx': [
    'next/dynamic',
    'react',
    '@stockpilot/core',
    './security-response-panel',
  ],
  'components/platform/zoned-time.tsx': [
    '@stockpilot/core',
    '@/lib/platform/dates',
    '@/lib/platform/last-active',
  ],
  'components/ui/button.tsx': [
    '@radix-ui/react-slot',
    'class-variance-authority',
    'react',
    '@/lib/utils',
  ],
  'components/ui/table.tsx': ['react', '@/lib/utils', './table-scroll'],
  'lib/auth/platform-admin.ts': [
    'server-only',
    'react',
    'next/headers',
    'next/navigation',
    '@/lib/env',
    '@/lib/supabase/middleware',
    '@/lib/supabase/admin',
    '@/lib/supabase/server',
    '@stockpilot/core',
    './session',
    './passkey-bridge-name',
    './verified-claims',
  ],
  'lib/control-flow.ts': ['next/navigation'],
  'lib/env.ts': ['server-only', 'zod'],
  'lib/error-reporter.ts': ['server-only', '@/server/services/lib/defer', './error-reporter-core'],
  'lib/platform/dates.ts': ['@stockpilot/core'],
  'lib/platform/last-active.ts': ['./dates'],
  'lib/platform/viewer-time-zone.ts': [
    'server-only',
    'react',
    '@stockpilot/core',
    '@/lib/auth/session',
    '@/lib/dashboard/request-cache',
  ],
  'lib/supabase/admin.ts': [
    '@supabase/supabase-js',
    '@/lib/env',
    '@/lib/supabase/url-length-guard.server',
    '@stockpilot/core',
  ],
  'server/security/passkey-maintenance.ts': [
    'server-only',
    '@/lib/auth/passkey-relying-party',
    '@/lib/env',
    '@/lib/error-reporter',
    '@/lib/supabase/admin',
    './passkey-state',
  ],
  'server/services/lib/fetch-by-ids.ts': [
    'server-only',
    '@/lib/error-reporter',
    '@/lib/error-text',
    '@/lib/supabase/in-filter',
    '../context',
    './paginate',
    './postgrest-error',
  ],
  'server/services/lib/system-context.ts': [
    'server-only',
    'node:crypto',
    '@/lib/error-reporter',
    '@/lib/supabase/admin',
    '@stockpilot/core',
    '../context',
  ],
};

/** The language's own globals a module of the alerts may name without importing them. */
const GLOBALS = new Set([
  'AbortController',
  'AbortSignal',
  'Array',
  'Boolean',
  'Date',
  'Error',
  'Infinity',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'Set',
  'String',
  'clearTimeout',
  'console',
  'setTimeout',
  'undefined',
]);
/** Names that reach the network or the process: refused even if a module declares one of its own. */
const NEVER = new Set([
  'fetch',
  'globalThis',
  'window',
  'self',
  'document',
  'navigator',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Image',
  'Worker',
  'process',
  'require',
  'eval',
  'Function',
  'importScripts',
]);
/** Properties a module of the alerts may not touch: writes, other doors of the client, the network. */
const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);
/** The two doors a module calls by a listed name, and may never take as a value. */
const DOOR_VALUES = new Set(['rpc', 'from']);
const DOORS = new Set([
  'functions',
  'storage',
  'channel',
  'removeChannel',
  'realtime',
  'auth',
  'schema',
  'fetch',
  'sendBeacon',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const parse = (name: string, text: string) =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Every module a file imports: static, re-exported, and dynamic (a dynamic one not written out is '<not a literal>'). */
function importsOf(name: string, text: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      out.push('<import equals>');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      out.push(arg && ts.isStringLiteralLike(arg) ? arg.text : '<not a literal>');
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(name, text));
  return [...new Set(out)];
}

/** Whether an identifier sits in a type, not in code (a class's `extends` is code). */
function inType(node: ts.Node): boolean {
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    const p = n.parent;
    if (
      ts.isExpressionWithTypeArguments(n) &&
      ts.isHeritageClause(p) &&
      p.token === ts.SyntaxKind.ExtendsKeyword &&
      ts.isClassLike(p.parent)
    ) {
      return false;
    }
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) {
      return true;
    }
  }
  return false;
}

/** Whether an identifier names something (a reference in code), not a declaration, a property or a tag. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p || inType(id)) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) || ts.isMetaProperty(p)) return false;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isTypeParameterDeclaration(p)) &&
    p.name === id
  ) {
    return false;
  }
  if ((ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) && p.label === id) {
    return false;
  }
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (
    ts.isImportClause(p) ||
    ts.isImportSpecifier(p) ||
    ts.isNamespaceImport(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportEqualsDeclaration(p)
  ) {
    return false;
  }
  if (ts.isJsxAttribute(p) && p.name === id) return false;
  if (
    (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) &&
    p.tagName === id &&
    /^[a-z]/.test(id.text)
  ) {
    return false;
  }
  return true;
}

/** What a module of the alerts does that its rule does not allow. Empty: nothing. */
function problemsIn(name: string, text: string, rule: ModuleRule): string[] {
  const problems: string[] = [];
  const imports = importsOf(name, text);
  for (const spec of imports) {
    if (!rule.imports.includes(spec)) problems.push(`imports ${spec} (not on its list)`);
  }
  for (const spec of rule.imports) {
    if (!imports.includes(spec)) problems.push(`no longer imports ${spec} (update its list)`);
  }

  const source = parse(name, text);
  const declared = new Set<string>();
  const bind = (b: ts.BindingName) => {
    if (ts.isIdentifier(b)) declared.add(b.text);
    else for (const e of b.elements) if (!ts.isOmittedExpression(e)) bind(e.name);
  };
  const named = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name);
    else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      declared.add(node.name.text);
    } else if (ts.isImportClause(node) && node.name) declared.add(node.name.text);
    else if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node)) declared.add(node.name.text);

    // A property taken by its name: x.name, or x['name'].
    let prop: string | null = null;
    let access: ts.Expression | null = null;
    if (ts.isPropertyAccessExpression(node)) {
      prop = node.name.text;
      access = node;
    } else if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (ts.isStringLiteralLike(key)) {
        prop = key.text;
        access = node;
      } else if (!ts.isNumericLiteral(key)) {
        problems.push('takes a property by a computed name');
      }
    } else if (
      ts.isComputedPropertyName(node) &&
      !ts.isStringLiteralLike(node.expression) &&
      !ts.isNumericLiteral(node.expression)
    ) {
      problems.push('takes a property by a computed name');
    } else if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
      if (name !== null && (DOOR_VALUES.has(name) || WRITES.has(name) || DOORS.has(name))) {
        problems.push(`takes .${name} out by destructuring`);
      }
    }
    if (prop !== null && access !== null) {
      const parent = access.parent;
      const call = ts.isCallExpression(parent) && parent.expression === access;
      const first = call ? (parent as ts.CallExpression).arguments[0] : undefined;
      const literal = first && ts.isStringLiteralLike(first) ? first.text : null;
      const receiver = (access as ts.PropertyAccessExpression | ts.ElementAccessExpression)
        .expression;
      if (prop === 'rpc') {
        if (!call) problems.push('takes .rpc as a value');
        else if (literal === null)
          problems.push('calls .rpc without a function named in a literal');
        else if (!rule.rpc.includes(literal))
          problems.push(`calls .rpc('${literal}') (not on its list)`);
      } else if (prop === 'from' && !(ts.isIdentifier(receiver) && receiver.text === 'Array')) {
        if (!call) problems.push('takes .from as a value');
        else if (literal === null)
          problems.push('reads .from() without a table named in a literal');
        else if (!rule.tables.includes(literal)) {
          problems.push(`reads .from('${literal}') (not on its list)`);
        }
      } else if (WRITES.has(prop)) {
        problems.push(`writes with .${prop}`);
      } else if (DOORS.has(prop)) {
        problems.push(`touches .${prop}`);
      }
    }
    if (ts.isIdentifier(node) && isReference(node)) named.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const n of [...named].sort()) {
    if (NEVER.has(n)) problems.push(`names ${n}`);
    else if (!declared.has(n) && !GLOBALS.has(n))
      problems.push(`names ${n} (never declared or imported)`);
  }
  return problems;
}

/** A local import's file under src, or null for a package. */
function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = path.posix.join(path.posix.dirname(from), spec);
  else return null;
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(path.join(WEB_SRC, base + ext))) return base + ext;
  }
  return `${base} (not found)`;
}

/** One level deep: each local module the alerts import must be listed, and import only what is listed for it. */
function oneLevelDeepProblems(
  modules: Record<string, ModuleRule>,
  deep: Record<string, string[]>,
  read: (file: string) => string,
): string[] {
  const problems: string[] = [];
  const followed = new Set<string>();
  for (const [file, rule] of Object.entries(modules)) {
    for (const spec of rule.imports) {
      const dep = resolveLocal(file, spec);
      if (dep === null || dep in modules || followed.has(dep)) continue;
      followed.add(dep);
      if (!(dep in deep)) {
        problems.push(
          `${file} imports ${dep}, which this guard does not follow (judge it, then list it)`,
        );
        continue;
      }
      for (const imported of importsOf(dep, read(dep))) {
        if (!deep[dep]!.includes(imported))
          problems.push(`${dep} imports ${imported} (not on its list)`);
      }
    }
  }
  for (const dep of Object.keys(deep)) {
    if (!followed.has(dep))
      problems.push(`${dep} is listed one level deep, but no module of the alerts imports it`);
  }
  return problems;
}

/** Each 0480 function's callers, read from the code of every file under src. */
/**
 * The parts of a string expression in order: each written-out piece as its
 * text, each part that is not written out as null (a concatenation with +, a
 * template and its spans, brackets and type assertions looked through).
 */
function partsOf(e: ts.Expression): Array<string | null> {
  if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return [e.text];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    return partsOf(e.expression);
  }
  if (ts.isSatisfiesExpression(e)) return partsOf(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...partsOf(e.left), ...partsOf(e.right)];
  }
  if (ts.isTemplateExpression(e)) {
    return [
      e.head.text,
      ...e.templateSpans.flatMap((span) => [...partsOf(span.expression), span.literal.text]),
    ];
  }
  return [null];
}
/** The whole text of a concatenation or template whose parts are all written out; else null. */
const joinedText = (e: ts.Expression): string | null => {
  const parts = partsOf(e);
  return parts.every((p) => p !== null) ? parts.join('') : null;
};
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether a name made of these parts (null: anything) could be one of 0480's functions, or a new one. */
function couldNameAnAlertsFunction(parts: Array<string | null>): boolean {
  const re = new RegExp(`^${parts.map((p) => (p === null ? '.*' : escapeRe(p))).join('')}$`);
  return [...Object.keys(CALLERS), 'platform_security_alert_something_new'].some((fn) =>
    re.test(fn),
  );
}

/** The calls of .rpc (or ['rpc']) in one file's code, with their first argument. */
function rpcCalls(name: string, text: string): Array<ts.Expression | undefined> {
  const out: Array<ts.Expression | undefined> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      if (
        (ts.isPropertyAccessExpression(c) && c.name.text === 'rpc') ||
        (ts.isElementAccessExpression(c) &&
          ts.isStringLiteralLike(c.argumentExpression) &&
          c.argumentExpression.text === 'rpc')
      ) {
        out.push(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(name, text));
  return out;
}

/** Anywhere under src: an .rpc( whose function is not one plain literal, and could be one of 0480's. */
function builtRpcNames(files: Array<{ name: string; text: string }>): string[] {
  const problems: string[] = [];
  for (const { name, text } of files) {
    if (!text.includes('rpc')) continue;
    for (const arg of rpcCalls(name, text)) {
      if (
        arg !== undefined &&
        (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
      ) {
        continue;
      }
      if (arg === undefined || couldNameAnAlertsFunction(partsOf(arg))) {
        problems.push(
          `${name}: .rpc( with a function name built from parts, which could be one of 0480's`,
        );
      }
    }
  }
  return problems;
}

/** Each caller in CALLERS is a module of the alerts, and its rpc list names exactly the alerts functions CALLERS gives it. */
function callersAreModules(
  callers: Record<string, string[]>,
  modules: Record<string, ModuleRule>,
): string[] {
  const problems: string[] = [];
  const files = new Set([...Object.values(callers).flat(), ...Object.keys(modules)]);
  for (const file of [...files].sort()) {
    const given = Object.keys(callers).filter((fn) => callers[fn]!.includes(file));
    const rule = modules[file];
    if (!rule) {
      problems.push(`${file} calls ${given.join(', ')} but is not a module of the alerts`);
      continue;
    }
    const listed = rule.rpc.filter((fn) => fn in callers);
    if (listed.join() !== given.join()) {
      problems.push(
        `${file} lists ${listed.join(', ') || 'none'} of 0480's functions; CALLERS gives it ${given.join(', ') || 'none'}`,
      );
    }
  }
  return problems;
}

function callersOf(files: Array<{ name: string; text: string }>): Record<string, string[]> {
  const found: Record<string, string[]> = Object.fromEntries(
    Object.keys(CALLERS).map((fn) => [fn, [] as string[]]),
  );
  for (const { name, text } of files) {
    if (!/platform_|security_|_alert|admin_user/.test(text)) continue;
    const strings: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        strings.push(node.text);
      } else if (ts.isTemplateExpression(node)) {
        strings.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
      }
      // The joined text of a whole concatenation or template (not of a part of one).
      if (
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
          !(
            ts.isBinaryExpression(node.parent) &&
            node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
          )) ||
        ts.isTemplateExpression(node)
      ) {
        const joined = joinedText(node as ts.Expression);
        if (joined !== null) strings.push(joined);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(name, text));
    for (const literal of strings) {
      for (const fn of Object.keys(CALLERS)) {
        if (new RegExp(`\\b${fn}\\b`).test(literal) && !found[fn]!.includes(name)) {
          found[fn]!.push(name);
        }
      }
      // A function of 0480 this guard does not know is a new door.
      for (const m of literal.matchAll(/\bplatform_security_alert_[a-z_]+\b/g)) {
        if (!(m[0] in CALLERS)) (found[m[0]] ??= []).push(name);
      }
    }
  }
  for (const fn of Object.keys(found)) found[fn]!.sort();
  return found;
}

const readSrc = (file: string) => readFileSync(path.join(WEB_SRC, file), 'utf8');
const allFiles = () =>
  sourceFiles(WEB_SRC).map((file) => ({ name: rel(file), text: readFileSync(file, 'utf8') }));

describe('release 4a of the security alerts sends nothing', () => {
  it("each of 0480's functions is called from its one module only; the setter and the recipients from none", () => {
    expect(callersOf(allFiles())).toEqual(CALLERS);
  });

  it("anywhere under src, no .rpc( builds a name that could be one of 0480's functions", () => {
    expect(builtRpcNames(allFiles())).toEqual([]);
  });

  it('every caller of an alerts function is a module of the alerts, with exactly those functions on its list', () => {
    expect(callersAreModules(CALLERS, MODULES)).toEqual([]);
  });

  it.each(Object.keys(MODULES))(
    '%s imports exactly its list, calls only its functions and tables, writes nothing, and names nothing it did not import',
    (file) => {
      expect(problemsIn(file, readSrc(file), MODULES[file]!)).toEqual([]);
    },
  );

  it('one level deep: every module the alerts import is listed, and imports only what is listed for it', () => {
    expect(oneLevelDeepProblems(MODULES, ONE_LEVEL_DEEP, readSrc)).toEqual([]);
  });

  it('every module of the alerts is listed (a new one under the alerts names must be judged here)', () => {
    const found = allFiles()
      .map((f) => f.name)
      .filter(
        (name) =>
          /(?:^|\/)(?:security-alerts|alerts-job|alerts-reports)(?:[/.-]|$)/.test(name) &&
          !name.startsWith('test/') &&
          !(name in MODULES),
      );
    expect(found).toEqual([]);
  });
});

describe('the guard reads what it says it reads', () => {
  const JOB = 'server/security/alerts-job.ts';
  const job = () => readSrc(JOB);

  it('a call from another module is found; a name in a comment is not', () => {
    const planted = [
      { name: 'server/x.ts', text: "admin.rpc('platform_security_alert_set', {});" },
      { name: 'server/y.ts', text: "// platform_admin_user_ids is 4b's\nconst a = 1;" },
      { name: 'server/z.ts', text: 'const fn = `platform_security_alert_claim`;' },
      { name: 'server/w.ts', text: "rpc('platform_security_alert_everything')" },
    ];
    const found = callersOf(planted);
    expect(found.platform_security_alert_set).toEqual(['server/x.ts']);
    expect(found.platform_admin_user_ids).toEqual([]);
    expect(found.platform_security_alert_claim).toEqual(['server/z.ts']);
    expect(found.platform_security_alert_everything).toEqual(['server/w.ts']);
  });

  it('the job as it is has nothing to find', () => {
    expect(problemsIn(JOB, job(), MODULES[JOB]!)).toEqual([]);
  });

  // The final review of 4a planted these ten into the job; six passed the first guard.
  it.each([
    [
      'a row written to the notifications table',
      "await admin.from('notifications').insert({ user_id: id, title: 'Security alert' });",
      ["reads .from('notifications') (not on its list)", 'writes with .insert'],
    ],
    [
      'a queue function',
      "await admin.rpc('enqueue_outbox_message', { p_kind: 'security_alert' });",
      ["calls .rpc('enqueue_outbox_message') (not on its list)"],
    ],
    [
      'an edge function',
      "await admin.functions.invoke('push', { body: { title: 'Security alert' } });",
      ['touches .functions'],
    ],
    [
      'a neutral helper beside the job that sends',
      "import { handOut } from './alert-delivery';\nawait handOut(claim);",
      ['imports ./alert-delivery (not on its list)'],
    ],
    [
      'the existing passkey mailer',
      "import { emailPasskeyAdded } from '@/server/security/passkey-emails';\nawait emailPasskeyAdded(x);",
      ['imports @/server/security/passkey-emails (not on its list)'],
    ],
    [
      'the mail library itself',
      "import { Resend } from 'resend';\nawait new Resend(k).emails.send({});",
      ['imports resend (not on its list)'],
    ],
    [
      'fetch through globalThis',
      "await globalThis.fetch('https://hooks.example.test/x', { method: 'POST' });",
      ['names globalThis', 'touches .fetch'],
    ],
    [
      'fetch renamed',
      "const post = fetch;\nawait post('https://hooks.example.test/x');",
      ['names fetch'],
    ],
    [
      'the error reporter used as the channel',
      "await reportError(new Error('SECURITY ALERT: sign_in_not_me'), { tag: 'alert', level: 'error' });",
      ['names reportError (never declared or imported)'],
    ],
    [
      'the recipients read from the env list the job already reads',
      "for (const to of (env.STOCKPILOT_PLATFORM_ADMIN_EMAILS ?? '').split(',')) await mailer.queue(to, body);",
      ['names mailer (never declared or imported)'],
    ],
  ])('a planted sender is found: %s', (_what, planted, expected) => {
    const found = problemsIn(JOB, `${job()}\n${planted}`, MODULES[JOB]!);
    for (const problem of expected) expect(found).toContain(problem);
  });

  it.each([
    [
      'the error reporter imported by the job itself',
      "import { reportError } from '@/lib/error-reporter';",
      'imports @/lib/error-reporter (not on its list)',
    ],
    [
      'a function named in a variable',
      "const fn = 'platform_security_alert_set';\nawait admin.rpc(fn);",
      'calls .rpc without a function named in a literal',
    ],
    [
      'the rpc door taken as a value',
      'const door = admin.rpc;',
      'takes .rpc as a value',
    ],
    [
      'a write by another name',
      "await admin.from('platform_security_alerts').upsert({});",
      'writes with .upsert',
    ],
    [
      'the auth door (an invitation is an email)',
      "await admin.auth.admin.inviteUserByEmail('a@example.test');",
      'touches .auth',
    ],
    ['a socket', "new WebSocket('wss://example.test');", 'names WebSocket'],
    ['fetch declared over', 'const fetch = (u: string) => u;\nawait fetch(url);', 'names fetch'],
    [
      'a dynamic import',
      "const m = await import('@/lib/notifications/x');",
      'imports @/lib/notifications/x (not on its list)',
    ],
    [
      'a dynamic import not written out',
      'const m = await import(where);',
      'imports <not a literal> (not on its list)',
    ],
    ['the process', "process.env.X = '1';", 'names process'],
  ])('more planted: %s', (_what, planted, problem) => {
    expect(problemsIn(JOB, `${job()}\n${planted}`, MODULES[JOB]!)).toContain(problem);
  });

  // The second review of the allow-list: a door by element access, a door taken as a value.
  it.each([
    [
      'rpc by element access',
      "await admin['rpc']('enqueue_outbox_message', {});",
      "calls .rpc('enqueue_outbox_message') (not on its list)",
    ],
    [
      'from by element access',
      "await admin['from']('notifications').select('id');",
      "reads .from('notifications') (not on its list)",
    ],
    [
      'a write by element access',
      "await admin.from('user_profiles')['update']({});",
      'writes with .update',
    ],
    [
      'a door by a computed name',
      "const door = 'r' + 'pc';\nawait admin[door]('enqueue_outbox_message');",
      'takes a property by a computed name',
    ],
    ['a computed property name', 'const o = { [kind]: 1 };', 'takes a property by a computed name'],
    [
      'a computed name destructured',
      'const { [kind]: door } = admin;',
      'takes a property by a computed name',
    ],
    ['rpc destructured', 'const { rpc } = admin;', 'takes .rpc out by destructuring'],
    [
      'from destructured and renamed',
      'const { from: q } = admin;',
      'takes .from out by destructuring',
    ],
    [
      'functions destructured',
      'const { functions } = admin;',
      'takes .functions out by destructuring',
    ],
    ['rpc held in a variable', 'const f = admin.rpc;', 'takes .rpc as a value'],
    ['rpc bound', 'const f = admin.rpc.bind(admin);', 'takes .rpc as a value'],
    [
      'rpc called through call',
      "await admin.rpc.call(admin, 'enqueue_outbox_message');",
      'takes .rpc as a value',
    ],
    ['from held in a variable', 'const q = admin.from;', 'takes .from as a value'],
  ])('planted, a door by another road: %s', (_what, planted, problem) => {
    expect(problemsIn(JOB, `${job()}\n${planted}`, MODULES[JOB]!)).toContain(problem);
  });

  it('a name built from parts is counted when every part is written out, and refused in .rpc( when it could be an alerts function', () => {
    const planted = [
      { name: 'server/a.ts', text: "await admin.rpc('platform_security_' + 'alert_claim', {});" },
      { name: 'server/b.ts', text: "await admin.rpc(`platform_security_alert_${'set'}`, {});" },
      { name: 'server/c.ts', text: "const fn = 'platform_' + 'admin_user_ids';" },
      { name: 'server/d.ts', text: 'await admin.rpc(fn, {});' },
      { name: 'server/e.ts', text: 'await admin.rpc(`platform_security_alert_${step}`, {});' },
      { name: 'server/f.ts', text: "await admin['rpc']('platform_security_' + kind);" },
      { name: 'server/g.ts', text: "await admin.rpc('inventory_' + kind, {});" },
      { name: 'server/h.ts', text: "await admin.rpc('purge_security_events');" },
    ];
    const found = callersOf(planted);
    expect(found.platform_security_alert_claim).toEqual(['server/a.ts']);
    expect(found.platform_security_alert_set).toEqual(['server/b.ts']);
    expect(found.platform_admin_user_ids).toEqual(['server/c.ts']);
    expect(builtRpcNames(planted).map((p) => p.slice(0, p.indexOf(':')))).toEqual([
      'server/a.ts',
      'server/b.ts',
      'server/d.ts',
      'server/e.ts',
      'server/f.ts',
    ]);
  });

  it('a caller the alerts modules do not list is found, and so is a module whose list disagrees with CALLERS', () => {
    const retention = 'app/api/cron/security-events-retention/route.ts';
    const { [retention]: _gone, ...withoutRetention } = MODULES;
    expect(callersAreModules(CALLERS, withoutRetention)).toEqual([
      `${retention} calls platform_security_alert_purge but is not a module of the alerts`,
    ]);
    const extra = {
      ...MODULES,
      [JOB]: { ...MODULES[JOB]!, rpc: [...MODULES[JOB]!.rpc, 'platform_security_alert_set'] },
    };
    expect(callersAreModules(CALLERS, extra)).toEqual([
      `${JOB} lists platform_security_alert_heartbeat, platform_security_alert_inputs, platform_security_alert_claim, platform_security_alert_result, platform_security_alert_set of 0480's functions; CALLERS gives it platform_security_alert_heartbeat, platform_security_alert_inputs, platform_security_alert_claim, platform_security_alert_result`,
    ]);
  });

  it('one level deep: a listed module that starts importing a sender is found', () => {
    const read = (file: string) =>
      file === 'lib/env.ts' ? `${readSrc(file)}\nimport { Resend } from 'resend';` : readSrc(file);
    expect(oneLevelDeepProblems(MODULES, ONE_LEVEL_DEEP, read)).toEqual([
      'lib/env.ts imports resend (not on its list)',
    ]);
  });

  it("one level deep: a new helper put on a module's list is not followed until it is listed", () => {
    const modules = {
      ...MODULES,
      [JOB]: { ...MODULES[JOB]!, imports: [...MODULES[JOB]!.imports, './alerts-job-delivery'] },
    };
    expect(oneLevelDeepProblems(modules, ONE_LEVEL_DEEP, readSrc)).toEqual([
      `${JOB} imports server/security/alerts-job-delivery (not found), which this guard does not follow (judge it, then list it)`,
    ]);
  });
});
