import { Drawer } from 'expo-router/drawer';
import * as React from 'react';

import { DrawerContent } from '@/components/drawer-content';
import { theme } from '@/lib/theme';

/**
 * Drawer wrapper around the bottom-tabs navigator. The drawer's
 * edge-swipe opens the sidebar on root tab screens; modal screens
 * (item/[id], scan-po, cycle-count/scan, bundles) live above this
 * drawer in the root Stack at app/_layout.tsx so their back-swipe
 * still works.
 *
 * The whole drawer is rendered by a single screen entry — the (tabs)
 * group — because the drawer is purely a navigation surface and the
 * tabs are the real content. Drawer items inside DrawerContent push
 * routes inside (tabs); they don't add new top-level screens here.
 */
export default function DrawerLayout() {
  return (
    <Drawer
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: 'front',
        // Slightly wider edge zone than the default ~20px so the
        // gesture is easier to land with a thumb on a phone. iOS
        // doesn't have an interactive-back gesture on root screens,
        // so a wider zone doesn't conflict.
        swipeEdgeWidth: 32,
        drawerStyle: {
          backgroundColor: theme.bgElevated,
          width: 296,
        },
        sceneStyle: { backgroundColor: theme.bg },
        overlayColor: 'rgba(0, 0, 0, 0.5)',
      }}
    >
      <Drawer.Screen name="(tabs)" options={{ drawerLabel: 'Home' }} />
    </Drawer>
  );
}
