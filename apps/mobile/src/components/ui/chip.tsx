import React from 'react';
import { Pressable } from 'react-native';

import { Mono } from '@/components/ui/text';
import { useTheme } from '@/lib/use-theme';

/**
 * Selectable pill used by picker rows (warehouse / vendor / site / rack
 * choices). Hoisted out of po-import's ApproveSheet and move-stock-modal,
 * which each declared an identical copy INSIDE their render — a React
 * Compiler violation (components created during render remount their
 * subtree every render), and a copy-paste pair besides. Reads the theme
 * itself so call sites stay exactly as they were.
 */
export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
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
      <Mono size={12.5} color={active ? c.card : c.ink}>
        {label}
      </Mono>
    </Pressable>
  );
}
