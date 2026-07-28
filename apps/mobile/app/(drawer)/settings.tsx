import Constants from 'expo-constants';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import {
  ArrowLeft,
  Bell,
  ChevronLeft,
  FileText,
  Fingerprint,
  HelpCircle,
  LayoutGrid,
  Lock,
  LogOut,
  Menu,
  Moon,
  Plug,
  RefreshCcw,
  Shield,
  Sparkles,
  Trash2,
  User,
  Warehouse,
  WifiOff,
  type LucideIcon,
} from 'lucide-react-native';
import * as React from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/ui/avatar';
import { Card, Hair } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Toggle } from '@/components/ui/toggle';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { getBiometricCapability, type BiometricCapability } from '@/lib/biometric';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { useEnabledModules } from '@/lib/enabled-modules';
import { useProfile } from '@/lib/use-profile';
import { useRole } from '@/lib/use-role';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Live version footer — was a hardcoded string that went stale (shipped
 * reading "v3.0.4 · build 2026.05.27" while the store build was 1.1.0).
 * `expoConfig.version` travels with the RUNNING bundle (embedded or OTA), and
 * `Updates.createdAt` is the publish time of the running OTA (null when on
 * the binary's embedded bundle). expo-application isn't in the binary, so the
 * native build number is intentionally not shown — never import it here via
 * OTA.
 */
const APP_VERSION = Constants.expoConfig?.version ?? '1.1.0';
const OTA_DATE = Updates.createdAt
  ? new Date(Updates.createdAt).toISOString().slice(0, 10)
  : null;
// Short unique id of the RUNNING OTA bundle — the date alone is ambiguous
// when several updates ship the same day; this is the ground truth for
// "is the fix on this phone yet" checks (null = embedded store bundle).
const OTA_ID = Updates.updateId ? Updates.updateId.slice(0, 8) : null;

/**
 * Settings — moved from a bottom tab into the drawer per design. Organised
 * by section (Account / Security / App / About) with mono eyebrows above
 * each card group. Sign-out is a destructive inline button at the bottom,
 * NOT a full-width red CTA.
 */
export default function Settings() {
  const { signOut, biometricEnabled, enableBiometric, disableBiometric } = useAuth();
  const profile = useProfile();
  const { c } = useTheme();
  const router = useRouter();
  const { isAdmin } = useRole();
  const enabledModules = useEnabledModules();
  const showIntegrations = enabledModules.has('integrations') && isAdmin;
  const navigation = useNavigation();
  const { fontScale } = useWindowDimensions();
  // The identity Card is a fixed three-up row — Avatar, name/email column,
  // OWNER Pill — and the name is the only shrinkable part, so past the shared
  // threshold it starves and iOS breaks the glyph run ("StockPil / ot").
  // Stacking hands the name the card's full interior; same threshold as
  // SettingRow below and every other stacking decision in this pass.
  const identityStacked = shouldStackRow(fontScale);
  const { return: returnPath } = useLocalSearchParams<{ return?: string }>();
  const [cap, setCap] = React.useState<BiometricCapability | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const probed = await getBiometricCapability();
      if (!cancelled) setCap(probed);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleBiometric(next: boolean) {
    if (pending) return;

    // Surface the underlying capability state up front — silently
    // ignoring "no hardware" / "not enrolled" is what burned the user
    // last session ("setting won't enable").
    if (next) {
      if (!cap?.hasHardware) {
        Alert.alert(
          'Biometric not available',
          'This device doesn’t report biometric hardware. Touch ID / Face ID / Fingerprint can’t be enabled here.',
        );
        return;
      }
      if (!cap.isEnrolled) {
        Alert.alert(
          `Set up ${cap.label} first`,
          `${cap.label} isn’t enrolled on this device. Open Settings · ${cap.label} on your device, enroll, then come back here to enable it for StockPilot.`,
        );
        return;
      }
    }

    setPending(true);
    if (next) {
      const ok = await enableBiometric();
      if (!ok) {
        Alert.alert(
          `${cap?.label ?? 'Biometric'} not enabled`,
          'The biometric prompt was cancelled or failed. Try again any time.',
        );
      }
    } else {
      await disableBiometric();
    }
    setPending(false);
  }

  const biometricSupported = !!cap?.hasHardware && !!cap?.isEnrolled;
  const biometricLabel = cap?.label ?? 'Face ID';
  const fullName = profile.fullName ?? profile.email ?? 'Account';

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => {
              if (typeof returnPath === 'string' && returnPath.length > 0) {
                router.replace(returnPath as never);
              } else if (router.canGoBack()) {
                router.back();
              } else {
                router.replace('/');
              }
            }}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <IconChip
              icon={Menu}
              onPress={() => (navigation as { openDrawer?: () => void }).openDrawer?.()}
            />
            <IconChip
              icon={HelpCircle}
              onPress={() =>
                Linking.openURL(
                  'mailto:hello@stockpilot.app?subject=StockPilot%20mobile%20support',
                ).catch(() => undefined)
              }
            />
          </View>
        </View>
        <View style={styles.head}>
          <Eyebrow>SETTINGS</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Account<Em>.</Em>
          </Display>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
      >
        <Card
          padding={16}
          style={identityStacked ? [styles.identity, styles.identityStacked] : styles.identity}
        >
          <Avatar size={52} />
          <View style={identityStacked ? styles.identityColStacked : styles.identityCol}>
            <Body size={16} style={{ fontFamily: FONT.display }}>
              {fullName}
            </Body>
            <Mono size={11.5} tracking={0.04} color={c.ink4} style={{ marginTop: 3 }}>
              {profile.email ?? ''}
            </Mono>
          </View>
          {/* Below the threshold the badge sits beside the name and needs
              flexShrink, or it claims its full intrinsic width and starves the
              identity column. Past it the badge owns its own line, where
              shrinking it would only wrap a label that already fits. */}
          {identityStacked ? (
            <Pill status="ok">OWNER</Pill>
          ) : (
            <Pill status="ok" style={{ flexShrink: 1 }}>OWNER</Pill>
          )}
        </Card>

        <Section label="ACCOUNT">
          <SettingRow
            icon={Warehouse}
            title="Workspaces"
            detail="View sites"
            chevron
            onPress={() => router.push('/locations?return=/settings')}
          />
          <Hair inset={70} />
          <SettingRow
            icon={User}
            title="Profile"
            chevron
            onPress={() =>
              Linking.openURL('https://stockpilotusa.com/dashboard/settings/profile').catch(
                () => undefined,
              )
            }
          />
          <Hair inset={70} />
          <SettingRow
            icon={Bell}
            title="Notifications"
            detail="Push, email"
            chevron
            onPress={() => router.push('/notifications?return=/settings')}
          />
          <Hair inset={70} />
          <SettingRow
            icon={Bell}
            title="Send test push"
            detail="To this device"
            chevron
            onPress={async () => {
              try {
                const { api } = await import('@/lib/api');
                const res = await api<{ delivered: number }>(
                  '/api/v1/push/test',
                  { method: 'POST', body: {} },
                );
                Alert.alert(
                  res.delivered > 0 ? 'Sent' : 'No registered devices',
                  res.delivered > 0
                    ? `Push sent to ${res.delivered} ${
                        res.delivered === 1 ? 'device' : 'devices'
                      }. Check your lock screen.`
                    : 'No push tokens are registered for this account yet. Open the app on a real iPhone (sim doesn’t register tokens), grant the notifications permission when prompted, then try again.',
                );
              } catch (e) {
                Alert.alert('Test push failed', e instanceof Error ? e.message : String(e));
              }
            }}
          />
        </Section>

        {showIntegrations ? (
          <Section label="INTEGRATIONS">
            <SettingRow
              icon={Plug}
              title="Integrations"
              detail="QuickBooks"
              chevron
              onPress={() => router.push('/settings/integrations' as never)}
            />
          </Section>
        ) : null}

        <Section label="SECURITY">
          <Pressable
            onPress={biometricSupported ? undefined : () => toggleBiometric(true)}
            style={({ pressed }) => ({ opacity: pressed && !biometricSupported ? 0.7 : 1 })}
          >
            <SettingRow
              icon={Fingerprint}
              title={`${biometricLabel} unlock`}
              detail={
                biometricSupported
                  ? undefined
                  : cap && !cap.hasHardware
                    ? 'No hardware'
                    : 'Tap to enrol'
              }
              trailing={
                <Toggle
                  value={biometricEnabled && biometricSupported}
                  onValueChange={toggleBiometric}
                />
              }
            />
          </Pressable>
          <Hair inset={70} />
          <SettingRow
            icon={Lock}
            title="Change password"
            chevron
            onPress={() =>
              Linking.openURL('https://stockpilotusa.com/dashboard/settings/security').catch(
                () => undefined,
              )
            }
          />
          <Hair inset={70} />
          <SettingRow
            icon={Shield}
            title="Two-factor"
            detail="Authenticator"
            chevron
            onPress={() =>
              Linking.openURL('https://stockpilotusa.com/dashboard/settings/security').catch(
                () => undefined,
              )
            }
          />
        </Section>

        <Section label="APP">
          <SettingRow
            icon={LayoutGrid}
            title="Customize tab bar"
            detail="Home + up to 5"
            chevron
            onPress={() => router.push('/settings/customize-tabs' as never)}
          />
          <Hair inset={70} />
          <SettingRow
            icon={Moon}
            title="Theme"
            detail="Auto"
            chevron
            onPress={() =>
              Alert.alert(
                'Theme',
                'Mobile follows your device appearance (Light or Dark) automatically.',
              )
            }
          />
          <Hair inset={70} />
          <SettingRow
            icon={RefreshCcw}
            title="Sync"
            detail="Wi-Fi + cellular"
            chevron
            onPress={() =>
              Alert.alert(
                'Sync',
                'Cycle counts and stock movements sync automatically every 60 seconds while the app is open. Cellular sync can be toggled in iOS Settings → StockPilot.',
              )
            }
          />
          <Hair inset={70} />
          <SettingRow
            icon={WifiOff}
            title="Offline cache"
            detail="Tap to clear"
            chevron
            onPress={() =>
              Alert.alert(
                'Clear offline cache?',
                'Cycle counts and items cached locally will be re-pulled from the server on next sync.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Clear',
                    style: 'destructive',
                    onPress: () =>
                      Alert.alert('Cleared', 'Local cache reset. Pull-to-refresh on any list to repopulate.'),
                  },
                ],
              )
            }
          />
        </Section>

        <Section label="DANGER ZONE">
          <SettingRow
            icon={Trash2}
            title="Delete my account"
            detail="Permanent"
            chevron
            onPress={() => confirmDeleteAccount(signOut)}
          />
        </Section>

        <Section label="ABOUT">
          <SettingRow
            icon={HelpCircle}
            title="Help & contact"
            chevron
            onPress={() =>
              Linking.openURL('mailto:hello@stockpilot.app?subject=StockPilot%20mobile%20support').catch(
                () => undefined,
              )
            }
          />
          <Hair inset={70} />
          <SettingRow
            icon={Shield}
            title="Privacy Policy"
            chevron
            onPress={() =>
              Linking.openURL('https://stockpilotusa.com/privacy').catch(() => undefined)
            }
          />
          <Hair inset={70} />
          <SettingRow
            icon={FileText}
            title="Terms of Service"
            chevron
            onPress={() =>
              Linking.openURL('https://stockpilotusa.com/terms').catch(() => undefined)
            }
          />
          <Hair inset={70} />
          <SettingRow
            icon={Sparkles}
            title="What's new"
            detail={`v${APP_VERSION}`}
            chevron
            onPress={() =>
              Alert.alert(
                'What’s new',
                `v${APP_VERSION} — Document scanner for PO attachments, customizable bottom tab bar (Settings → Customize tabs), transfer and receiving history now show real quantities and PO numbers, plus speed improvements.`,
              )
            }
          />
        </Section>

        <View style={styles.signoutBar}>
          <Pressable
            onPress={signOut}
            hitSlop={10}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingVertical: 10,
              flexShrink: 1,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <LogOut size={16} color={ACCENT.crit} strokeWidth={1.5} />
            <Body
              size={14.5}
              color={ACCENT.crit}
              style={{ fontFamily: FONT.display, flexShrink: 1 }}
            >
              Sign out
            </Body>
          </Pressable>
          <Mono size={10} tracking={0.1} color={c.ink4} style={{ flexShrink: 1, minWidth: 0 }}>
            {OTA_DATE ? `v${APP_VERSION} · ${OTA_DATE}${OTA_ID ? ` · #${OTA_ID}` : ''}` : `v${APP_VERSION}`}
          </Mono>
        </View>
      </ScrollView>
    </View>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 24 }}>
      <View style={{ paddingHorizontal: 4, paddingBottom: 10 }}>
        <Eyebrow>{label}</Eyebrow>
      </View>
      <Card padding={0}>{children}</Card>
    </View>
  );
}

function SettingRow({
  icon: Icon,
  title,
  detail,
  trailing,
  chevron = false,
  onPress,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  trailing?: React.ReactNode;
  chevron?: boolean;
  onPress?: () => void;
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  // Title and detail are both content and neither can be clamped, but they
  // share one row with a fixed icon well, a Toggle and a chevron. Past the
  // shared threshold the detail moves under the title and takes the full
  // column instead of splitting it. Below it, nothing moves.
  const stacked = shouldStackRow(fontScale);
  const detailNode = detail ? (
    <Body
      size={13.5}
      color={c.ink4}
      style={
        stacked
          ? { marginTop: 3 }
          : { flexShrink: 1, textAlign: 'right', marginRight: chevron ? 6 : 0 }
      }
    >
      {detail}
    </Body>
  ) : null;
  const inner = (
    <View style={rowStyles.row}>
      <View style={[rowStyles.iconWell, { borderColor: c.hair }]}>
        <Icon size={16} color={c.ink} strokeWidth={1.5} />
      </View>
      <View style={rowStyles.labelCol}>
        <Body size={15.5} style={{ fontFamily: FONT.display }}>
          {title}
        </Body>
        {stacked ? detailNode : null}
      </View>
      {stacked ? null : detailNode}
      {trailing}
      {chevron ? (
        <ChevronLeft
          size={14}
          color={c.ink4}
          strokeWidth={1.5}
          style={{ transform: [{ rotate: '180deg' }] }}
        />
      ) : null}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: c.hair }}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {inner}
    </Pressable>
  );
}

/**
 * Two-step destructive confirm for the App Store-required in-app
 * account deletion. Apple requires that the user can fully delete
 * their account from inside the app — not via a website link.
 *
 * Step 1: warn what will happen, offer Cancel.
 * Step 2: type-DELETE prompt — calls /api/v1/account/delete which
 *         tombstones the profile + invalidates the auth user.
 * On success, the auth context is torn down via signOut so the app
 * lands back at the sign-in screen.
 */
function confirmDeleteAccount(signOut: () => Promise<void> | void): void {
  Alert.alert(
    'Delete your account?',
    'This permanently removes your profile, biometric pairing, push tokens, and access to all StockPilot organizations you belong to. Inventory data owned by your organization is retained for org members.\n\nIf you are the sole owner of an organization with other members, transfer ownership first.\n\nThis cannot be undone.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Continue',
        style: 'destructive',
        onPress: () => promptDeleteConfirmation(signOut),
      },
    ],
  );
}

async function performDelete(signOut: () => Promise<void> | void) {
  try {
    const { api } = await import('@/lib/api');
    await api<{ ok: true }>('/api/v1/account/delete', {
      method: 'POST',
      body: { confirm: 'DELETE' },
    });
    await signOut();
    Alert.alert('Account deleted', 'Your account has been removed. Thanks for trying StockPilot.');
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    Alert.alert('Could not delete account', msg);
  }
}

function promptDeleteConfirmation(signOut: () => Promise<void> | void): void {
  // Alert.prompt is iOS-only — RN's Android impl is a no-op. On
  // Android we substitute a second yes/no confirm with the same
  // safety phrasing (App Store cares about iOS; Android Play Store
  // requires deletion but doesn't mandate the type-to-confirm UX).
  if (Platform.OS === 'ios') {
    Alert.prompt(
      'Type DELETE to confirm',
      'This is your last chance to back out. Type DELETE (all caps) to permanently delete your account.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete forever',
          style: 'destructive',
          onPress: (input) => {
            if ((input ?? '').trim() !== 'DELETE') {
              Alert.alert('Not deleted', 'You did not type DELETE exactly. Your account is unchanged.');
              return;
            }
            void performDelete(signOut);
          },
        },
      ],
      'plain-text',
    );
  } else {
    Alert.alert(
      'Final confirmation',
      'Tap “Delete forever” to permanently remove your account. There is no undo.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete forever',
          style: 'destructive',
          onPress: () => void performDelete(signOut),
        },
      ],
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  head: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 14,
  },
  // Stacked, the Avatar, the name/email column and the OWNER badge each take a
  // line of their own, so the name is measured against the card's full
  // interior rather than what the badge leaves behind. `flex-start` keeps the
  // 52pt Avatar circular and the badge pill-width instead of stretching both.
  identityStacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  identityCol: { flex: 1, minWidth: 0 },
  // In a column parent `flex: 1` would divide HEIGHT; `stretch` gives the
  // width. Same correction as inventory.tsx's `nameColStacked`.
  identityColStacked: { alignSelf: 'stretch', minWidth: 0 },
  signoutBar: {
    marginTop: 22,
    paddingHorizontal: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    // Sign out and the version/OTA string cannot both fit one line once the
    // label grows; wrapping keeps Sign out on screen and tappable.
    flexWrap: 'wrap',
    gap: 8,
  },
});

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 52,
  },
  labelCol: { flex: 1, minWidth: 0 },
  iconWell: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});
