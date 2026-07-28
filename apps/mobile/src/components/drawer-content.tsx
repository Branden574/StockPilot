import { type DrawerContentComponentProps } from '@react-navigation/drawer';
import { useRouter, useSegments } from 'expo-router';
import { LogOut } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandLockup } from '@/components/brand/mark';
import { Avatar } from '@/components/ui/avatar';
import { Hair } from '@/components/ui/card';
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
import { useSessionRevocation } from '@/lib/use-session-revocation';
import { useRole } from '@/lib/use-role';
import { useWorkspace } from '@/lib/use-workspace';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Side drawer — full web nav parity (Overview, Items, Books, Categories,
 * Tags, Movements, Rentals, Bundles, Orders, Cycle counts, Procedures,
 * POs, Locations, Suppliers, Reports, AI, Schedule, Notifications, Team,
 * Settings, Scan). Surfaces also accessible via bottom tabs are tagged
 * "TAB" so the user knows which entries are shortcuts vs. drawer-only.
 */
export function DrawerContent(props: DrawerContentComponentProps) {
  const { c } = useTheme();
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
  // Force-logout: when this device's session is revoked from another device,
  // sign out and redirect to the sign-in screen.
  const handleForcedSignOut = React.useCallback(
    () => router.replace('/(auth)/sign-in'),
    [router],
  );
  useSessionRevocation(user?.id ?? null, handleForcedSignOut);

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
                <Eyebrow>{section.label}</Eyebrow>
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
                  style={({ pressed }) => [
                    styles.row,
                    {
                      backgroundColor: isActive ? c.card : 'transparent',
                      borderColor: isActive ? c.hair : 'transparent',
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <Icon
                    size={18}
                    color={isActive ? c.ink : c.ink3}
                    strokeWidth={isActive ? 1.6 : 1.4}
                  />
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
                      color={c.ink4}
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

      <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
        <Hair />
        <View style={styles.profile}>
          <Avatar size={36} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Body size={14} color={c.ink} style={{ fontFamily: FONT.display }}>
              {profile.fullName ?? profile.email ?? 'Account'}
            </Body>
            <Mono size={10.5} color={c.ink4} tracking={0.04} style={{ marginTop: 2 }}>
              {profile.email ?? ''}
            </Mono>
          </View>
        </View>
        <Pressable
          onPress={signOut}
          style={({ pressed }) => [
            styles.signout,
            {
              borderColor: c.hair,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <LogOut size={16} color={ACCENT.crit} strokeWidth={1.5} />
          <Body
            size={14}
            color={ACCENT.crit}
            style={{ fontFamily: FONT.display, flexShrink: 1 }}
          >
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
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
    // minHeight + padding, not a 40pt frame: the label is uncapped (it is the
    // one destructive action here) so the pill has to grow around it.
    minHeight: 40,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 4,
  },
});
