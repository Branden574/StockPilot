import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Security invariant (docket S43b): the phone asks for the authenticator code
 * before anything of the account renders or syncs.
 *
 * WIRING, READ AS SOURCE. No test in this suite renders AuthProvider or the
 * root layout (the mobile suite has no React Native renderer), so the rule
 * itself is executed in mfa-level.test.ts and mfa-reconcile.test.ts, the
 * drains' hold in sync.drain.test.ts and cycle-count-sync.drain.test.ts, and
 * this file pins that the app is wired to them:
 *
 *   1. the gate is worked out from the session in render: no request decides
 *      it and none can lower it by failing;
 *   2. RootGate shows the code screen before the navigator whatever `loading`
 *      says, and hands the data hooks nobody until the code is entered;
 *   3. the sync and both outbox drains hold on the same answer, read from the
 *      stored session;
 *   4. the server's own factor list reaches the gate from every place the app
 *      already reads the user;
 *   5. THE WHOLE SET: every file of the phone that reads the assurance level,
 *      the factors or the gate is listed here with what it does. A new one
 *      fails this test until it is listed and reviewed.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(MOBILE_ROOT, rel), 'utf8');

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** One space per run of whitespace, so a reflow never breaks a pin. */
const flat = (src: string) => src.replace(/\s+/g, ' ');

const code = (rel: string) => flat(codeOnly(read(rel)));

/** The text of a top-level `function name(...)`, comments dropped, whitespace flattened. */
function functionText(rel: string, name: string): string {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = sf.statements.find(
    (st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === name,
  );
  expect(fn, `function ${name} in ${rel}`).toBeDefined();
  return flat(codeOnly(fn!.getText(sf)));
}

const AUTH = 'src/lib/auth-context.tsx';
const LAYOUT = 'app/_layout.tsx';

describe('1. the gate is worked out from the session, in render', () => {
  const auth = code(AUTH);

  it('mfaRequired is codeGateUp(session, the note), not a piece of state', () => {
    expect(auth).toContain(
      'const stepUpForced = React.useSyncExternalStore(subscribeStepUpForced, stepUpForcedFor);',
    );
    expect(auth).toContain('const mfaRequired = codeGateUp(session, stepUpForced);');
    expect(auth).not.toMatch(/setMfaRequired/);
    expect(auth).not.toMatch(/useState[^;]*mfa/i);
    // Exactly one definition, and it is the one handed to the context.
    expect(auth.match(/\bmfaRequired = /g)).toHaveLength(1);
    expect(auth).toMatch(/biometricEnabled, mfaRequired, verifyMfa,/);
  });

  it('no request decides the gate: the provider reads neither the level nor the factor list', () => {
    expect(auth).not.toContain('getAuthenticatorAssuranceLevel');
    expect(auth).not.toContain('listFactors');
    expect(auth).not.toContain('checkMfa');
  });

  it('nothing in the provider lowers the gate by hand: the note is only ever cleared there', () => {
    const sets = auth.match(/setStepUpForcedFor\([^)]*\)/g) ?? [];
    expect(sets.length).toBeGreaterThanOrEqual(2);
    for (const call of sets) expect(call).toBe('setStepUpForcedFor(null)');
    // Raised in one place: the reconcile, on the server's word.
    const reconcile = code('src/lib/mfa-reconcile.ts');
    expect(reconcile.match(/setStepUpForcedFor\(userId\)/g)).toHaveLength(2);
  });

  it('sign-in and the cold-launch hydrate wait on nothing for it', () => {
    const signIn = auth.slice(
      auth.indexOf("const signIn: AuthState['signIn']"),
      auth.indexOf("const verifyMfa: AuthState['verifyMfa']"),
    );
    expect(signIn).toContain('void sendSignedInNote(); return {}; };');
    const hydrate = auth.slice(
      auth.indexOf('const { data } = await supabase.auth.getSession();'),
      auth.indexOf('const { data: sub } = supabase.auth.onAuthStateChange('),
    );
    // The session is set before anything else is awaited. After it the
    // hydrate itself waits only for the biometric flag (the other await is
    // inside the detached probe's sign-out callback).
    expect(hydrate.indexOf('setSession(s);')).toBeGreaterThan(-1);
    expect(hydrate.slice(hydrate.indexOf('setSession(s);')).match(/\bawait [\w.]+/g)).toEqual([
      'await supabase.auth.signOut',
      'await isBiometricEnabledForUser',
    ]);
    expect(hydrate).toContain('void probeAndSettle(');
  });

  it('every auth event sets the session it carries first, so the gate follows each one', () => {
    expect(auth).toContain(
      'supabase.auth.onAuthStateChange(async (event, s) => { setSession(s);',
    );
  });

  it('the code is checked against the factor the session lists, else the one the server lists', () => {
    const verify = auth.slice(
      auth.indexOf("const verifyMfa: AuthState['verifyMfa']"),
      auth.indexOf('const signingOut = React.useRef(false);'),
    );
    expect(verify).toContain('let factorId = verifiedTotpFactorId(session?.user);');
    expect(verify).toContain('const live = await readLiveUser();');
    expect(verify).toContain('if (!live) return { error: MFA_CANNOT_CHECK_COPY };');
    expect(verify).toContain('factorId = verifiedTotpFactorId(live);');
    expect(verify).toContain('return { error: MFA_NO_AUTHENTICATOR_COPY };');
    // A factor the server no longer has runs the reconcile, for both calls.
    expect(verify.match(/reconcileIfFactorGone\((challengeErr|verifyErr)\);/g)).toEqual([
      'reconcileIfFactorGone(challengeErr);',
      'reconcileIfFactorGone(verifyErr);',
    ]);
    expect(auth).toContain("?.code === 'mfa_factor_not_found'");
  });
});

describe('2. RootGate: the code screen before anything else, and no data hook before the code', () => {
  const gate = functionText(LAYOUT, 'RootGate');

  it('the code screen does not wait for `loading`, and replaces the navigator', () => {
    const mfa = gate.indexOf('if (session && mfaRequired) { return <MfaChallengeScreen />; }');
    expect(mfa).toBeGreaterThan(-1);
    expect(gate).not.toContain('!loading && session && mfaRequired');
    expect(gate.indexOf('<Stack screenOptions=')).toBeGreaterThan(mfa);
    // Still under the disabled-account gate and above the biometric lock.
    expect(mfa).toBeGreaterThan(
      gate.indexOf("if (!loading && accountGate.state === 'disabled') { return <AccountDisabledScreen />;"),
    );
    expect(gate.indexOf('if (!loading && session && locked) { return <BiometricLockScreen />;')).toBeGreaterThan(mfa);
  });

  it('the data hooks are handed nobody until the code is entered', () => {
    const dataUser = gate.indexOf('const dataUser = session && !mfaRequired ? session.user : null;');
    expect(dataUser).toBeGreaterThan(-1);
    for (const hook of [
      'useSync(dataUser);',
      'useHeldOrderSubmissions(dataUser?.id ?? null, seeOrders);',
      "useActivityBeacon(dataUser?.id ?? null, segments.join('/'));",
    ]) {
      expect(gate, hook).toContain(hook);
      expect(gate.indexOf(hook), hook).toBeGreaterThan(dataUser);
    }
  });

  it('the session itself reaches only the hooks that must run at the code screen', () => {
    // Every use of the session's user in RootGate, in order. Push registration
    // holds itself (section 5); the revocation listener must reach a phone
    // sitting on the code screen; dataUser is the gate above.
    expect(gate.match(/[^;{}]*\bsession\??\.user\b[^;]*;/g)?.map((s) => s.trim())).toEqual([
      'const dataUser = session && !mfaRequired ? session.user : null;',
      'usePushNotifications(session?.user ?? null);',
      'useSessionRevocation(session?.user?.id ?? null, onForcedSignOut, revocationOptions);',
    ]);
    // And every hook RootGate calls is one this test knows about.
    expect([...new Set(gate.match(/(?<!React\.)\buse[A-Z]\w*(?=\()/g))].sort()).toEqual([
      'useAccountGate',
      'useActivityBeacon',
      'useAuth',
      'useHeldOrderSubmissions',
      'usePushNotifications',
      'useRouter',
      'useSegments',
      'useSessionRevocation',
      'useSync',
      'useTheme',
    ]);
  });

  it('the redirect never navigates while the code screen has replaced the navigator', () => {
    expect(gate).toContain(
      "if (loading || accountGate.state === 'disabled') return; if (session && mfaRequired) return; const inAuthGroup = segments[0] === '(auth)';",
    );
    expect(gate).toContain('}, [session, loading, mfaRequired, segments, router, accountGate.state]);');
  });

  it("What's New and the update pop-up stay in the signed-in shell only", () => {
    expect(gate).toContain('{session && !loading && !mfaRequired && !locked ? <WhatsNew /> : null}');
    expect(gate).toContain(
      '{session && !loading && !mfaRequired && !locked ? ( <UpdatePromptHost segments={segments} /> ) : null}',
    );
  });

  it('inside AuthProvider, the root layout mounts only the appearance bridge and RootGate', () => {
    const layout = functionText(LAYOUT, 'RootLayout');
    const provider = layout.slice(layout.indexOf('<AuthProvider>'), layout.indexOf('</AuthProvider>'));
    expect(provider.match(/<[A-Z]\w*/g)).toEqual([
      '<AuthProvider',
      '<AppearanceSessionBridge',
      '<StatusBar',
      '<ColdLaunchGateProvider',
      '<AppErrorBoundary',
      '<RootGate',
    ]);
    // The bridge reports nobody while the code is owed.
    expect(code('src/lib/appearance/session-bridge.tsx')).toContain(
      'if (loading || mfaRequired) return; getAppearanceController().setSession(userId);',
    );
  });
});

describe('3. the sync and both outbox drains hold on the same answer', () => {
  it('the stored session says whether the code is owed, in the same read as whose it is', () => {
    const storage = code('src/lib/auth-storage.ts');
    expect(storage).toContain("import { stepUpOwedFromStored } from './mfa-level';");
    expect(storage).toContain('if (head === null) return { present: false, userId: null, stepUpOwed: false };');
    expect(storage).toContain(
      'return { present: true, userId: storedSessionUserId(raw), stepUpOwed: stepUpOwedFromStored(raw) };',
    );
  });

  it('the live scope carries it, with the server-backed note, and an unreadable store owes it', () => {
    const scope = code('src/lib/session-scope.ts');
    expect(scope).toContain('const { userId, stepUpOwed } = await readDeviceAuthSession();');
    expect(scope).toContain('} catch { return { userId: null, stepUpOwed: true }; }');
    expect(scope).toContain(
      'stepUpOwed: stepUpOwed || (userId !== null && stepUpForcedFor() === userId),',
    );
    // Still never the refreshing getSession() (session-scope.test.ts).
    expect(scope).not.toContain('getSession');
  });

  it('the send decision holds every row while it is owed, before it looks at whose row it is', () => {
    const decision = functionText('src/lib/outbox-scope.ts', 'outboxSendDecision');
    const signedOut = decision.indexOf("if (!live.userId) return { send: false, reason: 'signed-out' };");
    const owed = decision.indexOf("if (live.stepUpOwed) return { send: false, reason: 'step-up-owed' };");
    const owner = decision.indexOf('isOwnedBy(row, live.userId)');
    expect(signedOut).toBeGreaterThan(-1);
    expect(owed).toBeGreaterThan(signedOut);
    expect(owner).toBeGreaterThan(owed);
    expect(decision.slice(owed).match(/send: true/g)).toHaveLength(1);
  });

  it('the snapshot pull returns before it reads, resets or asks for anything', () => {
    const pull = functionText('src/lib/sync.ts', 'pullSnapshot');
    const scope = pull.indexOf('const { userId: liveUserId, stepUpOwed } = await liveOutboxScope();');
    const hold = pull.indexOf('if (stepUpOwed) return null;');
    expect(scope).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(scope);
    // Nothing between the scope read and the hold.
    expect(pull.slice(scope, hold)).toBe(
      'const { userId: liveUserId, stepUpOwed } = await liveOutboxScope(); ',
    );
    for (const later of ['cacheOwnerAction(', 'deleteOrgData', 'getMeta(', 'isOnline()', 'api<SnapshotResponse>(']) {
      expect(pull.indexOf(later), later).toBeGreaterThan(hold);
    }
  });

  it('the count drain settles nothing and sends nothing through the same module', () => {
    const engine = code('src/lib/cycle-count-sync.ts');
    expect(engine).toContain('for (const stale of canSettleOutbox(staleScope) ? superseded : []) {');
    expect(engine).toContain('const decision = outboxSendDecision(row, await liveOutboxScope());');
    expect(functionText('src/lib/outbox-scope.ts', 'canSettleOutbox')).toContain(
      'return Boolean(live.userId) && !live.stepUpOwed;',
    );
    expect(code('src/lib/sync.ts')).toContain(
      'const decision = outboxSendDecision(action, await liveOutboxScope());',
    );
  });

  it('once the gate comes down with a session, the count drain gets a pass at once', () => {
    const auth = code(AUTH);
    expect(auth).toContain(
      'if (!gateWasUp.current) return; gateWasUp.current = false; if (gateUserId) void cycleCountSync.forceSync().catch(() => undefined);',
    );
  });
});

describe("4. the server's own factor list reaches the gate wherever the app already reads the user", () => {
  const auth = code(AUTH);

  it('the cold-launch probe and the probe after a refused request hand over what they read', () => {
    expect(auth).toContain(
      'void probeAndSettle( getAccountGateState(), () => supabase.auth.getUser().then(handOverLiveUser),',
    );
    expect(code('src/lib/use-account-gate.ts')).toContain(
      '() => withTimeout(supabase.auth.getUser().then(handOverLiveUser), PROBE_TIMEOUT_MS, null),',
    );
    expect(auth).toContain(
      'setLiveUserHandler((user) => { void reconcileCodeGate(user); }); return () => setLiveUserHandler(null);',
    );
  });

  it('the return to the foreground reconciles with the user it read, after any address refresh', () => {
    const foreground = auth.slice(
      auth.indexOf("const onChange = (state: AppStateStatus) => { if (state !== 'active') return;"),
      auth.indexOf("const sub = AppState.addEventListener('change', onChange);"),
    );
    expect(foreground).toContain('if (error || !liveUser) return null;');
    const refresh = foreground.indexOf('await supabase.auth.refreshSession();');
    const reconcile = foreground.indexOf('return reconcileCodeGate(liveUser);');
    expect(refresh).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(refresh);
  });

  it('the gate going up asks once, detached and bounded', () => {
    expect(auth).toContain(
      'if (mfaRequired) { if (gateWasUp.current) return; gateWasUp.current = true; void readLiveUser().then((user) => (user ? reconcileCodeGate(user) : null)); return; }',
    );
    const live = functionText(AUTH, 'readLiveUser');
    expect(live).toContain('return withTimeout(');
    expect(live).toContain('PROBE_TIMEOUT_MS, null,');
  });

  it('the reconcile reads the session auth-js holds and refreshes with a bound; a failure is null', () => {
    expect(auth).toContain(
      'const reconcileCodeGate = createStepUpReconciler({ currentSession: () => supabase.auth.getSession().then( ({ data }) => data.session, () => null, ), refreshSession: () => withTimeout( supabase.auth.refreshSession().then(({ data, error }) => (error ? null : data.session)), PROBE_TIMEOUT_MS, null, ), });',
    );
  });

  it('a verified code and a sign-out settle the note; nothing else in the provider touches it', () => {
    expect(auth).toContain(
      "if (event === 'MFA_CHALLENGE_VERIFIED') { setStepUpForcedFor(null); }",
    );
    const signedOut = auth.slice(
      auth.indexOf("if (event === 'SIGNED_OUT' || !s?.user) {"),
      auth.indexOf("if (event === 'SIGNED_IN') {"),
    );
    expect(signedOut).toContain('setStepUpForcedFor(null); return; }');
    expect(auth.match(/setStepUpForcedFor\(/g)).toHaveLength(2);
  });
});

describe('5. the whole set: every place the phone reads the level, the factors or the gate', () => {
  /** What marks a file as part of the set. Server refusal codes such as aal2_required are not it. */
  const MARK =
    /getAuthenticatorAssuranceLevel|listFactors|\.mfa\.(?:challenge|verify|enroll|unenroll)\b|\bmfaRequired\b|\bstepUpOwed\w*|\bcodeGateUp\b|\btokenAal\b|\bstepUpForcedFor\b|\bsetStepUpForcedFor\b/;

  /** The set, and what each file does with the answer. */
  const KNOWN: Record<string, string> = {
    'app/_layout.tsx': 'RootGate: shows the code screen and hands the data hooks nobody (section 2)',
    'src/lib/appearance/account.ts':
      'peekSignedInUser: the first-paint appearance read is not made for a session that owes its code',
    'src/lib/appearance/session-bridge.tsx': 'reports nobody to the appearance controller while the code is owed',
    'src/lib/auth-context.tsx': 'the gate, the code check and the reconcile wiring (sections 1 and 4)',
    'src/lib/auth-storage.ts': 'the stored session says whether the code is owed (section 3)',
    'src/lib/mfa-level.ts': 'the rule, read from a session (mfa-level.test.ts)',
    'src/lib/mfa-reconcile.ts': "the gate against the server's list (mfa-reconcile.test.ts)",
    'src/lib/outbox-scope.ts': 'the send decision holds every row while the code is owed (section 3)',
    'src/lib/session-scope.ts': 'the live scope carries the answer to both drains and the pull (section 3)',
    'src/lib/sync.ts': 'the snapshot pull holds (section 3)',
    'src/lib/use-push-notifications.ts':
      'registerThisDevice: writes no push token for a session that owes its code, read right before the write',
  };

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(path.join(MOBILE_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue;
        out.push(...sourceFiles(rel));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(rel);
      }
    }
    return out;
  }

  it('is exactly the listed files', { timeout: 60_000 }, () => {
    const found = [...sourceFiles('app'), ...sourceFiles('src')]
      .filter((rel) => MARK.test(codeOnly(read(rel))))
      .sort();
    expect(found).toEqual(Object.keys(KNOWN).sort());
  });

  it('push registration keeps its own hold: fail closed, read after the last wait before the write', () => {
    const push = code('src/lib/use-push-notifications.ts');
    const helper = functionText('src/lib/use-push-notifications.ts', 'owesAuthenticatorCode');
    expect(helper).toContain('if (error || !data?.currentLevel) return true;');
    expect(helper).toContain("return data.currentLevel === 'aal1' && data.nextLevel === 'aal2';");
    expect(helper).toContain('} catch { return true; }');
    const level = push.indexOf('if (await owesAuthenticatorCode()) return;');
    expect(level).toBeGreaterThan(-1);
    expect(push.indexOf("rpc('register_push_token'")).toBeGreaterThan(level);
    // One write site, behind that one check.
    expect(push.match(/owesAuthenticatorCode\(\)/g)).toHaveLength(2);
    expect(push.match(/rpc\('register_push_token'/g)).toHaveLength(1);
  });

  it('the first-paint appearance read is not made for a session that owes its code', () => {
    const peek = functionText('src/lib/appearance/account.ts', 'peekSignedInUser');
    const level = peek.indexOf("if (aal?.currentLevel === 'aal1' && aal?.nextLevel === 'aal2') return null;");
    expect(level).toBeGreaterThan(-1);
    expect(peek.indexOf('return userId;')).toBeGreaterThan(level);
    expect(peek).toContain('} catch { return null; }');
  });

  it('the only code check the phone makes is the code screen answering through verifyMfa', () => {
    const calls = [...sourceFiles('app'), ...sourceFiles('src')].filter((rel) =>
      /\.mfa\.(?:challenge|verify)\b/.test(codeOnly(read(rel))),
    );
    expect(calls).toEqual(['src/lib/auth-context.tsx']);
    expect(code('src/components/mfa-challenge-screen.tsx')).toContain(
      'const { error: err } = await verifyMfa(value);',
    );
  });
});
