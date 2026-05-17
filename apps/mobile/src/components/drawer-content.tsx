import {
  DrawerContentScrollView,
  type DrawerContentComponentProps,
} from '@react-navigation/drawer';
import { useRouter } from 'expo-router';
import * as React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { radius, space, theme } from '@/lib/theme';

interface NavItem {
  label: string;
  icon: string;
  href: string;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', icon: '⌂', href: '/' },
  { label: 'Inventory', icon: '▣', href: '/inventory' },
  { label: 'Receive', icon: '⇣', href: '/receive' },
  { label: 'Cycle counts', icon: '✓', href: '/cycle-counts' },
  { label: 'Scan', icon: '◫', href: '/scan' },
  { label: 'Bundles', icon: '◇', href: '/bundles' },
  { label: 'PO scan', icon: '⊟', href: '/scan-po' },
  { label: 'Settings', icon: '⚙', href: '/settings' },
];

/**
 * Custom content for the left drawer. Renders the nav list at the top
 * and an account section pinned to the bottom. Item taps close the
 * drawer and navigate via expo-router so tab routes deep-link
 * correctly and modal routes (bundles, scan-po) push onto the root
 * Stack above the drawer.
 *
 * Mobile doesn't track an active-warehouse or active-org yet (the
 * snapshot includes warehouses but there's no "current warehouse"
 * concept), so the account section only renders identity + sign out.
 * When those concepts land, this is the place to surface them.
 */
export function DrawerContent(props: DrawerContentComponentProps) {
  const router = useRouter();
  const { session, signOut } = useAuth();

  const user = session?.user ?? null;
  const fullName =
    (user?.user_metadata?.full_name as string | undefined) ?? null;
  const email = user?.email ?? '';
  const initials = computeInitials(fullName, email);

  const handleNav = React.useCallback(
    (href: string) => {
      props.navigation.closeDrawer();
      // Defer the route change one tick so the drawer-close animation
      // doesn't fight the route-render frame on lower-end devices.
      requestAnimationFrame(() => {
        router.push(href as Parameters<typeof router.push>[0]);
      });
    },
    [props.navigation, router],
  );

  const handleSignOut = React.useCallback(async () => {
    props.navigation.closeDrawer();
    try {
      await signOut();
    } catch (err) {
      console.warn('[drawer] sign-out failed', err);
    }
  }, [props.navigation, signOut]);

  return (
    <View style={styles.root}>
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>StockPilot</Text>
        </View>

        <View style={styles.navGroup}>
          {NAV_ITEMS.map((item) => (
            <NavRow
              key={item.href}
              label={item.label}
              icon={item.icon}
              onPress={() => handleNav(item.href)}
            />
          ))}
        </View>
      </DrawerContentScrollView>

      <View style={styles.footer}>
        <View style={styles.userRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View style={styles.userText}>
            {fullName ? (
              <Text style={styles.userName} numberOfLines={1}>
                {fullName}
              </Text>
            ) : null}
            <Text
              style={fullName ? styles.userEmail : styles.userName}
              numberOfLines={1}
            >
              {email || 'Not signed in'}
            </Text>
          </View>
        </View>

        <Pressable
          onPress={handleSignOut}
          style={({ pressed }) => [
            styles.signOutButton,
            pressed && styles.signOutButtonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface NavRowProps {
  label: string;
  icon: string;
  onPress: () => void;
}

function NavRow({ label, icon, onPress }: NavRowProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.navRow, pressed && styles.navRowPressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.navIcon}>{icon}</Text>
      <Text style={styles.navLabel}>{label}</Text>
    </Pressable>
  );
}

function computeInitials(fullName: string | null, email: string): string {
  const source = (fullName ?? email).trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bgElevated,
  },
  scrollContent: {
    paddingTop: space.xl,
    paddingBottom: space.lg,
  },
  headerRow: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
  },
  headerTitle: {
    color: theme.text,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  navGroup: {
    paddingHorizontal: space.sm,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    borderRadius: radius.md,
  },
  navRowPressed: {
    backgroundColor: theme.card,
  },
  navIcon: {
    color: theme.textMuted,
    fontSize: 18,
    width: 22,
    textAlign: 'center',
  },
  navLabel: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '500',
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    padding: space.lg,
    gap: space.md,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  userText: {
    flex: 1,
    minWidth: 0,
  },
  userName: {
    color: theme.text,
    fontSize: 14,
    fontWeight: '600',
  },
  userEmail: {
    color: theme.textMuted,
    fontSize: 12,
    marginTop: 1,
  },
  signOutButton: {
    paddingVertical: 10,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignItems: 'center',
  },
  signOutButtonPressed: {
    backgroundColor: theme.card,
  },
  signOutText: {
    color: theme.text,
    fontSize: 14,
    fontWeight: '600',
  },
});
