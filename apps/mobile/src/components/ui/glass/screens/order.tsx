import * as React from 'react';
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';

import { TYPE_CEILING, capTo } from '../../../../lib/theme';
import { GLASS_METRICS } from '../metrics';
import { INPUT_LINE } from '../primitive-styles';
import type { GlassLook } from '../use-glass';

/**
 * An order in Liquid Glass, from the iOS Order board (iOS-Order.dc.html, the
 * pick; iOS-NotifyFlow.dc.html step 3, the order a notification opens; sp.css
 * line numbers in brackets). Used only inside the order screen's and the pick
 * workspace's `lg` branches; Classic never reaches this file.
 *
 *   nav      Back as a 44pt glass circle, the order number as the 17/600
 *            title ("Pick SO-000229" while it is picked) and the status as
 *            the board's 26pt badge at the right;
 *   head     the requester at 22/700 over the charter or site line in 13
 *            (NotifyFlow step 3);
 *   cards    every section the screen already draws on the shared Card,
 *            which is the grouped glass surface in Liquid Glass; the screen's
 *            action buttons as iOS buttons, its dialogs and sheets on the
 *            overlay glass;
 *   pick     a first card with the line and unit counts over the board's
 *            progress bar, then each line as the board's pick card
 *            (.pick-card [772]): the name at 16/600, the SKU line, the
 *            quantity box in the stepper's place and shape (.ios-stepper
 *            [725-727]), "of N", the Picked and Short states' ring, and Save
 *            as an iOS capsule; Fill all as requested as the tinted capsule;
 *            and Complete picking as the iOS primary button.
 *
 * Not drawn, and why (recorded on the row): the board's −/+ stepper buttons
 * and per-line "Pick all N" (Classic has the typed box and one "Fill all as
 * requested"; a glass-only button would be an action Classic lacks), the
 * bin chip and the line photo (the pick workspace does not load them), and
 * the floating Finish bar (the pick is one part of the order screen's
 * scroll, so Complete picking stays at the end of its lines).
 */

/** The status badge at the nav's right (NotifyFlow step 3: 26 tall). */
export const GLASS_NAV_BADGE: ViewStyle = { minHeight: 26 };

/** The dialogs' corner (the sheet's material at the alert card's radius). */
export const GLASS_ORDER_DIALOG_RADIUS = 30;
const DIALOG_RADIUS = GLASS_ORDER_DIALOG_RADIUS;

const memo = new WeakMap<GlassLook, ReturnType<typeof build>>();

export function glassOrderStyles(lg: GlassLook) {
  let hit = memo.get(lg);
  if (!hit) {
    hit = build(lg);
    memo.set(lg, hit);
  }
  return hit;
}

function build(lg: GlassLook) {
  const opaque = lg.material === 'opaque';
  const group: ViewStyle = {
    borderRadius: GLASS_METRICS.group.radius,
    borderWidth: opaque ? 0 : StyleSheet.hairlineWidth,
    borderColor: lg.g.cardLine,
    backgroundColor: opaque ? lg.ios.card : lg.g.cardFill,
  };
  const semi = (size: number, color: string): TextStyle => ({
    ...lg.font.displaySemi,
    fontSize: size,
    letterSpacing: 0,
    color,
  });
  return StyleSheet.create({
    // .ios-nav [700].
    nav: {
      height: GLASS_METRICS.nav.height,
      paddingHorizontal: GLASS_METRICS.nav.paddingHorizontal,
      paddingTop: 0,
      flexDirection: 'row',
      gap: GLASS_METRICS.nav.gap,
      alignItems: 'center',
    },
    navTitle: {
      ...semi(17, lg.c.ink),
      letterSpacing: -0.4,
      flex: 1,
      textAlign: 'center',
    },
    // .ios-scroll [698]: 16 from the sides, 16 between the sections.
    scroll: { paddingHorizontal: 16, paddingBottom: 60, gap: 16 },
    // .pick-card [772]: the grouped glass card, 14/14/12, 12 between.
    pickCard: {
      ...group,
      paddingTop: 14,
      paddingHorizontal: 14,
      paddingBottom: 12,
      gap: 10,
    },
    pickName: { ...semi(16, lg.c.ink), lineHeight: 21 },
    // .ios-stepper output [725-727]: 44 tall, radius 22, 19/700 tabular, on
    // the field fill with the 3:1 input line.
    pickQty: {
      ...lg.font.displaySemi,
      fontWeight: '700',
      fontSize: 19,
      fontVariant: ['tabular-nums'],
      borderRadius: 22,
      borderColor: INPUT_LINE[lg.mode],
      backgroundColor: lg.g.fieldFill,
    },
    pickOf: { ...lg.font.displayRegular, fontSize: 15, letterSpacing: 0 },
    // Save: an iOS capsule, tinted while the line has unsaved changes.
    saveCapsule: {
      borderRadius: 22,
      borderWidth: 0,
      paddingHorizontal: 16,
      backgroundColor: lg.ios.fill,
    },
    saveCapsuleDirty: { backgroundColor: lg.g.accentWash },
    saveLabel: semi(15, lg.c.ink),
    saveLabelDirty: semi(15, lg.g.accentText),
    // Fill all as requested: the board's tinted capsule (.ios-capsule, accent wash).
    fillAll: {
      minHeight: 44,
      paddingHorizontal: 16,
      borderRadius: 22,
      backgroundColor: lg.g.accentWash,
      justifyContent: 'center',
    },
    fillAllLabel: semi(15, lg.g.accentText),
    // .ios-btn.primary [716-717]: the solid accent, 50pt, radius 25.
    complete: {
      minHeight: GLASS_METRICS.button.minHeight,
      borderRadius: GLASS_METRICS.button.radius,
      backgroundColor: lg.g.accent,
    },
    completeLabel: semi(17, lg.g.onAccent),
    // The muted "Being picked by another picker." card.
    lockedCard: { ...group, padding: 16 },
    // A line whose saved quantity covers it, or falls short of it, after the
    // pick (.pick-card.done / .short [773-774]: a 2pt inset ring).
    pickDone: { borderWidth: 2, borderColor: lg.g.ok },
    pickShort: { borderWidth: 2, borderColor: lg.g.warn },
    // The pick's first card (the board's padding 16, gap 10).
    pickHead: { ...group, padding: 16, gap: 10 },
    pickHeadLine: {
      ...lg.font.displayRegular,
      fontSize: 13,
      lineHeight: 18,
      letterSpacing: 0,
      fontVariant: ['tabular-nums'],
      color: lg.c.ink3,
    },
    // .prog: 8pt track, the accent over --ios-fill.
    pickTrack: { height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: lg.ios.fill },
    pickFill: { height: '100%', borderRadius: 4, backgroundColor: lg.g.ok },
    // The requester under the nav (NotifyFlow step 3): 22/700, 13 under it.
    headName: { marginTop: 0, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
    headLine: { marginTop: 2 },
    headBlock: { paddingTop: 0, paddingHorizontal: 4 },
    // An action button (.ios-btn [716]): 50pt, radius 25, no edge.
    addBtn: {
      minHeight: GLASS_METRICS.button.minHeight,
      borderRadius: GLASS_METRICS.button.radius,
      paddingHorizontal: GLASS_METRICS.button.paddingHorizontal,
    },
    actionLabel: { ...semi(17, lg.c.ink), lineHeight: 22 },
    // Every action: no edge of its own.
    actionEdge: { borderWidth: 0, borderColor: 'transparent' },
    // Secondary actions: .ios-btn.gray.
    outline: { backgroundColor: lg.ios.fill, borderWidth: 0, borderColor: 'transparent' },
    // A typed reason or note: the field fill with the 3:1 input line.
    reasonInput: {
      ...lg.font.displayRegular,
      borderRadius: 12,
      letterSpacing: 0,
      borderColor: INPUT_LINE[lg.mode],
      backgroundColor: lg.g.fieldFill,
    },
    // A centred dialog (the signature, Deny and Reopen dialogs): the
    // iPad-Orders alert card, radius 30 on the overlay glass.
    dialog: {
      backgroundColor: 'transparent',
      borderRadius: DIALOG_RADIUS,
      overflow: 'hidden',
    },
    // The photo tiles and the signature frame keep their photo ground.
    tile: { borderRadius: 14, borderColor: lg.g.cardLine },
  });
}

/**
 * What the board's nav and pick head say, from the words Classic already
 * draws: the number alone when the order has one, "Pick " before it while the
 * pick workspace is open.
 */
export function glassOrderTitle(number: string | null, picking: boolean): string {
  if (!number) return picking ? 'Pick' : 'Order';
  return picking ? `Pick ${number}` : number;
}

/** "1 of 5 lines · 5 of 40 units": the pick's progress, from the typed quantities. */
export function pickProgress(lines: readonly { requested: number; picked: number }[]) {
  const totalUnits = lines.reduce((n, l) => n + l.requested, 0);
  const units = lines.reduce((n, l) => n + Math.min(l.picked, l.requested), 0);
  const doneLines = lines.filter((l) => l.requested > 0 && l.picked >= l.requested).length;
  return {
    line: `${doneLines} of ${lines.length} lines \u00B7 ${units} of ${totalUnits} units`,
    units,
    totalUnits,
    ratio: totalUnits > 0 ? units / totalUnits : 0,
  };
}

/** The nav's title: the order as the board writes it ("Pick SO-000229" while it is picked). */
export function GlassOrderNavTitle({ lg, title }: { lg: GlassLook; title: string }) {
  return (
    <Text
      accessibilityRole="header"
      numberOfLines={1}
      maxFontSizeMultiplier={capTo(17, TYPE_CEILING.chrome)}
      style={glassOrderStyles(lg).navTitle}
    >
      {title}
    </Text>
  );
}

/** The pick's first card: the line and unit counts over the board's bar. */
export function GlassPickHead({
  lg,
  lines,
}: {
  lg: GlassLook;
  lines: readonly { requested: number; picked: number }[];
}) {
  const s = glassOrderStyles(lg);
  const { line, units, totalUnits, ratio } = pickProgress(lines);
  return (
    <View style={s.pickHead}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Units picked"
        accessibilityValue={{ min: 0, max: totalUnits, now: units }}
        style={s.pickTrack}
      >
        <View style={[s.pickFill, { width: `${Math.round(ratio * 100)}%` }]} />
      </View>
      <Text style={s.pickHeadLine}>{line}</Text>
    </View>
  );
}

/** The ring a saved line takes: covered in ok, short in warn, none while it is open. */
export function glassPickRing(lg: GlassLook, savedQty: number, requested: number) {
  const s = glassOrderStyles(lg);
  if (requested <= 0 || savedQty <= 0) return null;
  return savedQty >= requested ? s.pickDone : s.pickShort;
}
