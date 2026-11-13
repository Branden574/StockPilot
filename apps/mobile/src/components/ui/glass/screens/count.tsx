import * as React from 'react';
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';

import { TYPE_CEILING, capTo } from '../../../../lib/theme';
import { GLASS_METRICS } from '../metrics';
import { INPUT_LINE } from '../primitive-styles';
import type { GlassLook } from '../use-glass';

/**
 * A cycle count in Liquid Glass, from the iOS Count board (iOS-Count.dc.html;
 * sp.css line numbers in brackets). Used only inside the screen's `lg`
 * branches, each laid over Classic's own style at the place it is used (the
 * screen keeps one module-level style set), so Classic never reaches this
 * file.
 *
 *   nav      Back as a 44pt glass circle, the count's reference as the 17/600
 *            title, the sync status as the glass capsule (.ios-nav [700]);
 *   title    where the count is at 24/700 over the progress line (.col.g2);
 *   lines    one grouped surface (.ios-group [708]) of 56pt rows: the name at
 *            16/21, the sub-lines at 13/17, the count box at the right as a
 *            44pt well with the 19pt 700 tabular figure;
 *   footer   the board's entry card (.keypad.glass-strong [776]): 8pt in
 *            from the edges, radius 34, the strong glass material, and Post
 *            as the iOS primary button.
 *
 * The board's on-screen keypad, Skip and "Save on phone" are not drawn: each
 * line keeps its own count box with the system number pad and the screen's
 * draft saver (a count is saved on this phone as it is typed), so the
 * workflow is the one Classic has (brief section 10; recorded on the row).
 */

const memo = new WeakMap<GlassLook, ReturnType<typeof build>>();

/** The glass values for the count screen's style keys, one set per look. */
export function glassCountStyles(lg: GlassLook) {
  let hit = memo.get(lg);
  if (!hit) {
    hit = build(lg);
    memo.set(lg, hit);
  }
  return hit;
}

function build(lg: GlassLook) {
  const regular = (size: number, line: number, color: string): TextStyle => ({
    ...lg.font.displayRegular,
    fontSize: size,
    lineHeight: line,
    letterSpacing: 0,
    color,
  });
  const semi = (size: number, color: string): TextStyle => ({
    ...lg.font.displaySemi,
    fontSize: size,
    letterSpacing: 0,
    color,
  });
  const capsule: ViewStyle = {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 22,
    borderWidth: 0,
    backgroundColor: lg.ios.fill,
  };
  return StyleSheet.create({
    // The header loses its rule: the nav and the title sit on the scene.
    header: {
      paddingHorizontal: 16,
      paddingTop: 0,
      paddingBottom: 12,
      borderBottomWidth: 0,
    },
    nav: {
      height: GLASS_METRICS.nav.height,
      flexDirection: 'row',
      alignItems: 'center',
      gap: GLASS_METRICS.nav.gap,
    },
    // .ios-nav .ttl [701]: 17/600, -0.4, centred.
    navTitle: {
      ...semi(17, lg.c.ink),
      letterSpacing: -0.4,
      flex: 1,
      textAlign: 'center',
    },
    headerRow: {
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: 10,
      marginTop: 6,
    },
    // The board's title: 24/700, -0.3.
    placeTitle: {
      ...lg.font.displaySemi,
      fontWeight: '700',
      fontSize: 24,
      lineHeight: 29,
      letterSpacing: -0.3,
      color: lg.c.ink,
    },
    // Its line (13, tabular; ink-3: --ios-l2 is under AA over the scene).
    placeSub: { ...regular(13, 18, lg.c.ink3), fontVariant: ['tabular-nums'], marginTop: 2 },
    scanRow: { gap: 8 },
    // AI Scan, Scan, Release, Reassign: the iOS gray capsules.
    capsule: { ...capsule, minWidth: 0 },
    capsuleLabel: semi(15, lg.c.ink),
    lockedNote: { ...regular(13, 17, lg.c.ink3), maxWidth: undefined, textAlign: 'left' },
    badgeRow: { marginTop: 10 },
    badgeActions: { gap: 8 },
    // The conflict note as a grouped card on the warning wash.
    conflictBanner: {
      marginHorizontal: 16,
      marginBottom: 8,
      borderRadius: 16,
      borderBottomWidth: 0,
      paddingHorizontal: 14,
    },
    conflictText: regular(13, 18, lg.c.ink),
    conflictDismiss: semi(13, lg.g.warn),
    expectedHint: { ...regular(13, 18, lg.c.ink3), marginHorizontal: 4, marginBottom: 12 },
    linkedNote: { ...regular(13, 18, lg.c.ink3), marginHorizontal: 4 },
    // .ios-row [709]: 56pt rows, 10/16 padding, 12 between.
    line: {
      minHeight: GLASS_METRICS.row.minHeight,
      paddingVertical: GLASS_METRICS.row.paddingVertical,
      paddingHorizontal: GLASS_METRICS.row.paddingHorizontal,
      gap: GLASS_METRICS.row.gap,
      alignItems: 'center',
    },
    itemName: { ...regular(16, 21, lg.c.ink) },
    itemVariant: { ...semi(13, lg.c.ink2), lineHeight: 17, marginTop: 1 },
    itemSku: { fontSize: 12, marginTop: 1 },
    captured: regular(13, 17, lg.c.ink3),
    expected: { ...regular(13, 17, lg.c.ink3), marginTop: 2 },
    variance: semi(13, lg.c.ink3),
    destination: regular(13, 17, lg.c.ink),
    destinationPending: regular(13, 17, lg.c.ink3),
    linkChipText: semi(12, lg.g.warn),
    linkChip: { borderRadius: 12, paddingHorizontal: 10 },
    countBox: { minWidth: 92 },
    // The count as the board's value at the right of the row, typed into a
    // 44pt well: the field fill with the 3:1 input line, radius 12, 19/700
    // tabular (.ios-stepper output [727]).
    countInput: {
      ...lg.font.displaySemi,
      fontWeight: '700',
      fontSize: 19,
      fontVariant: ['tabular-nums'],
      borderRadius: 12,
      borderWidth: 1,
      minWidth: 80,
      paddingHorizontal: 12,
    },
    // .keypad.glass-strong [776]: 8 from the sides and the foot, radius 34,
    // 16/14/14 inside; the material is a GlassSheetBackdrop drawn first.
    footer: {
      left: GLASS_METRICS.sheet.inset,
      right: GLASS_METRICS.sheet.inset,
      bottom: GLASS_METRICS.sheet.inset,
      borderRadius: 34,
      borderTopWidth: 0,
      paddingHorizontal: 14,
      paddingTop: 16,
      backgroundColor: 'transparent',
    },
    // .ios-btn.primary [716-717]: the solid accent, 50pt, radius 25.
    postBtn: {
      minHeight: GLASS_METRICS.button.minHeight,
      borderRadius: GLASS_METRICS.button.radius,
      borderWidth: 0,
      backgroundColor: lg.g.accent,
      borderColor: lg.g.accent,
    },
    postBtnText: { ...semi(17, lg.g.onAccent) },
    footerNote: regular(14, 19, lg.c.ink2),
    footerRetry: capsule,
    emptyTitle: { ...semi(20, lg.c.ink), fontWeight: '700' },
    emptyBody: regular(15, 20, lg.c.ink3),
    emptyText: regular(15, 20, lg.c.ink3),
  } satisfies Record<string, ViewStyle | TextStyle>);
}

/** The glass well colours of a count box (the screen passes Classic's inline colours first). */
export function glassCountBox(lg: GlassLook): ViewStyle {
  return {
    backgroundColor: lg.g.fieldFill,
    borderColor: INPUT_LINE[lg.mode],
  };
}

/** A count line's row on the one grouped surface (first and last carry the corners). */
export function glassCountRowEdges(lg: GlassLook, first: boolean, last: boolean): ViewStyle {
  const r = GLASS_METRICS.group.radius;
  const opaque = lg.material === 'opaque';
  const edge = opaque ? 0 : StyleSheet.hairlineWidth;
  return {
    backgroundColor: opaque ? lg.ios.card : lg.g.cardFill,
    borderColor: lg.g.cardLine,
    borderLeftWidth: edge,
    borderRightWidth: edge,
    borderTopWidth: first ? edge : 0,
    borderBottomWidth: last ? edge : 0,
    borderTopLeftRadius: first ? r : 0,
    borderTopRightRadius: first ? r : 0,
    borderBottomLeftRadius: last ? r : 0,
    borderBottomRightRadius: last ? r : 0,
  };
}

/** The separator between two rows of the group (.ios-row + .ios-row::before [1044]). */
export function GlassRowSeparator({ lg }: { lg: GlassLook }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: GLASS_METRICS.row.separatorInset,
        right: 0,
        height: StyleSheet.hairlineWidth,
        backgroundColor: lg.g.line2,
      }}
    />
  );
}

/**
 * The count's title block in glass: where it is counted at 24/700 over the
 * progress line, or what the screen knows while it is loading. The reference
 * is the nav's title above it.
 */
export function GlassCountTitle({
  lg,
  title,
  sub,
  note,
}: {
  lg: GlassLook;
  title: string;
  sub: string | null;
  note: string | null;
}) {
  const s = glassCountStyles(lg);
  return (
    <View>
      <Text
        style={s.placeTitle}
        accessibilityRole="header"
        maxFontSizeMultiplier={capTo(24, TYPE_CEILING.display)}
      >
        {title}
      </Text>
      {sub ? <Text style={s.placeSub}>{sub}</Text> : null}
      {note ? <Text style={s.placeSub}>{note}</Text> : null}
    </View>
  );
}
