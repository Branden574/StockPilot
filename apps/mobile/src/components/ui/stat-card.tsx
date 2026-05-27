import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { Card } from './card';

type SparkKind = 'ok' | 'warn' | 'crit' | 'ink';

/**
 * Sparkline — mini line chart, 84×26, mono-stroke 1.4. Last point gets
 * a 2px mint dot. Used right-aligned inside StatCard.
 */
export function Sparkline({
  data,
  width = 84,
  height = 26,
  kind = 'ok',
}: {
  data: number[];
  width?: number;
  height?: number;
  kind?: SparkKind;
}) {
  const { c } = useTheme();
  if (!data.length) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = Math.max(1, max - min);
  const stepX = width / Math.max(1, data.length - 1);
  const pts = data.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / span) * (height - 4) - 2;
    return [x, y] as const;
  });

  const d = pts
    .map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ');

  const stroke =
    kind === 'warn'
      ? ACCENT.warn
      : kind === 'crit'
        ? ACCENT.crit
        : kind === 'ink'
          ? c.ink3
          : ACCENT.mint;

  const last = pts[pts.length - 1];

  return (
    <Svg width={width} height={height}>
      <Path
        d={d}
        stroke={stroke}
        strokeWidth={1.4}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={last[0]} cy={last[1]} r={2} fill={ACCENT.mint} />
    </Svg>
  );
}

/**
 * StatCard — label eyebrow, big tabular number, optional unit suffix,
 * mono delta (mint for positive, crit for negative). Optional sparkline
 * right-aligned. Used on Home + Cycle counts.
 */
export function StatCard({
  label,
  value,
  unit,
  delta,
  spark,
  sparkKind = 'ok',
}: {
  label: string;
  value: string;
  unit?: string;
  delta?: string;
  spark?: number[];
  sparkKind?: SparkKind;
}) {
  const { c, mode } = useTheme();
  const deltaColor =
    delta && (delta.startsWith('-') || delta.startsWith('↓'))
      ? ACCENT.crit
      : mode === 'dark'
        ? ACCENT.mintInkDark
        : ACCENT.mintInk;

  return (
    <Card padding={16} style={styles.wrap}>
      <View style={styles.header}>
        <Text
          style={[
            styles.label,
            { color: c.ink4 },
          ]}
        >
          {label}
        </Text>
        {spark ? (
          <Sparkline data={spark} kind={sparkKind} />
        ) : null}
      </View>
      <View style={styles.valueRow}>
        <Text style={[styles.value, { color: c.ink }]}>{value}</Text>
        {unit ? (
          <Text style={[styles.unit, { color: c.ink4 }]}>{unit}</Text>
        ) : null}
      </View>
      {delta ? (
        <Text style={[styles.delta, { color: deltaColor }]}>{delta}</Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: {
    minHeight: 102,
    justifyContent: 'space-between',
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  label: {
    fontFamily: FONT.mono,
    fontSize: 9.5,
    letterSpacing: 9.5 * 0.18,
    textTransform: 'uppercase',
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
  },
  value: {
    fontFamily: FONT.display,
    fontSize: 28,
    lineHeight: 28,
    letterSpacing: -28 * 0.028,
  },
  unit: {
    fontFamily: FONT.mono,
    fontSize: 11,
    letterSpacing: 11 * 0.08,
  },
  delta: {
    fontFamily: FONT.mono,
    fontSize: 10.5,
    letterSpacing: 10.5 * 0.04,
  },
});
