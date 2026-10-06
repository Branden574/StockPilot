import * as React from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';

import { RETURNS_COPY } from '@stockpilot/core';

import { MIN_TAP } from '@/components/item-verification-card';
import { FieldLabel, Mono } from '@/components/ui/text';
import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { replacementQuantityStepLabel, stepReplacementQuantity } from '@/lib/returns-view';
import { capTo, TYPE_CEILING } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * The replacement's quantity on the phone and the iPad (returns RX-2 review
 * fix P12, the web's quantity field): − and + from 1 to the returned
 * quantity of its line (returns-view replacementQuantityMax), the number
 * between them. The server refuses more and checks what the original order
 * line has left to exchange; its words show where the sheet shows refusals.
 *
 * A local choice, like the review's radios: it works offline (sending needs a
 * connection). Each button is a 44 pt target with its own name ("Increase the
 * replacement quantity for Walk Exchange Tee - M"), the number is announced
 * as it changes, and past the AX threshold (shouldStackRow) the label sits
 * above the stepper so the row never runs out of width. The glyphs are
 * control labels, capped at the control ceiling.
 */
export function ReplacementQuantityStepper({
  value,
  max,
  label,
  disabled = false,
  onChange,
}: {
  value: number;
  /** The returned quantity of its line (at least 1). */
  max: number;
  /** The returned line it is for ("Walk Exchange Tee - M"). */
  label: string;
  disabled?: boolean;
  onChange: (quantity: number) => void;
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const stacked = shouldStackRow(fontScale);

  const stepButton = (glyph: string, delta: number, off: boolean) => (
    <Pressable
      onPress={() => onChange(stepReplacementQuantity(value, delta, max))}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={replacementQuantityStepLabel(delta, label)}
      accessibilityState={{ disabled: off }}
      style={{
        minWidth: MIN_TAP,
        minHeight: MIN_TAP,
        paddingHorizontal: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.hair,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: off ? 0.35 : 1,
      }}
    >
      <Mono size={15} color={c.ink} maxFontSizeMultiplier={capTo(15, TYPE_CEILING.control)}>
        {glyph}
      </Mono>
    </Pressable>
  );

  return (
    <View
      style={{
        flexDirection: stacked ? 'column' : 'row',
        alignItems: stacked ? 'flex-start' : 'center',
        gap: 8,
      }}
    >
      <FieldLabel>{RETURNS_COPY.replacementQuantity.toUpperCase()}</FieldLabel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {stepButton('−', -1, disabled || value <= 1)}
        <Mono
          size={15}
          color={c.ink}
          style={{ minWidth: 24, textAlign: 'center' }}
          accessibilityLabel={`${RETURNS_COPY.replacementQuantity}: ${value}`}
          accessibilityLiveRegion="polite"
        >
          {value}
        </Mono>
        {stepButton('+', 1, disabled || value >= max)}
      </View>
    </View>
  );
}
