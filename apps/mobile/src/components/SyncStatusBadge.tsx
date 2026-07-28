import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { cycleCountSync, useSyncStatus } from '@/lib/cycle-count-sync';
import { TYPE_CEILING, capTo, radius, space, theme } from '@/lib/theme';

/**
 * Header pill that reflects the sync engine's state. Tap to force a
 * drain attempt — useful when the user wants to push their last edit
 * before walking away from a counter.
 *
 * State → UI:
 *   syncing                  spinner + "Syncing…"           (blue)
 *   offline                  gray dot + "Offline — N queued" (gray)
 *   failing                  red dot  + "Sync issue — retrying" (red)
 *   idle, pendingCount === 0 green dot + "All synced"        (green)
 *   idle, pendingCount > 0   amber dot + "N pending"         (amber)
 */
export function SyncStatusBadge() {
  const { status, pendingCount } = useSyncStatus();

  let label: string;
  let dotColor = theme.success;
  let kind: 'dot' | 'spinner' = 'dot';

  if (status === 'syncing') {
    label = 'Syncing…';
    dotColor = theme.primary;
    kind = 'spinner';
  } else if (status === 'offline') {
    label = pendingCount > 0 ? `Offline · ${pendingCount} queued` : 'Offline';
    dotColor = theme.textMuted;
  } else if (status === 'failing') {
    label = 'Sync issue · retrying';
    dotColor = theme.destructive;
  } else if (pendingCount === 0) {
    label = 'All synced';
    dotColor = theme.success;
  } else {
    label = `${pendingCount} pending`;
    dotColor = theme.warning;
  }

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
