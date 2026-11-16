import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The queued-work hold for authenticator set-up, WIRED. The rule and the
 * drains are executed in set-up-inputs.test.ts, outbox-scope.test.ts,
 * drain-failure.test.ts, sync.drain.test.ts and cycle-count-sync.drain.test.ts;
 * this pins where the inputs come from and that both drains use them.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
/** Code only (comments dropped), one space per run of whitespace. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

describe('the inputs: policy and role from the membership read, factors from every server read of the user', () => {
  it('set-up-inputs.ts is a leaf: core only, so the drains import nothing native through it', () => {
    const imports = [
      ...read('set-up-inputs.ts').matchAll(/^import [\s\S]*? from '([^']+)';/gm),
    ].map((m) => m[1]);
    expect(imports).toEqual(['@stockpilot/core']);
  });

  it('the workspace load reads each workspace policy in the same select and hands the rows over', () => {
    const load = code('use-workspace.ts');
    const fn = load.slice(
      load.indexOf('export async function loadOrgs('),
      load.indexOf('async function loadWarehouses('),
    );
    expect(fn).toContain(
      ".select('role, organization_id, organizations:organization_id (name, mfa_policy)')",
    );
    const started = fn.indexOf('const readSeq = beginSetUpRead();');
    const request = fn.indexOf('await supabase');
    const handed = fn.indexOf('recordMembershipInputs( userId,');
    expect(started).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(started);
    // Only after the error return: a failed read hands over nothing.
    expect(handed).toBeGreaterThan(fn.indexOf('return null;'));
    expect(fn).toContain('organization: r.organizations, })), readSeq, );');
  });

  it('every user read from the server reaches the store through the code gate reconcile', () => {
    const reconcile = code('mfa-reconcile.ts');
    expect(reconcile).toContain("import { noteServerReadUser } from './set-up-inputs';");
    expect(reconcile).toContain(
      'return (liveUser) => { noteServerReadUser(liveUser); running ??= run(liveUser)',
    );
  });

  it('the app connects the store at start: saved inputs and the bounded read', () => {
    expect(code('use-sync.ts')).toContain(
      "import { connectSetUpInputs } from './set-up-inputs-source';",
    );
    expect(code('use-sync.ts')).toMatch(
      /import type \{ User \} from '@supabase\/supabase-js'; connectSetUpInputs\(\);/,
    );
    const source = code('set-up-inputs-source.ts');
    expect(source).toContain(
      'registerSetUpInputsSource({ storage: AsyncStorage, read: readSetUpInputsNow });',
    );
    expect(source).toContain(
      'supabase.auth.getUser().then(handOverLiveUser), PROBE_TIMEOUT_MS, null,',
    );
    expect(source).toContain(
      'await withTimeout(loadOrgs(user.id), MEMBERSHIP_READ_TIMEOUT_MS, null);',
    );
  });
});

describe('both drains: the hold, the check after a kept 403, and the read that releases a held row', () => {
  it.each([
    ['sync.ts', 'action', 'markFailed(action.id, msg)'],
    ['cycle-count-sync.ts', 'row', 'outboxBumpFailure(row.id, msg)'],
  ])('%s', (file, rowName, keep) => {
    const src = code(file);
    expect(src).toContain(
      `const decision = outboxSendDecision(${rowName}, await liveOutboxScope()); if (!decision.send) { if (decision.reason === 'set-up-owed') requestSetUpInputsRead(); continue; }`,
    );
    expect(src).toContain(
      'classifyDrainFailure(e, { accountDisabled: getAccountDisabled(), setUp: setUpAnswerAfterRefusal(decision.userId, decision.orgId), });',
    );
    const kept = src.indexOf(
      'if (keptForSetUpCheck(e)) noteKeptRefusal(decision.userId, decision.orgId);',
    );
    expect(kept).toBeGreaterThan(-1);
    expect(src.indexOf(keep, kept)).toBeGreaterThan(kept);
  });

  it('the adjustment verdict carries the same answer, and a kept one holds its scope', () => {
    const src = code('sync.ts');
    expect(src).toContain(
      'handedOff: handedOffAt !== null, setUp: setUpAnswerAfterRefusal(decision.userId, decision.orgId), });',
    );
    expect(src).toContain(
      "} else if (verdict === 'held-for-set-up') { noteKeptRefusal(decision.userId, decision.orgId); heldScopes.add(scopeOf(decision)); await markFailed(action.id, msg); failed += 1; }",
    );
  });

  it('the count drain settles nothing it holds', () => {
    expect(code('cycle-count-sync.ts')).toContain(
      'for (const stale of canSettleOutbox(staleScope) ? superseded : []) { if (heldForSetUp(stale, staleScope)) continue;',
    );
  });
});

describe('the sign-out and the eviction forget the inputs beside the wipe of the account keys', () => {
  it.each(['auth-context.tsx', 'use-account-gate.ts'])('%s', (file) => {
    const src = code(file);
    expect(src).toContain("import { forgetSetUpInputs } from './set-up-inputs';");
    const step = src.slice(src.indexOf('clearAccountStorage: async () => {'));
    const forget = step.indexOf('await forgetSetUpInputs();');
    const wipe = step.indexOf(
      'const keys = accountScopedStorageKeys(await AsyncStorage.getAllKeys()); if (keys.length > 0) await AsyncStorage.multiRemove(keys);',
    );
    expect(forget).toBeGreaterThan(-1);
    expect(wipe).toBeGreaterThan(forget);
    expect(src.match(/forgetSetUpInputs\(\)/g)).toHaveLength(1);
  });

  it('every key the store writes is under the account-scoped prefix and names its account', () => {
    const store = code('set-up-inputs.ts');
    expect(store).toContain(
      "export const SET_UP_INPUTS_STORAGE_PREFIX = 'workspace.setUpInputs.';",
    );
    expect(store).toContain(
      'export function setUpInputsStorageKey(userId: string): string { return `${SET_UP_INPUTS_STORAGE_PREFIX}${userId}`; }',
    );
    expect(store.match(/\.setItem\(/g)).toHaveLength(1);
    expect(store).toContain('.setItem(setUpInputsStorageKey(userId),');
  });
});
