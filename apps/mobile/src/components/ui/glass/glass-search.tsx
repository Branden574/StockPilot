import { Search } from 'lucide-react-native';
import * as React from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { TYPE_CEILING, capTo } from '../../../lib/theme';
import { useTheme } from '../../../lib/use-theme';

import { GLASS_METRICS } from './metrics';

/**
 * The iOS search field on glass (.ios-search: 44 tall, radius 22, 17pt): the
 * --field-fill with its line, a search glyph, and the caller's TextInput
 * props (value, onChangeText, placeholder, accessibilityLabel). The field
 * keeps the input ceiling for Larger Text (TYPE_CEILING.input).
 */
export function GlassSearch(props: TextInputProps & { accessibilityLabel: string }) {
  const { c, g, font } = useTheme();
  const m = GLASS_METRICS.search;
  return (
    <View
      style={[
        styles.box,
        {
          minHeight: m.height,
          borderRadius: m.radius,
          paddingHorizontal: m.paddingHorizontal,
          gap: m.gap,
          backgroundColor: g?.fieldFill ?? c.card,
          borderColor: g?.fieldLine ?? c.hair2,
        },
      ]}
    >
      <Search size={m.iconSize} color={c.ink3} strokeWidth={1.8} />
      <TextInput
        placeholderTextColor={c.ink3}
        returnKeyType="search"
        clearButtonMode="while-editing"
        maxFontSizeMultiplier={capTo(m.fontSize, TYPE_CEILING.input)}
        {...props}
        style={[
          styles.input,
          font.displayRegular,
          { fontSize: m.fontSize, color: c.ink },
          props.style,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, paddingVertical: 8 },
});
