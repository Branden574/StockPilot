import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import {
  Box,
  ClipboardCheck,
  Layers,
  ScanLine,
  Truck,
  type LucideIcon,
} from 'lucide-react-native';
import * as React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Five-tab bottom bar — Home, Items, POs, Counts, Scan. Settings has
 * moved into the drawer to match the design (5 tabs is the iOS HIG /
 * Material 3 recommendation). The bar uses a translucent BlurView on
 * iOS for the brand's editorial "paper through glass" feel.
 */
export default function TabsLayout() {
  const { c, mode } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.bar,
        tabBarBackground: () =>
          Platform.OS === 'ios' ? (
            <BlurView
              tint={mode === 'dark' ? 'dark' : 'light'}
              intensity={70}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: c.paper },
              ]}
            />
          ),
        tabBarActiveTintColor: c.ink,
        tabBarInactiveTintColor: c.ink4,
        tabBarShowLabel: true,
        tabBarLabelStyle: {
          fontFamily: Platform.OS === 'android' ? FONT.display : FONT.mono,
          fontSize: Platform.OS === 'android' ? 11 : 10,
          letterSpacing: Platform.OS === 'android' ? -0.06 : 0.6,
        },
        tabBarItemStyle: {
          paddingTop: 6,
        },
        sceneStyle: { backgroundColor: c.paper },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, focused }) => <TabIcon icon={Box} color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="inventory"
        options={{
          title: 'Items',
          tabBarIcon: ({ color, focused }) => <TabIcon icon={Layers} color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="receive"
        options={{
          title: 'POs',
          tabBarIcon: ({ color, focused }) => <TabIcon icon={Truck} color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="cycle-counts"
        options={{
          title: 'Counts',
          tabBarIcon: ({ color, focused }) => <TabIcon icon={ClipboardCheck} color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: 'Scan',
          tabBarIcon: ({ color, focused }) => <TabIcon icon={ScanLine} color={color} focused={focused} />,
        }}
      />
      {/* Settings now lives in the drawer as a top-level route — see
          app/(drawer)/settings.tsx. The previous (tabs)/settings.tsx
          file was deleted to resolve the route collision that was
          rendering the legacy dark-navy Settings instead of the new
          warm-paper design. */}
    </Tabs>
  );
}

function TabIcon({
  icon: Icon,
  color,
  focused,
}: {
  icon: LucideIcon;
  color: string;
  focused: boolean;
}) {
  return (
    <Icon
      size={Platform.OS === 'android' ? 22 : 24}
      color={color}
      strokeWidth={focused ? 1.7 : 1.4}
    />
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    height: Platform.OS === 'ios' ? 84 : 72,
    paddingBottom: Platform.OS === 'ios' ? 24 : 14,
    position: 'absolute',
    backgroundColor: 'transparent',
    elevation: 0,
  },
});
