import { Tabs } from 'expo-router';
import * as React from 'react';
import { Text, View } from 'react-native';

import { theme } from '@/lib/theme';

type IconName = 'home' | 'inventory' | 'scan' | 'settings';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.bgElevated,
          borderTopColor: theme.border,
          height: 64,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Home', tabBarIcon: ({ color }) => <Icon name="home" color={color} /> }}
      />
      <Tabs.Screen
        name="inventory"
        options={{ title: 'Inventory', tabBarIcon: ({ color }) => <Icon name="inventory" color={color} /> }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: 'Scan',
          tabBarIcon: ({ focused }) => <ScanIcon focused={focused} />,
          tabBarLabelStyle: { display: 'none' },
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarIcon: ({ color }) => <Icon name="settings" color={color} /> }}
      />
    </Tabs>
  );
}

function Icon({ name, color }: { name: IconName; color: string }) {
  // Lightweight glyphs without an extra icon dep.
  const map: Record<IconName, string> = {
    home: '⌂',
    inventory: '▣',
    scan: '◫',
    settings: '⚙',
  };
  return <Text style={{ fontSize: 22, color }}>{map[name]}</Text>;
}

function ScanIcon({ focused }: { focused: boolean }) {
  return (
    <View
      style={{
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: focused ? theme.primaryDark : theme.primary,
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: -10,
        shadowColor: theme.primary,
        shadowOpacity: 0.4,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
      }}
    >
      <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>⎕</Text>
    </View>
  );
}
