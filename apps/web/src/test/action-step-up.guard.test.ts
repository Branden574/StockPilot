import * as fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCallGraph, shippedSourceFiles, type CallGraph } from './gate-reach';

/**
 * Security invariant (docket S43c): no Server Action works for a session that
 * still owes its authenticator code, except the reviewed ones listed here.
 *
 * requireOrgContext() (lib/auth/session.ts) sends a member who has a verified
 * factor, on a session that is not at aal2, to /signin/mfa before it hands out
 * an organization context. That holds an action only if the action asks for
 * that context. So, over every `'use server'` module under src, read on the
 * syntax tree (test/gate-reach.ts; a comment or a string naming a function is
 * never a call, and a call whose redirect a catch could keep does not count):
 *
 *   1. every name such a module exports at run time is one function this
 *      guard can read, and that function reaches requireOrgContext():
 *      directly, through withContext(), through a service's static
 *      forCurrentUser(), or through anything built on them. Or it is listed in
 *      REVIEWED, with its kind and a reason. An export that is not one
 *      readable function (a wrapped or aliased function, `.bind(...)`, a
 *      destructured or conditional export, a default expression, a re-export
 *      from a package) is reported by name, and listing does not excuse it:
 *      it is written as `export async function` instead;
 *   2. it asks first: the first call it awaits is requireOrgContext() or a
 *      function that itself asks first, all the way down (gate-reach.ts,
 *      "asks first"), so the context is not a branch taken after something
 *      was already read, and nothing is started beside it in a Promise.all.
 *      Or it is listed in ASKS_LATER, with what it does before and why that
 *      is safe;
 *   3. every listed entry is current: a REVIEWED action exists, still does NOT
 *      reach the gate (one that does leaves the list), gives a reason, a
 *      'platform' entry reaches one of the platform-admin gates
 *      (lib/auth/platform-admin.ts), which refuse an allowlisted account that
 *      owes its code, and a 'portal' entry asks resolvePortalContext() first
 *      (server/services/portal.ts), which sends such an account to the code
 *      page; an ASKS_LATER action exists, reaches the gate, and still does not
 *      ask first;
 *   4. no Server Action is declared inside another module (a function whose
 *      body starts with 'use server'): none exists, and a new one is read by
 *      rule 1 only once it is added here;
 *   5. the gate is where this guard thinks it is: requireOrgContext() asks
 *      stepUpIsOwed (lib/auth/step-up-gate.ts), and requireSession() and
 *      getServerSession() do not (the code page, the recovery code and
 *      enrolling run on them); the platform gates exist, and
 *      resolvePortalContext() asks the same rule (stepUpIsOwedByUser).
 *
 * The self-test at the bottom plants a violation of each rule, so this cannot
 * pass by reading nothing.
 */

const WEB_SRC = path.resolve(__dirname, '..');

const SESSION = 'lib/auth/session.ts';
const GATE = `${SESSION}#requireOrgContext`;
const PLATFORM_GATES = [
  'lib/auth/platform-admin.ts#checkPlatformAdmin',
  'lib/auth/platform-admin.ts#currentUserIsPlatformAdmin',
];
const PORTAL_GATE = 'server/services/portal.ts#resolvePortalContext';

type Kind =
  /** Part of signing in: it must run on a session that has not entered its code. */
  | 'before-the-code'
  /** The platform console: gated by checkPlatformAdmin or currentUserIsPlatformAdmin. */
  | 'platform'
  /** The customer portal: asks resolvePortalContext() first, which applies the same rule. */
  | 'portal'
  /** Reads its own principal and asks for the code by its own rule. */
  | 'own-rule'
  /** No member session is read: a public form, a cookie only. */
  | 'no-member-session'
  /** Asks for the context only inside a best-effort helper, so it does nothing for such a session. */
  | 'best-effort'
  /** Touches only the caller's own cosmetic row, and must work on the sign-in pages too. */
  | 'self-only';

interface Reviewed {
  kind: Kind;
  reason: string;
}

/** `<src-relative module>#<exported name>`. Reviewed 2026-11-12 (docket S43c). */
const REVIEWED: Record<string, Reviewed> = {
  // ── signing in ──
  'server/actions/auth.ts#signInAction': {
    kind: 'before-the-code',
    reason: 'Creates the session from the password; the code page comes next.',
  },
  'server/actions/auth.ts#signUpAction': {
    kind: 'before-the-code',
    reason: 'Creates an account; there is no session and no authenticator yet.',
  },
  'server/actions/auth.ts#signOutAction': {
    kind: 'before-the-code',
    reason: 'Ends the session, which a person on the code page must be able to do.',
  },
  'server/actions/auth.ts#requestPasswordResetAction': {
    kind: 'before-the-code',
    reason: 'Public by design: one answer for every address, limited per IP and address.',
  },
  'server/actions/auth.ts#completePasswordResetAction': {
    kind: 'before-the-code',
    reason:
      'Sets the new password on the recovery session the emailed link created; it asks an enrolled account for its code itself.',
  },
  'server/actions/mfa.ts#challengeFactorAction': {
    kind: 'before-the-code',
    reason:
      'Checks the authenticator code on the code page: the step that takes the session to aal2.',
  },
  'server/actions/mfa.ts#enrollFactorAction': {
    kind: 'before-the-code',
    reason:
      'Starts setting up a first authenticator, on a session that cannot have a code yet (requireSession). The Auth server refuses another factor to a session that has not entered the first one.',
  },
  'server/actions/mfa.ts#verifyEnrollmentAction': {
    kind: 'before-the-code',
    reason:
      'Confirms the set-up just started, with the account password, on a session that cannot have a code yet. Its audit row is written through the context after the session has reached aal2.',
  },
  'server/actions/mfa-recovery.ts#consumeMfaRecoveryCodeAction': {
    kind: 'before-the-code',
    reason:
      'The recovery code on the code page, for a person without their authenticator: aal1 by nature, gated by the account password and a rate limit.',
  },
  'server/actions/mfa-recovery.ts#getMfaRecoveryCodeStatus': {
    kind: 'before-the-code',
    reason:
      "Counts the caller's own recovery codes (two numbers), for the Security page and the code page.",
  },
  'server/actions/team.ts#acceptInviteAction': {
    kind: 'before-the-code',
    reason:
      'Joins the organization a single-use invitation names. It returns no organization data, and every page after it asks for the code.',
  },
  'server/actions/team.ts#acceptInviteWithSignupAction': {
    kind: 'before-the-code',
    reason: 'Creates the invited account and joins it: a new account has no authenticator.',
  },

  // ── the platform console ──
  'server/actions/organization.ts#createOrganizationAction': {
    kind: 'platform',
    reason: 'Platform admins only, with a fresh step-up (checkPlatformAdmin requireStepUp).',
  },
  'server/actions/platform-admin.ts#createOrgForCustomerAction': {
    kind: 'platform',
    reason: 'Platform admins only, with a fresh step-up (checkPlatformAdmin requireStepUp).',
  },
  'server/actions/platform-admin.ts#removeOrgAction': {
    kind: 'platform',
    reason: 'Platform admins only, with a fresh step-up (checkPlatformAdmin requireStepUp).',
  },
  'server/actions/platform-admin.ts#setOrgDeletionPassphraseAction': {
    kind: 'platform',
    reason: 'Platform admins only, with a fresh step-up (checkPlatformAdmin requireStepUp).',
  },
  'server/actions/platform/billing.ts#setOrgBillingAction': {
    kind: 'platform',
    reason: 'Platform admins only, with a fresh step-up (checkPlatformAdmin requireStepUp).',
  },
  'server/actions/platform/billing.ts#startOrgTrialAction': {
    kind: 'platform',
    reason: 'Platform admins only, with a fresh step-up (checkPlatformAdmin requireStepUp).',
  },
  'server/actions/platform/impersonation.ts#startActingAsAction': {
    kind: 'platform',
    reason: 'Platform admins only, with a fresh step-up (checkPlatformAdmin requireStepUp).',
  },
  'server/actions/platform/impersonation.ts#stopActingAsAction': {
    kind: 'platform',
    reason:
      "Ends the caller's own temporary membership; currentUserIsPlatformAdmin refuses an allowlisted account that owes its code.",
  },
  'server/actions/platform/permission-exceptions.ts#setOrderItemsAccessAction': {
    kind: 'platform',
    reason: 'Platform admins only, with a fresh step-up (checkPlatformAdmin requireStepUp).',
  },
  'server/actions/platform/users.ts#disableUserAccountAction': {
    kind: 'platform',
    reason: 'Platform admins only, with a fresh step-up (checkPlatformAdmin requireStepUp).',
  },
  'server/actions/platform/users.ts#reenableUserAccountAction': {
    kind: 'platform',
    reason: 'Platform admins only, with a fresh step-up (checkPlatformAdmin requireStepUp).',
  },
  'server/actions/platform/users.ts#sendUserPasswordResetAction': {
    kind: 'platform',
    reason:
      'Platform admins only; no fresh step-up, but checkPlatformAdmin refuses an allowlisted account that owes its code.',
  },
  'server/actions/support-tickets.ts#updateSupportTicketAction': {
    kind: 'platform',
    reason:
      'Support triage, from the console and from /dashboard/admin/support; currentUserIsPlatformAdmin refuses an allowlisted account that owes its code.',
  },

  // ── its own rule ──
  'server/actions/auth.ts#changePasswordAction': {
    kind: 'own-rule',
    reason:
      'Reads its own principal (getUser), checks the current password, and refuses an account that has an authenticator until its session is at aal2.',
  },
  'server/actions/email-change.ts#requestEmailChangeAction': {
    kind: 'own-rule',
    reason:
      "Reads its own principal (getUser) and hands the service that account's posture: an enrolled account must be at aal2 (docket S50a).",
  },
  'server/actions/email-change.ts#resendEmailChangeAction': {
    kind: 'own-rule',
    reason:
      "Reads its own principal (getUser) and hands the service that account's posture: an enrolled account must be at aal2 (docket S50a).",
  },
  'server/actions/email-change.ts#cancelEmailChangeAction': {
    kind: 'own-rule',
    reason:
      "Cancels the caller's own pending email change: it only withdraws a change, and returns no data.",
  },
  'server/actions/mfa-recovery.ts#generateMfaRecoveryCodesAction': {
    kind: 'own-rule',
    reason:
      'Recovery codes are per account, not per organization: it requires the verified token of the validated account at aal2 (docket S50a).',
  },

  // ── no member session ──
  'server/actions/support-tickets.ts#createSupportTicketAction': {
    kind: 'no-member-session',
    reason: 'The public support form: no session, limited per IP, written with the service client.',
  },
  // ── the customer portal (its own funnel, held to the same rule) ──
  'server/actions/portal.ts#submitPortalOrderAction': {
    kind: 'portal',
    reason:
      'The customer portal: it asks resolvePortalContext() first, which sends an account that has an authenticator to the code page until its session is at aal2, then serves only that customer.',
  },
  'server/actions/portal.ts#requestPortalReturnAction': {
    kind: 'portal',
    reason:
      'The customer portal: it asks resolvePortalContext() first, which sends an account that has an authenticator to the code page until its session is at aal2, then serves only that customer.',
  },
  'server/actions/portal.ts#portalReturnSheetAction': {
    kind: 'portal',
    reason:
      'The customer portal: it asks resolvePortalContext() first, which sends an account that has an authenticator to the code page until its session is at aal2, then serves only that customer.',
  },
  'server/actions/portal.ts#portalReturnOptionsAction': {
    kind: 'portal',
    reason:
      'The customer portal: it asks resolvePortalContext() first, which sends an account that has an authenticator to the code page until its session is at aal2, then serves only that customer.',
  },
  // ── no member session, continued ──
  'server/actions/saved-views.ts#setActiveWarehouseAction': {
    kind: 'no-member-session',
    reason:
      "Sets or clears the caller's own warehouse filter cookie. It reads no session and no data; the pages that apply the cookie ask for the context.",
  },

  // ── best effort ──
  'server/actions/delivery-request.ts#recordDeliveryRequestDraftedAction': {
    kind: 'best-effort',
    reason:
      "Writes one audit row through audit()'s own context, which is requireOrgContext(): for a session that owes its code no row is written, and nothing is returned.",
  },
  'server/actions/revalidate-inventory-view.ts#revalidateInventoryViewAction': {
    kind: 'best-effort',
    reason:
      'Marks the list cache of the organization withContext() resolves as stale: for a session that owes its code nothing is marked, and it answers false.',
  },

  // ── self only ──
  'server/actions/appearance.ts#getMyAppearanceAction': {
    kind: 'self-only',
    reason:
      "The caller's own Design and Theme row, on a client bound to the verified token of the account it names. No organization data.",
  },
  'server/actions/appearance.ts#setMyAppearanceAction': {
    kind: 'self-only',
    reason:
      "Saves the caller's own Design and Theme, on a client bound to the verified token of the account it names. The Appearance provider in the root layout calls it from any page, the sign-in pages included. No organization data.",
  },
};

/**
 * Actions that reach the gate but await something else first, each with what
 * comes before it. Reviewed 2026-11-12 (docket S43c).
 */
const ASKS_LATER: Record<string, string> = {
  'server/actions/mfa.ts#unenrollFactorAction': `requireSession() and the cookie client come first, and neither reads anything; withContext() is next, before the session's level, the policy or the factor is looked at.`,
  'server/actions/profile.ts#deleteOwnAccountAction': `requireSession() comes first because an account with no organization must be able to delete itself; one with a membership then goes through withContext() (gateMfaForSelfService), and the deletion itself asks an account that has an authenticator for aal2 (docket S50a).`,
};

/* ───────────────────────────── the reading ───────────────────────────── */

interface Tree {
  graph: CallGraph;
  /** The absolute path of a src-relative one. */
  abs: (rel: string) => string;
  rel: (abs: string) => string;
}

function treeOf(files: Array<{ path: string; text: string }>, srcRoot: string): Tree {
  return {
    graph: buildCallGraph(files, srcRoot),
    abs: (rel) => path.join(srcRoot, rel),
    rel: (abs) => path.relative(srcRoot, abs).split(path.sep).join('/'),
  };
}

const keyOf = (tree: Tree, file: string, name: string) => `${tree.rel(file)}#${name}`;
const targetOf = (tree: Tree, key: string) => {
  const [file, name] = key.split('#') as [string, string];
  return `${tree.abs(file)}#${name}`;
};

/**
 * Every Server Action: each name a 'use server' module exports at run time,
 * whether or not it can be read as a function (rule 1 reports one that
 * cannot).
 */
function actionsOf(tree: Tree): Array<{ file: string; name: string; key: string }> {
  return tree.graph.actionModules.flatMap((file) =>
    tree.graph.runtimeExports(file).map((name) => ({ file, name, key: keyOf(tree, file, name) })),
  );
}

const UNREADABLE = 'exported, but not as one function this guard can read';

/**
 * Rule 1: actions that do not reach the gate and are not listed, and exports
 * that are not one readable function (listed or not).
 */
function openActions(tree: Tree, reviewed: Record<string, Reviewed>): string[] {
  const reach = tree.graph.reach([targetOf(tree, GATE)]);
  return actionsOf(tree)
    .flatMap((a) => {
      const reaches = reach.exportReaches(a.file, a.name);
      if (reaches === null) return [`${a.key}: ${UNREADABLE}`];
      return reaches || reviewed[a.key] ? [] : [a.key];
    })
    .sort();
}

/** Rule 2: actions that reach the gate, but do not ask it first, and are not listed. */
function lateActions(tree: Tree, asksLater: Record<string, string>): string[] {
  const reach = tree.graph.reach([targetOf(tree, GATE)]);
  const late: string[] = [];
  for (const a of actionsOf(tree)) {
    if (!reach.exportReaches(a.file, a.name) || reach.exportAsksFirst(a.file, a.name)) continue;
    if (asksLater[a.key]) continue;
    const beside = reach.startedBesideFirst(a.file, a.name);
    if (beside) {
      late.push(`${a.key}:${beside.line}: starts \`${beside.text}\` beside the context`);
      continue;
    }
    const first = reach.firstAwaitedCall(a.file, a.name);
    if (first === null) late.push(`${a.key}: not one function, so its order cannot be read`);
    else if (first === 'none')
      late.push(`${a.key}: awaits nothing, and calls nothing that asks first`);
    else late.push(`${a.key}:${first.line}: awaits \`${first.text}\` before the context`);
  }
  return late.sort();
}

/** Rule 3: listed entries that are no longer true. */
function staleEntries(
  tree: Tree,
  reviewed: Record<string, Reviewed>,
  asksLater: Record<string, string> = {},
): string[] {
  const gate = tree.graph.reach([targetOf(tree, GATE)]);
  const platform = tree.graph.reach(PLATFORM_GATES.map((k) => targetOf(tree, k)));
  const portal = tree.graph.reach([targetOf(tree, PORTAL_GATE)]);
  const actionModules = new Set(tree.graph.actionModules);
  const problems: string[] = [];
  for (const [key, why] of Object.entries(asksLater)) {
    const [file, name] = key.split('#') as [string, string];
    const abs = tree.abs(file);
    if (reviewed[key]) problems.push(`${key}: in both lists`);
    if (!actionModules.has(abs) || gate.exportReaches(abs, name) === null) {
      problems.push(`${key}: no such action`);
      continue;
    }
    if (!gate.exportReaches(abs, name))
      problems.push(`${key}: listed as asking later but never reaches the gate`);
    else if (gate.exportAsksFirst(abs, name))
      problems.push(`${key}: asks first, so it leaves the list`);
    if (why.length <= 40) problems.push(`${key}: no reason given`);
  }
  for (const [key, entry] of Object.entries(reviewed)) {
    const [file, name] = key.split('#') as [string, string];
    const abs = tree.abs(file);
    if (!actionModules.has(abs)) {
      problems.push(`${key}: no such 'use server' module`);
      continue;
    }
    const reaches = gate.exportReaches(abs, name);
    if (reaches === null) {
      problems.push(`${key}: the module exports no such function`);
      continue;
    }
    if (reaches) problems.push(`${key}: reaches the gate, so it leaves the list`);
    if (entry.reason.length <= 40) problems.push(`${key}: no reason given`);
    if (entry.kind === 'platform' && !platform.exportReaches(abs, name)) {
      problems.push(`${key}: listed as 'platform' but reaches no platform-admin gate`);
    }
    if (entry.kind === 'portal' && !portal.exportAsksFirst(abs, name)) {
      problems.push(`${key}: listed as 'portal' but does not ask resolvePortalContext() first`);
    }
  }
  return problems.sort();
}

/** Rule 4: Server Actions declared inside modules that are not 'use server' modules. */
function inlineActionsOf(tree: Tree): string[] {
  return tree.graph
    .reach([targetOf(tree, GATE)])
    .inlineActions.map((a) => `${tree.rel(a.file)}:${a.line} ${a.name}`)
    .sort();
}

/* ───────────────────────────── the real tree ───────────────────────────── */

const REAL = treeOf(shippedSourceFiles(WEB_SRC, fs), WEB_SRC);

describe('every Server Action is held to the step-up rule (docket S43c)', () => {
  it('scans a real tree', () => {
    // 100 'use server' modules and 360 actions on 2026-11-12.
    expect(REAL.graph.actionModules.length).toBeGreaterThan(90);
    const actions = actionsOf(REAL);
    expect(actions.length).toBeGreaterThan(330);
    const reach = REAL.graph.reach([targetOf(REAL, GATE)]);
    expect(reach.reachingCount).toBeGreaterThan(400);
    // Known shapes, each read the way a person would: a direct call, through
    // withContext(), through a service's static forCurrentUser().
    for (const known of [
      'server/actions/notification-preferences.ts#updateNotificationPreferencesAction',
      'server/actions/activity.ts#loadOlderItemActivityAction',
      'server/actions/inventory.ts#createItemAction',
      'server/actions/org-switcher.ts#switchOrganizationAction',
    ]) {
      const [file, name] = known.split('#') as [string, string];
      expect(reach.exportReaches(REAL.abs(file), name), known).toBe(true);
    }
    expect(Object.keys(REVIEWED).length).toBeLessThan(actions.length / 5);
  });

  it('1. every action reaches requireOrgContext(), or is listed with a reason', () => {
    expect(openActions(REAL, REVIEWED)).toEqual([]);
  });

  it('2. every action that reaches it asks for the context first, or is listed with what comes before', () => {
    expect(lateActions(REAL, ASKS_LATER)).toEqual([]);
  });

  it('3. every listed entry is current', () => {
    expect(staleEntries(REAL, REVIEWED, ASKS_LATER)).toEqual([]);
  });

  it('4. no Server Action is declared inside another module', () => {
    expect(inlineActionsOf(REAL)).toEqual([]);
  });

  it('5. the gate is in requireOrgContext(), and not in requireSession() or getServerSession()', () => {
    const owed = REAL.graph.reach([targetOf(REAL, 'lib/auth/step-up-gate.ts#stepUpIsOwed')]);
    const session = REAL.abs(SESSION);
    expect(owed.exportReaches(session, 'requireOrgContext')).toBe(true);
    expect(owed.exportReaches(session, 'requireSession')).toBe(false);
    expect(owed.exportReaches(session, 'getServerSession')).toBe(false);
    // And withContext() is built on it.
    const gate = REAL.graph.reach([targetOf(REAL, GATE)]);
    expect(gate.exportReaches(REAL.abs('server/services/context.ts'), 'withContext')).toBe(true);
    // The platform gates the 'platform' entries rely on ask their own rule.
    const admin = REAL.abs('lib/auth/platform-admin.ts');
    expect(REAL.graph.hasExport(admin, 'checkPlatformAdmin')).toBe(true);
    expect(REAL.graph.hasExport(admin, 'currentUserIsPlatformAdmin')).toBe(true);
    // The portal's funnel, which the 'portal' entries rely on, asks the rule
    // itself, and every action of the portal module is such an entry.
    const byUser = REAL.graph.reach([
      targetOf(REAL, 'lib/auth/step-up-gate.ts#stepUpIsOwedByUser'),
    ]);
    expect(
      byUser.exportReaches(REAL.abs('server/services/portal.ts'), 'resolvePortalContext'),
    ).toBe(true);
    const portalActions = REAL.graph.runtimeExports(REAL.abs('server/actions/portal.ts'));
    expect(portalActions.length).toBeGreaterThanOrEqual(4);
    for (const name of portalActions) {
      expect(REVIEWED[`server/actions/portal.ts#${name}`]?.kind, name).toBe('portal');
    }
  });

  it('the actions the code page needs are on the list, so they are never moved behind the gate', () => {
    for (const key of [
      'server/actions/mfa.ts#challengeFactorAction',
      'server/actions/mfa-recovery.ts#consumeMfaRecoveryCodeAction',
      'server/actions/auth.ts#signOutAction',
      'server/actions/mfa.ts#enrollFactorAction',
      'server/actions/mfa.ts#verifyEnrollmentAction',
    ]) {
      expect(REVIEWED[key]?.kind, key).toBe('before-the-code');
    }
  });
});

/* ───────────────────── self-test: each rule can fail ───────────────────── */

describe('self-test: a planted violation of each rule is reported', () => {
  const ROOT = '/planted';
  const SESSION_SRC = `
    export const requireOrgContext = cache(async () => ({ organizationId: 'o' }));
    export const requireSession = cache(async () => ({ userId: 'u' }));`;
  const CONTEXT_SRC = `
    import { requireOrgContext } from '@/lib/auth/session';
    export const withContext = cache(async () => requireOrgContext());`;
  const PLATFORM_SRC = `
    export async function checkPlatformAdmin() { return { ok: true }; }
    export async function currentUserIsPlatformAdmin() { return true; }`;
  const PORTAL_SRC = `
    export async function resolvePortalContext() { return null; }`;
  const base = {
    'lib/auth/session.ts': SESSION_SRC,
    'server/services/context.ts': CONTEXT_SRC,
    'lib/auth/platform-admin.ts': PLATFORM_SRC,
    'server/services/portal.ts': PORTAL_SRC,
  };
  const tree = (files: Record<string, string>) =>
    treeOf(
      Object.entries({ ...base, ...files }).map(([k, text]) => ({ path: `${ROOT}/${k}`, text })),
      ROOT,
    );
  const reason = 'x'.repeat(41);

  it('1. reaching the gate: directly, through withContext(), a static forCurrentUser(), a wrapper, a re-export', () => {
    const t = tree({
      'server/services/things.ts': `
        import { withContext } from '@/server/services/context';
        export class ThingsService {
          static async forCurrentUser() { return new ThingsService(await withContext()); }
          constructor(private ctx: unknown) {}
          async list() { return []; }
        }`,
      'server/lib/authed.ts': `
        import { withContext } from '@/server/services/context';
        export function authed(fn: (ctx: unknown) => Promise<unknown>) {
          return async () => fn(await withContext());
        }`,
      'server/actions/a.ts': `'use server';
        import { requireOrgContext } from '@/lib/auth/session';
        import { withContext } from '@/server/services/context';
        import { ThingsService } from '@/server/services/things';
        import { authed } from '@/server/lib/authed';
        export async function direct() { return requireOrgContext(); }
        export async function throughContext() { const ctx = await withContext(); return ctx; }
        export async function throughService() { return (await ThingsService.forCurrentUser()).list(); }
        export const wrapped = authed(async (ctx) => ctx);
        export { direct as renamed };`,
      'server/actions/b.ts': `'use server';
        export { direct } from './a';`,
    });
    expect(openActions(t, {})).toEqual([]);
    expect(lateActions(t, {})).toEqual([
      // What a wrapper does before it calls the function it was handed is not
      // read from here: such an action is listed with its reason.
      'server/actions/a.ts#wrapped: awaits nothing, and calls nothing that asks first',
    ]);
  });

  it('1. an export that is not one readable function is reported by name, whatever its shape, and listing does not excuse it', () => {
    const t = tree({
      'server/lib/handlers.ts': `
        import { withContext } from '@/server/services/context';
        export async function gatedHandler() { return withContext(); }
        export const pair = { first: gatedHandler, second: gatedHandler };`,
      'server/actions/a.ts': `'use server';
        import { cookies } from 'next/headers';
        import { gatedHandler, pair } from '@/server/lib/handlers';
        import { withContext } from '@/server/services/context';
        const handler = async () => (await cookies()).getAll().length;
        function identity<T>(f: T): T { return f; }
        const wrappedConst = identity(handler);
        interface Row { id: string }
        export const wrappedIdentifier = identity(handler);
        export const aliasOfLocal = handler;
        export const aliasOfImport = gatedHandler;
        export const bound = handler.bind(null);
        export const { first, second: renamed } = pair;
        export const conditional = process.env.X ? handler : gatedHandler;
        export const notAFunction = 5;
        export { wrappedConst };
        export { parse } from 'some-package';
        export * as handlers from '@/server/lib/handlers';
        export type { Row };
        export { Row as RowAgain };
        export enum Mode { A, B }
        export async function readable() { return withContext(); }
        export default identity(handler);`,
      'server/actions/b.ts': `'use server';
        export * from 'some-package';
        export default class {}`,
    });
    const unreadable = (key: string) =>
      `${key}: exported, but not as one function this guard can read`;
    const expected = [
      unreadable('server/actions/a.ts#Mode'),
      unreadable('server/actions/a.ts#aliasOfImport'),
      unreadable('server/actions/a.ts#aliasOfLocal'),
      unreadable('server/actions/a.ts#bound'),
      unreadable('server/actions/a.ts#conditional'),
      unreadable('server/actions/a.ts#default'),
      unreadable('server/actions/a.ts#first'),
      unreadable('server/actions/a.ts#handlers'),
      unreadable('server/actions/a.ts#notAFunction'),
      unreadable('server/actions/a.ts#parse'),
      unreadable('server/actions/a.ts#renamed'),
      unreadable('server/actions/a.ts#wrappedConst'),
      unreadable('server/actions/a.ts#wrappedIdentifier'),
      unreadable("server/actions/b.ts#* (a re-export from 'some-package')"),
      unreadable('server/actions/b.ts#default'),
    ];
    // A type is no runtime export, and the one readable function passes.
    expect(openActions(t, {})).toEqual(expected);
    expect(
      openActions(t, {
        'server/actions/a.ts#wrappedIdentifier': { kind: 'own-rule', reason },
        'server/actions/a.ts#default': { kind: 'own-rule', reason },
      }),
    ).toEqual(expected);
  });

  it('1. not reaching it: a session only, a comment or a string naming the gate, an instance method', () => {
    const t = tree({
      'server/actions/a.ts': `'use server';
        import { requireSession } from '@/lib/auth/session';
        import { createClient } from '@/lib/supabase/server';
        export async function sessionOnly() {
          const s = await requireSession();
          return (await createClient()).from('t').select('*').eq('user_id', s.userId);
        }
        // requireOrgContext() is called elsewhere
        export async function namedInAComment() { return 'requireOrgContext()'; }
        export async function instanceMethod(svc: { withContext(): Promise<unknown> }) {
          return svc.withContext();
        }`,
    });
    expect(openActions(t, {})).toEqual([
      'server/actions/a.ts#instanceMethod',
      'server/actions/a.ts#namedInAComment',
      'server/actions/a.ts#sessionOnly',
    ]);
    // Listing one covers that one only.
    expect(
      openActions(t, { 'server/actions/a.ts#sessionOnly': { kind: 'before-the-code', reason } }),
    ).toEqual(['server/actions/a.ts#instanceMethod', 'server/actions/a.ts#namedInAComment']);
  });

  it('1. a context asked for only where a catch could keep the redirect does not count', () => {
    const t = tree({
      'server/services/audit.ts': `
        import { withContext } from '@/server/services/context';
        export async function audit(row: unknown) {
          try { const ctx = await withContext(); return [ctx, row]; } catch { return null; }
        }
        export async function quietly(row: unknown) {
          return withContext().catch(() => null);
        }
        export async function settled() {
          return Promise.allSettled([withContext()]);
        }
        export async function rethrowing(row: unknown) {
          try { return await withContext(); } catch (e) { if (isNextControlFlowError(e)) throw e; return null; }
        }
        export async function rethrowingLast(row: unknown) {
          try { return await withContext(); } catch (e) { if (e instanceof TypeError) return null; throw e; }
        }`,
      'server/actions/a.ts': `'use server';
        import { audit, quietly, rethrowing, rethrowingLast, settled } from '@/server/services/audit';
        export async function onlyThroughAudit() { await audit({}); return true; }
        export async function onlyThroughACatchHandler() { return quietly({}); }
        export async function onlyThroughAllSettled() { return settled(); }
        export async function throughARethrowingCatch() { return rethrowing({}); }
        export async function throughACatchThatEndsInThrow() { return rethrowingLast({}); }`,
    });
    expect(openActions(t, {})).toEqual([
      'server/actions/a.ts#onlyThroughACatchHandler',
      'server/actions/a.ts#onlyThroughAllSettled',
      'server/actions/a.ts#onlyThroughAudit',
    ]);
  });

  it('1. nothing in a client module counts: it runs in the browser', () => {
    const t = tree({
      'components/button.tsx': `'use client';
        import { withContext } from '@/server/services/context';
        export function Button() { void withContext(); return null; }`,
      'server/actions/a.ts': `'use server';
        import { Button } from '@/components/button';
        export async function rendersAClientComponent() { return Button(); }`,
    });
    expect(openActions(t, {})).toEqual(['server/actions/a.ts#rendersAClientComponent']);
  });

  it('2. an action that awaits something else before the context is late, however harmless the first call looks', () => {
    const t = tree({
      'lib/filter.ts': `
        import { requireOrgContext } from '@/lib/auth/session';
        export async function activeFilter() {
          const raw = (await cookies()).get('filter')?.value;
          if (!raw) return null;
          await requireOrgContext();
          return raw;
        }
        export async function gated() { const ctx = await requireOrgContext(); return ctx; }
        export async function gatedTwiceRemoved() { return gated(); }`,
      'server/actions/a.ts': `'use server';
        import { cookies } from 'next/headers';
        import { requireOrgContext, requireSession } from '@/lib/auth/session';
        import { createClient } from '@/lib/supabase/server';
        import { activeFilter, gated, gatedTwiceRemoved } from '@/lib/filter';
        export async function readsFirst(id: string) {
          const supabase = await createClient();
          const { data } = await supabase.from('t').select('*').eq('id', id);
          if (data) await requireOrgContext();
          return data;
        }
        export async function sessionFirst() {
          const s = await requireSession();
          const ctx = await requireOrgContext();
          return [s, ctx];
        }
        export async function throughAHelperThatCanReturnEarly() {
          const filter = await activeFilter();
          return (await createClient()).from('t').select('*').eq('w', filter);
        }
        export async function inParallel() {
          const [ctx] = await Promise.all([requireOrgContext(), fetch('/x')]);
          return ctx;
        }
        export async function besideAHelperThatCanReturnEarly() {
          const [ctx, filter] = await Promise.all([requireOrgContext(), activeFilter()]);
          return [ctx, filter];
        }
        export async function besideOthersThatAskFirst(input: Promise<string>) {
          const [ctx, again, jar, client, value] = await Promise.all([
            requireOrgContext(),
            gated().then((c) => fetch('/after/' + c.organizationId)),
            cookies(),
            createClient(),
            input,
          ]);
          return [ctx, again, jar, client, value];
        }
        export async function besideAnInlineFunctionThatAsksLater() {
          const [ctx, n] = await Promise.all([
            requireOrgContext(),
            (async () => { await fetch('/write'); return requireOrgContext(); })(),
          ]);
          return [ctx, n];
        }
        export async function besideACallThatOnlyNamesTheContext() {
          const [ctx, n] = await Promise.all([requireOrgContext(), fetch('/x', { body: String(gated()) })]);
          return [ctx, n];
        }
        export async function throughHelpers() { return (await gatedTwiceRemoved()).organizationId; }
        export async function awaitsNothing() { return requireOrgContext(); }`,
    });
    expect(openActions(t, {})).toEqual([]);
    expect(lateActions(t, {})).toEqual([
      "server/actions/a.ts#besideACallThatOnlyNamesTheContext:47: starts `fetch('/x', { body: String(gated()) })` beside the context",
      'server/actions/a.ts#besideAHelperThatCanReturnEarly:26: starts `activeFilter()` beside the context',
      "server/actions/a.ts#besideAnInlineFunctionThatAsksLater:42: starts `(async () => { await fetch('/write'); return requireOrgContext(); })()` beside the context",
      "server/actions/a.ts#inParallel:22: starts `fetch('/x')` beside the context",
      'server/actions/a.ts#readsFirst:7: awaits `await createClient()` before the context',
      'server/actions/a.ts#sessionFirst:13: awaits `await requireSession()` before the context',
      'server/actions/a.ts#throughAHelperThatCanReturnEarly:18: awaits `await activeFilter()` before the context',
    ]);
    // Listing one, with what comes before it, covers that one only.
    const why = 'x'.repeat(41);
    expect(lateActions(t, { 'server/actions/a.ts#sessionFirst': why })).toHaveLength(6);
    // And a listed action that asks first, never reaches the gate, or is gone is reported.
    expect(
      staleEntries(
        t,
        {},
        {
          'server/actions/a.ts#sessionFirst': why,
          'server/actions/a.ts#inParallel': why,
          'server/actions/a.ts#besideOthersThatAskFirst': why,
          'server/actions/a.ts#gone': why,
          'server/actions/a.ts#readsFirst': 'short',
        },
      ),
    ).toEqual([
      'server/actions/a.ts#besideOthersThatAskFirst: asks first, so it leaves the list',
      'server/actions/a.ts#gone: no such action',
      'server/actions/a.ts#readsFirst: no reason given',
    ]);
  });

  it('3. a listed entry that reaches the gate, names nothing, gives no reason, or is no platform action is reported', () => {
    const t = tree({
      'server/actions/a.ts': `'use server';
        import { requireOrgContext } from '@/lib/auth/session';
        import { checkPlatformAdmin } from '@/lib/auth/platform-admin';
        import { resolvePortalContext } from '@/server/services/portal';
        import { createClient } from '@/lib/supabase/server';
        export async function gated() { return requireOrgContext(); }
        export async function open() { return 1; }
        export async function console() { return checkPlatformAdmin(); }
        export async function portalFirst() { const ctx = await resolvePortalContext(); return ctx; }
        export async function portalLate() {
          const rows = await (await createClient()).from('orders').select('*');
          return [rows, await resolvePortalContext()];
        }`,
      'server/lib/not-actions.ts': `export async function helper() { return 1; }`,
    });
    expect(
      staleEntries(t, {
        'server/actions/a.ts#gated': { kind: 'before-the-code', reason },
        'server/actions/a.ts#open': { kind: 'platform', reason },
        'server/actions/a.ts#console': { kind: 'platform', reason: 'short' },
        'server/actions/a.ts#portalFirst': { kind: 'portal', reason },
        'server/actions/a.ts#portalLate': { kind: 'portal', reason },
        'server/actions/a.ts#gone': { kind: 'own-rule', reason },
        'server/actions/missing.ts#x': { kind: 'own-rule', reason },
        'server/lib/not-actions.ts#helper': { kind: 'own-rule', reason },
      }),
    ).toEqual([
      'server/actions/a.ts#console: no reason given',
      'server/actions/a.ts#gated: reaches the gate, so it leaves the list',
      'server/actions/a.ts#gone: the module exports no such function',
      "server/actions/a.ts#open: listed as 'platform' but reaches no platform-admin gate",
      "server/actions/a.ts#portalLate: listed as 'portal' but does not ask resolvePortalContext() first",
      "server/actions/missing.ts#x: no such 'use server' module",
      "server/lib/not-actions.ts#helper: no such 'use server' module",
    ]);
  });

  it('4. a Server Action declared inside a component is found', () => {
    const t = tree({
      'app/form.tsx': `
        export function Form() {
          async function save(data: FormData) {
            'use server';
            return data;
          }
          return save;
        }`,
    });
    expect(inlineActionsOf(t)).toEqual(['app/form.tsx:3 save']);
  });
});
