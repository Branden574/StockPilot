import React from 'react';
import { Pressable, View } from 'react-native';

// Relative imports on purpose (as in checkbox.tsx): touch-target.test.ts
// loads this file in the node test runner, which does not resolve `@/`.
import { useTheme } from '../../lib/use-theme';
import { Mono } from './text';

/**
 * Selectable pill used by picker rows (warehouse / vendor / site / rack
 * choices). Hoisted out of po-import's ApproveSheet and move-stock-modal,
 * which each declared an identical copy INSIDE their render — a React
 * Compiler violation (components created during render remount their
 * subtree every render), and a copy-paste pair besides. Reads the theme
 * itself so call sites stay exactly as they were.
 *
 * `swatch` is an OPTIONAL decorative dot for the crate-colour row. It is
 * additive on purpose: when it is absent the pill renders exactly the element
 * tree it always did, so the warehouse / vendor / site / kind rows are
 * untouched by the colour picker's arrival.
 *
 * A swatch NEVER replaces the label — see CrateColorOption. The dot is an
 * accelerator for people who can use it; the name is the information.
 *
 * Look (the reference's chips): unselected is the recessed fill (sunk) with
 * the stronger border; selected is the ink fill, its words in the card
 * colour.
 *
 * THE 44pt TARGET (redesign P2.5c). The drawn chip is about 36pt tall
 * (9pt padding round a 12.5pt label), so a chip that is a control (it has
 * `onPress`, as every chip today does) is drawn inside a frame: the Pressable
 * is at least 44pt tall and wide, the chip a View centred in it, so the
 * target VoiceOver outlines and a finger can hit is 44pt and the chip looks
 * as it did. A frame, not hitSlop (the Checkbox and Button rule). In a
 * wrapping row of chips each line is 44pt, not 36pt, so the row's lines sit
 * 8pt further apart. A chip without `onPress` is display only: the chip
 * alone, no frame, no button role.
 */
export function Chip({
  label,
  active,
  onPress,
  swatch,
}: {
  label: string;
  active: boolean;
  /** Makes the chip a control in a 44pt frame; without it the chip only
   *  shows its label. */
  onPress?: () => void;
  swatch?: string | null;
}) {
  const { c } = useTheme();
  const text = (
    <Mono size={12.5} color={active ? c.card : c.ink}>
      {label}
    </Mono>
  );
  const chip = (
    <View
      style={{
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: active ? c.ink : c.hair2,
        backgroundColor: active ? c.ink : c.sunk,
      }}
    >
      {swatch ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: swatch,
              // Ringed in the pill's own FOREGROUND colour so the two extremes
              // of the registry stay visible on both pill states: white on the
              // light pill, black on the selected dark one.
              borderWidth: 1,
              borderColor: active ? c.card : c.hair2,
            }}
          />
          {text}
        </View>
      ) : (
        text
      )}
    </View>
  );
  if (!onPress) return chip;
  return (
    <Pressable
      onPress={onPress}
      // A selectable option: screen readers hear the label and whether it is
      // the one chosen.
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      // The 44pt frame, the chip centred in it both ways (so a one-letter
      // chip keeps its own width inside a 44pt-wide target); minHeight /
      // minWidth so a chip whose label grows with Dynamic Type still grows
      // past it.
      style={CHIP_FRAME}
    >
      {chip}
    </Pressable>
  );
}

/** The least a control chip's frame measures each way (the iOS minimum). */
export const CHIP_MIN_TARGET = 44;

const CHIP_FRAME = {
  minHeight: CHIP_MIN_TARGET,
  minWidth: CHIP_MIN_TARGET,
  alignItems: 'center',
  justifyContent: 'center',
} as const;
