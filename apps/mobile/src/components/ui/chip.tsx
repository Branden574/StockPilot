import React from 'react';
import { Pressable, View } from 'react-native';

import { Mono } from '@/components/ui/text';
import { useTheme } from '@/lib/use-theme';

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
 */
export function Chip({
  label,
  active,
  onPress,
  swatch,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  swatch?: string | null;
}) {
  const { c } = useTheme();
  const text = (
    <Mono size={12.5} color={active ? c.card : c.ink}>
      {label}
    </Mono>
  );
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: active ? c.ink : c.hair,
        backgroundColor: active ? c.ink : c.paper2,
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
              borderColor: active ? c.card : c.hair,
            }}
          />
          {text}
        </View>
      ) : (
        text
      )}
    </Pressable>
  );
}
