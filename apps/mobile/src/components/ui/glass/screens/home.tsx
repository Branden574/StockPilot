import { Barcode, ChevronRight, Minus, Plus, RotateCcw } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { SyncBadgeTone } from '../../../../lib/sync-badge';
import { TYPE_CEILING, capTo } from '../../../../lib/theme';
import { useTheme } from '../../../../lib/use-theme';
import { Card } from '../../card';
import { StatCard } from '../../stat-card';
import { Body } from '../../text';
import { GlassButtonLook, GlassStatusCapsule, GlassSubline, GlassTile } from '../parts';

/**
 * Home in Liquid Glass (iOS-Home.dc.html): the parts the board draws that
 * Classic Home has in another form. Rendered only inside Home's `lg`
 * branches; every value comes from the data Home already loads.
 */

/** The sync status as the board's glass capsule in the top bar (a dot and the badge words). */
export function GlassSyncCapsule({ label, tone }: { label: string; tone: SyncBadgeTone }) {
  const { g, c } = useTheme();
  const dot =
    tone === 'success'
      ? (g?.okFill ?? c.accent)
      : tone === 'warning'
        ? (g?.warnFill ?? c.warnText)
        : tone === 'destructive'
          ? (g?.dangerFill ?? c.critText)
          : tone === 'muted'
            ? c.ink4
            : c.ink;
  return (
    <GlassStatusCapsule label={label} dot={dot} accessibilityLabel={`Sync status: ${label}`} />
  );
}

/** "Main Warehouse · Monday, Nov 2": the workspace and the long date under the title. */
export function GlassHomeSubline({ orgName, now }: { orgName: string; now: Date }) {
  const day = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  return <GlassSubline>{`${orgName} · ${day}`}</GlassSubline>;
}

/**
 * The scan card as the board's hero group ("NEXT FOR YOU"): a tile and the
 * eyebrow over the title, the line of copy, and the primary button's look.
 * The card stays one control (Classic's Pressable around it).
 */
export function GlassScanHero() {
  const { c, g, font } = useTheme();
  return (
    <>
      <View style={styles.heroHead}>
        <GlassTile icon={Barcode} fill={g?.accent ?? c.accent} />
        <View style={styles.heroTitles}>
          <Text
            maxFontSizeMultiplier={capTo(12, TYPE_CEILING.eyebrow)}
            style={[font.displaySemi, styles.heroEyebrow, { color: c.ink3 }]}
          >
            QUICK ADJUST
          </Text>
          <Text
            maxFontSizeMultiplier={capTo(19, TYPE_CEILING.display)}
            style={[font.displaySemi, styles.heroTitle, { color: c.ink }]}
          >
            Scan to adjust stock.
          </Text>
        </View>
      </View>
      <Body size={15} color={c.ink2}>
        Point at a barcode, QR, or rack tag. Stock moves before you put the phone down.
      </Body>
      <GlassButtonLook label="Open scanner" icon={Barcode} />
    </>
  );
}

/** The four figures as grouped glass tiles, two by two; a failed read says so in a card. */
export function GlassHomeFigures({
  figures,
  value,
  errorText,
}: {
  figures: { itemCount: number; lowStockCount: number; outOfStockCount: number } | null;
  value: { value: string; unit: string };
  errorText: string;
}) {
  if (!figures) {
    return (
      <Card padding={16}>
        <Body size={14.5} accessibilityRole="alert">
          {errorText}
        </Body>
      </Card>
    );
  }
  return (
    <View style={styles.grid}>
      <View style={styles.cell}>
        <StatCard label="ITEMS" value={figures.itemCount.toLocaleString()} unit="SKUs" />
      </View>
      <View style={styles.cell}>
        <StatCard label="VALUE" value={value.value} unit={value.unit} />
      </View>
      <View style={styles.cell}>
        <StatCard label="LOW" value={figures.lowStockCount.toLocaleString()} unit="SKUs" />
      </View>
      <View style={styles.cell}>
        <StatCard label="OUT" value={figures.outOfStockCount.toLocaleString()} unit="SKUs" />
      </View>
    </View>
  );
}

/**
 * A recent movement as the board's Today row (.ios-row with an .ios-tile):
 * the in/out/zero tile, the item name, the verb, reason and time, the change
 * in its tone, and the chevron. The whole row opens the item, as in Classic.
 */
export function GlassMovementRow({
  itemName,
  detail,
  quantityChange,
  divider,
  onPress,
}: {
  itemName: string;
  detail: string;
  quantityChange: number;
  divider: boolean;
  onPress: () => void;
}) {
  const { c, g, ios, font, type } = useTheme();
  const isAdd = quantityChange > 0;
  const isSub = quantityChange < 0;
  const Icon = isAdd ? Plus : isSub ? Minus : RotateCcw;
  const fill = isAdd
    ? (g?.accent ?? c.accent)
    : isSub
      ? (g?.dangerFill ?? c.critText)
      : (g?.warnFill ?? c.warnText);
  const ink = isAdd ? (g?.accentText ?? c.accent) : isSub ? c.critText : c.warnText;
  const row = type?.row ?? { fontSize: 16, lineHeight: 21 };
  const sub = type?.rowSub ?? { fontSize: 13, lineHeight: 17 };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: g?.selFill ?? c.accentWash },
      ]}
    >
      <GlassTile icon={Icon} fill={fill} />
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[font.displayRegular, row, { color: c.ink }]}>
          {itemName}
        </Text>
        <Text numberOfLines={2} style={[font.displayRegular, sub, { color: c.ink3 }]}>
          {detail}
        </Text>
      </View>
      <Text style={[font.displaySemi, styles.qty, { color: ink }]}>
        {isAdd ? '+' : ''}
        {quantityChange}
      </Text>
      <ChevronRight size={14} color={ios?.l2 ?? c.ink4} strokeWidth={1.8} />
      {divider ? (
        <View style={[styles.separator, { backgroundColor: g?.line2 ?? c.hair }]} />
      ) : null}
    </Pressable>
  );
}

/** Home's layout in Liquid Glass (iOS-Home.dc.html, sp.css .ios-nav / .ios-scroll / .ios-group). */
export const GLASS_HOME = StyleSheet.create({
  // .ios-nav: 16 side padding, 10 between its buttons, 52 tall.
  nav: {
    paddingHorizontal: 16,
    minHeight: 52,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  navGroup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  // The title block (.col.g2, margin-top 2) at the scroll's 16pt edge.
  head: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 14, gap: 2 },
  title: { marginTop: 0 },
  // .ios-scroll: 16 sides, 22 between sections; the tab bar's room below.
  scroll: { paddingTop: 4, gap: 22 },
  block: { paddingHorizontal: 16 },
  // .ios-group.hero-glass: padding 18, 14 between its parts.
  hero: { padding: 18, gap: 14 },
  section: { paddingHorizontal: 16, gap: 8 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  seeAll: { minHeight: 44, minWidth: 44, paddingHorizontal: 4, justifyContent: 'center' },
});

const styles = StyleSheet.create({
  heroHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heroTitles: { flex: 1, minWidth: 0 },
  heroEyebrow: { fontSize: 12, lineHeight: 16, letterSpacing: 12 * 0.02 },
  heroTitle: { fontSize: 19, lineHeight: 24, fontWeight: '700', letterSpacing: -0.3 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cell: { flexBasis: '47%', flexGrow: 1 },
  row: {
    minHeight: 56,
    paddingVertical: 10,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowBody: { flex: 1, minWidth: 0 },
  qty: { fontSize: 17, fontVariant: ['tabular-nums'], letterSpacing: 0 },
  // .ios-row + .ios-row::before with --sep-l 58 (16 padding, 30 tile, 12 gap).
  separator: {
    position: 'absolute',
    left: 58,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
});
