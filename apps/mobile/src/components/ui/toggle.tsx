import * as React from 'react';
import { Pressable, View } from 'react-native';

import { useTheme } from '@/lib/use-theme';
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
      style={({ pressed }) => ({
        width: 48,
        height: 28,
        borderRadius: 999,
        backgroundColor: track,
        opacity: pressed ? 0.85 : 1,
        position: 'relative',
        justifyContent: 'center',
      })}
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
    </Pressable>
  );
}
