import * as React from 'react';
import { Pressable, View } from 'react-native';

import { useTheme } from '@/lib/use-theme';

/**
 * Toggle — small ink-on-paper switch used in settings rows. Slides the
 * 22pt knob across a 48pt track. Tap to flip.
 */
export function Toggle({
  value,
  onValueChange,
}: {
  value: boolean;
  onValueChange?: (v: boolean) => void;
}) {
  const { c, mode } = useTheme();
  return (
    <Pressable
      onPress={() => onValueChange?.(!value)}
      style={({ pressed }) => ({
        width: 48,
        height: 28,
        borderRadius: 999,
        backgroundColor: value ? c.ink : c.hair,
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
          backgroundColor: mode === 'dark' && !value ? c.card : '#fff',
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
