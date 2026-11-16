import { DELETE_ACCOUNT_CONFIRM_COPY as CORE_DELETE_CONFIRM_WORDS } from '@stockpilot/core';
import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Modal } from '@/components/ui/modal';
import { BUTTON_RADIUS, buttonTone } from '@/components/ui/tones';
import {
  appAccountDeleteDeps,
  createAccountDeleteFlow,
  hasVerifiedAuthenticator,
  type AccountDeleteFlow,
} from '@/lib/account-delete';
import { useAuth } from '@/lib/auth-context';
// The phone's warning text. Core's DELETE_ACCOUNT_CONFIRM_COPY (the field
// words) is imported above as CORE_DELETE_CONFIRM_WORDS, so the two names
// never meet in this file.
import { DELETE_ACCOUNT_CONFIRM_COPY } from '@/lib/deleted-user-labels';
import { FONT, RADIUS, SHADOW, space } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/** The iOS minimum tap target, in points. */
const MIN_TAP = 44;

/**
 * DELETE YOUR ACCOUNT, confirmed the way the website's dialog confirms it
 * (account-delete.ts has the rule and every answer).
 *
 *  - The warning, then the word typed: "Type DELETE to confirm".
 *  - An account with no authenticator also gives its password ("Your
 *    password", secure entry, the password manager's current password), or
 *    asks for a six-digit code by email ("Email me a code instead") and types
 *    it (number pad, the one-time-code autofill), with "Send a new code" and
 *    "Use my password instead".
 *  - An account with an authenticator confirms with the word alone; the
 *    session already entered its code.
 *
 * Every sentence is core's (or the phone's existing warning). Nothing typed
 * is shown back, logged or stored; Cancel, the backdrop and the escape scrub
 * forget it all, and are refused while a delete is under way, whose answer
 * decides. Once the account is gone the sign-out discards its queued work and
 * the sign-in screen replaces this sheet; "Account deleted" then says so.
 *
 * Classic look (no Liquid Glass variant). VoiceOver, as the app's other
 * sheets: the backdrop is a sibling behind the card, a button named Close;
 * the sheet is modal; each field is named; the answer line is an alert.
 *
 * Not wired into Settings here. Mount it with `visible` and `onClose`, inside
 * AuthProvider.
 */
export function DeleteAccountConfirmSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  // Set by the open content: Cancel, the backdrop, the escape scrub and the
  // system back all close through it, and it refuses while a delete is under
  // way.
  const closeRef = React.useRef<(() => void) | null>(null);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => (closeRef.current ?? onClose)()}
      statusBarTranslucent
    >
      {/* key: a new content, and so a new flow, per open: each open starts
          blank (reset by remount, as the app's other sheets). */}
      <SheetContent key={String(visible)} onClose={onClose} closeRef={closeRef} />
    </Modal>
  );
}

function SheetContent({
  onClose,
  closeRef,
}: {
  onClose: () => void;
  closeRef: React.MutableRefObject<(() => void) | null>;
}) {
  const { session, signOut } = useAuth();
  // What is asked first, read when the sheet opens; the server decides.
  const [flow] = React.useState<AccountDeleteFlow>(() =>
    createAccountDeleteFlow({
      hasAuthenticator: hasVerifiedAuthenticator(session?.user?.factors),
      deps: appAccountDeleteDeps({
        signOut,
        announceDeleted: (sentence) => Alert.alert('Account deleted', sentence),
      }),
    }),
  );
  // Closed or gone: forget what was typed (a delete under way keeps going).
  React.useEffect(() => () => void flow.cancel(), [flow]);

  const close = React.useCallback(() => {
    if (flow.cancel()) onClose();
  }, [flow, onClose]);
  React.useEffect(() => {
    closeRef.current = close;
    return () => {
      if (closeRef.current === close) closeRef.current = null;
    };
  }, [closeRef, close]);

  const { c, mode } = useTheme();
  const s = React.useSyncExternalStore(flow.subscribe, flow.getState);
  const passwordRef = React.useRef<TextInput>(null);
  const codeRef = React.useRef<TextInput>(null);

  // Once an answer is in, the field it is about takes the focus: the code
  // field after a code was sent or refused, the password field after a
  // password was refused or asked for.
  const wasBusy = React.useRef(false);
  React.useEffect(() => {
    if (s.busy !== null) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current || s.ended !== null) return;
    wasBusy.current = false;
    if (s.method === 'password') passwordRef.current?.focus();
    if (s.method === 'code') codeRef.current?.focus();
  }, [s.busy, s.method, s.ended]);

  const busy = s.busy !== null;
  const deleting = s.busy === 'delete';
  const cancelTone = buttonTone('outline', c);
  const deleteTone = buttonTone('primary', c);
  const linkTone = buttonTone('ghost', c);
  const field = [styles.input, { borderColor: c.hair2, backgroundColor: c.sunk, color: c.ink }];

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      {/* The backdrop is a SIBLING behind the card (sheet-backdrop-guard.test.ts). */}
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={close}
        style={{ flex: 1, justifyContent: 'flex-end' }}
      >
        <Pressable
          onPress={close}
          onAccessibilityTap={close}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(14,15,13,0.4)' },
          ]}
        />
        <View style={[styles.sheet, { backgroundColor: c.card }, SHADOW.sheet]}>
          <View style={styles.grabberRow}>
            <View style={[styles.grabber, { backgroundColor: c.hair2 }]} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Text accessibilityRole="header" style={[styles.title, { color: c.ink }]}>
              Delete your account?
            </Text>

            {s.ended === null ? (
              <>
                <Text style={[styles.body, { color: c.ink3 }]}>{DELETE_ACCOUNT_CONFIRM_COPY}</Text>

                <Text style={[styles.label, { color: c.ink }]}>Type DELETE to confirm</Text>
                <TextInput
                  value={s.typed}
                  onChangeText={flow.setTyped}
                  editable={!busy}
                  accessibilityLabel="Type DELETE to confirm"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoComplete="off"
                  spellCheck={false}
                  style={field}
                />

                {s.method === 'password' ? (
                  <>
                    <Text style={[styles.label, { color: c.ink }]}>
                      {CORE_DELETE_CONFIRM_WORDS.passwordLabel}
                    </Text>
                    <TextInput
                      ref={passwordRef}
                      value={s.password}
                      onChangeText={flow.setPassword}
                      editable={!busy}
                      accessibilityLabel={CORE_DELETE_CONFIRM_WORDS.passwordLabel}
                      accessibilityHint={CORE_DELETE_CONFIRM_WORDS.passwordHint}
                      secureTextEntry
                      textContentType="password"
                      autoComplete="current-password"
                      autoCapitalize="none"
                      autoCorrect={false}
                      spellCheck={false}
                      style={field}
                    />
                    <Text style={[styles.hint, { color: c.ink3 }]}>
                      {CORE_DELETE_CONFIRM_WORDS.passwordHint}
                    </Text>
                    <Pressable
                      onPress={() => void flow.sendCode()}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: busy, busy: s.busy === 'code' }}
                      style={({ pressed }) => [
                        styles.link,
                        { opacity: busy ? 0.5 : pressed ? 0.7 : 1 },
                      ]}
                    >
                      <Text style={[styles.linkLabel, { color: linkTone.fg }]}>
                        {CORE_DELETE_CONFIRM_WORDS.emailCode}
                      </Text>
                    </Pressable>
                  </>
                ) : null}

                {s.method === 'code' ? (
                  <>
                    <Text style={[styles.label, { color: c.ink }]}>
                      {CORE_DELETE_CONFIRM_WORDS.codeLabel}
                    </Text>
                    <TextInput
                      ref={codeRef}
                      value={s.code}
                      onChangeText={flow.setCode}
                      editable={!busy}
                      accessibilityLabel={CORE_DELETE_CONFIRM_WORDS.codeLabel}
                      accessibilityHint={CORE_DELETE_CONFIRM_WORDS.codeSent}
                      keyboardType="number-pad"
                      textContentType="oneTimeCode"
                      autoComplete="one-time-code"
                      maxLength={6}
                      style={[field, { fontFamily: FONT.mono, letterSpacing: 4 }]}
                    />
                    <Text style={[styles.hint, { color: c.ink3 }]}>
                      {CORE_DELETE_CONFIRM_WORDS.codeSent}
                    </Text>
                    <View style={styles.links}>
                      <Pressable
                        onPress={() => void flow.sendCode()}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: busy, busy: s.busy === 'code' }}
                        style={({ pressed }) => [
                          styles.link,
                          { opacity: busy ? 0.5 : pressed ? 0.7 : 1 },
                        ]}
                      >
                        <Text style={[styles.linkLabel, { color: linkTone.fg }]}>
                          {CORE_DELETE_CONFIRM_WORDS.sendAgain}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={flow.usePassword}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: busy }}
                        style={({ pressed }) => [
                          styles.link,
                          { opacity: busy ? 0.5 : pressed ? 0.7 : 1 },
                        ]}
                      >
                        <Text style={[styles.linkLabel, { color: linkTone.fg }]}>
                          {CORE_DELETE_CONFIRM_WORDS.usePassword}
                        </Text>
                      </Pressable>
                    </View>
                  </>
                ) : null}
              </>
            ) : null}

            {s.notice ? (
              <Text
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                style={[styles.notice, { color: s.ended === 'done' ? c.ink : c.critText }]}
              >
                {s.notice}
              </Text>
            ) : null}
          </ScrollView>

          {s.ended === null ? (
            <View style={styles.actions}>
              <Pressable
                onPress={close}
                disabled={deleting}
                accessibilityRole="button"
                accessibilityState={{ disabled: deleting }}
                style={({ pressed }) => [
                  styles.action,
                  {
                    backgroundColor: cancelTone.bg,
                    borderColor: cancelTone.border,
                    opacity: deleting ? 0.5 : pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Text style={[styles.actionLabel, { color: cancelTone.fg }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void flow.confirm()}
                disabled={!s.ready}
                accessibilityRole="button"
                accessibilityState={{ disabled: !s.ready, busy: deleting }}
                style={({ pressed }) => [
                  styles.action,
                  {
                    backgroundColor: deleteTone.bg,
                    borderColor: deleteTone.border,
                    opacity: !s.ready ? 0.5 : pressed ? 0.85 : 1,
                  },
                ]}
              >
                {deleting ? <ActivityIndicator color={deleteTone.fg} /> : null}
                <Text style={[styles.actionLabel, { color: deleteTone.fg }]}>Delete account</Text>
              </Pressable>
            </View>
          ) : s.ended !== 'done' ? (
            <View style={styles.actions}>
              <Pressable
                onPress={close}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.action,
                  {
                    backgroundColor: cancelTone.bg,
                    borderColor: cancelTone.border,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Text style={[styles.actionLabel, { color: cancelTone.fg }]}>Close</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    paddingBottom: 36,
    paddingHorizontal: 22,
    maxHeight: '92%',
  },
  grabberRow: { alignItems: 'center', marginBottom: 16 },
  grabber: { width: 36, height: 5, borderRadius: 100 },
  title: { fontFamily: FONT.displaySemi, fontWeight: '600', fontSize: 20 },
  body: { fontFamily: FONT.displayRegular, fontSize: 13, marginTop: 6, lineHeight: 18 },
  label: {
    fontFamily: FONT.displaySemi,
    fontWeight: '600',
    fontSize: 13,
    marginTop: 18,
    marginBottom: 8,
  },
  input: {
    minHeight: MIN_TAP,
    borderWidth: 1,
    borderRadius: RADIUS.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: FONT.displayRegular,
    fontSize: 16,
  },
  hint: { fontFamily: FONT.displayRegular, fontSize: 12, marginTop: 6, lineHeight: 16 },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.md },
  // Words-only buttons in a 44pt frame, so a larger text size grows them.
  link: { minHeight: MIN_TAP, justifyContent: 'center', alignSelf: 'flex-start' },
  linkLabel: {
    fontFamily: FONT.display,
    fontWeight: '500',
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  notice: { fontFamily: FONT.displayRegular, fontSize: 13, marginTop: 14, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: 18 },
  // The shared Button's md recipe (52pt, radius 14), drawn here so a long
  // label wraps inside its half of the row instead of being cut short.
  action: {
    flex: 1,
    minHeight: 52,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: BUTTON_RADIUS.md,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  actionLabel: {
    fontFamily: FONT.display,
    fontWeight: '500',
    fontSize: 15,
    textAlign: 'center',
    flexShrink: 1,
  },
});
