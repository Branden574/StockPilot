import * as React from 'react';
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';

import { capTo, TYPE_CEILING } from '../../../../lib/theme';
import { Card } from '../../card';
import { Pill } from '../../pill';
import { GLASS_METRICS } from '../metrics';
import { glassStatLabel, glassStatUnit, glassStatValue } from '../primitive-styles';
import type { GlassLook } from '../use-glass';

/**
 * The item screen in Liquid Glass, from the iOS Item board (iOS-Item.dc.html):
 * the glass nav with the item's name as its title (.ios-nav .ttl [701]), the
 * 26/31 700 name over one mono line, the photo as a grouped tile (radius 24),
 * the tabs as the iOS segmented control, the three figure tiles (On hand,
 * Reorder at, Suggested reorder) over the stock card, and the Adjust sheet as
 * a glass sheet. Used only inside the screen's `lg` branches; Classic never
 * reaches this file.
 */

function cached<T>(build: (lg: GlassLook) => T): (lg: GlassLook) => T {
  const memo = new WeakMap<GlassLook, T>();
  return (lg) => {
    const hit = memo.get(lg);
    if (hit !== undefined) return hit;
    const value = build(lg);
    memo.set(lg, value);
    return value;
  };
}

/** Geometry with no colour in it (.ios-nav [700], .ios-scroll [698]: 16 sides, 18 between blocks). */
export const GLASS_ITEM = StyleSheet.create({
  // The chips keep their 44pt frames: 16 from the edges as the board's circles.
  nav: {
    height: GLASS_METRICS.nav.height,
    paddingHorizontal: GLASS_METRICS.nav.paddingHorizontal,
    gap: GLASS_METRICS.nav.gap,
    flexDirection: 'row',
    alignItems: 'center',
  },
  hero: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  name: { marginTop: 0, fontSize: 26, lineHeight: 31, letterSpacing: -0.4 },
  photoBlock: { paddingHorizontal: 16, marginTop: 14 },
  tabsTrack: { marginHorizontal: 16, marginTop: 18, marginBottom: 18 },
  column: { paddingHorizontal: 16, gap: 18 },
  figures: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  figure: { flexGrow: 1, flexBasis: 96, minWidth: 0 },
  figureValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 },
  figurePill: { marginTop: 8, alignSelf: 'flex-start' },
  // The meta rows as the iOS row (.ios-row [709]): 56 tall at least, 10/16.
  metaRow: {
    minHeight: GLASS_METRICS.row.minHeight,
    paddingVertical: GLASS_METRICS.row.paddingVertical,
  },
});

/** The words and fills of the item screen's glass parts, per look. */
export const glassItemStyles = cached((lg: GlassLook) => {
  const text = (size: number, weight: TextStyle['fontWeight'], color: string): TextStyle => ({
    ...lg.font.displayRegular,
    fontSize: size,
    fontWeight: weight,
    letterSpacing: 0,
    color,
  });
  return StyleSheet.create({
    // .ios-nav .ttl [701]: 17/600, -.4 tracking, centred between the circles.
    navTitle: {
      ...text(17, '600', lg.c.ink),
      letterSpacing: -0.4,
      flex: 1,
      textAlign: 'center',
    },
    // The SKU, category and barcode on one line: mono, ink-3 (the board's
    // --ios-l2 sits under AA on the page; ink-3 is the AA choice).
    metaLine: { color: lg.c.ink3, marginTop: 2 },
    // The photo as a grouped tile: radius 24, the card line; an empty tile is
    // the content glass fill.
    photoTile: {
      borderRadius: GLASS_METRICS.group.radius,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: lg.g.cardLine,
    },
    photoEmpty: { backgroundColor: lg.g.cardFill },
    // The meta rows' key and value as an iOS settings row: the key in the
    // ink, the value in ink-3, both 15 in the system face.
    metaLabel: text(15, '400', lg.c.ink),
    metaValue: text(15, '400', lg.c.ink3),
    // A busy or Replace chip over the photo: the strong glass fill.
    photoChip: { backgroundColor: lg.g.glassStrong, borderColor: lg.g.cardLine },
    // The Adjust sheet's NEW TOTAL: the stepper's 700 tabular figure.
    newTotal: {
      ...lg.font.displaySemi,
      fontWeight: '700',
      fontVariant: ['tabular-nums'],
      letterSpacing: -0.4,
    },
  } satisfies Record<string, ViewStyle | TextStyle>);
});

/** "UNIT COST" read as "Unit cost": a Classic eyebrow key as an iOS row's words. */
export function sentenceCase(label: string): string {
  if (label !== label.toUpperCase()) return label;
  const lower = label.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

type StockStatus = 'ok' | 'warn' | 'crit';
const STATUS_WORD: Record<StockStatus, string> = { ok: 'OK', warn: 'LOW', crit: 'OUT' };

function Figure({
  lg,
  label,
  value,
  unit,
  status,
}: {
  lg: GlassLook;
  label: string;
  value: number;
  unit?: string;
  status?: StockStatus;
}) {
  const spoken = [label, String(value), unit, status ? STATUS_WORD[status] : null]
    .filter(Boolean)
    .join(', ');
  return (
    <View style={GLASS_ITEM.figure}>
      <Card padding={12} style={{ flex: 1 }}>
        <View accessible accessibilityLabel={spoken}>
          <Text
            style={[glassStatLabel(lg), { color: lg.c.ink3 }]}
            numberOfLines={2}
            maxFontSizeMultiplier={capTo(12, TYPE_CEILING.control)}
          >
            {label}
          </Text>
          <View style={GLASS_ITEM.figureValueRow}>
            <Text
              style={[glassStatValue(lg), { fontSize: 28, color: lg.c.ink, flexShrink: 1 }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
              maxFontSizeMultiplier={capTo(28, TYPE_CEILING.display)}
            >
              {value}
            </Text>
            {unit ? (
              <Text
                style={[glassStatUnit(lg), { color: lg.c.ink3, flexShrink: 1 }]}
                numberOfLines={1}
              >
                {unit}
              </Text>
            ) : null}
          </View>
          {status ? (
            <View style={GLASS_ITEM.figurePill}>
              <Pill status={status}>{STATUS_WORD[status]}</Pill>
            </View>
          ) : null}
        </View>
      </Card>
    </View>
  );
}

/**
 * The board's three figure tiles (iOS-Item.dc.html: On hand, Available,
 * Reorder at). The item has no "available" figure of its own on the phone,
 * so the tiles are the numbers the Classic stock card shows: On hand with its
 * unit and the OK / LOW / OUT pill, Reorder at, and Suggested reorder. They
 * wrap under each other when large text needs the room.
 */
export function GlassItemFigures({
  lg,
  onHand,
  unit,
  status,
  reorderPoint,
  reorderQuantity,
}: {
  lg: GlassLook;
  onHand: number;
  unit: string;
  status: StockStatus;
  reorderPoint: number;
  reorderQuantity: number;
}) {
  return (
    <View style={GLASS_ITEM.figures}>
      <Figure lg={lg} label="On hand" value={onHand} unit={unit} status={status} />
      <Figure lg={lg} label="Reorder at" value={reorderPoint} />
      <Figure lg={lg} label="Suggested reorder" value={reorderQuantity} />
    </View>
  );
}
