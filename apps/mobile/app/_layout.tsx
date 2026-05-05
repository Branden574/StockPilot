import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';

import { AuthProvider, useAuth } from '@/lib/auth-context';
import { usePushNotifications } from '@/lib/use-push-notifications';

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <RootGate />
    </AuthProvider>
  );
}

function RootGate() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Register an Expo push token + persist to push_tokens whenever the
  // signed-in user changes. No-op for nullable session.
  usePushNotifications(session?.user ?? null);

  React.useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === '(auth)';
    if (!session && !inAuthGroup) {
      router.replace('/(auth)/sign-in');
    } else if (session && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [session, loading, segments, router]);

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0a0f1f' } }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="item/[id]" options={{ presentation: 'card' }} />
      <Stack.Screen name="scan-po/index" options={{ presentation: 'card' }} />
    </Stack>
  );
}
