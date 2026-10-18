import { useDrawerStatus, type DrawerContentComponentProps } from 'expo-router/drawer';
import { useIsFocused, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LogOut } from 'lucide-react-native';
import * as React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  SafeAreaView,
  initialWindowMetrics,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { BrandLockup } from '@/components/brand/mark';
import { Avatar } from '@/components/ui/avatar';
import { Hair } from '@/components/ui/card';
import { BUTTON_RADIUS } from '@/components/ui/tones';
import { Body, Eyebrow, Mono } from '@/components/ui/text';
import {
  WorkspaceHeaderChip,
  WorkspaceSwitcherSheet,
} from '@/components/workspace-switcher';
import { useAuth } from '@/lib/auth-context';
import { drawerSectionsFor, type DrawerNavItem } from '@/lib/drawer-nav';
import { useEnabledModules } from '@/lib/enabled-modules';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useProfile } from '@/lib/use-profile';
import { usePermissionsRealtime } from '@/lib/use-permissions-realtime';
import { useRole } from '@/lib/use-role';
import { useWorkspace } from '@/lib/use-workspace';
import { FONT, TYPE_CEILING, capTo, type ThemeMode } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * A top inset deeper than a status bar alone makes (20pt on an iPhone with a
 * Home button, 24pt on an iPad) is a sensor housing, which keeps its inset
 * when the status bar hides. Read once, at launch, so hiding the bar can
 * never feed back into the answer.
 */
const SENSOR_HOUSING = Platform.OS === 'ios' && (initialWindowMetrics?.insets.top ?? 0) > 24;

/**
 * Whether the drawer hides the status bar: only while it is open over the
 * Scan tab in light mode, with nothing pushed over them (`onTop`: a screen
 * opened from a notification or a link while the drawer is open leaves the
 * drawer open underneath). Past the 320pt panel the battery sits on the Scan
 * tab's camera bar, which is dark in both modes, so the root's dark glyphs
 * read at about 1.08:1 there (the clock over the panel reads at 20:1). Only
 * on an iPhone with a sensor housing, where hiding moves nothing: on an
 * iPhone with a Home button or an iPad the top inset is the status bar's own,
 * so hiding it would drop the panel and the screen by 20-24pt on every open,
 * and those keep the status bar as before. It follows the drawer's state,
 * not the navigator's drawerHideStatusBarOnOpen, which hides the bar as a
 * swipe starts and shows it again only when the drawer's state changes, so a
 * swipe that never opened the drawer would leave it hidden on every screen.
 */
function hidesStatusBar(
  open: boolean,
  onTop: boolean,
  mode: ThemeMode,
  activeHref: string,
  sensorHousing: boolean,
): boolean {
  return open && onTop && mode === 'light' && activeHref === '/scan' && sensorHousing;
}

/**
 * Side drawer — full web nav parity (Overview, Items, Books, Categories,
 * Tags, Movements, Rentals, Bundles, Orders, Cycle counts, Procedures,
 * POs, Locations, Suppliers, Reports, AI, Schedule, Notifications, Team,
 * Settings, Scan). Surfaces also accessible via bottom tabs are tagged
 * "TAB" so the user knows which entries are shortcuts vs. drawer-only.
 *
 * Drawn as the reference sidebar (DESIGN-SPEC 5.1) on the per-mode palette:
 * section labels in the muted ink, rows in ink2 with ink3 icons, the page on
 * screen on the reference's selected-row fill in full ink and the heavier
 * weight (and announced as selected), every row a 44pt target. The entries,
 * their order, gates and words are the registry's, exactly as before.
 */
export function DrawerContent(props: DrawerContentComponentProps) {
  const { c, mode } = useTheme();
  const insets = useSafeAreaInsets();
  const drawerOpen = useDrawerStatus() === 'open';
  // The drawer's own screen (the root stack's drawer group) is on top.
  const onTop = useIsFocused();
  const { signOut, user } = useAuth();
  const profile = useProfile();
  const { role } = useRole();
  const { activeOrgId } = useWorkspace();
  const enabledModules = useEnabledModules();
  const permissions = useEffectivePermissions();
  // Live permission updates: when an admin grants/revokes this user's access,
  // re-fetch the effective set so the drawer's links update without a restart.
  usePermissionsRealtime({ organizationId: activeOrgId, userId: user?.id ?? null, role: role ?? null });
  const router = useRouter();
  const segments = useSegments();
  // Force-logout lives in RootGate now (app/_layout.tsx) so it is mounted on
  // every screen, not only behind the drawer.

  const activeHref = React.useMemo(() => {
    const path = '/' + segments.filter((s) => !s.startsWith('(')).join('/');
    return path === '/' || path === '/index' ? '/' : path;
  }, [segments]);

  // Drawer is derived from the shared @stockpilot/core registry:
  // resolveSurface filters the admin section out for non-admins (mirroring
  // web's navForRole()) and drops items for modules the org hasn't enabled.
  // While the role is still loading we treat the user as 'staff' — that
  // yields exactly the non-admin drawer the old code showed while isAdmin
  // was false, so there's no flicker for the admin section. enabledModules
  // defaults to DEFAULT_MODULE_IDS until a snapshot persists, so the
  // grandfathered all-modules-on org renders its full drawer offline too.
  const sections = React.useMemo(
    () => drawerSectionsFor(role ?? 'staff', enabledModules, permissions),
    [role, enabledModules, permissions],
  );

  const navigate = (item: DrawerNavItem) => {
    props.navigation.closeDrawer();
    if (item.href === '/') router.push('/');
    else router.push(item.href as never);
  };

  const [switcherOpen, setSwitcherOpen] = React.useState(false);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      {/* Mounted only while it applies: when the drawer closes it unmounts and
          the status bar of the root (or of the Scan tab) shows again. */}
      {hidesStatusBar(drawerOpen, onTop, mode, activeHref, SENSOR_HOUSING) ? (
        <StatusBar hidden animated hideTransitionAnimation="fade" style="dark" />
      ) : null}
      <SafeAreaView edges={['top']} style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <BrandLockup size={26} />
        <View style={{ marginTop: 12 }}>
          <WorkspaceHeaderChip onPress={() => setSwitcherOpen(true)} />
        </View>
      </SafeAreaView>
      <WorkspaceSwitcherSheet
        visible={switcherOpen}
        onDismiss={() => setSwitcherOpen(false)}
      />

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 16, paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
      >
        {sections.map((section, sIdx) => (
          <View key={section.label ?? `section-${sIdx}`} style={{ marginTop: sIdx === 0 ? 0 : 20 }}>
            {section.label ? (
              <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
                <Eyebrow accessibilityRole="header">{section.label}</Eyebrow>
              </View>
            ) : null}
            {section.items.map((item) => {
              const Icon = item.icon;
              const isActive =
                item.href === activeHref ||
                (item.href === '/' && (activeHref === '/' || activeHref.startsWith('/index'))) ||
                (item.href !== '/' && activeHref.startsWith(item.href));
              return (
                <Pressable
                  key={item.id}
                  onPress={() => navigate(item)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isActive }}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      // The reference's selected nav row: the hover fill,
                      // which paper2 is in both modes (a step below the page
                      // in light, a step above it in dark).
                      backgroundColor: isActive ? c.paper2 : 'transparent',
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <Icon size={18} color={isActive ? c.ink : c.ink3} strokeWidth={1.6} />
                  <Body
                    size={14}
                    color={isActive ? c.ink : c.ink2}
                    style={{
                      flex: 1,
                      fontFamily: isActive ? FONT.display : FONT.displayRegular,
                    }}
                  >
                    {item.label}
                  </Body>
                  {item.inTabs ? (
                    // Micro-marker, capped: the nav LABEL beside it keeps
                    // scaling freely (plan §3), so this fixed 3-letter string
                    // is the sibling that has to stop taking width from it.
                    <Mono
                      size={9}
                      tracking={0.16}
                      upper
                      color={c.ink3}
                      numberOfLines={1}
                      maxFontSizeMultiplier={capTo(9, TYPE_CEILING.chrome)}
                      style={{ flexShrink: 0 }}
                    >
                      TAB
                    </Mono>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>

      {/* Clear of the home indicator: the root is a plain View, so the
          footer takes the bottom inset itself (16pt where there is none). */}
      <View style={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 16) }}>
        <Hair />
        <View style={styles.profile}>
          <Avatar size={36} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
              {profile.fullName ?? profile.email ?? 'Account'}
            </Body>
            <Mono size={10.5} color={c.ink3} tracking={0.04} style={{ marginTop: 2 }}>
              {profile.email ?? ''}
            </Mono>
          </View>
        </View>
        <Pressable
          onPress={() => void signOut()}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.signout,
            {
              borderColor: c.hair2,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <LogOut size={16} color={c.critText} strokeWidth={1.5} />
          <Body size={14} color={c.critText} style={{ fontFamily: FONT.display, flexShrink: 1 }}>
            Sign out
          </Body>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  // minHeight, not a fixed height: a 44pt target that grows with the label.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 44,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 2,
  },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 14,
    paddingBottom: 10,
  },
  signout: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    // minHeight + padding, not a fixed frame: the label is uncapped (it is the
    // one destructive action here) so the button has to grow around it. 44pt
    // at the default size, the iOS minimum target.
    minHeight: 44,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: BUTTON_RADIUS.sm,
    borderWidth: 1,
    marginTop: 4,
  },
});
