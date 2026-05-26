import * as React from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { getBiometricCapability, type BiometricCapability } from '@/lib/biometric';
import { radius, space, theme } from '@/lib/theme';

export default function Settings() {
  const { user, signOut, biometricEnabled, enableBiometric, disableBiometric } = useAuth();
  const [cap, setCap] = React.useState<BiometricCapability | null>(null);
  const [pending, setPending] = React.useState(false);

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

  async function toggleBiometric(next: boolean) {
    if (pending) return;
    setPending(true);
    if (next) {
      const ok = await enableBiometric();
      if (!ok) {
        Alert.alert(
          'Could not enable',
          cap?.hasHardware === false
            ? 'This device does not have biometric hardware.'
            : cap?.isEnrolled === false
            ? `Set up ${cap?.label ?? 'a biometric'} in your device settings, then try again.`
            : 'Biometric setup was cancelled.',
        );
      }
    } else {
      await disableBiometric();
    }
    setPending(false);
  }

  const biometricSupported = !!cap?.hasHardware && !!cap?.isEnrolled;
  const biometricLabel = cap?.label ?? 'Biometric';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>Account</Text>
        <Text style={styles.title}>Settings</Text>
      </View>

      <View style={styles.body}>
        <View style={styles.card}>
          <Text style={styles.label}>Signed in as</Text>
          <Text style={styles.value}>{user?.email}</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Sign in with {biometricLabel}</Text>
              <Text style={styles.rowHint}>
                {biometricSupported
                  ? `Skip the password on this device. Prompts ${biometricLabel} when you open StockPilot.`
                  : cap?.hasHardware === false
                  ? 'This device has no biometric hardware.'
                  : `Enrol ${biometricLabel} in your device settings to use this.`}
              </Text>
            </View>
            <Switch
              value={biometricEnabled}
              onValueChange={toggleBiometric}
              disabled={!biometricSupported || pending}
              trackColor={{ false: theme.bgElevated, true: theme.primary }}
              thumbColor="#fff"
              ios_backgroundColor={theme.bgElevated}
            />
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Version</Text>
          <Text style={styles.value}>0.1.0 — Phase 7 preview</Text>
        </View>

        <Text style={styles.help}>
          Push notifications, offline mode, and image capture ship in a follow-up. Use the web dashboard for invites,
          billing, purchase orders, and reports.
        </Text>

        <Pressable
          style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.85 }]}
          onPress={signOut}
        >
          <Text style={styles.signOutLabel}>Sign out</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  header: { padding: space.lg, paddingBottom: space.md },
  eyebrow: { color: theme.primary, fontSize: 12, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: theme.text, fontSize: 28, fontWeight: '700', marginTop: space.xs },
  body: { padding: space.lg, gap: space.md },
  card: {
    backgroundColor: theme.card,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowHint: { color: theme.textMuted, fontSize: 12, marginTop: 4, lineHeight: 16 },
  label: { color: theme.textMuted, fontSize: 11, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { color: theme.text, fontSize: 15, marginTop: 4 },
  help: { color: theme.textMuted, fontSize: 13, lineHeight: 18, marginTop: space.sm },
  signOut: {
    backgroundColor: theme.destructive,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: space.lg,
  },
  signOutLabel: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
