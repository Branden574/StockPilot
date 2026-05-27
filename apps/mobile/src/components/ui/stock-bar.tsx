import * as React from 'react';
import { View } from 'react-native';

import { ACCENT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

type Kind = 'ok' | 'warn' | 'crit' | 'ink';

/**
 * Thin mint progress bar — 3pt tall by default. Used on cycle counts,
 * PO partial-receive progress, and bundle distribute previews.
 */
export function StockBar({
  value,
  max = 100,
  kind = 'ok',
  height = 3,
}: {
  value: number;
  max?: number;
  kind?: Kind;
  height?: number;
}) {
  const { c } = useTheme();
  const pct = Math.max(0, Math.min(100, (value / max) * 100));

  let fill = ACCENT.mint;
  if (kind === 'warn') fill = ACCENT.warn;
  if (kind === 'crit') fill = ACCENT.crit;
  if (kind === 'ink') fill = c.ink;

  return (
    <View
      style={{
        height,
        backgroundColor: c.hair,
        borderRadius: 100,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          height: '100%',
          width: `${pct}%`,
          backgroundColor: fill,
          borderRadius: 100,
        }}
      />
    </View>
  );
}
