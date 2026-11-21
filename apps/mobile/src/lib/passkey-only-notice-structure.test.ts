import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { PASSKEY_ONLY_NOTICE_COPY } from '@stockpilot/core';

/**
 * Security invariant: an account whose only second step is a passkey is shown
 * a plain screen in place of the code box, and nothing else changes for it
 * (plan section 5).
 *
 * Read as source (the suite has no React Native renderer). RootGate
 * (app/_layout.tsx) shows PasskeyOnlyNotice for a session that owes its
 * second step (mfaRequired) when passkeyOnlySession (mfa-level.ts) says every
 * verified factor of its user is a bridge, right before the code screen, after the
 * disabled-account screen and before the biometric lock and the set-up hold.
 * The code screen's own line and the gate are unchanged
 * (code-gate-wiring.test.ts sections 1 and 2), so the data hooks are still
 * handed nobody. The notice checks no code, reads no gate state, opens the
 * website's security page through webLink, and signs out through
 * signOutToFallback; every word is core's. Its Check again (review 2-3
 * finding 10) reads the user only, through the provider's recheckCodeGate:
 * the read the gate makes when it comes up (readLiveUser, then the code
 * gate's reconcile), so an app added on the website refreshes the session and
 * the code screen takes the notice's place. Never the set-up read, the
 * workspace or the memberships (review B finding 2): the session still owes
 * its second step. Still here, a line says whether the server answered
 * (core's AUTHENTICATOR_CHECK_RESULT_COPY).
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(MOBILE_ROOT, rel), 'utf8');
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const flat = (src: string) => src.replace(/\s+/g, ' ');

function functionText(rel: string, name: string): string {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = sf.statements.find(
    (st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === name,
  );
  expect(fn, `function ${name} in ${rel}`).toBeDefined();
  return flat(codeOnly(fn!.getText(sf)));
}

const NOTICE = 'src/components/passkey-only-notice.tsx';

describe('RootGate: the notice in place of the code screen, for a bridge-only account', () => {
  const gate = functionText('app/_layout.tsx', 'RootGate');
  const branch =
    "if (session && mfaRequired && passkeyOnly(session)) { const { PasskeyOnlyNotice } = require('@/components/passkey-only-notice') as typeof import('@/components/passkey-only-notice'); return <PasskeyOnlyNotice />; }";
  const notice = gate.indexOf(branch);
  const codeScreen = gate.indexOf('if (session && mfaRequired) { return <MfaChallengeScreen />; }');

  it('sits right before the code screen, which is unchanged', () => {
    expect(notice).toBeGreaterThan(-1);
    expect(codeScreen).toBeGreaterThan(notice);
    // Nothing between the two.
    expect(gate.slice(notice, codeScreen).trim()).toBe(branch);
    expect(gate.split('PasskeyOnlyNotice />')).toHaveLength(2);
  });

  it('after the disabled-account screen, before the lock, the set-up hold and the navigator', () => {
    expect(notice).toBeGreaterThan(
      gate.indexOf(
        "if (!loading && accountGate.state === 'disabled') { return <AccountDisabledScreen />;",
      ),
    );
    for (const later of [
      'if (!loading && session && locked) { return <BiometricLockScreen />;',
      'if (session && setUpHold) {',
      '<Stack screenOptions=',
    ]) {
      expect(gate.indexOf(later), later).toBeGreaterThan(notice);
    }
  });

  it("asks mfa-level's rule for the session, and nothing else", () => {
    expect(functionText('app/_layout.tsx', 'passkeyOnly')).toBe(
      "function passkeyOnly(session: SessionLike): boolean { const { passkeyOnlySession } = require('@/lib/mfa-level') as typeof import('@/lib/mfa-level'); return passkeyOnlySession(session); }",
    );
  });

  it('the data hooks are still handed nobody while the second step is owed', () => {
    expect(gate).toContain(
      'const dataUser = session && !mfaRequired && !setUpHold ? session.user : null;',
    );
  });
});

describe('PasskeyOnlyNotice', () => {
  const src = flat(codeOnly(read(NOTICE)));

  it('every word is core’s', () => {
    for (const key of Object.keys(PASSKEY_ONLY_NOTICE_COPY)) {
      expect(src, key).toContain(`PASSKEY_ONLY_NOTICE_COPY.${key}`);
    }
    // No sentence of its own in the markup: every text child is a constant.
    expect(src).not.toMatch(/>\s*[A-Z][a-z]+ [a-z]+[^<{]*</);
  });

  it("opens the website's security page through webLink, and signs out through signOutToFallback", () => {
    expect(src).toContain('Linking.openURL(webLink(AUTHENTICATOR_SET_UP_PAGE))');
    expect(src).toContain("import { webLink } from '@/lib/web-links';");
    expect(src).toContain('signOutToFallback()');
  });

  it('checks no code and reads no gate state', () => {
    expect(src).not.toMatch(/verifyMfa|\.mfa\.|mfaRequired|stepUpOwed|codeGateUp|listFactors/);
  });

  it("Check again reads the user only, through the gate's own read, and says whether the server answered", () => {
    expect(src).toContain('const { recheckCodeGate, signOutToFallback } = useAuth();');
    expect(src).toContain('answer = await recheckCodeGate();');
    expect(src).toContain(
      "answer === 'answered' ? AUTHENTICATOR_CHECK_RESULT_COPY.checked : AUTHENTICATOR_CHECK_RESULT_COPY.noAnswer;",
    );
    // Never the set-up read, the workspace or the memberships: the session
    // still owes its second step (review B finding 2). Nor the session itself.
    const whole = read('src/components/passkey-only-notice.tsx');
    expect(whole).not.toMatch(
      /readSetUpInputsForHold|readSetUpInputsNow|setUpCheckAnswered|loadOrgs|useWorkspace|organization_members|set-up-hold|use-workspace/,
    );
    expect(src).not.toMatch(/\bsession\b/);
    // The provider's recheck is the gate's own user read and reconcile, and
    // nothing else.
    const recheck = flat(codeOnly(read('src/lib/auth-context.tsx')));
    expect(recheck).toContain(
      "const recheckCodeGate: AuthState['recheckCodeGate'] = async () => { const live = await readLiveUser(); if (!live) return 'no_answer'; await reconcileCodeGate(live); return 'answered'; };",
    );
  });

  it('Check again sits next to the way out, and both stay usable while a check runs', () => {
    const check = src.indexOf('{PASSKEY_ONLY_NOTICE_COPY.checkAgain}');
    const out = src.indexOf('{PASSKEY_ONLY_NOTICE_COPY.differentAccount}');
    expect(check).toBeGreaterThan(src.indexOf('{PASSKEY_ONLY_NOTICE_COPY.openWebsite}'));
    expect(out).toBeGreaterThan(check);
    // Only Check again waits for its own read; the way out never does.
    expect(src.match(/disabled=\{[^}]*\}/g)).toEqual(['disabled={checking}']);
  });
});
