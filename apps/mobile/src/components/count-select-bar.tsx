import { useRouter } from 'expo-router';
import { ClipboardCheck } from 'lucide-react-native';
import * as React from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { GROUP_COPY } from '@stockpilot/core';

import { Mono } from '@/components/ui/text';
import { showWriteCtaForRole } from '@/lib/cta-gating';
import { groupSelectedHref, phoneGroupingCheck } from '@/lib/display-groups';
import { isOnline } from '@/lib/sync';
import { TYPE_CEILING, capTo } from '@/lib/theme';
import { countSelection, useCountPicks, useCountSelectionCount } from '@/lib/use-count-selection';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useRole } from '@/lib/use-role';
import { useTheme } from '@/lib/use-theme';

/**
 * Floating bar shown while a list tab is in cycle-count select mode.
 * Reads the shared count-selection store so it reflects picks made across
 * both the Items and Books tabs. "Review" opens the confirm screen.
 *
 * "Group" (Group selected, migration 0400) opens the grouping review for the
 * picks, offered to someone who can edit items (the permission alone decides,
 * as on the item screen; cosmetic, the route refuses on its own). It needs a
 * connection, two or more records, and one type: the bar says which is
 * missing instead of opening a review that could only refuse.
 */
export function CountSelectBar({
  visible,
  bottomInset,
}: {
  visible: boolean;
  bottomInset: number;
}) {
  const router = useRouter();
  const { c } = useTheme();
  const count = useCountSelectionCount();
  const picks = useCountPicks();
  const { role } = useRole();
  const permissions = useEffectivePermissions();
  const canGroup = showWriteCtaForRole(role, permissions, 'items:update');

  if (!visible) return null;

  async function openGroup() {
    if (!(await isOnline())) {
      Alert.alert(GROUP_COPY.bulkAction, GROUP_COPY.offline);
      return;
    }
    const check = phoneGroupingCheck(picks);
    if (!check.ok) {
      Alert.alert(GROUP_COPY.bulkAction, check.message);
      return;
    }
    router.push(groupSelectedHref({ itemIds: picks.map((p) => p.id), view: check.view }));
  }

  return (
    <View
      style={[
        styles.wrap,
        { bottom: bottomInset + 12, backgroundColor: c.card, borderColor: c.hair },
      ]}
    >
      {/* Dynamic Type: the bar is absolutely positioned with left/right pinned,
          so it cannot grow sideways. The count label is the one thing here that
          can give, so it shrinks and wraps; without that, Review was pushed off
          the right edge and the whole selection flow dead-ended with no way to
          submit the count. */}
      <Mono
        size={13}
        color={c.ink}
        style={{ fontVariant: ['tabular-nums'], flexShrink: 1, minWidth: 0 }}
      >
        {count} selected
      </Mono>
      {/* The actions wrap onto a second line inside the bar rather than run
          off its edge (maxWidth): at large Dynamic Type sizes Clear, Group and
          Review together are wider than a phone. */}
      <View style={styles.actions}>
        <Pressable onPress={() => countSelection.clear()} hitSlop={8} disabled={count === 0}>
          <Mono size={12.5} color={count === 0 ? c.ink4 : c.ink3}>
            Clear
          </Mono>
        </Pressable>
        {canGroup ? (
          <Pressable
            onPress={() => void openGroup()}
            disabled={count === 0}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={GROUP_COPY.bulkAction}
          >
            <Mono
              size={12.5}
              color={count === 0 ? c.ink4 : c.ink}
              maxFontSizeMultiplier={capTo(12.5, TYPE_CEILING.control)}
            >
              Group
            </Mono>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => {
            if (count === 0) return;
            router.push('/cycle-count/new');
          }}
          disabled={count === 0}
          style={({ pressed }) => [
            styles.reviewBtn,
            { backgroundColor: c.ink, opacity: count === 0 ? 0.4 : pressed ? 0.85 : 1 },
          ]}
        >
          <ClipboardCheck size={15} color={c.paper} strokeWidth={1.8} />
          <Mono size={13} color={c.paper}>
            Review
          </Mono>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 20,
    right: 20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    columnGap: 16,
    rowGap: 8,
    flexShrink: 0,
    maxWidth: '100%',
  },
  reviewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
});
