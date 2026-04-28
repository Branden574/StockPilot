import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { radius, space, theme } from '@/lib/theme';

export default function Settings() {
  const { user, signOut } = useAuth();

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
