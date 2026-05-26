import * as React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { getBiometricCapability, type BiometricCapability } from '@/lib/biometric';
import { radius, space, theme } from '@/lib/theme';

/**
 * One-shot opt-in sheet shown right after a successful interactive
 * sign-in IF the device is biometric-capable AND the user hasn't
 * already made a choice for this account. Two buttons: Enable / Not now.
 *
 * "Not now" simply closes the sheet — the user can flip the toggle in
 * Settings later. We don't store a "user declined" flag; the absence
 * of the opt-in flag is the off state. If the user signs out and back
 * in we will offer the sheet again on next interactive sign-in.
 */
export function BiometricOptInSheet({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const { enableBiometric } = useAuth();
  const [cap, setCap] = React.useState<BiometricCapability | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      const c = await getBiometricCapability();
      if (!cancelled) setCap(c);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  // If the device isn't capable, we shouldn't have been opened in the
  // first place — auto-dismiss as a safety net.
  React.useEffect(() => {
    if (!visible || !cap) return;
    if (!cap.hasHardware || !cap.isEnrolled) onDismiss();
  }, [cap, onDismiss, visible]);

  if (!cap) return null;

  async function handleEnable() {
    if (busy) return;
    setBusy(true);
    await enableBiometric();
    setBusy(false);
    onDismiss();
  }

  const label = cap.label;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <View style={styles.scrim}>
        <View style={styles.sheet}>
          <View style={styles.iconWell}>
            <Text style={styles.iconGlyph}>{label === 'Face ID' ? '⌒' : '◉'}</Text>
          </View>
          <Text style={styles.title}>Use {label} next time?</Text>
          <Text style={styles.body}>
            Skip the password on this device. We&apos;ll prompt you with{' '}
            {label} when you open StockPilot. You can turn this off in Settings
            anytime.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]}
            onPress={handleEnable}
            disabled={busy}
          >
            <Text style={styles.primaryLabel}>Enable {label}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.85 }]}
            onPress={onDismiss}
          >
            <Text style={styles.secondaryLabel}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  sheet: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radius.xl,
    padding: space.xl,
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
  },
  iconWell: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.bgElevated,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.md,
  },
  iconGlyph: { color: theme.primary, fontSize: 28 },
  title: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: space.sm,
    marginBottom: space.lg,
  },
  primary: {
    backgroundColor: theme.primary,
    borderRadius: radius.md,
    paddingVertical: 13,
    paddingHorizontal: 24,
    alignItems: 'center',
    width: '100%',
  },
  primaryLabel: { color: '#fff', fontWeight: '600', fontSize: 15 },
  secondary: {
    marginTop: space.sm,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryLabel: { color: theme.textMuted, fontSize: 13, fontWeight: '500' },
});
