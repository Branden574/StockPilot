import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { StyleSheet, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTheme } from '../../../../lib/use-theme';
import { GlassBackdrop } from '../glass-backdrop';
import { GLASS_METRICS } from '../metrics';
import { GLASS_CIRCLE, glassFieldBox, glassFieldInput, glassGroupRow } from '../primitive-styles';
import type { GlassLook } from '../use-glass';

/**
 * The operations screens in Liquid Glass (stage 4, native-ops lane): bundles,
 * categories, customers, exceptions, locations, maintenance, movements, PO
 * imports, procedures, purchase orders, recurring POs, rentals, reports and
 * Book Order Totals, returns and the return workbench, schedule, staging,
 * suppliers, tags and the group and ungroup reviews.
 *
 * None of these screens is drawn on a board: each is an INFERRED extension
 * (COVERAGE.md "Native screens"), composed from the iOS boards' parts
 * (project/sp.css; line numbers in brackets) and the web panels of
 * Routes-Gallery-1/-2, Reports, Book-Order-Totals and Return-Detail:
 *
 *   frame     the scene behind, the 52pt nav with 44pt glass circles, the
 *             large title over its line (the list frame's GLASS_LIST, reused
 *             as it is), or on a record the 17/600 nav title between the
 *             circles (screens/po.tsx GlassPoNavTitle, reused);
 *   surfaces  every Card is the grouped glass surface (ui/card.tsx); a
 *             screen's own wells, capsules and bars take the values below;
 *   sheets    the one sheet frame the core flows use (glass-sheet-frames
 *             guard): the --scrim tint, the card 8pt in at radius 36 with
 *             the glass-strong material as its first child, the --ios-sep
 *             grabber.
 *
 * Used only inside the screens' `lg` branches; Classic never reaches here.
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

/** The boards' side margin and the gap between sections (.ios-scroll [698]). */
export const OPS_SIDE = 16;
export const OPS_SECTION_GAP = 22;

export const GLASS_OPS = StyleSheet.create({
  /** A screen's scroll content: 16 from the sides, 10 under the head (the list frame's top). */
  scroll: { paddingHorizontal: OPS_SIDE, paddingTop: 10 },
  /** The head of a record screen: the title block 4pt in, 2 under the nav. */
  recordHead: {
    paddingHorizontal: OPS_SIDE + GLASS_METRICS.largeTitle.marginHorizontal,
    paddingTop: 2,
  },
  /** A bar of controls under a head (segments, a search): 16 from the sides. */
  controls: { paddingHorizontal: OPS_SIDE },
});

/**
 * An icon well in a row (Reports, Routes-Gallery categories and exceptions):
 * the iOS fill, radius 10, no ring; the opaque material draws it on the
 * opaque fill the same way (the token already is opaque there).
 */
export const glassIconWell = cached((lg): ViewStyle => ({
  backgroundColor: lg.ios.fill,
  borderWidth: 0,
  borderColor: 'transparent',
  borderRadius: 10,
}));

/**
 * A small secondary control drawn as Classic's bordered pill (a header
 * action, "Full report on web"): the iOS gray capsule (.ios-btn.gray [719]),
 * the fill with no ring, fully rounded. Its words keep Classic's colour (ink).
 */
export const glassGrayCapsule = cached((lg): ViewStyle => ({
  backgroundColor: lg.ios.fill,
  borderWidth: 0,
  borderColor: 'transparent',
  borderRadius: 999,
}));

/**
 * A bar pinned to the screen's foot (a submit bar, a selection bar): Classic
 * paints it on the page colour behind a hairline; Liquid Glass lifts it off
 * the scene as the floating action bar (.item-actions [768]: 16 from the
 * sides, radius 32), its material a GlassBackdrop drawn first inside it.
 */
export const GLASS_FOOT_BAR: ViewStyle = {
  backgroundColor: 'transparent',
  borderTopWidth: 0,
  marginHorizontal: GLASS_METRICS.actionBar.left,
  marginBottom: 8,
  paddingHorizontal: OPS_SIDE,
  borderRadius: GLASS_METRICS.actionBar.radius,
  overflow: 'hidden',
};

/**
 * One list row drawn as a piece of one grouped surface (.ios-group [708])
 * where a screen draws its rows itself in one column: the content fill, the
 * corners and edge only at the group's two ends.
 */
export function glassOpsGroupRow(lg: GlassLook, first: boolean, last: boolean): ViewStyle {
  return glassGroupRow(lg, { first, last });
}

/** The separator between two rows of a group, 16 in (.ios-row + .ios-row::before [1044]). */
export function GlassOpsSeparator({ lg }: { lg: GlassLook }) {
  return (
    <View
      pointerEvents="none"
      style={{
        height: StyleSheet.hairlineWidth,
        marginLeft: GLASS_METRICS.row.separatorInset,
        backgroundColor: lg.g.line2,
      }}
    />
  );
}

/**
 * A state note a screen shows above its content (a stale read, a refusal):
 * the boards' status line (.ios-group with its tint, padding 12 14, radius
 * 24), on the wash of its tone.
 */
export const GLASS_NOTE: ViewStyle = {
  borderRadius: GLASS_METRICS.group.radius,
  paddingVertical: 12,
  paddingHorizontal: 14,
  borderWidth: 0,
};

/** A header action as the small iOS gray capsule (36pt; the frame round it stays 44). */
export const GLASS_HEADER_ACTION: ViewStyle = {
  minHeight: 36,
  paddingHorizontal: 14,
  paddingVertical: 6,
};

/**
 * A screen's own top bar in glass (.ios-nav [700]): 52 tall, 16 from the
 * sides, its controls 10 apart, no rule under it (the boards' nav floats on
 * the scene). For a bar Classic draws with a hairline under it.
 */
export const GLASS_OPS_NAV: ViewStyle = {
  minHeight: GLASS_METRICS.nav.height,
  paddingHorizontal: GLASS_METRICS.nav.paddingHorizontal,
  paddingTop: 0,
  paddingBottom: 0,
  flexDirection: 'row',
  alignItems: 'center',
  gap: GLASS_METRICS.nav.gap,
  borderBottomWidth: 0,
};

/** A nav button Classic draws as words ("← Back"): the 44pt glass circle's frame. */
export const GLASS_NAV_CIRCLE: ViewStyle = {
  ...GLASS_CIRCLE,
  minWidth: GLASS_METRICS.circle.size,
  minHeight: GLASS_METRICS.circle.size,
  marginVertical: 0,
  paddingHorizontal: 0,
};

/** A nav button with words (Refresh, Save): the 44pt glass capsule (.ios-capsule.glass [705]). */
export const GLASS_NAV_CAPSULE: ViewStyle = {
  minHeight: GLASS_METRICS.circle.size,
  borderRadius: GLASS_METRICS.circle.size / 2,
  paddingHorizontal: 16,
  marginVertical: 0,
  overflow: 'hidden',
};

/**
 * The nav's title between its circles (.ios-nav .ttl [701]): 17/600, -0.4,
 * centred. Laid over a screen's own Display title, which keeps its element.
 */
export const GLASS_NAV_TITLE: TextStyle = {
  flex: 1,
  textAlign: 'center',
  fontSize: 17,
  lineHeight: 22,
  letterSpacing: -0.4,
  fontWeight: '600',
};

/**
 * What a nav button Classic draws as words shows in glass: the round glass
 * circle with the boards' 20pt glyph. Decoration inside the existing button,
 * which keeps its element, its name for VoiceOver and its action.
 */
export function GlassCircleLook({ icon: Icon }: { icon: LucideIcon }) {
  const { c } = useTheme();
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={GLASS_CIRCLE}
    >
      <GlassBackdrop variant="floating" radius={GLASS_METRICS.circle.size / 2} />
      <Icon size={GLASS_METRICS.circle.iconSize} color={c.ink} strokeWidth={1.8} />
    </View>
  );
}

/** The floating glass behind a nav capsule's own words, drawn as its first child. */
export function GlassCapsuleBackdrop() {
  return <GlassBackdrop variant="floating" radius={GLASS_METRICS.circle.size / 2} />;
}

/**
 * A record screen's head Classic draws as a column under a rule (Back over
 * the title): in glass the column sits on the scene 16 from the sides, no
 * rule, Back as the 44pt glass circle 10 above the title (iOS-Item: the
 * circle in the nav, the name under it).
 */
export const GLASS_RECORD_HEADER: ViewStyle = {
  paddingHorizontal: OPS_SIDE,
  paddingTop: 4,
  paddingBottom: 10,
  borderBottomWidth: 0,
};
export const GLASS_RECORD_BACK: ViewStyle = {
  ...GLASS_NAV_CIRCLE,
  alignSelf: 'flex-start',
  marginTop: 0,
  marginBottom: 10,
};

/** A section's heading over its group (.ios-h [706] in a .col.g8 section, 22 apart). */
export const GLASS_SECTION_HEADING: TextStyle = { marginTop: OPS_SECTION_GAP - 8, marginBottom: 8 };

/** The floating glass behind a foot bar's own words and buttons, drawn as its first child. */
export function GlassFootBackdrop() {
  return <GlassBackdrop variant="floating" radius={GLASS_METRICS.actionBar.radius} />;
}

/** The row of segments or chips under a list head: 16 from the sides, 14 under the title block. */
export const GLASS_TABS_WRAP: ViewStyle = { paddingHorizontal: OPS_SIDE, paddingTop: 14 };

/** A screen's create action in the nav (New): the small accent iOS button (.ios-btn.primary, 36pt, fully rounded). */
export const glassNavPrimary = cached((lg): ViewStyle => ({
  backgroundColor: lg.g.accent,
  minHeight: 36,
  borderRadius: 18,
  paddingHorizontal: 14,
}));
export const glassNavPrimaryLabel = cached((lg): TextStyle => ({
  ...lg.font.displaySemi,
  fontSize: 15,
  color: lg.g.onAccent,
}));

/** The return workbench in glass: 16 from the sides, 16 between its cards; its failed panel on the group. */
export const GLASS_WORKBENCH = StyleSheet.create({
  content: { paddingHorizontal: OPS_SIDE, gap: 16 },
  failed: { marginTop: 24, marginHorizontal: OPS_SIDE, paddingTop: 32, paddingBottom: 32 },
});

/** A record screen's scroll content in glass: 16 from the sides, 10 under the nav. */
export const GLASS_RECORD_BODY: ViewStyle = { paddingHorizontal: OPS_SIDE, paddingTop: 10 };

/** A record screen's single card under the nav (a failed read, a missing workspace): 16 from the sides. */
export const GLASS_RECORD_PAD: ViewStyle = { paddingHorizontal: OPS_SIDE };

/** A multi-line text box Classic draws by hand: the glass field (field fill, the 3:1 input line, radius 12) in the system face. */
export const glassTextArea = cached(
  (lg): TextStyle => ({ ...glassFieldBox(lg, false), ...glassFieldInput(lg) }),
);
/** A read-only copy box keeps its mono words; only its frame is the glass field. */
export const glassCopyBox = cached((lg): ViewStyle => glassFieldBox(lg, false));

/** A typed box Classic draws by hand with its own colours: the glass field, the system face, ink words. */
export const glassTypedBox = cached(
  (lg): TextStyle => ({ ...glassFieldBox(lg, false), ...glassFieldInput(lg), color: lg.c.ink }),
);

/**
 * A footer Classic pins to the screen's foot on the page colour behind a
 * rule: the boards' floating action bar (.item-actions [768]): 16 from the
 * sides, 22 up, 7 round its contents, radius 32, its material a
 * GlassFootBackdrop drawn first inside it. Its own button is 50 tall, so the
 * bar is the board's 64.
 */
export const GLASS_ACTION_BAR: ViewStyle = {
  backgroundColor: 'transparent',
  borderTopWidth: 0,
  left: GLASS_METRICS.actionBar.left,
  right: GLASS_METRICS.actionBar.right,
  bottom: GLASS_METRICS.actionBar.bottom,
  paddingHorizontal: GLASS_METRICS.actionBar.paddingHorizontal,
  paddingTop: 7,
  paddingBottom: 7,
  borderRadius: GLASS_METRICS.actionBar.radius,
  overflow: 'hidden',
};

/** How far the floating bar sits off the foot: added to the room a list leaves under its rows. */
export const GLASS_ACTION_BAR_LIFT = GLASS_METRICS.actionBar.bottom;

/** A commit Classic draws as its own ink block: the iOS primary button (.ios-btn.primary [716-717]). */
export const glassAccentButton = cached(
  (lg): ViewStyle => ({
    backgroundColor: lg.g.accent,
    borderRadius: GLASS_METRICS.button.radius,
    minHeight: GLASS_METRICS.button.minHeight,
    paddingVertical: GLASS_METRICS.button.paddingVertical,
    justifyContent: 'center',
  }),
);
/** Its words: 17/600 on the accent (--on-accent). */
export const glassAccentLabel = cached(
  (lg): TextStyle => ({ ...lg.font.displaySemi, fontSize: 17, letterSpacing: 0, color: lg.g.onAccent }),
);
