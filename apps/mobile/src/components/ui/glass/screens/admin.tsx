import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';

import { TYPE_CEILING, capTo } from '../../../../lib/theme';
import { GLASS_METRICS } from '../metrics';
import { GlassHeading, GlassTile } from '../parts';
import { glassCardStyle, glassGroupRow } from '../primitive-styles';
import type { GlassLook } from '../use-glass';

import {
  GLASS_AVATAR_FILLS,
  GLASS_TILED_INSET,
  type GlassTileTone,
  glassAvatarFill,
  glassSettingTone,
  glassStackRow,
  glassSyncCountTone,
  glassTileFill,
  inkAlpha,
} from './admin-model';
import { GlassRowSeparator } from './count';
import { GLASS_ORDER_DIALOG_RADIUS } from './order';

/**
 * The phone's admin, settings and help screens in Liquid Glass (stage 4,
 * native-admin lane): admin/*, ai and ai/chat, notifications, settings and
 * its sub-screens, support, team and zendesk. Every one is an INFERRED
 * extension of the iOS boards (the iOS rules of project/sp.css, line numbers
 * in brackets; Routes-Gallery-2 for the team, audit, notification and
 * settings rows; Site-Support for the support form), except Unsent work,
 * which follows iOS-Sync.dc.html for the parts that exist.
 *
 * Used only inside the screens' `lg` branches (const lg = useGlass()), so
 * Classic never reaches this file. Every control, row, state and message a
 * screen has in Classic stays where it is; these are frames, spacing, the
 * grouped rows and the small parts the boards draw.
 */

export {
  GLASS_AVATAR_FILLS,
  GLASS_TILED_INSET,
  type GlassTileTone,
  glassAvatarFill,
  glassSettingTone,
  glassStackRow,
  glassTileFill,
  inkAlpha,
};

/** The 16pt scroll edge and the sections' rhythm (.ios-scroll [698]: 16 sides, 22 between sections). */
export const GLASS_PAGE = StyleSheet.create({
  /** A ScrollView's content: 16 from the sides (Classic: 20). */
  scroll: { paddingHorizontal: 16, paddingBottom: 60 },
  /** A section: 22 under the one before it (.ios-scroll gap). */
  section: { marginTop: 22 },
  /** A section's heading (.ios-h [706]), 8 over its group (.col.g8). */
  sectionHead: { paddingHorizontal: 0, paddingBottom: 8 },
  /** The settings row (.ios-row [709-711]): 56 min, 10/16 padding, 12 gap. */
  row: {
    minHeight: GLASS_METRICS.row.minHeight,
    paddingVertical: GLASS_METRICS.row.paddingVertical,
    paddingHorizontal: GLASS_METRICS.row.paddingHorizontal,
    gap: GLASS_METRICS.row.gap,
  },
  /** The nav when it carries a centred title (.ios-nav [700] with .ttl [701]). */
  navTitled: {
    minHeight: GLASS_METRICS.nav.height,
    paddingHorizontal: GLASS_METRICS.nav.paddingHorizontal,
    flexDirection: 'row',
    alignItems: 'center',
    gap: GLASS_METRICS.nav.gap,
  },
});

/** The row title of a tiled settings row (16/21, the system face). */
export function glassSettingTitle(lg: GlassLook): TextStyle {
  return {
    ...lg.font.displayRegular,
    fontSize: lg.type.row.fontSize,
    lineHeight: lg.type.row.lineHeight,
    letterSpacing: 0,
  };
}

/** A row's detail on the right (.ios-row .val: 16pt, --ios-l2 drawn at ink-3 for AA). */
export function glassSettingDetail(lg: GlassLook): TextStyle {
  return {
    ...lg.font.displayRegular,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0,
    color: lg.c.ink3,
  };
}

/** A person's monogram circle (Routes-Gallery-2 team rows): 36pt, white 13/600 initials. */
export function GlassMonogram({ initials, name }: { initials: string; name: string }) {
  return (
    <View
      style={[styles.monogram, { backgroundColor: glassAvatarFill(name) }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text maxFontSizeMultiplier={capTo(13, TYPE_CEILING.chrome)} style={styles.monogramText}>
        {initials}
      </Text>
    </View>
  );
}

/**
 * A list screen's row card drawn as part of ONE grouped surface (.ios-group
 * [708] with .ios-row separators [1044]), as Routes-Gallery-2 draws the team,
 * audit and notification lists. The shared list frame keeps Classic's 10pt
 * gap between rows (components/ui/glass/screens/list.tsx), so every row after
 * the first takes it back (-10 on top) and the rows meet; the first and last
 * carry the group's corners, and a .5pt separator inset 16 (or the given
 * inset) sits on top of every row after the first. The row's own card is
 * drawn bare inside it (GLASS_BARE_CARD).
 */
export function GlassJoinedRow({
  lg,
  index,
  count,
  inset,
  children,
}: {
  lg: GlassLook;
  index: number;
  count: number;
  inset?: number;
  children: React.ReactNode;
}) {
  const first = index === 0;
  const last = index === count - 1;
  return (
    <View style={[glassGroupRow(lg, { first, last }), !first && styles.joined, styles.clip]}>
      {first ? null : inset == null ? (
        <GlassRowSeparator lg={lg} />
      ) : (
        <View
          pointerEvents="none"
          style={[styles.separator, { left: inset, backgroundColor: lg.g.line2 }]}
        />
      )}
      {children}
    </View>
  );
}

/**
 * A row's own Card inside a GlassJoinedRow: no fill, edge or corner of its
 * own (the joined row draws them), the iOS row's padding (12/16; the boards'
 * two-line rows are 56-64 tall).
 */
export const GLASS_BARE_CARD: ViewStyle = {
  backgroundColor: 'transparent',
  borderWidth: 0,
  borderRadius: 0,
  paddingVertical: 12,
  paddingHorizontal: GLASS_METRICS.row.paddingHorizontal,
};

/** A centred dialog's corner: the order screen's alert card (iPad-Orders), radius 30. */
export const GLASS_DIALOG_RADIUS = GLASS_ORDER_DIALOG_RADIUS;

/**
 * A centred dialog's card: no fill or edge of its own (its material is a
 * GlassSheetBackdrop at GLASS_DIALOG_RADIUS, drawn as the card's first
 * child), the radius, overflow hidden; the order screen's dialogs draw the same.
 */
export const GLASS_DIALOG_CARD: ViewStyle = {
  backgroundColor: 'transparent',
  borderColor: 'transparent',
  borderWidth: 0,
  borderRadius: GLASS_DIALOG_RADIUS,
  overflow: 'hidden',
};

/** The words of a centred nav title (.ios-nav .ttl [701]): 17/600, -0.4. */
export function GlassNavTitle({ lg, title }: { lg: GlassLook; title: string }) {
  return (
    <Text
      accessibilityRole="header"
      numberOfLines={1}
      maxFontSizeMultiplier={capTo(17, TYPE_CEILING.chrome)}
      style={[
        lg.font.displaySemi,
        { flex: 1, textAlign: 'center', fontSize: 17, letterSpacing: -0.4, color: lg.c.ink },
      ]}
    >
      {title}
    </Text>
  );
}

const styles = StyleSheet.create({
  syncHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingBottom: 8,
  },
  syncHeadTitle: { flexShrink: 1 },
  syncPill: { minHeight: 24, borderRadius: 12, paddingHorizontal: 9, justifyContent: 'center' },
  syncCount: { fontSize: 13, lineHeight: 18, letterSpacing: 0, fontVariant: ['tabular-nums'] },
  record: { paddingVertical: 14, paddingHorizontal: 16, gap: 10 },
  recordHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  recordText: { flex: 1, minWidth: 0 },
  recordTitle: { fontSize: 16, lineHeight: 21, letterSpacing: 0 },
  recordSub: { fontSize: 13, lineHeight: 17, letterSpacing: 0 },
  recordMessage: { fontSize: 14, lineHeight: 20, letterSpacing: 0 },
  recordButton: {
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: 18,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordButtonText: { fontSize: 15, letterSpacing: 0 },
  joined: { marginTop: -10 },
  clip: { overflow: 'hidden' },
  separator: { position: 'absolute', top: 0, right: 0, height: StyleSheet.hairlineWidth },
  monogram: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  monogramText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0,
  },
});

/**
 * Customize tab bar's live preview drawn as the IosTabBar capsule
 * (IosTabBar.dc.html; lib/appearance/tab-bar.ts GLASS_IOS_TAB_BAR): radius
 * 32, 64 tall, 5 in; each tab 54 tall at radius 27, the chosen one on the
 * ink 8% fill with its glyph and words in the accent ink.
 */
export const GLASS_TAB_PREVIEW = StyleSheet.create({
  card: { borderRadius: 32 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingHorizontal: 5 },
  tab: { height: 54, borderRadius: 27, justifyContent: 'center', gap: 2 },
});

/** A reorder, add or remove control on a customize row: the iOS fill circle, no ring. */
export function glassControlChip(lg: GlassLook): ViewStyle {
  return { borderWidth: 0, borderRadius: 15, backgroundColor: lg.ios.fill };
}

/**
 * Unsent work in Liquid Glass, from iOS-Sync.dc.html (exact for the parts
 * that exist; the combined Sync screen, its status group and per-row Remove
 * are [Proposed] and not built). A section head is the board's row: the
 * .ios-h heading with its count at the right, as the board's .ios-sub
 * figure ("Waiting to send", 3 of 3) or its tinted .ios-pill ("Needs
 * checking", 2).
 */
export function GlassSyncSectionHead({
  lg,
  title,
  count,
  tone,
}: {
  lg: GlassLook;
  title: string;
  count: number;
  tone?: 'warn' | 'danger';
}) {
  const { wash, ink } = glassSyncCountTone(lg, tone);
  return (
    <View style={styles.syncHead}>
      <GlassHeading style={styles.syncHeadTitle}>{title}</GlassHeading>
      <View
        style={wash ? [styles.syncPill, { backgroundColor: wash }] : undefined}
        accessibilityLabel={`${count}`}
      >
        <Text
          maxFontSizeMultiplier={capTo(13, TYPE_CEILING.chrome)}
          style={[
            lg.font.displaySemi,
            styles.syncCount,
            { color: ink, fontWeight: wash ? '600' : '400' },
          ]}
        >
          {count}
        </Text>
      </View>
    </View>
  );
}

/**
 * One record of unsent work as the board's "Needs checking" card (an
 * .ios-group with padding 14/16 and 10 between its parts): the coloured
 * tile (warn-fill for a change that may have been applied, danger-fill for a
 * refusal, the accent for work held for another account), the 600 title over
 * its 13pt sub-line, the message at 14/20 in ink-2, and the record's one
 * action, Discard, as the board's gray .ios-btn (44pt) in the refusal red.
 */
export function GlassSyncRecord({
  lg,
  icon,
  tone,
  title,
  sub,
  message,
  action,
}: {
  lg: GlassLook;
  icon: LucideIcon;
  tone: 'warn' | 'danger' | 'accent';
  title: string;
  sub: string;
  message?: string | null;
  action?: { label: string; accessibilityLabel: string; onPress: () => void } | null;
}) {
  const fill = tone === 'warn' ? lg.g.warnFill : tone === 'danger' ? lg.g.dangerFill : lg.g.accent;
  return (
    <View style={[glassCardStyle(lg), styles.record]}>
      <View style={styles.recordHead}>
        <GlassTile icon={icon} fill={fill} />
        <View style={styles.recordText}>
          <Text style={[lg.font.displaySemi, styles.recordTitle, { color: lg.c.ink }]}>
            {title}
          </Text>
          <Text style={[lg.font.displayRegular, styles.recordSub, { color: lg.c.ink3 }]}>
            {sub}
          </Text>
        </View>
      </View>
      {message ? (
        <Text style={[lg.font.displayRegular, styles.recordMessage, { color: lg.c.ink2 }]}>
          {message}
        </Text>
      ) : null}
      {action ? (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.accessibilityLabel}
          style={({ pressed }) => [
            styles.recordButton,
            { backgroundColor: lg.ios.fill, transform: [{ scale: pressed ? 0.97 : 1 }] },
          ]}
        >
          <Text
            maxFontSizeMultiplier={capTo(15, TYPE_CEILING.control)}
            style={[lg.font.displaySemi, styles.recordButtonText, { color: lg.c.critText }]}
          >
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The groups of records: each record its own card, 10 apart; no surface of their own. */
export const GLASS_SYNC_LIST: ViewStyle = {
  backgroundColor: 'transparent',
  borderWidth: 0,
  gap: 10,
};

/**
 * Support & feedback (inferred: Site-Support.dc.html's form as a native
 * grouped form): the glass nav (.ios-nav [700], no rule under it) with the
 * centred 17/600 title, a spacer as wide as the two 44pt circles and their
 * 10pt gap, and the attached screenshot on the iOS fill.
 */
export const GLASS_SUPPORT = StyleSheet.create({
  nav: {
    minHeight: GLASS_METRICS.nav.height,
    paddingHorizontal: GLASS_METRICS.nav.paddingHorizontal,
    paddingTop: 0,
    paddingBottom: 0,
    gap: GLASS_METRICS.nav.gap,
    borderBottomWidth: 0,
  },
  navTitle: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.4 },
  spacer: { width: GLASS_METRICS.circle.size * 2 + GLASS_METRICS.nav.gap },
  attach: { borderWidth: 0, borderRadius: 14 },
});

/** The AI assistant's hero mark (inferred): the 88pt well on the iOS fill at radius 22, no ring. */
export function glassHeroWell(lg: GlassLook): ViewStyle {
  return { borderWidth: 0, borderRadius: 22, backgroundColor: lg.ios.fill };
}
