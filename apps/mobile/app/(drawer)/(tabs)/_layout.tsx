import { BlurView } from 'expo-blur';
import { Tabs, useRouter, useSegments } from 'expo-router';
import { type LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { useEnabledModules } from '@/lib/enabled-modules';
import {
  activeTabShouldRedirect,
  allowedTabIds,
  chosenTabSlots,
  resolveTabConfig,
  TAB_SLOT_IDS,
  tabCandidate,
  type TabSlotId,
} from '@/lib/tab-config';
import { useStoredTabSlots } from '@/lib/tab-config-store';
import { HOME_TAB_ICON, TAB_ICONS } from '@/lib/tab-icons';
import { FONT } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useRole } from '@/lib/use-role';
import { useTheme } from '@/lib/use-theme';

/**
 * Customizable bottom bar — Home pinned first, then 2–5 user-chosen tabs
 * (Settings → Customize tab bar). The DEFAULT config renders EXACTLY the bar
 * this layout always had: Home, Items, Books, POs, Scan, with Books/POs
 * module-gated the same way (`href: null` when the org lacks the module) and
 * cycle-counts hidden-but-routable. Users who never customize see a
 * pixel-identical bar.
 *
 * expo-router mechanics (typedRoutes): every candidate's Tabs.Screen is
 * declared statically on every render — chosen tabs first in config order,
 * then every remaining candidate with `href: null` (hidden from the bar but
 * still mounted and deep-linkable, the long-standing cycle-counts mechanism;
 * hidden-tab links like the drawer's /cycle-counts keep working unchanged).
 *
 * Gating = user config ∩ allowed. The five legacy tabs keep the exact
 * module-only gates this file always applied; tabs that are NEW to the bar
 * (Counts, Orders, Movements, Reports) reuse the drawer's resolver (module +
 * role + effective permission — the same hooks drawer-content passes in), so
 * customization never widens access. If gating turns off the module/permission
 * behind the ACTIVE tab and that tab is one the user CHOSE, the user is sent
 * Home rather than stranded — but only once role + permissions have loaded
 * (see activeTabShouldRedirect). Either way the screen stays mounted via
 * href:null, so there is no crash.
 *
 * The bar uses a translucent BlurView on iOS for the brand's editorial
 * "paper through glass" feel.
 */
export default function TabsLayout() {
  const { c, mode } = useTheme();
  // Same sources drawer-content gates with: enabledModules defaults to
  // DEFAULT_MODULE_IDS until a snapshot persists (no flicker for the
  // grandfathered all-modules org), role falls back to 'staff' while loading,
  // permissions fall back to the static role map when undefined.
  const enabledModules = useEnabledModules();
  const { role, loading: roleLoading } = useRole();
  const permissions = useEffectivePermissions();
  const { user } = useAuth();
  const storedSlots = useStoredTabSlots(user?.id ?? null);

  const allowed = React.useMemo(
    () => allowedTabIds({ enabledModules, role: role ?? 'staff', permissions }),
    [enabledModules, role, permissions],
  );
  const chosen = React.useMemo(() => chosenTabSlots(storedSlots), [storedSlots]);
  const visibleSlots = React.useMemo(
    () => resolveTabConfig(storedSlots, allowed),
    [storedSlots, allowed],
  );
  const hiddenSlots = React.useMemo(
    () => TAB_SLOT_IDS.filter((id) => !visibleSlots.includes(id)),
    [visibleSlots],
  );

  // Active-tab gating guard: if the focused tab is one the user CHOSE and its
  // module/permission gate turns off (org disables a module, admin revokes a
  // permission), land on Home instead of stranding the user on a screen that
  // will 403. Decision logic lives in activeTabShouldRedirect (pure, tested):
  //   • waits for BOTH gate inputs to finish loading — role (the transient
  //     'staff' fallback must not yank an admin off their tab at cold start)
  //     AND effective permissions (undefined = still reading; resolveSurface's
  //     static-role-map fallback could transiently disallow an override-granted
  //     tab). enabledModules needs no wait: its loading default is the
  //     PERMISSIVE superset, which can only over-allow, never falsely gate.
  //   • UNCHOSEN tabs never redirect — a deep link to a hidden (href: null)
  //     tab renders exactly like cycle-counts always has, gated or not.
  const segments = useSegments();
  const router = useRouter();
  const gatesLoaded = !roleLoading && permissions !== undefined;
  React.useEffect(() => {
    if (!segments.some((s) => s === '(tabs)')) return;
    const leaf = segments[segments.length - 1];
    if (activeTabShouldRedirect(leaf, chosen, allowed, gatesLoaded)) {
      router.replace('/');
    }
  }, [segments, chosen, allowed, gatesLoaded, router]);

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
      {/* Home is pinned: always first, never a configurable slot. */}
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, focused }) => (
            <TabIcon icon={HOME_TAB_ICON} color={color} focused={focused} />
          ),
        }}
      />
      {visibleSlots.map((id) => (
        <Tabs.Screen key={id} name={id} options={slotOptions(id)} />
      ))}
      {/* Everything not in the bar stays mounted + deep-linkable (href: null),
          e.g. the drawer's Cycle counts link renders inside the tabs
          navigator so the bottom bar persists on that screen. */}
      {hiddenSlots.map((id) => (
        <Tabs.Screen key={id} name={id} options={{ href: null }} />
      ))}
    </Tabs>
  );
}

function slotOptions(id: TabSlotId): {
  title: string;
  tabBarIcon: (props: { color: string; focused: boolean }) => React.ReactNode;
} {
  return {
    title: tabCandidate(id).title,
    tabBarIcon: ({ color, focused }) => (
      <TabIcon icon={TAB_ICONS[id]} color={color} focused={focused} />
    ),
  };
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
