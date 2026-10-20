import { Check, ChevronRight, Minus, Plus } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Body, Mono } from '@/components/ui/text';
import { buttonTone } from '@/components/ui/tones';
import { spokenValue } from '@/lib/order-storefront/a11y';
import { MIN_TAP, stepperCountWidth } from '@/lib/order-storefront/layout';
import { FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * The storefront's small controls (phone ordering PO-4). Every one is a named
 * VoiceOver element in a frame of at least 44 pt; their labels are chrome,
 * capped at the control ceiling with the frame growing (minHeight); a
 * disabled control says why in its hint.
 *
 * The redesign look (DESIGN-SPEC 6.2, 6.5): the shared button tones
 * (tones.ts buttonTone: ink for committing, the card fill with the stronger
 * border for the outline, words only for ghost, refusal-red words for
 * destructive), labels in the display face at 13/500 (the reference's
 * control label), and controls edged in the stronger border (hair2), never
 * the card hairline alone.
 */

/** A text action at least 44 pt tall: Add, Details, Clear all, Preview. */
export function SmallAction({
  label,
  onPress,
  disabled = false,
  hint,
  accessibilityLabel,
  variant = 'outline',
  busy = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  hint?: string;
  accessibilityLabel?: string;
  variant?: 'outline' | 'primary' | 'ghost' | 'destructive';
  busy?: boolean;
}) {
  const { c } = useTheme();
  const off = disabled || busy;
  const tone = buttonTone(variant, c);
  const fg = tone.fg;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: off, busy }}
      style={({ pressed }) => [
        styles.small,
        {
          backgroundColor: tone.bg,
          borderColor: tone.border,
          opacity: off ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : null}
      <Body size={13} color={fg} maxFontSizeMultiplier={ACTION_CAP} style={styles.label}>
        {label}
      </Body>
    </Pressable>
  );
}

/**
 * The quantity stepper: −, the count (a button that opens the quantity
 * sheet), +. Each part is its own 44 pt named button; + stops at what is
 * available (`atMax`), saying so in its hint. While the cart is locked every
 * part carries the lock's words as its hint (`lockHint`, desk check F7.1).
 */
export function Stepper({
  quantity,
  available,
  atMax,
  disabled,
  decLabel,
  incLabel,
  countLabel,
  incHint,
  lockHint,
  onDec,
  onInc,
  onCount,
}: {
  quantity: number;
  available: number;
  atMax: boolean;
  disabled: boolean;
  decLabel: string;
  incLabel: string;
  countLabel: string;
  incHint?: string;
  /** Why the whole stepper is dimmed (the lock), or undefined. */
  lockHint?: string;
  onDec: () => void;
  onInc: () => void;
  onCount: () => void;
}) {
  const { c } = useTheme();
  const incOff = disabled || atMax;
  return (
    <View style={[styles.stepper, { borderColor: c.hair2, backgroundColor: c.card }]}>
      <Pressable
        onPress={disabled ? undefined : onDec}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={decLabel}
        accessibilityHint={lockHint}
        accessibilityState={{ disabled }}
        style={[styles.stepButton, { opacity: disabled ? 0.4 : 1 }]}
      >
        <Minus size={16} color={c.ink} strokeWidth={1.8} />
      </Pressable>
      <Pressable
        onPress={disabled ? undefined : onCount}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={countLabel}
        accessibilityHint={lockHint}
        accessibilityState={{ disabled }}
        style={[styles.count, { minWidth: stepperCountWidth(available) }]}
      >
        <Mono size={15} color={c.ink} maxFontSizeMultiplier={COUNT_CAP}>
          {quantity}
        </Mono>
      </Pressable>
      <Pressable
        onPress={incOff ? undefined : onInc}
        disabled={incOff}
        accessibilityRole="button"
        accessibilityLabel={incLabel}
        accessibilityHint={lockHint ?? incHint}
        accessibilityState={{ disabled: incOff }}
        style={[styles.stepButton, { opacity: incOff ? 0.4 : 1 }]}
      >
        <Plus size={16} color={c.ink} strokeWidth={1.8} />
      </Pressable>
    </View>
  );
}

/** One choice of a radio group (VoiceOver: a radio button, checked or not). */
export function RadioRow({
  label,
  detail,
  checked,
  disabled = false,
  hint,
  onPress,
}: {
  label: string;
  detail?: string | null;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={hint}
      accessibilityState={{ checked, disabled }}
      style={({ pressed }) => [
        styles.radio,
        { borderColor: checked ? c.ink : c.hair2, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Body size={15} color={c.ink}>
          {label}
        </Body>
        {detail ? (
          <Body size={12.5} color={c.ink3}>
            {detail}
          </Body>
        ) : null}
      </View>
      {checked ? <Check size={18} color={c.ink} strokeWidth={2} /> : null}
    </Pressable>
  );
}

/** Pickup or Delivery: a segmented control that VoiceOver reads as a radio
 *  group. The reference's segmented switch (DESIGN-SPEC 6.5): a recessed
 *  track (sunk) with the chosen segment on the card colour, its words in ink
 *  and semibold, ringed in muted ink (ink3, 3:1 or more on the track in both
 *  modes, where the reference's hairline ring is 1.4:1), so the choice never
 *  rests on a faint fill or a colour alone. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  disabled: boolean;
  hint?: string;
  onChange: (value: T) => void;
}) {
  const { c } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.segmented, { backgroundColor: c.sunk }]}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={disabled ? undefined : () => onChange(o.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityHint={hint}
            accessibilityState={{ checked, disabled }}
            style={[
              styles.segment,
              {
                backgroundColor: checked ? c.card : 'transparent',
                borderColor: checked ? c.ink3 : 'transparent',
                opacity: disabled ? 0.5 : 1,
              },
            ]}
          >
            <Body
              size={13}
              color={checked ? c.ink : c.ink3}
              maxFontSizeMultiplier={ACTION_CAP}
              style={[styles.label, checked && styles.labelOn]}
            >
              {o.label}
            </Body>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A setup row: a label, its value, and a tap to change it (Ship from, For,
 *  Deliver to, Needed by). With no `onPress` it only shows the value (one
 *  VoiceOver element, not a button). */
export function SetupRow({
  label,
  value,
  detail,
  disabled = false,
  hint,
  onPress,
}: {
  label: string;
  value: string;
  detail?: string | null;
  disabled?: boolean;
  hint?: string;
  onPress?: () => void;
}) {
  const { c } = useTheme();
  if (!onPress) {
    return (
      <View
        accessible
        accessibilityLabel={`${label}: ${spokenValue(value)}${detail ? `, ${detail}` : ''}`}
        style={[styles.setup, { borderColor: c.hair, backgroundColor: c.card }]}
      >
        <Mono size={11} color={c.ink3} upper tracking={0.12} maxFontSizeMultiplier={LABEL_CAP}>
          {label}
        </Mono>
        <Body size={15.5} color={c.ink} style={{ fontFamily: FONT.display }}>
          {value}
        </Body>
        {detail ? (
          <Body size={12.5} color={c.ink3}>
            {detail}
          </Body>
        ) : null}
      </View>
    );
  }
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${spokenValue(value)}${detail ? `, ${detail}` : ''}`}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      // A row that can be tapped is a control: the stronger border (the
      // read-only row keeps the card hairline).
      style={({ pressed }) => [
        styles.setup,
        styles.setupTappable,
        { borderColor: c.hair2, backgroundColor: c.card, opacity: disabled ? 0.6 : pressed ? 0.85 : 1 },
      ]}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Mono size={11} color={c.ink3} upper tracking={0.12} maxFontSizeMultiplier={LABEL_CAP}>
          {label}
        </Mono>
        <Body size={15.5} color={c.ink} style={{ fontFamily: FONT.display }}>
          {value}
        </Body>
        {detail ? (
          <Body size={12.5} color={c.ink3}>
            {detail}
          </Body>
        ) : null}
      </View>
      {/* A row that can be tapped looks it (PO-4 review): the read-only one
          (no onPress) has no chevron. */}
      <ChevronRight size={16} color={c.ink3} strokeWidth={1.5} />
    </Pressable>
  );
}

const ACTION_CAP = capTo(13, TYPE_CEILING.control);
const COUNT_CAP = capTo(15, TYPE_CEILING.input);
const LABEL_CAP = capTo(11, TYPE_CEILING.label);

const styles = StyleSheet.create({
  small: {
    minHeight: MIN_TAP,
    minWidth: MIN_TAP,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  /** A control's words: the display face at 500 (the shared Button's), and
   *  they wrap inside the frame instead of overflowing it. */
  label: { fontFamily: FONT.display, flexShrink: 1, textAlign: 'center' },
  labelOn: { fontFamily: FONT.displaySemi },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  stepButton: {
    minWidth: MIN_TAP,
    minHeight: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: {
    minHeight: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  radio: {
    minHeight: MIN_TAP,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 10,
  },
  // The track: padding 3, radius 10, segments sharing its width (the phone's
  // action segments, DESIGN-SPEC 6.5).
  segmented: {
    flexDirection: 'row',
    gap: 4,
    padding: 3,
    borderRadius: 10,
  },
  segment: {
    flex: 1,
    minHeight: MIN_TAP,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  setup: {
    minHeight: MIN_TAP,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 10,
    gap: 3,
  },
  setupTappable: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
