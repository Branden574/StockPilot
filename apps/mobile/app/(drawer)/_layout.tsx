import { Drawer } from 'expo-router/drawer';
import * as React from 'react';

import { DrawerContent } from '@/components/drawer-content';
import { palette } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Drawer wrapper around the bottom-tabs navigator. Holds the full web
 * navigation parity (Books, Bundles, Orders, Rentals, Categories,
 * Tags, Movements, Procedures, Purchase orders, Locations, Suppliers,
 * Reports, AI Assistant, Schedule, Notifications, Team, Settings, Admin)
 * — the bottom tabs are just the 5 most-used surfaces.
 */
export default function DrawerLayout() {
  const { c, mode } = useTheme();
  return (
    <Drawer
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: 'front',
        swipeEdgeWidth: 32,
        drawerStyle: {
          backgroundColor: c.paper,
          width: 320,
        },
        sceneStyle: { backgroundColor: c.paper },
        overlayColor:
          mode === 'dark' ? 'rgba(0, 0, 0, 0.65)' : 'rgba(14, 15, 13, 0.4)',
      }}
    >
      <Drawer.Screen name="(tabs)" options={{ drawerLabel: 'Home' }} />
      <Drawer.Screen name="books" options={{ drawerLabel: 'Books' }} />
      <Drawer.Screen name="bundles" options={{ drawerLabel: 'Bundles' }} />
      <Drawer.Screen name="orders" options={{ drawerLabel: 'Orders' }} />
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
      <Drawer.Screen name="settings" options={{ drawerLabel: 'Settings' }} />
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
        name="admin/reconciliation"
        options={{ drawerLabel: 'Reconciliation', drawerItemStyle: { display: 'none' } }}
      />
      <Drawer.Screen
        name="admin/audit"
        options={{ drawerLabel: 'Audit log', drawerItemStyle: { display: 'none' } }}
      />
    </Drawer>
  );
}
