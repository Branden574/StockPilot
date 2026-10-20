import * as React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/lib/use-theme';
import { meterColor, meterTrack, type MeterKind } from './tones';

type Kind = MeterKind;

/**
 * Thin accent progress bar — 3pt tall by default. Used on cycle counts,
 * PO partial-receive progress, and bundle distribute previews. The fill is
 * the per-mode accent (or warn / crit / ink) and the track the stronger
 * border, so the fill stands at 3.5:1 or more against it in both modes.
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

  const fill = meterColor(kind, c);

  return (
    <View
      style={{
        height,
        backgroundColor: meterTrack(c),
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
