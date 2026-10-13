import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the iPhone push-tap fix (Phase 3).
 *
 * The coordinator, the parser and the open steps are tested as pure modules.
 * What they cannot reach is the wiring: this suite has no React Native
 * renderer, so the connections that make a tap open its order are pinned at
 * source level. Each is a specific way the fix silently stops working:
 *
 *   1. capture starts at module scope, before the fonts gate, AuthProvider and
 *      the session restore (a tap that launched the app was emitted before any
 *      listener existed, and nothing read it);
 *   2. the host is mounted with the Stack, after every gate, never over MFA,
 *      the Face ID lock or a disabled account;
 *   3. exactly one response listener app-wide, no second consumer, and no
 *      receipt listener (a receipt must never navigate);
 *   4. registration no longer opens URLs (Safari, the swallowed .catch);
 *   5. the sign-in to MFA window is covered, and only a completed deliberate
 *      sign-out or an eviction drops the tap;
 *   6. the launch OTA reload waits for a notification launch;
 *   7. the host and the notice only read and navigate.
 */

const ROOT = path.resolve(__dirname, '../..');
/** A file's source, or '' while it does not exist (each pin then fails on its own). */
const read = (file: string) =>
  existsSync(path.join(ROOT, file)) ? readFileSync(path.join(ROOT, file), 'utf8') : '';
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

/** Source with comments removed: a comment may name what the code may not do. */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const flat = (src: string) => codeOnly(src).replace(/\s+/g, ' ');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__mocks__' || name === '__fixtures__') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('1. capture starts with the JS runtime, before every gate', () => {
  it('_layout.tsx starts the coordinator at module scope, right after initSentry()', () => {
    const layout = codeOnly(read('app/_layout.tsx'));
    expect(layout).toContain("import { notificationIntents } from '@/lib/notification-intent';");
    const sentryAt = layout.indexOf('\ninitSentry();\n');
    const startAt = layout.indexOf('\nnotificationIntents.start();\n');
    expect(sentryAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(sentryAt);
    // Outside any function: above the root layout, at column 0.
    expect(startAt).toBeLessThan(layout.indexOf('function RootLayout('));
    expect(layout.match(/notificationIntents\.start\(\)/g)).toHaveLength(1);
  });
});

describe('2. the host opens it, from the Stack branch only', () => {
  const layout = codeOnly(read('app/_layout.tsx'));
  const mount =
    '{session && !loading && !mfaRequired && !locked ? <NotificationIntentHost /> : null}';

  it('RootGate mounts the host once, beside WhatsNew, after every gate has returned', () => {
    expect(layout).toContain(
      "import { NotificationIntentHost } from '@/components/notification-intent-host';",
    );
    expect(layout.split(mount)).toHaveLength(2);
    const at = layout.indexOf(mount);
    expect(at).toBeGreaterThan(layout.indexOf('return <AccountDisabledScreen />;'));
    expect(at).toBeGreaterThan(layout.indexOf('return <MfaChallengeScreen />;'));
    expect(at).toBeGreaterThan(layout.indexOf('return <BiometricLockScreen />;'));
    expect(at).toBeGreaterThan(layout.indexOf('</Stack>'));
  });

  it('an eviction or a revoked session (the one forced exit) drops the pending tap', () => {
    const fn = layout.slice(
      layout.indexOf('const onForcedSignOut = React.useCallback('),
      layout.indexOf('const accountGate = useAccountGate('),
    );
    const clearAt = fn.indexOf("notificationIntents.clear('evicted');");
    expect(clearAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(fn.indexOf('router.replace(signedOutRoute() as Href);'));
  });

  it('the old tap handler is not mounted any more', () => {
    expect(layout).toContain('usePushNotifications(session?.user ?? null);');
  });
});

describe('3. one listener, one launch read, and no receipt navigation, app-wide', () => {
  const files = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'app'))];
  const holders = (needle: string) =>
    files.filter((f) => codeOnly(readFileSync(f, 'utf8')).includes(needle)).map(rel);

  it('exactly one addNotificationResponseReceivedListener, in notification-intent.ts', () => {
    // Vacuity control: the sweep found the app's sources.
    expect(files.length).toBeGreaterThan(100);
    expect(holders('addNotificationResponseReceivedListener')).toEqual([
      'src/lib/notification-intent.ts',
    ]);
    expect(holders('getLastNotificationResponse')).toEqual(['src/lib/notification-intent.ts']);
    expect(holders('clearLastNotificationResponse')).toEqual(['src/lib/notification-intent.ts']);
  });

  it('no useLastNotificationResponse (it installs a listener of its own) and no receipt listener', () => {
    expect(holders('useLastNotificationResponse')).toEqual([]);
    expect(holders('addNotificationReceivedListener')).toEqual([]);
  });
});

describe('4. registration no longer handles taps', () => {
  it('use-push-notifications.ts opens no URL and installs no response listener', () => {
    const hook = codeOnly(read('src/lib/use-push-notifications.ts'));
    expect(hook).not.toContain('Linking');
    expect(hook).not.toContain('addNotificationResponseReceivedListener');
    expect(hook).not.toContain('rewriteWebPath');
    // Presentation in the foreground and the token RPC stay (push-register-wiring.test.ts).
    expect(hook).toContain('Notifications.setNotificationHandler({');
    expect(hook).toMatch(/rpc\(\s*'register_push_token'/);
  });
});

describe('5. auth: the sign-in to MFA window, and the deliberate sign-out', () => {
  const auth = read('src/lib/auth-context.tsx');
  const code = codeOnly(auth);
  const fn = (name: string) =>
    code.slice(code.indexOf(`const ${name}: AuthState['${name}']`)).split('\n  };\n')[0] ?? '';

  it('signIn raises mfaPending before the password grant and lowers it in a finally after the MFA check', () => {
    const body = fn('signIn');
    const raise = body.indexOf('setMfaPending(true);');
    const grant = body.indexOf('supabase.auth.signInWithPassword(');
    const check = body.indexOf('await checkMfa();');
    const fin = body.indexOf('} finally {');
    const lower = body.indexOf('setMfaPending(false);');
    expect(raise).toBeGreaterThan(-1);
    expect(raise).toBeLessThan(grant);
    expect(check).toBeGreaterThan(grant);
    expect(fin).toBeGreaterThan(check);
    expect(lower).toBeGreaterThan(fin);
  });

  it('mfaPending is part of the auth state the host reads', () => {
    expect(code).toContain('mfaPending: boolean;');
    expect(flat(auth)).toMatch(/value=\{\{[^}]*\bmfaPending,/);
  });

  it('only a completed deliberate sign-out drops the pending tap (never the fallback to a password)', () => {
    expect(code).toContain("import { notificationIntents } from './notification-intent';");
    expect(fn('signOut')).toMatch(
      /if \(outcome === 'signed-out'\) \{\s*notificationIntents\.clear\('deliberate-sign-out'\);\s*\}/,
    );
    expect(code.match(/notificationIntents\.clear\(/g)).toHaveLength(1);
    expect(fn('signOutToFallback')).not.toContain('notificationIntents');
  });
});

describe('6. the launch OTA reload waits for a notification launch', () => {
  it('runStartupUpdate asks seenNotificationThisLaunch() after the fetch and before reloadAsync', () => {
    const ota = codeOnly(read('src/lib/use-ota-updates.ts'));
    const body = ota.slice(ota.indexOf('export async function runStartupUpdate('));
    const fetchAt = body.indexOf('await deps.fetchUpdateAsync();');
    const askAt = body.indexOf('if (deps.seenNotificationThisLaunch()) {');
    const reloadAt = body.indexOf('await deps.reloadAsync();');
    expect(fetchAt).toBeGreaterThan(-1);
    expect(askAt).toBeGreaterThan(fetchAt);
    expect(reloadAt).toBeGreaterThan(askAt);
    expect(ota).toContain(
      'seenNotificationThisLaunch: () => notificationIntents.seenThisLaunch(),',
    );
  });
});

describe('7. the host and the notice only read and navigate', () => {
  const host = read('src/components/notification-intent-host.tsx');
  const notice = read('src/components/notification-intent-notice.tsx');
  const imports = (src: string) => [...src.matchAll(/from '([^']+)';/g)].map((m) => m[1]).sort();

  it('import only these modules: no order, return, delivery, Outlook or email action module', () => {
    expect(imports(host)).toEqual(
      [
        '@/components/notification-intent-notice',
        '@/lib/auth-context',
        '@/lib/cold-launch-gate',
        '@/lib/exceptions-api',
        '@/lib/notification-intent',
        '@/lib/notification-open',
        '@/lib/push-open-diagnostics',
        '@/lib/supabase',
        '@/lib/tour-targets',
        '@/lib/use-workspace',
        'expo-network',
        'expo-router',
        'react',
      ].sort(),
    );
    // The connection rule the drawer's switcher applies, and nothing else from there.
    expect(host).toContain("import { isOfflineState } from '@/lib/exceptions-api';");
    expect(imports(notice)).toEqual(
      [
        '@/components/ui/button',
        '@/components/ui/card',
        '@/components/ui/text',
        '@/components/workspace-switcher',
        '@/lib/notification-open',
        '@/lib/theme',
        '@/lib/use-theme',
        'react',
        'react-native',
      ].sort(),
    );
  });

  it('never call the API, fetch, Linking, or write', () => {
    for (const src of [host, notice].map(codeOnly)) {
      expect(src).not.toMatch(/\bapi\(/);
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toContain('Linking');
      expect(src).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
      expect(src).not.toMatch(/\bmethod:/);
    }
  });

  it("the host opens with router.push, waits for the splash and What's New, and holds the interruption lock", () => {
    const code = codeOnly(host);
    expect(code).toContain('router.push(');
    expect(code).toContain('!splashActive && !whatsNewOpen');
    expect(code).toContain('setTourVisible(NOTICE_LOCK_ID, true);');
    expect(code).toContain('setTourVisible(NOTICE_LOCK_ID, false)');
    expect(code).toContain("const NOTICE_LOCK_ID = 'notification-notice';");
  });

  it('a newer tap closes an open notice', () => {
    expect(codeOnly(host)).toContain('shown && intent && shown.seq === intent.seq ? shown : null');
  });

  it('the open effect acts on the tap take() handed over, never on the render it ran for', () => {
    const code = codeOnly(host);
    const start = code.indexOf('const take = notificationIntents.take(');
    expect(start).toBeGreaterThan(-1);
    const effect = code.slice(start, code.indexOf('const onAction = ', start));
    // nextOpenStep answers idle unless take() handed over this render's tap.
    expect(effect).toContain('forSeq: intent.seq,');
    const handedOver = effect.indexOf('const it = take.intent;');
    expect(handedOver).toBeGreaterThan(-1);
    // From there on, every branch (finish, open, the notice, the check) uses it.
    const branches = effect.slice(handedOver, effect.indexOf('}, [', handedOver));
    expect(branches).toContain('switch (step.kind) {');
    expect(branches).not.toMatch(/(?<![.\w])intent\b/);
  });

  it('a slow workspace check shows Checking; a newer tap, a sign-out or an unmount ends it (decision (b))', () => {
    const code = codeOnly(host);
    // One check at a time, per host instance (notification-open.test.ts runs it).
    expect(code).toContain('createWorkspaceChecks(() => notificationIntents.peek()?.seq ?? null)');
    expect(code).toContain(
      'checks.start(seq, () => resolveTargetWorkspace(supabase, step.table, step.id), {',
    );
    expect(flat(host)).toMatch(
      /setShown\(\{ seq, notice: \{ kind: 'checking', noun: targetNoun\(target\.routeKind\) \}, busy: false, \}\)/,
    );
    // The open effect waits on the running check, which always answers (the
    // read's deadline), never on a ref that a stalled read would hold.
    expect(code).toContain('checks.running(intent.seq)');
    expect(code).not.toContain('resolvingSeq');
    // A newer tap or a sign-out (no tap pending) ends it; so does an unmount.
    expect(code).toContain('const pendingSeq = intent?.seq ?? null;');
    expect(code).toContain('checks.keepOnly(pendingSeq);');
    expect(code).toContain('React.useEffect(() => () => checks.cancel(), [checks]);');
  });

  it('the notice shows a spinner while something is under way', () => {
    expect(codeOnly(notice)).toContain('{content.progress ? (');
    expect(codeOnly(notice)).toContain('<ActivityIndicator');
  });

  it('reads the live navigator route, not only the published one', () => {
    const code = codeOnly(host);
    expect(code).toContain('focusedStackRoute(navigation.getRootState())');
    expect(code).toContain('navigation.isReady()');
  });

  it("reads the workspace without loading it, and switches only through the drawer's own switch", () => {
    const code = codeOnly(host);
    expect(code).toContain('useWorkspaceSnapshot()');
    expect(code).not.toMatch(/\buseWorkspace\(\)/);
    expect(code).toContain('setActiveOrg(');
    expect(notice).toContain(
      "import { WORKSPACE_SWITCH_OFFLINE_COPY } from '@/components/workspace-switcher';",
    );
    expect(codeOnly(notice)).toContain('{WORKSPACE_SWITCH_OFFLINE_COPY}');
  });

  it('the notice is a modal sheet VoiceOver treats as one, and announces itself', () => {
    expect(notice).toContain('accessibilityViewIsModal');
    expect(notice).toContain('AccessibilityInfo.announceForAccessibility(');
    expect(notice).toContain('onAccessibilityEscape=');
  });
});

describe('8. the inbox opens a notification before its mark-read answers (brief §13)', () => {
  it('open() never awaits the update, and still sends it before navigating', () => {
    const inbox = codeOnly(read('app/(drawer)/notifications.tsx'));
    const start = inbox.indexOf('function open(notif: NotificationRow)');
    expect(start).toBeGreaterThan(-1);
    const body = inbox.slice(start, inbox.indexOf('return (', start));
    expect(inbox).not.toContain('async function open(');
    expect(body).not.toContain('await');
    // A supabase-js builder is lazy: `.then()` is what sends it.
    expect(flat(body)).toMatch(
      /supabase \.from\('notifications'\) \.update\(\{ read_at: readAt \}\) \.eq\('id', notif\.id\) \.then\(/,
    );
    expect(body.indexOf('.then(')).toBeLessThan(body.indexOf('router.push('));
  });
});
