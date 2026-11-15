import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every catch in a Server Action module answers a check of the caller's
 * access that could not be read with that check's own sentence.
 *
 * withContext() holds an organization's module state as unknown when it could
 * not be read, and asking about such a module throws ModulesUnavailableError
 * (the permission set and the account status have errors of the same kind).
 * None of them is a fault of the action. The shared mapper
 * (server/lib/action-error-result.ts) answers each with its own sentence,
 * "Your access could not be checked. Please try again." for a module state.
 * A module that keeps its OWN mapping answers anything it does not know with
 * its generic sentence, so it has to ask the shared helper first.
 *
 * THE RULE, read on the TypeScript syntax tree of every module under
 * server/actions: each `catch` reaches the shared mapping, that is, its block
 * (or a function of the same file it calls, followed all the way down) calls
 * one of
 *   - actionErrorResult(...)
 *   - uncheckedAccessResult(...) or uncheckedAccessMessage(...)
 *   - RowFailures' message(...) (one row of an import; the same module)
 * or the catch is listed in REVIEWED with why it answers nothing of the kind
 * (a best-effort step that returns no error, a catch around one call that
 * cannot raise such a check, a per-item line of a bulk run).
 *
 * WHAT THIS IS NOT. It reads that the call is there, not what the mapping
 * does with it; the behaviour is held by module-state-unread.actions.test.ts
 * (real actions over an unknown module state) and by the shared module's own
 * suite. A REVIEWED entry is a person's judgement, checked only for being
 * current (the function still has that many such catches).
 */

const ACTIONS_DIR = __dirname;

const SHARED_CALLS = new Set([
  'actionErrorResult',
  'uncheckedAccessResult',
  'uncheckedAccessMessage',
]);

function actionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) actionFiles(full, out);
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface Finding {
  /** `file#function`, the key REVIEWED is written in. */
  key: string;
  line: number;
}

/** The catches of one source text that do not reach the shared mapping. */
function unmappedCatches(fileName: string, text: string): Finding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const usesRowFailures = /\bRowFailures\b/.test(text);

  // Every function of the file that has a name: declarations, and arrow or
  // function expressions bound to a const.
  const functions = new Map<string, ts.Node>();
  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functions.set(node.name.text, node.body);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functions.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const reaches = (node: ts.Node, seen: Set<string>): boolean => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isIdentifier(callee)) {
          if (SHARED_CALLS.has(callee.text)) {
            found = true;
            return;
          }
          const body = functions.get(callee.text);
          if (body && !seen.has(callee.text)) {
            seen.add(callee.text);
            if (reaches(body, seen)) {
              found = true;
              return;
            }
          }
        } else if (
          usesRowFailures &&
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'message'
        ) {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  const enclosingFunction = (node: ts.Node): string => {
    let name = '(module)';
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text;
      else if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      ) {
        name = n.name.text;
      }
    }
    return name;
  };

  const rel = path.relative(ACTIONS_DIR, fileName).split(path.sep).join('/');
  const findings: Finding[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isCatchClause(node) && !reaches(node.block, new Set())) {
      findings.push({
        key: `${rel}#${enclosingFunction(node)}`,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return findings;
}

/**
 * Catches that do not reach the shared mapping, on purpose. `count` is how
 * many such catches the function has; the reason says why none of them can
 * be the place a check that could not be read is answered wrongly.
 */
const REVIEWED: Record<string, { count: number; why: string }> = {
  'appearance.ts#setMyAppearanceAction': {
    count: 1,
    why: 'its own result shape ({ ok: false, reason }), shown as "not saved": no sentence of any kind is passed on, and no module is asked',
  },
  'auth.ts#changePasswordAction': {
    count: 2,
    why: 'two best-effort steps after the password was changed (sign out other sessions, the notice): each logs and goes on, and returns no error',
  },
  'auth.ts#revokeMyOtherSessions': {
    count: 1,
    why: 'a helper that answers "failed" to its caller, around one Auth call: no organization context',
  },
  'delivery-request.ts#recordDeliveryRequestDraftedAction': {
    count: 1,
    why: 'a best-effort audit note: it returns nothing either way',
  },
  'email-routing-settings.ts#setOrgEmailRoutingAction': {
    count: 1,
    why: 'around the address check alone (a pure function that throws its own validation words); the work is in a second try that reaches the shared mapper',
  },
  'exceptions.ts#canOpenRequest': {
    count: 1,
    why: 'answers a yes or no about one read to its caller: anything but a clean read is "no", and it is reported',
  },
  'inventory.ts#bulkPlaceStockAction': {
    count: 1,
    why: 'one item of a bulk placement: a per-item line with its own words; the run itself is in a try that reaches the shared mapping',
  },
  'mfa-recovery.ts#getMfaRecoveryCodeStatus': {
    count: 1,
    why: 'a count shown on the security page, its own shape; a failed read shows zero codes and no sentence',
  },
  'mfa-recovery.ts#consumeMfaRecoveryCodeAction': {
    count: 1,
    why: 'around creating the service client alone: only a server without its key throws there',
  },
  'mfa.ts#challengeFactorAction': {
    count: 1,
    why: "around the read of the account's own factor list alone (an Auth call): no organization context",
  },
  'onboarding.ts#dismissOnboardingAction': {
    count: 1,
    why: 'best-effort: the panel is already hidden, and it returns nothing',
  },
  'order-readiness.ts#readOrderReadinessAction': {
    count: 1,
    why: 'its own failed state with its own words ("Could not check readiness."), which already says the check could not be made',
  },
  'order-readiness.ts#loadShortfallPoAction': {
    count: 3,
    why: 'a read that never throws: each half that could not be read is null by contract (the dialog keeps what it has), and a module state that could not be read is reported',
  },
  'order-requests.ts#suggestNeededByAction': {
    count: 1,
    why: 'a suggestion: any failure is "no suggestion", never an error',
  },
  'organization.ts#createOrganizationAction': {
    count: 1,
    why: 'around creating the service client alone: only a server without its key throws there',
  },
  'permissions.ts#alreadyRestricted': {
    count: 1,
    why: 'a pure check of rows already read: it rethrows anything but its own list error',
  },
  'platform-admin.ts#createOrgForCustomerAction': {
    count: 1,
    why: 'around creating the service client alone: only a server without its key throws there',
  },
  'platform-admin.ts#setOrgDeletionPassphraseAction': {
    count: 1,
    why: 'around creating the service client alone, in the platform console (no organization context)',
  },
  'platform-admin.ts#removeOrgAction': {
    count: 2,
    why: 'around creating the service client, and one account of a clean-up loop (counted and reported): the platform console, no organization context',
  },
  'profile.ts#resolveSessionMfaPosture': {
    count: 1,
    why: "around the read of the account's own factor list alone: an unreadable list is held as MFA required",
  },
  'profile.ts#removeOrphanAvatar': {
    count: 1,
    why: 'a best-effort storage clean-up that logs and returns nothing',
  },
  'profile.ts#deleteOwnAccountAction': {
    count: 2,
    why: 'around the step-up re-check (rethrown unless the account is already gone) and a best-effort session revoke after the delete',
  },
  'profile.ts#endThisBrowserSession': {
    count: 1,
    why: 'a best-effort local sign-out, reported',
  },
  'return-request.ts#recordReturnRequestDraftedAction': {
    count: 1,
    why: 'a best-effort audit note: it returns nothing either way',
  },
  'sage50-import.ts#importSage50Action': {
    count: 2,
    why: 'one vendor row, and the supplier step as a whole (skipped with a disclosed reason so the items still import); the module is asked before both, outside them, where the shared mapper answers',
  },
  'support-tickets.ts#createSupportTicketAction': {
    count: 1,
    why: 'the public contact form: no session and no organization context',
  },
  'support-tickets.ts#submitDashboardTicketAction': {
    count: 1,
    why: 'a ticket insert with its own result shape and words; no module is asked',
  },
  'support-tickets.ts#updateSupportTicketAction': {
    count: 1,
    why: 'the platform console: no organization context',
  },
  'team.ts#transferOwnershipAction': {
    count: 1,
    why: "around the read of the account's own factor list alone: an unreadable list refuses the transfer",
  },
  'team.ts#acceptInviteWithSignupAction': {
    count: 1,
    why: 'around creating the service client alone: only a server without its key throws there',
  },
};

function census(): Map<string, number[]> {
  const byKey = new Map<string, number[]>();
  for (const file of actionFiles(ACTIONS_DIR)) {
    for (const f of unmappedCatches(file, readFileSync(file, 'utf8'))) {
      byKey.set(f.key, [...(byKey.get(f.key) ?? []), f.line]);
    }
  }
  return byKey;
}

describe('Server Action catches and a check that could not be read', () => {
  const found = census();

  it('reads the action modules', () => {
    expect(actionFiles(ACTIONS_DIR).length).toBeGreaterThan(80);
  });

  it('every catch reaches the shared mapping, or is listed with its reason', () => {
    const unlisted = [...found.entries()]
      .filter(([key]) => !(key in REVIEWED))
      .map(([key, lines]) => `${key} (line ${lines.join(', ')})`);
    expect(unlisted).toEqual([]);
  });

  it('every listed entry is current: the function still has that many such catches', () => {
    const stale = Object.entries(REVIEWED)
      .filter(([key, entry]) => (found.get(key)?.length ?? 0) !== entry.count)
      .map(([key, entry]) => `${key}: listed ${entry.count}, found ${found.get(key)?.length ?? 0}`);
    expect(stale).toEqual([]);
  });

  it('every listed entry says why', () => {
    for (const [key, entry] of Object.entries(REVIEWED)) {
      expect(entry.why.length, key).toBeGreaterThan(20);
    }
  });
});

/* ─────────────────────────────── self-test ─────────────────────────────── */

describe('the scan itself', () => {
  const scan = (text: string) => unmappedCatches(path.join(ACTIONS_DIR, 'planted.ts'), text);

  it('a catch that answers its own generic sentence is found, by function', () => {
    const findings = scan(`
      export async function plantedAction() {
        try { await work(); } catch (e) {
          return err('internal_error', 'Something went wrong. Please try again.');
        }
      }`);
    expect(findings.map((f) => f.key)).toEqual(['planted.ts#plantedAction']);
  });

  it('a catch that calls the shared mapper, or the helper, is not', () => {
    expect(
      scan(`
      export async function a() { try { await work(); } catch (e) { return actionErrorResult(e, 't'); } }
      export async function b() {
        try { await work(); } catch (e) {
          const unchecked = uncheckedAccessMessage(e, 't');
          if (unchecked) return { error: unchecked };
          return { error: 'no' };
        }
      }`),
    ).toEqual([]);
  });

  it('a catch that goes through a local mapper is followed into it, all the way down', () => {
    const through = `
      function toResult(e: unknown) { return inner(e); }
      const inner = (e: unknown) => {
        const unchecked = uncheckedAccessResult(e, 't');
        return unchecked ?? err('internal_error', 'no');
      };
      export async function a() { try { await work(); } catch (e) { return toResult(e); } }`;
    expect(scan(through)).toEqual([]);
    const notThrough = through.replace("uncheckedAccessResult(e, 't')", 'null');
    expect(scan(notThrough).map((f) => f.key)).toEqual(['planted.ts#a']);
  });

  it('a name in a comment or a string is not a call', () => {
    const findings = scan(`
      export async function a() {
        try { await work(); } catch (e) {
          // actionErrorResult(e, 't') would answer this
          return err('internal_error', 'uncheckedAccessResult(');
        }
      }`);
    expect(findings).toHaveLength(1);
  });

  it("a row's message counts only where RowFailures is used", () => {
    const row = `
      export async function a(rows: unknown[]) {
        for (const r of rows) { try { await work(r); } catch (e) { out.push(failures.message(e)); } }
      }`;
    expect(scan(row)).toHaveLength(1);
    expect(scan(`const failures = new RowFailures('t');${row}`)).toEqual([]);
  });
});
