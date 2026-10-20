import * as React from 'react';
import { Pressable, View } from 'react-native';

// Relative imports on purpose (as in checkbox.tsx): touch-target.test.ts
// loads this file in the node test runner, which does not resolve `@/`.
import { useTheme } from '../../lib/use-theme';
import { toggleTone } from './tones';

/**
 * Toggle — small ink-on-paper switch used in settings rows. Slides the
 * 22pt knob across a 48pt track. Tap to flip.
 *
 * Announced as a switch with its on / off state (it was an unnamed, roleless
 * element to VoiceOver), and as dimmed while the caller withholds
 * `onValueChange` (a save in flight), when a tap could do nothing. Colours
 * are tones.ts `toggleTone`: the knob stands out from its track at 3:1 or
 * more in both states and modes; the off track is the stronger border.
 *
 * THE 44pt TARGET (redesign P2.5c). The Pressable is a frame 44pt tall (and
 * the track's 48pt wide) with the 48 x 28 track centred in it, so the target
 * VoiceOver outlines and a finger can hit is 48 x 44 while the switch looks
 * as it did. The frame's -8pt vertical margins give the 16pt it adds back, so
 * it takes the track's 28pt in its row and no row grows: a settings row keeps
 * its 52pt, and in a card row shorter than 44pt the frame reaches into the
 * card's padding (the new architecture hit-tests a child that overflows its
 * parent, unlike hitSlop, which no parent passes on).
 */
export function Toggle({
  value,
  onValueChange,
  accessibilityLabel,
}: {
  value: boolean;
  onValueChange?: (v: boolean) => void;
  /** What the switch turns on or off ("Face ID unlock"), when no visible
   *  label is grouped with it. */
  accessibilityLabel?: string;
}) {
  const { c } = useTheme();
  const inert = !onValueChange;
  const { track, knob } = toggleTone(value, c);
  return (
    <Pressable
      onPress={() => onValueChange?.(!value)}
      disabled={inert}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled: inert }}
      style={TOGGLE_FRAME}
    >
      {({ pressed }) => (
        <View
          style={{
            width: TOGGLE_TRACK.width,
            height: TOGGLE_TRACK.height,
            borderRadius: 999,
            backgroundColor: track,
            opacity: pressed ? 0.85 : 1,
            position: 'relative',
            justifyContent: 'center',
          }}
        >
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: knob,
              position: 'absolute',
              top: 3,
              left: value ? 23 : 3,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 1 },
              shadowOpacity: 0.2,
              shadowRadius: 3,
              elevation: 2,
            }}
          />
        </View>
      )}
    </Pressable>
  );
}

/** The drawn switch: a 48 x 28pt track. */
export const TOGGLE_TRACK = { width: 48, height: 28 } as const;

/** The least the switch's frame measures top to bottom (the iOS minimum). */
export const TOGGLE_MIN_TARGET = 44;

/** The frame: 44pt tall round the track, its added height given back by
 *  negative margins so the row lays it out at the track's 28pt. */
const TOGGLE_FRAME = {
  minHeight: TOGGLE_MIN_TARGET,
  marginVertical: -(TOGGLE_MIN_TARGET - TOGGLE_TRACK.height) / 2,
  alignItems: 'center',
  justifyContent: 'center',
} as const;
