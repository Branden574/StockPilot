import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { syncBadgeDot, syncBadgeSurface, type Tone } from '@/components/ui/tones';
import { cycleCountSync, useSyncStatus } from '@/lib/cycle-count-sync';
import { syncBadgeState } from '@/lib/sync-badge';
import { TYPE_CEILING, capTo, palette, radius, space } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

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
 *
 * Colours follow the device's mode (redesign plan P2.5 moved it off the
 * light-only legacy `theme` alias): the reference's neutral chip, with the
 * state's tone on the dot (tones.ts `syncBadgeDot`). The words carry the
 * state; the dot only repeats it.
 *
 * `surface` says what it is drawn on. The default, `screen`, is a screen in
 * the device's mode (the header of app/cycle-count/[id].tsx). `camera` is
 * the always-dark bar over a live camera (app/cycle-count/scan/[id].tsx,
 * and ai-scan/[id].tsx when P5.9 moves it): that bar is dark in both modes,
 * so the badge on it is too. It takes the dark palette's raised chip with a
 * 1pt outline that stands out at 3:1 from any dark bar, a solid one or a
 * translucent one over a bright scene (where the chip's own fill does).
 * Same words, same tap, same button.
 */
export function SyncStatusBadge({ surface = 'screen' }: { surface?: SyncBadgeSurface }) {
  const { c } = useTheme();
  const { status, pendingCount, rejectedCount, unconfirmedCount } = useSyncStatus();
  const { label, tone, spinner } = syncBadgeState({
    status,
    pendingCount,
    rejectedCount,
    unconfirmedCount,
  });
  const onCamera = surface === 'camera';
  const dotColor = onCamera ? syncBadgeDot(tone, CAMERA_PALETTE) : syncBadgeDot(tone, c);
  const chip = onCamera ? CAMERA_CHIP : syncBadgeSurface(c);
  const kind: 'dot' | 'spinner' = spinner ? 'spinner' : 'dot';

  return (
    <Pressable
      onPress={() => {
        void cycleCountSync.forceSync();
      }}
      style={({ pressed }) => [
        styles.pill,
        onCamera && styles.pillOnCamera,
        { backgroundColor: chip.bg, borderColor: chip.border },
        pressed && { opacity: 0.65 },
      ]}
      accessibilityRole="button"
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
      <Text
        style={[styles.label, { color: chip.fg }]}
        numberOfLines={1}
        maxFontSizeMultiplier={LABEL_CAP}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** What the badge is drawn on (see the component's note). */
export type SyncBadgeSurface = 'screen' | 'camera';

/** The camera bar is dark in both modes, so a badge on it takes the dark palette. */
const CAMERA_PALETTE = palette('dark');

/**
 * The badge's chip on a camera bar: the dark palette's raised surface, its
 * secondary ink for the words, and the decorative ink for a 1pt outline
 * (3.66:1 on the viewfinder colour, 3.89:1 on black). On a translucent bar
 * over a bright scene the outline fades and the fill takes over (3.90:1).
 * primitives-structure.test.ts measures each of these.
 */
const CAMERA_CHIP: Tone = {
  fg: CAMERA_PALETTE.ink2,
  bg: CAMERA_PALETTE.card,
  border: CAMERA_PALETTE.ink4,
};

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
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
    marginRight: space.xs,
    maxWidth: '60%',
    flexShrink: 1,
  },
  /** A full point on a camera bar: a hairline at 3:1 is too thin to find. */
  pillOnCamera: {
    borderWidth: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    flexShrink: 1,
  },
});
