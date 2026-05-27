import * as React from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { FONT, RADIUS } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { Mono } from './text';

/**
 * Form input field — mono-eyebrow label above, 50pt-tall input with
 * hairline border that deepens to ink on focus. Optional trailing icon
 * slot (eye, mail, etc).
 */
export function Field({
  label,
  trailing,
  style,
  ...inputProps
}: TextInputProps & {
  label: string;
  trailing?: React.ReactNode;
  style?: ViewStyle;
}) {
  const { c } = useTheme();
  const [focused, setFocused] = React.useState(false);

  return (
    <View style={[styles.wrap, style]}>
      <Mono size={10} tracking={0.12} upper color={c.ink4}>
        {label}
      </Mono>
      <View
        style={[
          styles.inputBox,
          {
            backgroundColor: c.card,
            borderColor: focused ? c.ink : c.hair,
          },
        ]}
      >
        <TextInput
          {...inputProps}
          onFocus={(e) => {
            setFocused(true);
            inputProps.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            inputProps.onBlur?.(e);
          }}
          placeholderTextColor={c.ink5}
          style={[
            styles.input,
            {
              color: c.ink,
              paddingRight: trailing ? 44 : 14,
            },
          ]}
        />
        {trailing ? (
          <View style={styles.trailing}>{trailing}</View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
  },
  inputBox: {
    height: 50,
    borderRadius: RADIUS.tile,
    borderWidth: 1,
    justifyContent: 'center',
    position: 'relative',
  },
  input: {
    fontFamily: FONT.displayRegular,
    fontSize: 16,
    letterSpacing: -0.19,
    paddingHorizontal: 14,
    height: '100%',
  },
  trailing: {
    position: 'absolute',
    right: 12,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
});
