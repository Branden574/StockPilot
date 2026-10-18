import * as React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
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

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      // VoiceOver and TalkBack announce it as a button, and as dimmed /
      // disabled when `disabled` (Pressable maps it into accessibilityState).
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        styles.base,
        {
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
          ...(block ? { width: '100%' } : null),
        },
        style,
      ]}
    >
      {leading ? <View style={styles.slot}>{leading}</View> : null}
      <Text
        style={[
          styles.label,
          {
            color: tone.fg,
            fontSize,
          },
        ]}
        numberOfLines={1}
        maxFontSizeMultiplier={capTo(fontSize, TYPE_CEILING.control)}
      >
        {children}
      </Text>
      {trailing ? <View style={styles.slot}>{trailing}</View> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
});
