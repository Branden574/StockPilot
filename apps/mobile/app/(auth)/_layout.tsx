import { Stack } from 'expo-router';
import * as React from 'react';

import { useTheme } from '@/lib/use-theme';

export default function AuthLayout() {
  const { c } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: c.paper },
      }}
    />
  );
}
