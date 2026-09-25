import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { cycleCountSync, useSyncStatus } from '@/lib/cycle-count-sync';
import { syncBadgeState, type SyncBadgeTone } from '@/lib/sync-badge';
import { TYPE_CEILING, capTo, radius, space, theme } from '@/lib/theme';

/**
 * Header pill that reflects the sync engine's state. Tap to force a
 * drain attempt — useful when the user wants to push their last edit
 * before walking away from a counter.
 *
 * What it says is decided in src/lib/sync-badge.ts (the full table is
 * there). Two cases this pill got wrong before:
 *
 *   • A terminal REJECTION leaves `pendingCount` at zero, and the badge
 *     answered "All synced" over the top of writes that never landed. It now
 *     says how many were not sent; Settings → Unsent work lists them.
 *   • A stock adjustment sent from the outbox whose answer never came back is
 *     parked as rejected too, but it MAY have been applied. The badge called
 *     it "not sent", which reads as "enter it again". It now says "not
 *     confirmed".
 */
const TONE_COLOR: Record<SyncBadgeTone, string> = {
  primary: theme.primary,
  muted: theme.textMuted,
  destructive: theme.destructive,
  success: theme.success,
  warning: theme.warning,
};

export function SyncStatusBadge() {
  const { status, pendingCount, rejectedCount, unconfirmedCount } = useSyncStatus();
  const { label, tone, spinner } = syncBadgeState({
    status,
    pendingCount,
    rejectedCount,
    unconfirmedCount,
  });
  const dotColor = TONE_COLOR[tone];
  const kind: 'dot' | 'spinner' = spinner ? 'spinner' : 'dot';

  return (
    <Pressable
      onPress={() => {
        void cycleCountSync.forceSync();
      }}
      style={({ pressed }) => [styles.pill, pressed && { opacity: 0.65 }]}
      accessibilityLabel={`Sync status: ${label}. Tap to retry.`}
    >
      {kind === 'spinner' ? (
        <ActivityIndicator size="small" color={dotColor} />
      ) : (
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
      )}
      {/* Chrome cap + a bounded pill: this badge shares a `space-between` row
          with the Release / Reassign buttons in the cycle-count header, where
          nothing else can shrink, so an uncapped "Offline · 12 queued" pushes
          them off-screen. */}
      <Text style={styles.label} numberOfLines={1} maxFontSizeMultiplier={LABEL_CAP}>
        {label}
      </Text>
    </Pressable>
  );
}

/** 11pt badge label against the chrome ceiling. */
const LABEL_CAP = capTo(11, TYPE_CEILING.chrome);

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radius.lg,
    backgroundColor: theme.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignSelf: 'flex-start',
    marginRight: space.xs,
    maxWidth: '60%',
    flexShrink: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    color: theme.text,
    fontSize: 11,
    fontWeight: '600',
    flexShrink: 1,
  },
});
