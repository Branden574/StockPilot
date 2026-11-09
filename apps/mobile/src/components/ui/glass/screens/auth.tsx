import * as React from 'react';
import { StyleSheet, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTheme } from '../../../../lib/use-theme';
import { GlassSurface } from '../glass-surface';
import { GLASS_METRICS } from '../metrics';
import { INPUT_LINE } from '../primitive-styles';
import type { GlassLook } from '../use-glass';

/**
 * Sign-in and the gates in Liquid Glass (sp.css line numbers in brackets):
 *
 *   frame    the scene behind the shell's brand bar (Auth-SignIn-Mobile:
 *            the brand top left, the card 16 in from the sides);
 *   panel    the board's form card in its glass ring: an 8pt ring of
 *            overlay glass at radius 30 round a card at radius 23 on the
 *            glass-strong fill, the card's own padding 32/28/28 (stage 3's
 *            auth.glass.css on the web, so both read the same). Sign-in draws
 *            it behind its scroll's content; the account-disabled and MFA
 *            gates draw it behind the shell's content (Auth-States cards and
 *            the MFA step sit in the same card on the web);
 *   lock     the biometric lock as the NotifyFlow step 2 sheet
 *            (.ios-sheet.glass-strong [740]: 8 from the sides and the foot,
 *            radius 36, the grabber, 16 between its parts).
 *
 * Used only inside `lg` branches; Classic never reaches this file.
 */

/** The ring's width and the two corners (Auth-SignIn: ring 8, ring radius 30, card 23). */
export const GLASS_AUTH_RING = { width: 8, radius: 30, cardRadius: 23 } as const;

/** The card's own padding inside the ring (32 top, 28 sides and foot). */
const CARD_PAD = { top: 32, side: 28, bottom: 28 } as const;

export const GLASS_AUTH = StyleSheet.create({
  // The shell's content: the board's 16pt side margins (the card's ring
  // starts 16 in from the screen's edge at 390).
  content: { paddingHorizontal: 16 },
  // The panel as a scroll's content (sign-in): padding is ring + card padding.
  panel: {
    borderRadius: GLASS_AUTH_RING.radius,
    overflow: 'hidden',
    marginTop: 20,
    marginBottom: 30,
    paddingTop: GLASS_AUTH_RING.width + CARD_PAD.top,
    paddingHorizontal: GLASS_AUTH_RING.width + CARD_PAD.side,
    paddingBottom: GLASS_AUTH_RING.width + CARD_PAD.bottom,
  },
  // The panel as the shell's own content (the gates): sized to what it
  // holds, 16 in from the sides, under the brand bar.
  gatePanel: {
    flex: 0,
    marginHorizontal: 16,
    marginTop: 20,
    borderRadius: GLASS_AUTH_RING.radius,
    overflow: 'hidden',
    paddingTop: GLASS_AUTH_RING.width + CARD_PAD.top,
    paddingHorizontal: GLASS_AUTH_RING.width + CARD_PAD.side,
    paddingBottom: GLASS_AUTH_RING.width + CARD_PAD.bottom,
  },
  // The account-disabled gate's card: the panel, its parts centred
  // (Auth-States "Account disabled": .ac .tc).
  gateCard: {
    flex: 0,
    marginHorizontal: 16,
    marginTop: 20,
    borderRadius: GLASS_AUTH_RING.radius,
    overflow: 'hidden',
    alignItems: 'center',
    paddingTop: GLASS_AUTH_RING.width + CARD_PAD.top,
    paddingHorizontal: GLASS_AUTH_RING.width + CARD_PAD.side,
    paddingBottom: GLASS_AUTH_RING.width + CARD_PAD.bottom,
  },
  // A centred state card (Auth-States "Account disabled": .ac .tc, gap 14).
  centred: { alignItems: 'center' },
  // The sign-in heading block (.col.g6: the h1 over its ink-2 line).
  signHead: { marginTop: 0 },
  // The h1 (.h1 26/32, 650, -.022em) and its line 6 under it.
  h1: { fontSize: 26, lineHeight: 32, letterSpacing: -0.57, marginTop: 0 },
  h1Line: { marginTop: 6, maxWidth: undefined },
  // The form inside the panel (.col.g16, 20 under the heading): the fields sit
  // in the card itself, so the Classic hero card draws no surface of its own.
  form: {
    marginTop: 20,
    padding: 0,
    gap: 16,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  // The rule between the form and the rest (.hr, 20 above and below).
  divider: { marginTop: 20 },
  footer: { marginTop: 20, justifyContent: 'flex-start' },
  footerText: { textAlign: 'left' },
  // Welcome's Sign in as the board's glass pill (.btn-glass.btn-pill: 44
  // tall here for the touch target, 16 in, the glass ring as its edge).
  pill: {
    paddingHorizontal: 16,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  // The MFA gate's heading (.h1) 6 under its tile, and the line 6 under it.
  mfaHead: { marginTop: 6 },
  centredText: { textAlign: 'center' },
  // The state's icon tile: 56, radius 16 (.empty-ic at the cards' size).
  tile: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
    marginBottom: 14,
  },
  // The MFA step's tile: 48, radius 14 (Auth-SignIn .empty-ic).
  mfaTile: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
  },
  iconWrap: { alignItems: 'flex-start', marginBottom: 12 },
  // The h1/h2 heading's spacing in the card (.col.g6): 6 above the line under it.
  headLine: { marginTop: 6 },
  // The biometric lock's sheet (.ios-sheet [740]) at the foot of the shell.
  lockSheet: {
    flex: 0,
    marginTop: 'auto',
    marginHorizontal: GLASS_METRICS.sheet.inset,
    marginBottom: GLASS_METRICS.sheet.inset,
    borderRadius: GLASS_METRICS.sheet.radius,
    overflow: 'hidden',
    paddingTop: GLASS_METRICS.sheet.paddingTop,
    paddingHorizontal: GLASS_METRICS.sheet.paddingHorizontal,
    paddingBottom: 28,
    gap: 16,
  },
  // Its middle: the parts 12 apart, no flex of their own.
  lockCentre: { flex: 0, gap: 12 },
  // The Face ID glyph's tile (.faceid [sp.css]: 64, radius 20, accent wash).
  lockWell: { width: 64, height: 64, borderRadius: 20, marginTop: 0 },
  // The heading (22/700, -.3) centred over the buttons.
  lockTitle: { textAlign: 'center', marginTop: 0, maxWidth: undefined },
  // The buttons under the words.
  lockFooter: { paddingBottom: 0, gap: 10 },
});

/** The 6-digit code field (Auth-SignIn #au-code: 56 tall, 28pt digits, .5em apart, radius 14). */
export function glassCodeInput(lg: GlassLook, error: boolean): TextStyle {
  return {
    height: 56,
    paddingVertical: 0,
    fontSize: 28,
    letterSpacing: 14,
    borderRadius: 14,
    backgroundColor: lg.g.fieldFill,
    borderColor: error ? lg.g.danger : INPUT_LINE[lg.mode],
  };
}

/** The icon tile's fill and glyph colour for a state (danger for a refusal, else the well). */
export function glassStateTile(
  lg: GlassLook,
  tone: 'danger' | 'neutral',
): { fill: string; ink: string } {
  return tone === 'danger'
    ? { fill: lg.g.dangerWash, ink: lg.g.danger }
    : { fill: lg.g.surface3, ink: lg.c.ink };
}

/**
 * The panel's material, drawn as the panel's first child (absolutely filling
 * it, touches passing through): the ring of overlay glass (no touch effect:
 * the ring is not a control), and the card on
 * the glass-strong fill 8pt inside it (the opaque chrome under Reduce
 * Transparency, where GlassSurface draws solid).
 */
export function GlassAuthPanelBackdrop() {
  const { g } = useTheme();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <GlassSurface
        variant="overlay"
        radius={GLASS_AUTH_RING.radius}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.card, { backgroundColor: g?.glassStrong ?? 'transparent' }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    top: GLASS_AUTH_RING.width,
    left: GLASS_AUTH_RING.width,
    right: GLASS_AUTH_RING.width,
    bottom: GLASS_AUTH_RING.width,
    borderRadius: GLASS_AUTH_RING.cardRadius,
  } satisfies ViewStyle,
});
