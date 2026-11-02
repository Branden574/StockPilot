import { useRouter } from 'expo-router';
import { ClipboardCheck } from 'lucide-react-native';
import * as React from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { GROUP_COPY, UNGROUP_COPY } from '@stockpilot/core';

import { Mono } from '@/components/ui/text';
import { countSelectOffers } from '@/lib/count-select-offers';
import { groupSelectedHref, phoneGroupingCheck } from '@/lib/display-groups';
import { useEnabledModules } from '@/lib/enabled-modules';
import { isOnline } from '@/lib/sync';
import { SHADOW, TYPE_CEILING, capTo } from '@/lib/theme';
import { phoneUngroupCheck, phoneUngroupOffer, ungroupSelectedHref } from '@/lib/ungroup-selected';
import { countSelection, useCountPicks, useCountSelectionCount } from '@/lib/use-count-selection';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useRole } from '@/lib/use-role';
import { useTheme } from '@/lib/use-theme';

/**
 * Floating bar shown while a list tab is in cycle-count select mode.
 * Reads the shared count-selection store so it reflects picks made across
 * both the Items and Books tabs. "Review" opens the confirm screen, and is
 * drawn only for someone who can start a count (B42: a manager with
 * cycle_counts:assign and stock:adjust, the module on; countSelectOffers).
 *
 * "Group" (Group selected, migration 0400) opens the grouping review for the
 * picks, offered to someone who can edit items (the permission alone decides,
 * as on the item screen; cosmetic, the route refuses on its own). It needs a
 * connection, two or more records, and one type: the bar says which is
 * missing instead of opening a review that could only refuse.
 *
 * "Ungroup" (owner 2026-10-12, Ungroup anything) opens the Ungroup review for
 * EVERY pick when at least one has something to leave that the member may
 * undo (a display group or a shared SKU with items:update; a size family also
 * with sports:manage and the sports module on): the same rule as the web's
 * bulk bar (core ungroupOfferKind). Online only; the route refuses on its own.
 *
 * Look (DESIGN-SPEC 6.21, the phone select bar): the card surface with the
 * stronger border (it floats over rows of the same card colour, where the
 * hairline and a shadow both vanish in dark mode), radius 14, the count in
 * mono, Clear in muted ink, Group and Ungroup in ink, Review the ink button.
 * Every action is a 44pt frame, so the bar is as tall as its targets.
 *
 * `onHeight` reports the bar's height, which grows when its actions wrap at
 * large text sizes, so a list can keep its last rows and its pager clear of
 * the bar instead of under it.
 */
export function CountSelectBar({
  visible,
  bottomInset,
  onHeight,
}: {
  visible: boolean;
  bottomInset: number;
  onHeight?: (height: number) => void;
}) {
  const router = useRouter();
  const { c } = useTheme();
  const count = useCountSelectionCount();
  const picks = useCountPicks();
  const { role } = useRole();
  const permissions = useEffectivePermissions();
  const enabledModules = useEnabledModules();
  // One read of who may do what here (B42): Review only for someone who can
  // start a count, Group and Ungroup by their own rules, unchanged.
  const offers = countSelectOffers({ role, permissions, enabledModules });
  const canGroup = offers.group;
  const canUngroup = phoneUngroupOffer(picks, {
    editItems: offers.group,
    unlinkFamilies: offers.unlinkFamilies,
  });

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

  async function openUngroup() {
    if (!(await isOnline())) {
      Alert.alert(UNGROUP_COPY.bulkAction, UNGROUP_COPY.selectedOffline);
      return;
    }
    const check = phoneUngroupCheck(picks);
    if (!check.ok) {
      Alert.alert(UNGROUP_COPY.bulkAction, check.message);
      return;
    }
    router.push(ungroupSelectedHref({ picks, view: check.view }));
  }

  return (
    <View
      onLayout={onHeight ? (e) => onHeight(e.nativeEvent.layout.height) : undefined}
      style={[
        styles.wrap,
        SHADOW.fab,
        { bottom: bottomInset + 12, backgroundColor: c.card, borderColor: c.hair2 },
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
        {/* A button with a name now (VoiceOver read the word with no role). */}
        <Pressable
          onPress={() => countSelection.clear()}
          hitSlop={GROUP_HIT_SLOP}
          disabled={count === 0}
          accessibilityRole="button"
          style={styles.textAction}
        >
          <Mono size={12.5} color={count === 0 ? c.ink4 : c.ink3}>
            Clear
          </Mono>
        </Pressable>
        {canGroup ? (
          <Pressable
            onPress={() => void openGroup()}
            disabled={count === 0}
            hitSlop={GROUP_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={GROUP_COPY.bulkAction}
            style={styles.textAction}
          >
            <Mono
              size={12.5}
              color={count === 0 ? c.ink4 : c.ink}
              maxFontSizeMultiplier={capTo(12.5, TYPE_CEILING.control)}
            >
              {GROUP_COPY.bulkActionShort}
            </Mono>
          </Pressable>
        ) : null}
        {canUngroup ? (
          <Pressable
            onPress={() => void openUngroup()}
            disabled={count === 0}
            hitSlop={GROUP_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={UNGROUP_COPY.bulkAction}
            style={styles.textAction}
          >
            <Mono
              size={12.5}
              color={count === 0 ? c.ink4 : c.ink}
              maxFontSizeMultiplier={capTo(12.5, TYPE_CEILING.control)}
            >
              {UNGROUP_COPY.bulkAction}
            </Mono>
          </Pressable>
        ) : null}
        {offers.review ? (
          <Pressable
            onPress={() => {
              if (count === 0) return;
              router.push('/cycle-count/new');
            }}
            disabled={count === 0}
            accessibilityRole="button"
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
        ) : null}
      </View>
    </View>
  );
}

/** The text actions' touch target (people review P11): a 12.5pt label sits on
 *  a line of about 16pt, and 14pt above and below make 44pt, the minimum;
 *  8pt on each side widens it and keeps it clear of its neighbours. React
 *  Native's hitSlop never reaches past the parent's bounds (the actions row),
 *  so each action is also a 44pt frame (styles.textAction): the frame holds
 *  the height, and the slop's sides still widen the target. */
const GROUP_HIT_SLOP = { top: 14, bottom: 14, left: 8, right: 8 };

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
    borderRadius: 14,
    borderWidth: 1,
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
  // Clear, Group and Ungroup: words in a frame at least 44pt tall (a real
  // frame, so VoiceOver outlines the target a finger can hit).
  textAction: {
    minHeight: 44,
    justifyContent: 'center',
  },
  // The ink button, 44pt tall (minHeight, so it grows with its words), radius
  // 10 as the reference's phone segments.
  reviewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
});
