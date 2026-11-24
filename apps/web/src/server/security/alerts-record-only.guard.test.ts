// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Security invariant: release 4a of the security alerts is RECORD ONLY.
 *
 * Nothing in this build may send an alert, look up who would receive one, or
 * change a switch, a threshold or a planned check. So:
 *   1. every function of migration 0480 is called (named in a string literal
 *      of code, comments aside) from exactly the module this release gives
 *      it, and from nowhere else: the job's four, the daily job's baseline,
 *      the retention's purge, the console's list. The setter
 *      (platform_security_alert_set) and the recipients' lookup
 *      (platform_admin_user_ids) are called from nowhere: 4b adds them, with
 *      their own review.
 *   2. the modules of the alerts (the job, its two routes, the console's
 *      service, action, section, client and page) import no sender, no
 *      notification module and no mail or push library, call no fetch of
 *      their own, and never name a send function.
 * The self-tests at the bottom plant each violation, so this cannot pass by
 * reading nothing.
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

/** The modules of the alerts: none may send. */
const ALERT_MODULES = [
  'server/security/alerts-job.ts',
  'app/api/cron/security-alerts/route.ts',
  'app/api/cron/security-summary/route.ts',
  'server/services/platform/security-alerts.ts',
  'server/actions/platform/security-alerts.ts',
  'components/platform/platform-security-alerts-section.tsx',
  'components/platform/security-alerts/security-alerts-client.tsx',
  'app/(platform)/platform/security/alerts/page.tsx',
];

/** An import a module that must not send may not make. */
const SENDER_IMPORT =
  /(?:^|\/)(?:resend|email|emails|mail|mailer|push|notify|notifications?|digest|expo-server-sdk|nodemailer|twilio)(?:[-/.]|$)|-email$|-emails$|-notify$/i;
/** A name that sends. */
const SENDER_NAME = /^(?:send[A-Z]\w*|notify[A-Z]\w*|deliver[A-Z]\w*|push[A-Z]\w*To\w*)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

interface Read {
  strings: string[];
  imports: string[];
  calls: string[];
}

/** What a file's code says: its string literals, the modules it imports, the names it calls. */
function readCode(name: string, text: string): Read {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Read = { strings: [], imports: [], calls: [] };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.strings.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.strings.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
        const arg = node.arguments[0];
        out.imports.push(ts.isStringLiteral(arg) ? arg.text : '<not a literal>');
      } else if (ts.isIdentifier(callee)) {
        out.calls.push(callee.text);
      } else if (ts.isPropertyAccessExpression(callee)) {
        out.calls.push(callee.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Each 0480 function's callers, read from the code of every file under src. */
function callersOf(files: Array<{ name: string; text: string }>): Record<string, string[]> {
  const found: Record<string, string[]> = Object.fromEntries(
    Object.keys(CALLERS).map((fn) => [fn, [] as string[]]),
  );
  for (const { name, text } of files) {
    if (!/platform_security_alert_|platform_admin_user_ids/.test(text)) continue;
    for (const literal of readCode(name, text).strings) {
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

/** What a module of the alerts does that sends, or could. */
function sendingIn(name: string, text: string): string[] {
  const code = readCode(name, text);
  const problems: string[] = [];
  for (const spec of code.imports) {
    if (spec === '<not a literal>' || SENDER_IMPORT.test(spec)) problems.push(`imports ${spec}`);
  }
  for (const call of code.calls) {
    if (call === 'fetch') problems.push('calls fetch');
    if (SENDER_NAME.test(call)) problems.push(`calls ${call}`);
  }
  return problems;
}

const allFiles = () =>
  sourceFiles(WEB_SRC).map((file) => ({ name: rel(file), text: readFileSync(file, 'utf8') }));

describe('release 4a of the security alerts sends nothing', () => {
  it("each of 0480's functions is called from its one module only; the setter and the recipients from none", () => {
    expect(callersOf(allFiles())).toEqual(CALLERS);
  });

  it.each(ALERT_MODULES)(
    '%s imports no sender, calls no fetch and names no send function',
    (file) => {
      const text = readFileSync(path.join(WEB_SRC, file), 'utf8');
      expect(sendingIn(file, text)).toEqual([]);
    },
  );

  it('every module of the alerts is listed (a new one under the alerts folders must be judged here)', () => {
    const listed = new Set(ALERT_MODULES);
    const found = allFiles()
      .map((f) => f.name)
      .filter(
        (name) =>
          /(?:^|\/)(?:security-alerts|alerts-job)(?:[/.-]|$)/.test(name) &&
          !name.startsWith('test/') &&
          !listed.has(name),
      );
    expect(found).toEqual([]);
  });
});

describe('the guard reads what it says it reads', () => {
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

  it.each([
    ["import { sendEmail } from '@/lib/email/resend';", 'imports @/lib/email/resend'],
    ["import { x } from '@/server/services/push';", 'imports @/server/services/push'],
    [
      "import { x } from '@/server/security/passkey-emails';",
      'imports @/server/security/passkey-emails',
    ],
    ["const m = await import('@/lib/notifications/x');", 'imports @/lib/notifications/x'],
    ['const m = await import(path);', 'imports <not a literal>'],
    ["await fetch('https://example.test');", 'calls fetch'],
    ['await sendSecurityAlert(row);', 'calls sendSecurityAlert'],
    ['await lib.notifyAdmins(row);', 'calls notifyAdmins'],
  ])('a planted sender is found: %s', (text, problem) => {
    expect(sendingIn('planted.ts', text)).toContain(problem);
  });

  it('the plain imports of an alerts module are not a sender', () => {
    expect(
      sendingIn(
        'ok.ts',
        "import { reportError } from '@/lib/error-reporter';\nimport { env } from '@/lib/env';\nimport { createAdminClient } from '@/lib/supabase/admin';",
      ),
    ).toEqual([]);
  });
});
