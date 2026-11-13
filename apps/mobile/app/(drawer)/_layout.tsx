import { Drawer } from 'expo-router/drawer';
import * as React from 'react';
import { StyleSheet } from 'react-native';

import { DrawerContent } from '@/components/drawer-content';
import { useTheme } from '@/lib/use-theme';

/**
 * Drawer wrapper around the bottom-tabs navigator. Holds the full web
 * navigation parity (Books, Bundles, Orders, Rentals, Categories,
 * Tags, Movements, Procedures, Purchase orders, Locations, Suppliers,
 * Reports, AI Assistant, Schedule, Notifications, Team, Settings, Admin)
 * — the bottom tabs are just the 5 most-used surfaces.
 *
 * The panel is the page colour with a hairline on its open edge, as the
 * reference sidebar (DESIGN-SPEC 5.1), so it keeps a visible edge over the
 * dimmed screen in dark mode too.
 *
 * The status bar is the drawer content's to hide (hidesStatusBar in
 * src/components/drawer-content.tsx: only while the drawer is open over the
 * Scan tab's dark camera bar in light mode). The navigator's
 * drawerHideStatusBarOnOpen is left off on purpose: it hides the bar as a
 * swipe starts and shows it again only when the drawer's state changes, so a
 * swipe that never opened the drawer would leave it hidden.
 *
 * Liquid Glass: the panel is the artifact's sidebar sheet, so the navigator's
 * own panel turns transparent and the drawer content draws the glass surface
 * itself (GlassView, BlurView or the opaque --chrome, by material), over the
 * glass scrim. Classic keeps every option below exactly as it was.
 */
export default function DrawerLayout() {
  const { c, mode, g, material } = useTheme();
  const glassOptions = React.useMemo(
    () =>
      g === null
        ? null
        : {
            drawerStyle: {
              backgroundColor: material === 'opaque' ? g.chrome : 'transparent',
              borderRightWidth: StyleSheet.hairlineWidth,
              borderRightColor: g.glassRing,
              width: 320,
            },
            overlayColor: g.scrim,
          },
    [g, material],
  );
  return (
    <Drawer
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: 'front',
        swipeEdgeWidth: 32,
        drawerStyle: {
          backgroundColor: c.paper,
          borderRightWidth: StyleSheet.hairlineWidth,
          borderRightColor: c.hair,
          width: 320,
        },
        sceneStyle: { backgroundColor: c.paper },
        overlayColor:
          mode === 'dark' ? 'rgba(0, 0, 0, 0.65)' : 'rgba(14, 15, 13, 0.4)',
        ...glassOptions,
      }}
    >
      <Drawer.Screen name="(tabs)" options={{ drawerLabel: 'Home' }} />
      <Drawer.Screen name="staging" options={{ drawerLabel: 'Staging' }} />
      <Drawer.Screen name="exceptions" options={{ drawerLabel: 'Exceptions' }} />
      <Drawer.Screen name="bundles" options={{ drawerLabel: 'Bundles' }} />
      <Drawer.Screen name="orders" options={{ drawerLabel: 'Orders' }} />
      <Drawer.Screen name="returns" options={{ drawerLabel: 'Returns' }} />
      <Drawer.Screen name="rentals" options={{ drawerLabel: 'Rentals' }} />
      <Drawer.Screen name="categories" options={{ drawerLabel: 'Categories' }} />
      <Drawer.Screen name="tags" options={{ drawerLabel: 'Tags' }} />
      <Drawer.Screen name="movements" options={{ drawerLabel: 'Movements' }} />
      <Drawer.Screen name="procedures" options={{ drawerLabel: 'Procedures' }} />
      <Drawer.Screen
        name="purchase-orders"
        options={{ drawerLabel: 'Purchase orders' }}
      />
      <Drawer.Screen name="po-imports" options={{ drawerLabel: 'PO imports' }} />
      <Drawer.Screen name="recurring-pos" options={{ drawerLabel: 'Recurring POs' }} />
      <Drawer.Screen name="customers" options={{ drawerLabel: 'Accounts' }} />
      <Drawer.Screen name="locations" options={{ drawerLabel: 'Locations' }} />
      <Drawer.Screen name="suppliers" options={{ drawerLabel: 'Suppliers' }} />
      <Drawer.Screen name="reports" options={{ drawerLabel: 'Reports' }} />
      <Drawer.Screen name="ai" options={{ drawerLabel: 'AI Assistant' }} />
      <Drawer.Screen name="schedule" options={{ drawerLabel: 'Schedule' }} />
      <Drawer.Screen
        name="notifications"
        options={{ drawerLabel: 'Notifications' }}
      />
      <Drawer.Screen name="team" options={{ drawerLabel: 'Team' }} />
      <Drawer.Screen name="maintenance" options={{ drawerLabel: 'Maintenance' }} />
      <Drawer.Screen name="support" options={{ drawerLabel: 'Support & feedback' }} />
      <Drawer.Screen name="settings" options={{ drawerLabel: 'Settings' }} />
      <Drawer.Screen
        name="settings/integrations"
        options={{ drawerLabel: 'Integrations', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="settings/customize-tabs"
        options={{ drawerLabel: 'Customize tab bar', drawerItemStyle: { display: 'none' } }}
      />
      {/* Settings > Appearance (Dark, Light, Liquid Glass, System). */}
      <Drawer.Screen
        name="settings/appearance"
        options={{ drawerLabel: 'Appearance', drawerItemStyle: { display: 'none' } }}
      />
      {/* Reached from Settings only — an unregistered route would otherwise be
          auto-added to the drawer under its raw file path. */}
      <Drawer.Screen
        name="settings/rejected-work"
        options={{ drawerLabel: 'Unsent work', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="settings/change-email"
        options={{ drawerLabel: 'Change email', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="admin/index"
        options={{ drawerLabel: 'Admin overview', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="admin/charters"
        options={{ drawerLabel: 'Charters', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="admin/warehouses"
        options={{ drawerLabel: 'Warehouses', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="admin/bins"
        options={{ drawerLabel: 'Bins', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="admin/users"
        options={{ drawerLabel: 'Users', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="admin/vendor-mappings"
        options={{ drawerLabel: 'Vendor mappings', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="admin/uom-conversions"
        options={{ drawerLabel: 'UoM conversions', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="admin/audit"
        options={{ drawerLabel: 'Audit log', drawerItemStyle: { display: 'none' } }}
      />
    </Drawer>
  );
}
