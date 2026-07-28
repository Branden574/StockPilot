import { useRouter } from 'expo-router';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Minus,
  Plus,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Hair } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Em, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { useEnabledModules } from '@/lib/enabled-modules';
import {
  allowedTabIds,
  chosenTabSlots,
  MAX_TAB_SLOTS,
  MIN_TAB_SLOTS,
  resolveTabConfig,
  TAB_CANDIDATES,
  tabCandidate,
  type TabSlotId,
} from '@/lib/tab-config';
import {
  resetTabSlots,
  saveTabSlots,
  useStoredTabSlots,
} from '@/lib/tab-config-store';
import { HOME_TAB_ICON, TAB_ICONS } from '@/lib/tab-icons';
import {
  PREVIEW_MIN_FONT_SCALE,
  previewLabelStyleForCount,
  type TabLabelMetrics,
} from '@/lib/tab-label';
import { FONT } from '@/lib/theme';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useRole } from '@/lib/use-role';
import { useTheme } from '@/lib/use-theme';

// Old-architecture Android needs the experimental switch for
// LayoutAnimation; on the new architecture (this app) it's a harmless no-op
// guarded call. Never let animation setup throw — this runs at module load.
try {
  if (
    Platform.OS === 'android' &&
    UIManager.setLayoutAnimationEnabledExperimental
  ) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
  }
} catch {
  // Animation is polish only.
}

/**
 * Settings → Customize tab bar. Purely opt-in: the working list is the user's
 * raw CHOSEN slots (a never-customized user sees today's default bar), every
 * edit persists immediately (secure-store via tab-config-store, fail-safe),
 * and "Reset to default" deletes the stored config so the user returns to the
 * true out-of-the-box bar — i.e. the default ids raw, tracking any future
 * default change, never a gating-filtered snapshot.
 *
 * The screen edits and persists CHOICES, not the gating-filtered resolution:
 * gating applies only at render/preview time (resolveTabConfig). A chosen tab
 * whose module/permission is transiently off shows greyed with an
 * "unavailable right now" note — still reorderable, still removable, still
 * persisted — so an unrelated edit can never permanently drop it and it
 * reappears in place the moment gating re-allows it.
 *
 * Layout: live preview of the REAL bar up top (Home pinned first, gating
 * applied), then the chosen slots with chevron reorder + remove, then the
 * remaining allowed candidates with add. Min 2 / max 5 chosen — controls
 * disable at the bounds with a hint line. Only candidates the drawer/module
 * gating allows can be ADDED, so customization can never widen access.
 */
export default function CustomizeTabsScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const { fontScale } = useWindowDimensions();
  // Reorder/remove chips move to their own line past the shared threshold.
  const stackControls = shouldStackRow(fontScale);

  // Same gating inputs the tab bar itself resolves with.
  const enabledModules = useEnabledModules();
  const { role } = useRole();
  const permissions = useEffectivePermissions();
  const stored = useStoredTabSlots(userId);

  const allowed = React.useMemo(
    () => allowedTabIds({ enabledModules, role: role ?? 'staff', permissions }),
    [enabledModules, role, permissions],
  );
  // The working list is the user's raw CHOICES (pre-gating) — this is what
  // edits persist, so a transiently-gated chosen tab survives unrelated
  // edits. Edits notify the store, the store notifies useStoredTabSlots here
  // and in the tab layout, so the preview and the real bar update together.
  const slots = React.useMemo(() => chosenTabSlots(stored), [stored]);
  // What the bar ACTUALLY renders right now (choices ∩ gating) — preview only.
  const previewSlots = React.useMemo(
    () => resolveTabConfig(stored, allowed),
    [stored, allowed],
  );
  const available = React.useMemo(
    () =>
      TAB_CANDIDATES.filter(
        (cand) => allowed.has(cand.id) && !slots.includes(cand.id),
      ),
    [allowed, slots],
  );
  // Same density tier the real bar will use for this config (Home + gated
  // chosen slots), scaled for the miniature preview.
  const previewMetrics = previewLabelStyleForCount(
    1 + previewSlots.length,
    Platform.OS === 'android' ? 'android' : 'ios',
  );

  // Reduce-motion: one-shot probe, same pattern as scanner-tip.tsx — skip
  // the reorder/add/remove layout animation entirely when enabled.
  const [reduceMotion, setReduceMotion] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (active) setReduceMotion(on);
    });
    return () => {
      active = false;
    };
  }, []);

  const animate = React.useCallback(() => {
    if (reduceMotion) return;
    try {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    } catch {
      // Animation is polish only — never let it break an edit.
    }
  }, [reduceMotion]);

  const commit = (next: TabSlotId[]) => {
    if (!userId) return;
    animate();
    void saveTabSlots(userId, next);
  };

  const atMin = slots.length <= MIN_TAB_SLOTS;
  const atMax = slots.length >= MAX_TAB_SLOTS;

  const move = (id: TabSlotId, delta: -1 | 1) => {
    const from = slots.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= slots.length) return;
    const next = [...slots];
    next[from] = next[to];
    next[to] = id;
    commit(next);
  };
  const remove = (id: TabSlotId) => {
    if (atMin) return;
    commit(slots.filter((s) => s !== id));
  };
  const add = (id: TabSlotId) => {
    if (atMax || slots.includes(id)) return;
    commit([...slots, id]);
  };
  const reset = () => {
    if (!userId) return;
    animate();
    void resetTabSlots(userId);
  };

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip
            icon={ArrowLeft}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/settings' as never);
            }}
          />
        </View>
        <View style={styles.head}>
          <Eyebrow>SETTINGS · TAB BAR</Eyebrow>
          <Display size={34} style={{ marginTop: 12 }}>
            Bottom <Em>tabs.</Em>
          </Display>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Live preview of the REAL bar — Home pinned, then the chosen slots
            in order with gating applied (a currently-unavailable choice is
            absent here but stays editable in the list below). Label sizing
            mirrors the real bar's density tiers (previewLabelStyleForCount). */}
        <Card padding={0} style={{ marginTop: 14 }}>
          <View style={styles.preview}>
            <PreviewTab
              icon={HOME_TAB_ICON}
              label="Home"
              metrics={previewMetrics}
              active
            />
            {previewSlots.map((id) => (
              <PreviewTab
                key={id}
                icon={TAB_ICONS[id]}
                label={tabCandidate(id).title}
                metrics={previewMetrics}
              />
            ))}
          </View>
        </Card>
        <View style={{ paddingHorizontal: 4, paddingTop: 10 }}>
          <Mono size={10} tracking={0.1} color={c.ink4}>
            HOME IS ALWAYS FIRST · {slots.length} OF {MAX_TAB_SLOTS} SLOTS USED
          </Mono>
        </View>

        <Section label="IN YOUR BAR">
          {slots.map((id, idx) => {
            const cand = tabCandidate(id);
            // Chosen but currently gated (module off / permission revoked):
            // greyed + annotated, NOT silently absent. It stays in the stored
            // choices — still movable and removable — and rejoins the bar the
            // moment gating re-allows it.
            const unavailable = !allowed.has(id);
            return (
              <React.Fragment key={id}>
                {idx > 0 ? <Hair inset={70} /> : null}
                <View style={[styles.row, stackControls && styles.rowStacked]}>
                  <View style={[styles.iconWell, { borderColor: c.hair }]}>
                    <SlotIcon id={id} color={unavailable ? c.ink4 : c.ink} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Body
                      size={15.5}
                      color={unavailable ? c.ink4 : undefined}
                      style={{ fontFamily: FONT.display }}
                    >
                      {cand.settingsLabel}
                    </Body>
                    {unavailable ? (
                      <Mono
                        size={10}
                        tracking={0.06}
                        color={c.ink4}
                        style={{ marginTop: 3 }}
                      >
                        UNAVAILABLE RIGHT NOW — HIDDEN FROM THE BAR
                      </Mono>
                    ) : null}
                  </View>
                  {/* Three 30pt chips plus the icon well leave the label ~200pt
                      of a 393pt screen. Past the shared threshold the chips
                      take their own line and the label takes the width. */}
                  <View style={[styles.controls, stackControls && styles.controlsStacked]}>
                    <ControlChip
                      icon={ChevronUp}
                      label={`Move ${cand.settingsLabel} up`}
                      disabled={idx === 0}
                      onPress={() => move(id, -1)}
                    />
                    <ControlChip
                      icon={ChevronDown}
                      label={`Move ${cand.settingsLabel} down`}
                      disabled={idx === slots.length - 1}
                      onPress={() => move(id, 1)}
                    />
                    <ControlChip
                      icon={Minus}
                      label={`Remove ${cand.settingsLabel} from the bar`}
                      disabled={atMin}
                      onPress={() => remove(id)}
                    />
                  </View>
                </View>
              </React.Fragment>
            );
          })}
        </Section>
        {atMin ? (
          <Hint text={`MINIMUM ${MIN_TAB_SLOTS} TABS — ADD ANOTHER BEFORE REMOVING ONE.`} />
        ) : null}

        <Section label="AVAILABLE">
          {available.length === 0 ? (
            <View style={styles.row}>
              <Body muted size={14}>
                Everything available to you is already in your bar.
              </Body>
            </View>
          ) : (
            available.map((cand, idx) => (
              <React.Fragment key={cand.id}>
                {idx > 0 ? <Hair inset={70} /> : null}
                <View style={styles.row}>
                  <View style={[styles.iconWell, { borderColor: c.hair }]}>
                    <SlotIcon id={cand.id} color={c.ink} />
                  </View>
                  <Body size={15.5} style={{ flex: 1, fontFamily: FONT.display }}>
                    {cand.settingsLabel}
                  </Body>
                  <ControlChip
                    icon={Plus}
                    label={`Add ${cand.settingsLabel} to the bar`}
                    disabled={atMax}
                    onPress={() => add(cand.id)}
                  />
                </View>
              </React.Fragment>
            ))
          )}
        </Section>
        {atMax && available.length > 0 ? (
          <Hint text={`MAXIMUM ${MAX_TAB_SLOTS} TABS — REMOVE ONE TO ADD ANOTHER.`} />
        ) : null}

        <Section label="RESET">
          <Pressable
            onPress={reset}
            android_ripple={{ color: c.hair }}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <View style={styles.row}>
              <View style={[styles.iconWell, { borderColor: c.hair }]}>
                <RotateCcw size={16} color={c.ink} strokeWidth={1.5} />
              </View>
              <View style={{ flex: 1 }}>
                <Body size={15.5} style={{ fontFamily: FONT.display }}>
                  Reset to default
                </Body>
                <Mono size={10.5} tracking={0.04} color={c.ink4} style={{ marginTop: 3 }}>
                  Home · Items · Books · POs · Scan
                </Mono>
              </View>
            </View>
          </Pressable>
        </Section>
      </ScrollView>
    </View>
  );
}

function SlotIcon({ id, color }: { id: TabSlotId; color: string }) {
  const Icon = TAB_ICONS[id];
  return <Icon size={16} color={color} strokeWidth={1.5} />;
}

function PreviewTab({
  icon: Icon,
  label,
  metrics,
  active = false,
}: {
  icon: LucideIcon;
  label: string;
  metrics: TabLabelMetrics;
  active?: boolean;
}) {
  const { c } = useTheme();
  const tint = active ? c.ink : c.ink4;
  // Raw Text, not <Mono>: the bar's letterSpacing is ABSOLUTE pt while
  // Mono's `tracking` prop is an em ratio — feeding 0.6 into Mono produced
  // 9 × 0.6 = 5.4pt of tracking, the "O r d e r s" bug this replaces. One
  // line always; adjustsFontSizeToFit only as a last resort (the preview's
  // slots are a touch narrower than the real bar's inside the Card).
  return (
    <View style={styles.previewTab}>
      <Icon size={20} color={tint} strokeWidth={active ? 1.7 : 1.4} />
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={PREVIEW_MIN_FONT_SCALE}
        allowFontScaling={false}
        style={[styles.previewLabel, { color: tint }, metrics]}
      >
        {label}
      </Text>
    </View>
  );
}

/** 30pt bordered icon button for reorder/add/remove — disabled at bounds. */
function ControlChip({
  icon: Icon,
  label,
  disabled,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.control,
        { borderColor: c.hair },
        disabled && { opacity: 0.3 },
        pressed && !disabled && { opacity: 0.6 },
      ]}
    >
      <Icon size={15} color={c.ink} strokeWidth={1.6} />
    </Pressable>
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

function Hint({ text }: { text: string }) {
  const { c } = useTheme();
  return (
    <View style={{ paddingHorizontal: 4, paddingTop: 8 }}>
      <Mono size={10} tracking={0.1} color={c.ink4}>
        {text}
      </Mono>
    </View>
  );
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
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  previewTab: {
    flex: 1,
    alignItems: 'center',
  },
  previewLabel: {
    fontFamily: Platform.OS === 'android' ? FONT.display : FONT.mono,
    textAlign: 'center',
    alignSelf: 'stretch',
    marginTop: 5,
    paddingHorizontal: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 52,
  },
  rowStacked: { flexWrap: 'wrap' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  controlsStacked: { width: '100%', justifyContent: 'flex-end' },
  iconWell: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginRight: 6,
  },
  control: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
