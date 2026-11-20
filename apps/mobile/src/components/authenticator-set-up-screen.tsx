import { ShieldCheck } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  AppState,
  type AppStateStatus,
  Linking,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandLockup } from '@/components/brand/mark';
import { useDeleteAccountConfirm } from '@/components/delete-account-confirm-sheet';
import { Button } from '@/components/ui/button';
import { Body, Display } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { pendingCountInWorkspace } from '@/lib/cycle-count-cache';
import { cycleCountSync } from '@/lib/cycle-count-sync';
import {
  readSetUpInputsForHold,
  setUpCheckAnswered,
  setUpHoldDetails,
  setUpHoldQueuedLine,
  setUpHoldWorkspaces,
  subscribeSetUpHold,
} from '@/lib/set-up-hold';
import { useTheme } from '@/lib/use-theme';
import { setActiveOrg } from '@/lib/use-workspace';
import { webLink } from '@/lib/web-links';

import {
  AUTHENTICATOR_CHECK_RESULT_COPY,
  AUTHENTICATOR_CHECK_UNAVAILABLE_COPY,
  AUTHENTICATOR_SET_UP_HOLD_COPY,
  AUTHENTICATOR_SET_UP_OWED_COPY,
  AUTHENTICATOR_SET_UP_TITLE,
  AUTHENTICATOR_SET_UP_URL,
  authenticatorSetUpHoldBody,
} from '@stockpilot/core';

/**
 * Shown by RootGate in place of the app while `useAuth().setUpHold` is not
 * null (set-up-hold.ts). One heading and one body per state:
 *
 *   'owed'    "Set up an authenticator to continue", with core's sentence
 *             naming the organization and who it asks, and a way to the
 *             website, where set-up happens (the phone does not enrol);
 *   'unknown' "Your access could not be checked": a check answered and could
 *             not be judged. Its body claims nothing about the member and
 *             never names the organization.
 *
 * Every sentence is core's; the queued-work line is set-up-hold.ts's. The
 * actions: Set up on the website (owed only), Check again, Switch workspace
 * (when another organization is kept for the account), Sign out, Delete my
 * account (the delete sheet, delete-account-confirm-sheet.tsx: the account
 * settings are not reachable while the app is held).
 *
 * Organizations only. The switch list is the organizations kept for the
 * account (setUpHoldWorkspaces), and a tap calls the workspace switch
 * (use-workspace.ts setActiveOrg). No workspace load runs for this screen,
 * and no warehouse is read for a workspace that holds the account.
 *
 * Queued work: nothing is dropped. No snapshot pull runs while held (sync.ts).
 * Rows of the held workspace wait (could-not-check tries them, and a row
 * refused for want of an authenticator stays on the phone); rows of another
 * workspace are sent as usual. The line under the body counts the held workspace's rows of this
 * account, read again on each return to the foreground and after each pass
 * of the count engine.
 *
 * Check again reads the set-up inputs at once (readSetUpInputsForHold). Its
 * answer goes to the same store the queue asks, so queued rows follow it; a
 * workspace whose policy does not hold the account lets the app in, and an
 * authenticator added on the website brings the code screen up first. Still
 * held, a line under the body says what happened (an answer came, or none
 * came), and VoiceOver says it too. Sign out stays usable while a check
 * runs.
 *
 * Classic look only. VoiceOver: the state's heading is a header and takes
 * focus when the screen replaces the app and when the state changes; every
 * action is a named button of at least 44pt (the shared 52pt Button); the
 * content scrolls, so the largest text fits a 320pt phone.
 */
export function AuthenticatorSetUpScreen({ state }: { state: 'owed' | 'unknown' }) {
  const { session, signOut } = useAuth();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const deleteAccount = useDeleteAccountConfirm({ signOut });
  const userId = session?.user?.id ?? null;

  // The body follows the store (a name or policy read again re-renders it).
  const body = React.useSyncExternalStore(subscribeSetUpHold, () =>
    holdBody(state, setUpHoldDetails(session?.user)),
  );
  const heldOrgId = React.useSyncExternalStore(
    subscribeSetUpHold,
    () => setUpHoldDetails(session?.user).orgId,
  );
  const workspaces = React.useSyncExternalStore(subscribeSetUpHold, () =>
    setUpHoldWorkspaces(session?.user),
  );
  const others = workspaces.filter((w) => w.orgId !== heldOrgId);

  const [checking, setChecking] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);
  const [listOpen, setListOpen] = React.useState(false);
  const [switchingTo, setSwitchingTo] = React.useState<string | null>(null);
  const [waiting, setWaiting] = React.useState(0);

  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // How many of this account's changes for the held workspace have not been
  // sent: at mount and after each pass of the count engine (its subscribe
  // answers at once), and on each return to the foreground.
  const countWaiting = React.useCallback(() => {
    if (!heldOrgId) {
      setWaiting(0);
      return;
    }
    void pendingCountInWorkspace(heldOrgId).then(
      (n) => {
        if (mounted.current) setWaiting(n);
      },
      () => undefined,
    );
  }, [heldOrgId]);
  React.useEffect(() => {
    const stopEngine = cycleCountSync.subscribe(() => countWaiting());
    const appSub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') countWaiting();
    });
    return () => {
      stopEngine();
      appSub.remove();
    };
  }, [countWaiting]);

  // The state's heading takes VoiceOver's focus when this screen replaces the
  // app, and again when the state changes.
  const title = React.useRef<View>(null);
  React.useEffect(() => {
    const node = title.current;
    if (node) AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
  }, [state]);

  async function checkAgain() {
    if (checking) return;
    setChecking(true);
    setResult(null);
    try {
      await readSetUpInputsForHold(userId);
    } finally {
      if (mounted.current) setChecking(false);
    }
    // Still here: still held. Say what the check found. (Let in, this screen
    // is gone and the app or the code screen has taken its place.)
    if (!mounted.current) return;
    const found = setUpHoldDetails(session?.user);
    if (!found.hold) return;
    const answered = setUpCheckAnswered(session?.user);
    const line = answered
      ? AUTHENTICATOR_CHECK_RESULT_COPY.checked
      : AUTHENTICATOR_CHECK_RESULT_COPY.noAnswer;
    setResult(line);
    // With no answer nothing was confirmed: only the line is said.
    AccessibilityInfo.announceForAccessibility(
      answered ? `${line} ${holdBody(found.hold, found)}` : line,
    );
    countWaiting();
  }

  async function switchTo(orgId: string) {
    if (switchingTo) return;
    setSwitchingTo(orgId);
    try {
      await setActiveOrg(orgId);
    } catch {
      // A switch that could not be saved leaves the workspace as it was.
    } finally {
      if (mounted.current) {
        setSwitchingTo(null);
        setListOpen(false);
      }
    }
  }

  async function onSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  }

  function openWebsite() {
    Linking.openURL(webLink(AUTHENTICATOR_SET_UP_URL)).catch(() => undefined);
  }

  const queued = setUpHoldQueuedLine(state, waiting);
  const busy = checking || signingOut || switchingTo !== null;

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <View
        style={{
          paddingTop: Math.max(insets.top, 24) + 16,
          paddingHorizontal: 24,
          paddingBottom: 12,
        }}
      >
        <BrandLockup size={26} />
      </View>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.iconRing, { borderColor: c.hair2 }]}>
          <ShieldCheck size={30} color={c.ink} strokeWidth={1.5} />
        </View>

        <View ref={title} accessible accessibilityRole="header">
          <Display size={28}>{holdTitle(state)}</Display>
        </View>
        <Body muted style={styles.body}>
          {body}
        </Body>
        {result ? (
          <Body size={13} style={styles.result} accessibilityLiveRegion="polite">
            {result}
          </Body>
        ) : null}
        {queued ? (
          <Body size={13} muted style={styles.queued}>
            {queued}
          </Body>
        ) : null}

        <View style={styles.actions}>
          {state === 'owed' ? (
            <Button
              block
              wrap
              onPress={openWebsite}
              accessibilityHint={AUTHENTICATOR_SET_UP_HOLD_COPY.setUpOnWebsiteHint}
            >
              {AUTHENTICATOR_SET_UP_HOLD_COPY.setUpOnWebsite}
            </Button>
          ) : null}
          <Button
            block
            wrap
            variant={state === 'owed' ? 'outline' : 'primary'}
            onPress={() => void checkAgain()}
            disabled={busy}
          >
            {AUTHENTICATOR_SET_UP_HOLD_COPY.checkAgain}
          </Button>
          {others.length > 0 ? (
            <Button
              block
              wrap
              variant="outline"
              onPress={() => setListOpen((open) => !open)}
              disabled={busy}
            >
              {AUTHENTICATOR_SET_UP_HOLD_COPY.switchWorkspace}
            </Button>
          ) : null}
          {others.length > 0 && listOpen ? (
            <View style={styles.orgList}>
              {others.map((w) => (
                <Button
                  key={w.orgId}
                  block
                  wrap
                  variant="ghost"
                  onPress={() => void switchTo(w.orgId)}
                  disabled={busy}
                >
                  {w.name ?? AUTHENTICATOR_SET_UP_HOLD_COPY.unnamedWorkspace}
                </Button>
              ))}
            </View>
          ) : null}
          <Button block wrap variant="ghost" onPress={() => void onSignOut()} disabled={signingOut}>
            {AUTHENTICATOR_SET_UP_HOLD_COPY.signOut}
          </Button>
          <Button block wrap variant="destructive" onPress={deleteAccount.open} disabled={busy}>
            {AUTHENTICATOR_SET_UP_HOLD_COPY.deleteAccount}
          </Button>
        </View>
      </ScrollView>

      {deleteAccount.sheet}
    </View>
  );
}

/** The state's own heading: set-up owed, or the check that could not be judged. */
function holdTitle(state: 'owed' | 'unknown'): string {
  return state === 'unknown'
    ? AUTHENTICATOR_CHECK_UNAVAILABLE_COPY.title
    : AUTHENTICATOR_SET_UP_TITLE;
}

/** The state's own body: core's organization sentence for a policy as read, else could-not-check. */
function holdBody(state: 'owed' | 'unknown', details: ReturnType<typeof setUpHoldDetails>): string {
  if (state === 'unknown') return AUTHENTICATOR_CHECK_UNAVAILABLE_COPY.body;
  return details.policy
    ? authenticatorSetUpHoldBody(details.name, details.policy)
    : AUTHENTICATOR_SET_UP_OWED_COPY;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 24,
  },
  iconRing: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 1.4,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  body: {
    marginTop: 10,
  },
  result: {
    marginTop: 12,
  },
  queued: {
    marginTop: 12,
  },
  orgList: {
    gap: 4,
  },
  actions: {
    marginTop: 24,
    gap: 8,
  },
});
