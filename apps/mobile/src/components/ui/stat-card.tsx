import * as React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { shouldStackRow } from '@/lib/dynamic-type-layout';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import { Card } from './card';

/**
 * Whether the card header has to become a column. Reads the LIVE scale off
 * `useWindowDimensions()` so it re-renders when the user changes Larger Text
 * mid-session, and defers the threshold to the pure, unit-tested helper.
 */
function useStackedHeader(): boolean {
  const { fontScale } = useWindowDimensions();
  return shouldStackRow(fontScale);
}

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
  // Paired with LABEL_CAP, and the half that actually stops "IT/EM/S". A 2-up
  // card is ~143pt of interior; the sparkline is a fixed 84pt, so the label is
  // left ~51pt — which even a capped 20pt "ITEMS" (~68pt) overruns, and iOS
  // then breaks it per character. Past the threshold the chart drops below the
  // label and the label gets the whole card width. Below it (≤1.35x, every
  // non-accessibility size) the label needs ~47pt and nothing moves.
  const stacked = useStackedHeader();
  const deltaColor =
    delta && (delta.startsWith('-') || delta.startsWith('↓'))
      ? ACCENT.crit
      : mode === 'dark'
        ? ACCENT.mintInkDark
        : ACCENT.mintInk;

  return (
    <Card padding={16} style={styles.wrap}>
      <View style={[styles.header, stacked && styles.headerStacked]}>
        <Text
          style={[
            styles.label,
            { color: c.ink4 },
          ]}
          maxFontSizeMultiplier={LABEL_CAP}
        >
          {label}
        </Text>
        {spark ? (
          <Sparkline data={spark} kind={sparkKind} />
        ) : null}
      </View>
      <View style={styles.valueRow}>
        <Text
          style={[styles.value, { color: c.ink }]}
          maxFontSizeMultiplier={capTo(28, TYPE_CEILING.display)}
        >
          {value}
        </Text>
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

/**
 * 9.5pt micro-marker against the chrome ceiling. Uncapped it reached 34pt at
 * AX5 — larger than the 28pt VALUE it labels, which inverts the card's whole
 * hierarchy.
 */
const LABEL_CAP = capTo(9.5, TYPE_CEILING.chrome);

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
    gap: 8,
  },
  headerStacked: {
    flexDirection: 'column',
  },
  label: {
    fontFamily: FONT.mono,
    fontSize: 9.5,
    letterSpacing: 9.5 * 0.18,
    textTransform: 'uppercase',
    // The label still scales, up to the ceiling — it just has to wrap rather
    // than shoulder the fixed 84pt sparkline beside it. RN text defaults to
    // flexShrink 0, so without these it claims its full intrinsic width and
    // pushes the chart off the card.
    flex: 1,
    flexShrink: 1,
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
