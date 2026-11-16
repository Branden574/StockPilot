import { ShieldCheck } from 'lucide-react-native';
import * as React from 'react';
import { AccessibilityInfo, Linking, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandLockup } from '@/components/brand/mark';
import { useDeleteAccountConfirm } from '@/components/delete-account-confirm-sheet';
import { Button } from '@/components/ui/button';
import { Body, Display } from '@/components/ui/text';
import { WorkspaceSwitcherSheet } from '@/components/workspace-switcher';
import { useAuth } from '@/lib/auth-context';
import { totalPendingCount } from '@/lib/cycle-count-cache';
import {
  readSetUpInputsForHold,
  setUpHoldDetails,
  setUpHoldQueuedLine,
  subscribeSetUpHold,
} from '@/lib/set-up-hold';
import { useTheme } from '@/lib/use-theme';
import { useWorkspace } from '@/lib/use-workspace';
import { webLink } from '@/lib/web-links';

import {
  AUTHENTICATOR_SET_UP_HOLD_COPY,
  AUTHENTICATOR_SET_UP_OWED_COPY,
  AUTHENTICATOR_SET_UP_TITLE,
  AUTHENTICATOR_SET_UP_URL,
  authenticatorSetUpHoldBody,
  CONTEXT_UNAVAILABLE_COPY,
} from '@stockpilot/core';

/**
 * SET UP AN AUTHENTICATOR TO CONTINUE. Shown by RootGate in place of the
 * app while `useAuth().setUpHold` is not null (set-up-hold.ts):
 *
 *   'owed'    the workspace's policy, as read, asks this account for an
 *             authenticator: core's sentence naming the organization and who
 *             it asks, and a way to the website, where set-up happens (the
 *             phone does not enrol);
 *   'unknown' the check could not tell: core's could-not-check sentence,
 *             never the organization's.
 *
 * Every sentence is core's; the queued-work line is set-up-hold.ts's. The
 * actions: Set up on the website (owed only), Check again, Switch workspace
 * (with more than one), Sign out, Delete my account (the delete sheet,
 * delete-account-confirm-sheet.tsx: the account settings are not reachable
 * while the app is held).
 *
 * Queued work: nothing is dropped. The sync does not run while held; the
 * queue holds the rows of a workspace that owes set-up and sends them after
 * it; the line under the body says how many are waiting.
 *
 * Check again reads the set-up inputs at once (readSetUpInputsForHold). Its
 * answer goes to the same store the queue asks, so queued rows follow it; a
 * workspace that no longer holds the account lets the app in, and an
 * authenticator added on the website brings the code screen up first.
 *
 * Classic look only. VoiceOver: the title is a header and takes focus when
 * the screen replaces the app; every action is a named button of at least
 * 44pt (the shared 52pt Button); the result of Check again is said aloud;
 * the content scrolls, so the largest text fits a 320pt phone.
 */
export function AuthenticatorSetUpScreen({ state }: { state: 'owed' | 'unknown' }) {
  const { session, signOut } = useAuth();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { orgs } = useWorkspace();
  const deleteAccount = useDeleteAccountConfirm({ signOut });
  const userId = session?.user?.id ?? null;

  // The body follows the store (a name or policy read again re-renders it).
  const body = React.useSyncExternalStore(subscribeSetUpHold, () =>
    holdBody(state, setUpHoldDetails(session?.user)),
  );

  const [checking, setChecking] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const [switching, setSwitching] = React.useState(false);
  const [waiting, setWaiting] = React.useState(0);

  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // How many changes on this phone have not been sent (the sync badge's tally).
  const countWaiting = React.useCallback(() => {
    void totalPendingCount().then(
      (n) => {
        if (mounted.current) setWaiting(n);
      },
      () => undefined,
    );
  }, []);
  React.useEffect(() => {
    countWaiting();
  }, [countWaiting]);

  // The title takes VoiceOver's focus when this screen replaces the app.
  const title = React.useRef<View>(null);
  React.useEffect(() => {
    const node = title.current;
    if (node) AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
  }, []);

  async function checkAgain() {
    if (checking) return;
    setChecking(true);
    try {
      await readSetUpInputsForHold(userId);
    } finally {
      if (mounted.current) setChecking(false);
    }
    // Still here: still held. Say what the check found. (Let in, this screen
    // is gone and the app or the code screen has taken its place.)
    if (!mounted.current) return;
    const found = setUpHoldDetails(session?.user);
    if (found.hold) AccessibilityInfo.announceForAccessibility(holdBody(found.hold, found));
    countWaiting();
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
  const busy = checking || signingOut;

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
          <Display size={28}>{AUTHENTICATOR_SET_UP_TITLE}</Display>
        </View>
        <Body muted style={styles.body}>
          {body}
        </Body>
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
          {orgs.length > 1 ? (
            <Button block wrap variant="outline" onPress={() => setSwitching(true)} disabled={busy}>
              {AUTHENTICATOR_SET_UP_HOLD_COPY.switchWorkspace}
            </Button>
          ) : null}
          <Button block wrap variant="ghost" onPress={() => void onSignOut()} disabled={busy}>
            {AUTHENTICATOR_SET_UP_HOLD_COPY.signOut}
          </Button>
          <Button block wrap variant="destructive" onPress={deleteAccount.open} disabled={busy}>
            {AUTHENTICATOR_SET_UP_HOLD_COPY.deleteAccount}
          </Button>
        </View>
      </ScrollView>

      {orgs.length > 1 ? (
        <WorkspaceSwitcherSheet visible={switching} onDismiss={() => setSwitching(false)} />
      ) : null}
      {deleteAccount.sheet}
    </View>
  );
}

/** The body for the state: core's organization sentence for a policy as read, else could-not-check. */
function holdBody(state: 'owed' | 'unknown', details: ReturnType<typeof setUpHoldDetails>): string {
  if (state === 'unknown') return CONTEXT_UNAVAILABLE_COPY;
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
  queued: {
    marginTop: 12,
  },
  actions: {
    marginTop: 24,
    gap: 8,
  },
});
