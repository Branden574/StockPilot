import * as React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { getBiometricCapability, type BiometricCapability } from '@/lib/biometric';
import { radius, space, theme } from '@/lib/theme';

/**
 * Full-screen lock that renders when a user with biometric enabled
 * opens the app and has a valid Supabase session on disk. Triggers
 * the OS biometric prompt automatically once on mount, plus a
 * "Try again" button if they cancel, plus a "Use password" escape
 * hatch that calls signOutToFallback() to drop them at the sign-in
 * screen on this device only (other devices stay signed in).
 *
 * Auto-prompt is fire-and-forget: if the user cancels the OS sheet
 * we don't loop. Re-prompt only happens when they tap "Try again",
 * matching the pattern banking apps use (1Password, Apple Pay, etc).
 */
export function BiometricLockScreen() {
  const { unlock, signOutToFallback, user } = useAuth();
  const [busy, setBusy] = React.useState(false);
  const [cap, setCap] = React.useState<BiometricCapability | null>(null);
  const [attempted, setAttempted] = React.useState(false);
  const [failedOnce, setFailedOnce] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const c = await getBiometricCapability();
      if (!cancelled) setCap(c);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tryUnlock = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setAttempted(true);
    const ok = await unlock();
    setBusy(false);
    if (!ok) setFailedOnce(true);
  }, [busy, unlock]);

  // Auto-prompt on first mount once we know the device is capable.
  // If the capability check says no hardware or no enrollment, we
  // never prompt — those cases drop straight to the "Use password"
  // path via the explicit button below.
  React.useEffect(() => {
    if (!cap) return;
    if (!cap.hasHardware || !cap.isEnrolled) return;
    if (attempted) return;
    void tryUnlock();
  }, [cap, attempted, tryUnlock]);

  const greeting = user?.email ? user.email : 'StockPilot';
  const label = cap?.label ?? 'Biometric';

  return (
    <View style={styles.root}>
      <View style={styles.center}>
        <Text style={styles.brand}>StockPilot</Text>
        <Text style={styles.greeting}>{greeting}</Text>

        <View style={styles.iconWell}>
          {busy ? (
            <ActivityIndicator color={theme.primary} size="large" />
          ) : (
            <Text style={styles.iconGlyph}>{label === 'Face ID' ? '⌒' : '◉'}</Text>
          )}
        </View>

        {!cap ? (
          <Text style={styles.hint}>Checking device…</Text>
        ) : !cap.hasHardware || !cap.isEnrolled ? (
          <Text style={styles.hint}>
            Biometric authentication isn&apos;t set up on this device. Sign in with
            your password to continue.
          </Text>
        ) : failedOnce ? (
          <Text style={styles.hint}>
            {label} couldn&apos;t verify you. Try again or sign in with your password.
          </Text>
        ) : (
          <Text style={styles.hint}>Use {label} to unlock</Text>
        )}

        {cap && cap.hasHardware && cap.isEnrolled && (
          <Pressable
            style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]}
            onPress={tryUnlock}
            disabled={busy}
          >
            <Text style={styles.primaryLabel}>Unlock with {label}</Text>
          </Pressable>
        )}

        <Pressable
          style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.85 }]}
          onPress={signOutToFallback}
        >
          <Text style={styles.secondaryLabel}>Use password instead</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  center: { width: '100%', maxWidth: 380, alignItems: 'center' },
  brand: {
    color: theme.primary,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  greeting: { color: theme.text, fontSize: 16, marginTop: space.sm, opacity: 0.9 },
  iconWell: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    marginTop: space.xl,
    marginBottom: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGlyph: { color: theme.primary, fontSize: 44 },
  hint: {
    color: theme.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: space.lg,
    paddingHorizontal: space.md,
  },
  primary: {
    backgroundColor: theme.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    width: '100%',
  },
  primaryLabel: { color: '#fff', fontWeight: '600', fontSize: 15 },
  secondary: {
    marginTop: space.md,
    paddingVertical: 10,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  secondaryLabel: { color: theme.textMuted, fontSize: 13, fontWeight: '500' },
});
