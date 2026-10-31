import * as React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

// Relative imports on purpose (as in checkbox.tsx): touch-target.test.ts
// loads this file in the node test runner, which does not resolve `@/`.
import { FONT, TYPE_CEILING, capTo } from '../../lib/theme';
import { useTheme } from '../../lib/use-theme';
import { BUTTON_RADIUS, buttonTone, type ButtonVariant } from './tones';

type Variant = ButtonVariant;
type Size = 'sm' | 'md';

/**
 * The shared button. Which variant goes where is decided once, in
 * tones.ts `buttonTone` (the web's hierarchy rule, DESIGN-SPEC 6.2):
 *
 *   primary      ink fill: commit the work in front of you (Post receipt,
 *                Save count, Distribute, Submit order request)
 *   accent       accent fill: create something new at page level (New item,
 *                Place an order, Start count); an icon in `leading` takes
 *                `c.accentInk`
 *   outline      secondary
 *   ghost        borderless words ("Not now", "Use password instead")
 *   destructive  refusal-red words only, never a full red bar
 *
 * A screen shows at most one ink and one accent button. 52pt (md) and 36pt
 * (sm) tall, corner radius 14 / 10. Press scales to 0.98 per brand motion
 * spec.
 *
 * THE 44pt TARGET (redesign P2.5c). md is taller than 44pt on its own. sm
 * draws its 36pt button inside a frame: the Pressable is the frame, at least
 * 44pt tall and wide, and the drawn button is a View centred in it, so the
 * target VoiceOver outlines and a finger can hit is 44pt while the button
 * looks exactly as it did. A frame, not hitSlop: hitSlop never reaches past
 * the parent's bounds and loses to an overlapping sibling (the Checkbox and
 * IconChip rule). The caller's `style` is split: what places the button in
 * its parent (margins, alignSelf, flex, width, position) goes on the frame,
 * everything else (minHeight, padding, colours) stays on the drawn button, so
 * a caller that already passes minHeight 44 still draws a 44pt button in a
 * 44pt frame. A one-glyph label narrower than 44pt would be drawn 44pt wide
 * (no sm button is that narrow today).
 *
 * ONE LINE, OR `wrap`. The label is one line by default, so a short label in
 * a row of buttons ellipsizes inside its own button instead of shoving its
 * neighbour off the row. A label that is a sentence ("Release replacement
 * before return is received") was cut that way to "Release replacement…" at
 * larger text sizes, and short of its end even at the default size on a
 * narrow phone (docket B10). Such a button passes `wrap`: the label takes as
 * many lines as it needs, centred, and the button grows taller (minHeight,
 * never height). A label that fits draws exactly as before.
 */
export function Button({
  children,
  onPress,
  variant = 'primary',
  size = 'md',
  block = false,
  disabled = false,
  leading,
  trailing,
  wrap = false,
  style,
  accessibilityLabel,
  accessibilityHint,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  block?: boolean;
  disabled?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  /** A label that may need more than one line wraps, centred, instead of
   *  being cut to one line (see ONE LINE, OR `wrap` above). */
  wrap?: boolean;
  style?: ViewStyle;
  /** The spoken name when the visible label alone is ambiguous (a "Remove"
   *  on each of several photos). Defaults to the label's text. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const { c } = useTheme();
  const tone = buttonTone(variant, c);

  const minHeight = size === 'sm' ? 36 : 52;
  const padH = size === 'sm' ? 14 : 20;
  const fontSize = size === 'sm' ? 13 : 15.5;
  const framed = size === 'sm';

  const drawn = (pressed: boolean): ViewStyle => ({
    // minHeight, not height: the label is allowed to grow to the 22pt
    // control ceiling, and the button grows with it instead of clipping.
    minHeight,
    paddingVertical: 6,
    paddingHorizontal: padH,
    borderRadius: BUTTON_RADIUS[size],
    backgroundColor: tone.bg,
    borderColor: tone.border,
    opacity: disabled ? 0.5 : 1,
    transform: [{ scale: pressed ? 0.98 : 1 }],
  });
  const blockWidth: ViewStyle | null = block ? { width: '100%' } : null;
  const split = framed ? splitButtonStyle(style) : null;

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      // VoiceOver and TalkBack announce it as a button, and as dimmed /
      // disabled when `disabled` (Pressable maps it into accessibilityState).
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) =>
        split
          ? [styles.frame, blockWidth, split.frame]
          : [styles.base, drawn(pressed), blockWidth, style]
      }
    >
      {({ pressed }) => {
        // Inside the Pressable in the source as well as on screen: the
        // Pressable is the one root element (sheet-a11y-structure.test.ts).
        const content = (
          <>
            {leading ? <View style={styles.slot}>{leading}</View> : null}
            <Text
              style={[
                styles.label,
                wrap ? styles.labelWrap : null,
                {
                  color: tone.fg,
                  fontSize,
                },
              ]}
              numberOfLines={wrap ? undefined : 1}
              maxFontSizeMultiplier={capTo(fontSize, TYPE_CEILING.control)}
            >
              {children}
            </Text>
            {trailing ? <View style={styles.slot}>{trailing}</View> : null}
          </>
        );
        return split ? (
          <View style={[styles.base, drawn(pressed), split.drawn]}>{content}</View>
        ) : (
          content
        );
      }}
    </Pressable>
  );
}

/** The least an sm button's frame measures each way (the iOS minimum). */
export const BUTTON_MIN_TARGET = 44;

/** The style keys that place a button in its parent. On a framed (sm) button
 *  they go on the frame; every other key stays on the drawn button. */
const FRAME_KEYS: ReadonlySet<string> = new Set([
  'margin',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'marginStart',
  'marginEnd',
  'marginHorizontal',
  'marginVertical',
  'alignSelf',
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'width',
  'minWidth',
  'maxWidth',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'start',
  'end',
  'zIndex',
  'display',
]);

/**
 * A caller's style for a framed button, in two parts: `frame` places the
 * 44pt frame in the parent, `drawn` is everything else, laid on the button
 * that shows. Exported for touch-target.test.ts.
 */
export function splitButtonStyle(style: StyleProp<ViewStyle>): {
  frame: ViewStyle;
  drawn: ViewStyle;
} {
  const flat = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const frame: Record<string, unknown> = {};
  const drawn: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    (FRAME_KEYS.has(key) ? frame : drawn)[key] = value;
  }
  return { frame: frame as ViewStyle, drawn: drawn as ViewStyle };
}

const styles = StyleSheet.create({
  // The sm button's target: at least 44pt each way (minHeight / minWidth, so
  // it still grows with the label), the drawn button centred in it. The frame
  // is a column, so the drawn button stretches to the frame's width when the
  // caller sets one (block, width, flex in a row).
  frame: {
    minHeight: BUTTON_MIN_TARGET,
    minWidth: BUTTON_MIN_TARGET,
    justifyContent: 'center',
  },
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
  },
  slot: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    fontFamily: FONT.display,
    fontWeight: '500',
    letterSpacing: -0.15,
    // Paired with the cap: RN defaults text to flexShrink 0, so without this a
    // numberOfLines={1} label refuses to yield and shoves its sibling out of a
    // two-button footer row instead of ellipsizing inside its own button.
    flexShrink: 1,
    minWidth: 0,
  },
  // A wrapped label's lines centre under each other, as the one line did.
  labelWrap: {
    textAlign: 'center',
  },
});
