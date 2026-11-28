// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Security invariant: release 4a of the security alerts is RECORD ONLY.
 *
 * Nothing in this build may send an alert, look up who would receive one, or
 * change a switch, a threshold or a planned check.
 *
 * WHAT THIS GUARD IS: A TRIPWIRE, NOT A PROOF. It reads the source of the
 * alerts' modules and fails when a change adds a way to send that it
 * recognises, so an accidental or careless sender (a mailer imported out of
 * habit, a helper that posts, a write to the wrong table) fails CI before
 * anyone relies on review alone. It does not prove that nothing can be sent:
 * it reads text and names, not what runs, and code written on purpose to get
 * past it can. A reviewer still reads every change to these modules and to
 * this guard; that review is the control.
 *
 * WHAT IT CATCHES. It is an allow-list, not a list of senders to look for (a
 * sender with a neutral name would pass that):
 *   1. CALLERS: every function of migration 0480 is named (in a string
 *      literal of code, or in a concatenation or template whose parts are
 *      all written out; comments aside) in exactly the module this release
 *      gives it, and nowhere else: the job's four, the daily job's baseline,
 *      the retention's purge, the console's list. The setter
 *      (platform_security_alert_set) and the recipients' lookup
 *      (platform_admin_user_ids) are named nowhere. Anywhere under src, an
 *      .rpc( whose function is not one plain literal, and could be one of
 *      them, is refused.
 *   2. MODULES: each module of the alerts (the alert job, its report helper
 *      and its route, the daily job, the retention job, the console's
 *      service, action, section, client and page; every caller in CALLERS
 *      must be one of them):
 *        - imports exactly the modules on its list, and from each exactly
 *          the names listed for that import (types included; '*' for a
 *          namespace import, an `export *` or a dynamic import, listed only
 *          for React in the client). A new name taken from a module already
 *          allowed fails, whatever that module has come to export;
 *        - calls .rpc only with a function named in a literal on its list,
 *          and .from only with a table on its list, and writes nothing
 *          (insert, update, upsert, delete);
 *        - does not take .rpc or .from as a value, touches none of the
 *          client's other doors in DOORS, and takes no property by a
 *          computed name;
 *        - names nothing it did not declare or import beyond the plain
 *          language globals in GLOBALS, and none of the names in NEVER
 *          (network, process and code-loading names) even if it declares one.
 *   3. ONE LEVEL DEEP: every module of the app that a module of the alerts
 *      imports (and that is not one itself) is read too. It may import only
 *      what ONE_LEVEL_DEEP lists for it, and may name none of NEVER and make
 *      no dynamic import beyond the few uses ONE_LEVEL_DEEP_JUDGED lists for
 *      it, by count: one more, or a new one, fails. A new helper is on no
 *      list, so it fails until it is judged and listed.
 * The self-tests at the bottom plant senders of each kind above, and each
 * must be found, so this cannot pass by reading nothing.
 *
 * WHAT IT DOES NOT COVER, in general terms: what a name holds when the code
 * runs (it reads names, not types, and is not scope-aware); a module more
 * than one level deep, a package, and @stockpilot/core (the pure half, no
 * I/O, not followed); and anything outside apps/web/src. It finds the
 * senders it recognises, not every way code can reach the network.
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
  /**
   * Exactly the modules it imports, and for each exactly the names it takes
   * from it (types included): 'default' for a default import, '*' for a
   * namespace import, an `export *` or a dynamic import; [] for an import
   * of its side effects only (server-only, a stylesheet).
   */
  imports: Record<string, string[]>;
  /** The only database functions it may call, by exact name. */
  rpc: string[];
  /** The only tables it may read with .from(), by exact name. */
  tables: string[];
}

/** THE MODULES OF THE ALERTS: what each may import and call. */
const MODULES: Record<string, ModuleRule> = {
  'server/security/alerts-job.ts': {
    imports: {
      'server-only': [],
      '@/lib/env': ['env'],
      '@/lib/supabase/admin': ['createAdminClient'],
      '@/server/security/alerts-reports': [
        'alertWhereCode',
        'reportAlertJob',
        'AlertJobReportData',
        'AlertJobReportTag',
      ],
      '@stockpilot/core': [
        'ADMIN_EMAILS_MOST',
        'ALERT_EXPECTED_CLAIM_REFUSALS',
        'alertReminderKey',
        'alertRestartAsk',
        'dueReminderStep',
        'planSecurityAlerts',
        'readSecurityAlertClaim',
        'readSecurityAlertHeartbeatFinish',
        'readSecurityAlertHeartbeatStart',
        'readSecurityAlertInputs',
        'readSecurityAlertResult',
        'recordOnlyResult',
        'AlertClaimAnswer',
        'AlertClaimAsk',
        'AlertSpikeHeld',
        'SecurityAlertInputs',
        'SecurityAlertPlan',
      ],
    },
    rpc: [
      'platform_security_alert_heartbeat',
      'platform_security_alert_inputs',
      'platform_security_alert_claim',
      'platform_security_alert_result',
    ],
    tables: [],
  },
  'server/security/alerts-reports.ts': {
    imports: {
      'server-only': [],
      '@/lib/error-reporter': ['reportError'],
      '@stockpilot/core': ['ALERT_REPORT_GAP_HOURS'],
    },
    rpc: [],
    tables: [],
  },
  'app/api/cron/security-alerts/route.ts': {
    imports: {
      'next/server': ['NextResponse'],
      '@/lib/env': ['env'],
      '@/server/security/alerts-job': ['runSecurityAlerts', 'SECURITY_ALERTS_TAG'],
      '@/server/services/lib/system-context': ['secretsEqual'],
    },
    rpc: [],
    tables: [],
  },
  'app/api/cron/security-summary/route.ts': {
    imports: {
      'next/server': ['NextResponse'],
      '@/lib/env': ['env'],
      '@/lib/supabase/admin': ['createAdminClient'],
      '@/server/security/alerts-reports': [
        'alertWhereCode',
        'reportAlertJob',
        'AlertJobReportData',
        'AlertJobReportTag',
      ],
      '@/server/services/lib/system-context': ['secretsEqual'],
      '@stockpilot/core': ['readSecurityAlertBaseline'],
    },
    rpc: ['platform_security_alert_baseline'],
    tables: [],
  },
  'app/api/cron/security-events-retention/route.ts': {
    imports: {
      'next/server': ['NextResponse'],
      '@/lib/env': ['env'],
      '@/lib/error-reporter': ['reportError'],
      '@/lib/supabase/admin': ['createAdminClient'],
      '@/server/security/passkey-maintenance': ['runPasskeyMaintenance'],
      '@/server/services/lib/system-context': ['secretsEqual'],
    },
    rpc: [
      'purge_security_events',
      'purge_sign_in_alerts',
      'purge_security_event_samples',
      'platform_security_alert_purge',
    ],
    tables: [],
  },
  'server/services/platform/security-alerts.ts': {
    imports: {
      'server-only': [],
      '@/lib/error-reporter': ['reportError'],
      '@/lib/supabase/admin': ['createAdminClient'],
      '@/server/services/lib/fetch-by-ids': ['fetchAllRowsByIds', 'rawErrorText'],
      '@stockpilot/core': [
        'ALERT_LIST_DEFAULT',
        'SECURITY_ALERTS_FAILED',
        'readSecurityAlertList',
        'SecurityAlertChange',
        'SecurityAlertChangeView',
        'SecurityAlertsResult',
      ],
    },
    rpc: ['platform_security_alert_list'],
    tables: ['user_profiles'],
  },
  'server/actions/platform/security-alerts.ts': {
    imports: {
      zod: ['z'],
      '@/lib/auth/platform-admin': ['checkPlatformConsoleRead'],
      '@/server/services/platform/security-alerts': ['readPlatformSecurityAlerts'],
      '@stockpilot/core': [
        'SECURITY_ALERTS_FAILED',
        'SECURITY_ALERTS_REFUSED',
        'SecurityAlertsResult',
      ],
    },
    rpc: [],
    tables: [],
  },
  'components/platform/platform-security-alerts-section.tsx': {
    imports: {
      '@/lib/platform/viewer-time-zone': ['readPlatformViewerTimeZone'],
      '@/server/services/platform/security-alerts': ['readPlatformSecurityAlerts'],
      './security-alerts/security-alerts-client': ['SecurityAlertsClient'],
    },
    rpc: [],
    tables: [],
  },
  'components/platform/security-alerts/security-alerts-client.tsx': {
    imports: {
      // React's namespace (React.useState and the rest): the one '*' on any list.
      react: ['*'],
      '@/components/patterns/state-panel': ['StatePanel'],
      '@/components/platform/platform-table': ['PlatformTable'],
      '@/components/platform/security-response/security-response-button': [
        'SecurityResponseButton',
      ],
      '@/components/platform/security-response/security-response-host': ['SecurityResponseHost'],
      '@/components/platform/zoned-time': [
        'ConsoleMoment',
        'consoleZoneNote',
        'SECURITY_PAGES_CLOCK',
        'ZonedWords',
      ],
      '@/components/ui/button': ['Button'],
      '@/components/ui/table': ['TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow'],
      '@/lib/control-flow': ['isControlFlow'],
      '@/lib/platform/dates': ['formatMomentInZone'],
      '@/lib/platform/last-active': ['formatExactUtc'],
      '@/server/actions/platform/security-alerts': ['readPlatformSecurityAlertsAction'],
      '@stockpilot/core': [
        'ALERT_LIST_DEFAULT',
        'SECURITY_ALERTS_FAILED',
        'SECURITY_ALERTS_WORDS',
        'securityAlertCardId',
        'securityAlertChangeLabel',
        'securityAlertChangeValueWords',
        'securityAlertClassLabel',
        'securityAlertCountsWords',
        'securityAlertEventsFromMs',
        'securityAlertPhaseLabel',
        'securityAlertRuleLabel',
        'securityAlertSendingLines',
        'securityAlertsHeartbeatSay',
        'securityAlertThresholdRows',
        'securityAlertWhat',
        'SecurityAlertChangeView',
        'SecurityAlertRow',
        'SecurityAlertsResult',
        'SecurityAlertsView',
      ],
      './record-only-banner': ['SecurityAlertsRecordOnlyBanner'],
    },
    rpc: [],
    tables: [],
  },
  'components/platform/security-alerts/record-only-banner.tsx': {
    imports: { '@stockpilot/core': ['SECURITY_ALERTS_WORDS'] },
    rpc: [],
    tables: [],
  },
  'app/(platform)/platform/security/alerts/page.tsx': {
    imports: {
      next: ['Metadata'],
      react: ['Suspense'],
      '@/components/patterns/page-header': ['PageHeader', 'PageHeaderBackLink'],
      '@/components/platform/platform-page': ['PlatformPage'],
      '@/components/platform/platform-security-alerts-section': ['PlatformSecurityAlertsSection'],
      '@/components/platform/security-alerts/record-only-banner': [
        'SecurityAlertsRecordOnlyBanner',
      ],
      '@/lib/auth/platform-admin': ['requirePlatformAdmin'],
      '@/styles/liquid-glass/pages/admin.css': [],
      '@/styles/liquid-glass/pages/platform.css': [],
      '@stockpilot/core': ['SECURITY_ALERTS_WORDS'],
    },
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

/**
 * ONE LEVEL DEEP, JUDGED: the only uses of a NEVER name, or of a dynamic
 * import ('import()'), that a module one level deep may make, each by its
 * exact count as judged on 2026-11-27. Every other module one level deep may
 * make none. One more use, or a use of another of them, fails.
 */
const ONE_LEVEL_DEEP_JUDGED: Record<string, Record<string, number>> = {
  // Loads its own panel's code (a module already on its list) when the panel opens.
  'components/platform/security-response/security-response-host.tsx': { 'import()': 1 },
  // Reads the environment's variables, and tells the server from the browser.
  'lib/env.ts': { process: 10, window: 1 },
  // Its own health check of the sign-in service (a GET to the project's URL, no alert in it).
  'server/security/passkey-maintenance.ts': { fetch: 1 },
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
  'Reflect',
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

/**
 * The names a file takes from each module it imports or re-exports from:
 * each named binding by the name the module exports it under, 'default' for
 * a default import, '*' for a namespace import, an `export *` (or `* as`)
 * and a dynamic import of a written-out module. An import of side effects
 * only takes nothing.
 */
function takenFrom(name: string, text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const take = (spec: string, taken?: string) => {
    const names = out.get(spec) ?? new Set<string>();
    if (taken !== undefined) names.add(taken);
    out.set(spec, names);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      take(spec);
      const clause = node.importClause;
      if (clause?.name) take(spec, 'default');
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) take(spec, '*');
      else if (bindings)
        for (const e of bindings.elements) take(spec, (e.propertyName ?? e.name).text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      take(spec);
      const clause = node.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) take(spec, '*');
      else for (const e of clause.elements) take(spec, (e.propertyName ?? e.name).text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      take(node.arguments[0].text, '*');
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(name, text));
  return out;
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
  const listed = Object.keys(rule.imports);
  for (const spec of imports) {
    if (!listed.includes(spec)) problems.push(`imports ${spec} (not on its list)`);
  }
  for (const spec of listed) {
    if (!imports.includes(spec)) problems.push(`no longer imports ${spec} (update its list)`);
  }
  // From each import on its list, exactly the names listed for it.
  for (const [spec, taken] of takenFrom(name, text)) {
    const names = rule.imports[spec];
    if (names === undefined) continue;
    for (const n of [...taken].sort()) {
      if (!names.includes(n)) problems.push(`takes ${n} from ${spec} (not on its list)`);
    }
    for (const n of names) {
      if (!taken.has(n)) problems.push(`no longer takes ${n} from ${spec} (update its list)`);
    }
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
  const code = ['.ts', '.tsx', '/index.ts', '/index.tsx'].find((ext) =>
    existsSync(path.join(WEB_SRC, base + ext)),
  );
  if (code !== undefined) return base + code;
  // A stylesheet holds no code, so it is not followed; it must still be on the
  // module's exact import list. Only a .css file that exists, with no code file
  // behind the same name (checked just above).
  if (base.endsWith('.css') && existsSync(path.join(WEB_SRC, base))) return null;
  return `${base} (not found)`;
}

/** How many times a file names each of NEVER in its code, and makes a dynamic import ('import()'). */
function neverUses(name: string, text: string): Map<string, number> {
  const uses = new Map<string, number>();
  const count = (what: string) => uses.set(what, (uses.get(what) ?? 0) + 1);
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && NEVER.has(node.text) && isReference(node)) count(node.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      count('import()');
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(name, text));
  return uses;
}

/**
 * One level deep: each local module the alerts import must be listed, import
 * only what is listed for it, and use NEVER's names and dynamic imports only
 * as judged for it, by count.
 */
function oneLevelDeepProblems(
  modules: Record<string, ModuleRule>,
  deep: Record<string, string[]>,
  read: (file: string) => string,
  judged: Record<string, Record<string, number>> = ONE_LEVEL_DEEP_JUDGED,
): string[] {
  const problems: string[] = [];
  const followed = new Set<string>();
  for (const [file, rule] of Object.entries(modules)) {
    for (const spec of Object.keys(rule.imports)) {
      const dep = resolveLocal(file, spec);
      if (dep === null || dep in modules || followed.has(dep)) continue;
      followed.add(dep);
      if (!(dep in deep)) {
        problems.push(
          `${file} imports ${dep}, which this guard does not follow (judge it, then list it)`,
        );
        continue;
      }
      const text = read(dep);
      for (const imported of importsOf(dep, text)) {
        if (!deep[dep]!.includes(imported))
          problems.push(`${dep} imports ${imported} (not on its list)`);
      }
      const allowed = judged[dep] ?? {};
      const uses = neverUses(dep, text);
      for (const what of [...new Set([...uses.keys(), ...Object.keys(allowed)])].sort()) {
        const n = uses.get(what) ?? 0;
        const ok = allowed[what] ?? 0;
        if (n !== ok) problems.push(`${dep} uses ${what} (${n}; judged for ${ok})`);
      }
    }
  }
  for (const dep of Object.keys(deep)) {
    if (!followed.has(dep))
      problems.push(`${dep} is listed one level deep, but no module of the alerts imports it`);
  }
  for (const dep of Object.keys(judged)) {
    if (!(dep in deep)) problems.push(`${dep} is judged, but is not listed one level deep`);
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
    ['the rpc door taken as a value', 'const door = admin.rpc;', 'takes .rpc as a value'],
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
      [JOB]: {
        ...MODULES[JOB]!,
        imports: { ...MODULES[JOB]!.imports, './alerts-job-delivery': [] },
      },
    };
    expect(oneLevelDeepProblems(modules, ONE_LEVEL_DEEP, readSrc)).toEqual([
      `${JOB} imports server/security/alerts-job-delivery (not found), which this guard does not follow (judge it, then list it)`,
    ]);
  });

  it('one level deep: only a stylesheet that exists is left unfollowed; any other .css name is still judged', () => {
    const modules = {
      ...MODULES,
      [JOB]: {
        ...MODULES[JOB]!,
        imports: { ...MODULES[JOB]!.imports, '@/styles/liquid-glass/pages/not-a-sheet.css': [] },
      },
    };
    expect(oneLevelDeepProblems(modules, ONE_LEVEL_DEEP, readSrc)).toEqual([
      `${JOB} imports styles/liquid-glass/pages/not-a-sheet.css (not found), which this guard does not follow (judge it, then list it)`,
    ]);
    // And a stylesheet is still held to the exact import list of its module.
    const page = 'app/(platform)/platform/security/alerts/page.tsx';
    const text = `${readSrc(page)}\nimport '@/styles/liquid-glass/pages/inventory.css';`;
    expect(problemsIn(page, text, MODULES[page]!)).toEqual([
      'imports @/styles/liquid-glass/pages/inventory.css (not on its list)',
    ]);
  });

  // Review round 2 (R2-S1): what a module one level deep does with no new import.
  const DEEP = 'lib/error-reporter.ts';
  it.each([
    ['a fetch call', "void fetch('https://hooks.example.test/x', { method: 'POST' });", 'fetch'],
    ['a call through globalThis', 'globalThis.queueMicrotask(() => undefined);', 'globalThis'],
    ['the Function constructor', "const make = new Function('return 1');", 'Function'],
    ['a call through Reflect', 'Reflect.apply(String, undefined, [1]);', 'Reflect'],
    ['eval', "eval('1');", 'eval'],
    [
      'a dynamic import of a module already on its list',
      "void import('./error-reporter-core');",
      'import()',
    ],
    ['require', "const https = require('node:https');", 'require'],
  ])('one level deep: a listed module that adds %s is found', (_what, planted, what) => {
    const read = (file: string) => (file === DEEP ? `${readSrc(file)}\n${planted}` : readSrc(file));
    expect(oneLevelDeepProblems(MODULES, ONE_LEVEL_DEEP, read)).toEqual([
      `${DEEP} uses ${what} (1; judged for 0)`,
    ]);
  });

  it('one level deep: a judged use is held to its count (one more fetch is found), and a judged use that is gone must come off the list', () => {
    const health = 'server/security/passkey-maintenance.ts';
    const read = (file: string) =>
      file === health
        ? `${readSrc(file)}\nvoid fetch('https://hooks.example.test/x', { method: 'POST' });`
        : readSrc(file);
    expect(oneLevelDeepProblems(MODULES, ONE_LEVEL_DEEP, read)).toEqual([
      `${health} uses fetch (2; judged for 1)`,
    ]);
    const stale = { ...ONE_LEVEL_DEEP_JUDGED, 'lib/control-flow.ts': { fetch: 1 } };
    expect(oneLevelDeepProblems(MODULES, ONE_LEVEL_DEEP, readSrc, stale)).toEqual([
      'lib/control-flow.ts uses fetch (0; judged for 1)',
    ]);
  });

  it('a re-export through an import already allowed: the new name is refused where a module of the alerts takes it', () => {
    const REPORTS = 'server/security/alerts-reports.ts';
    // The error reporter comes to re-export more from a module already on its list ...
    const read = (file: string) =>
      file === DEEP
        ? `${readSrc(file)}\nexport { reportError as reportNow } from './error-reporter-core';\nexport * from './error-reporter-core';`
        : readSrc(file);
    // ... which one level deep reads as nothing new (the same import) ...
    expect(oneLevelDeepProblems(MODULES, ONE_LEVEL_DEEP, read)).toEqual([]);
    // ... but the report helper taking the new names is refused, name by name.
    const takes = `${readSrc(REPORTS)}\nimport { reportNow, isNextControlFlowError } from '@/lib/error-reporter';`;
    expect(problemsIn(REPORTS, takes, MODULES[REPORTS]!)).toEqual([
      'takes isNextControlFlowError from @/lib/error-reporter (not on its list)',
      'takes reportNow from @/lib/error-reporter (not on its list)',
    ]);
  });

  it.each([
    [
      'a namespace import of an allowed module',
      "import * as reporter from '@/server/security/alerts-reports';",
      'takes * from @/server/security/alerts-reports (not on its list)',
    ],
    [
      'a dynamic import of an allowed module',
      "const later = await import('@/lib/supabase/admin');",
      'takes * from @/lib/supabase/admin (not on its list)',
    ],
    [
      'a re-export of everything an allowed module has',
      "export * from '@/lib/env';",
      'takes * from @/lib/env (not on its list)',
    ],
    [
      'a default import of an allowed module',
      "import admin from '@/lib/supabase/admin';",
      'takes default from @/lib/supabase/admin (not on its list)',
    ],
    [
      'a name renamed on the way in',
      "import { createAdminClient as make, createAdminClient as again } from '@/lib/supabase/admin';\nimport { recordOnlyResult as other, isAlertCounts as check } from '@stockpilot/core';",
      'takes isAlertCounts from @stockpilot/core (not on its list)',
    ],
  ])('planted, a name taken from an import already allowed: %s', (_what, planted, problem) => {
    expect(problemsIn(JOB, `${job()}\n${planted}`, MODULES[JOB]!)).toContain(problem);
  });

  it('a name on a list that the module no longer takes must come off it', () => {
    const rule = {
      ...MODULES[JOB]!,
      imports: { ...MODULES[JOB]!.imports, '@/lib/env': ['env', 'clientEnv'] },
    };
    expect(problemsIn(JOB, job(), rule)).toEqual([
      'no longer takes clientEnv from @/lib/env (update its list)',
    ]);
  });
});
