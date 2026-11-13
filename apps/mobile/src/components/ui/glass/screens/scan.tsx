import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import { GLASS_TOKENS } from '../../../../lib/appearance/glass-tokens.generated';
import { GLASS_METRICS } from '../metrics';
import type { GlassLook } from '../use-glass';

/**
 * The Scan tab in Liquid Glass (iOS-Scan.dc.html; project/sp.css, line
 * numbers in brackets). Used only inside the tab's `lg` branches.
 *
 * The camera chrome is dark in every scheme, as the board draws it
 * (data-theme="dark" over the camera; Classic's camera bar is dark in both
 * modes too): the board's .dark-glass [763] fills (--glass rgba(30,34,32,.5),
 * a light edge, white words). Under the opaque material (Reduce Transparency,
 * a low-end phone, Android) they are the Night chrome, solid.
 *
 * The result and add sheets follow the device's scheme, as Classic's do: the
 * shared buttons and fields inside them draw in that scheme, so a Night sheet
 * under a Day button would not read (recorded deviation from the board's
 * Night sheet).
 */

/** .dark-glass [763]: the fill, its edge and the words on it. */
export function cameraGlass(lg: GlassLook): { fill: string; edge: string; ink: string } {
  return lg.material === 'opaque'
    ? { fill: GLASS_TOKENS.nightOpaque.chrome, edge: 'rgba(255,255,255,0.18)', ink: '#FFFFFF' }
    : { fill: 'rgba(30,34,32,0.5)', edge: 'rgba(255,255,255,0.18)', ink: '#FFFFFF' };
}

/** The board's mint (--mint, sp.css): the reticle's beam. */
export const SCAN_MINT = '#5DB89F';

/** The board's reticle (.reticle [748-757]): 250x150, white 4pt corners 34pt long, radius 14. */
export const GLASS_RETICLE = {
  width: 250,
  height: 150,
  corner: 34,
  stroke: 4,
  radius: 14,
} as const;

/** One reticle corner in glass: the shared corner, then its own edges (cornerTL..cornerBR). */
export function glassReticleCorner(lg: GlassLook, which: 'TL' | 'TR' | 'BL' | 'BR'): ViewStyle[] {
  const st = glassScanStyles(lg);
  return [st.corner, st[`corner${which}`]];
}

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

/** Every Scan style that depends on the look (scheme and material), made once per look. */
export const glassScanStyles = cached((lg: GlassLook) => {
  const cam = cameraGlass(lg);
  const m = GLASS_METRICS.sheet;
  const text = (size: number, weight: TextStyle['fontWeight'], color: string): TextStyle => ({
    ...lg.font.displayRegular,
    fontSize: size,
    fontWeight: weight,
    letterSpacing: 0,
    color,
  });
  return StyleSheet.create({
    // The bar floats over the camera (.ios-nav over .ios-cam): no fill of its
    // own, the viewfinder runs under it.
    cameraBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 6,
      backgroundColor: 'transparent',
    },
    barRow: {
      minHeight: GLASS_METRICS.nav.height,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: GLASS_METRICS.nav.gap,
      paddingHorizontal: GLASS_METRICS.nav.paddingHorizontal,
    },
    // .ios-circ.glass [703] on dark glass.
    closeBtn: {
      width: GLASS_METRICS.circle.size,
      height: GLASS_METRICS.circle.size,
      borderRadius: GLASS_METRICS.circle.size / 2,
      backgroundColor: cam.fill,
      borderColor: cam.edge,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
    },
    barSpacer: { width: GLASS_METRICS.circle.size },
    // The modes as the board's capsules (.ios-capsule.glass [705], gap 8).
    modeTrack: { flexDirection: 'row', flexShrink: 1, gap: 8 },
    modeSegment: {
      minHeight: 44,
      paddingVertical: 6,
      paddingHorizontal: 16,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: cam.edge,
      backgroundColor: cam.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // .ios-capsule.scan-on [767]: white, near-black words.
    modeSegmentOn: { backgroundColor: '#FFFFFF', borderColor: '#FFFFFF' },
    modeLabel: { ...lg.font.displaySemi, fontSize: 15, letterSpacing: 0, color: cam.ink },
    modeLabelOn: { ...lg.font.displaySemi, fontSize: 15, letterSpacing: 0, color: '#111111' },
    viewfinder: { flex: 1, backgroundColor: '#000000' },
    reticle: { width: GLASS_RETICLE.width, height: GLASS_RETICLE.height },
    corner: {
      position: 'absolute',
      width: GLASS_RETICLE.corner,
      height: GLASS_RETICLE.corner,
      borderColor: '#FFFFFF',
    },
    cornerTL: {
      top: 0,
      left: 0,
      borderTopWidth: GLASS_RETICLE.stroke,
      borderLeftWidth: GLASS_RETICLE.stroke,
      borderTopLeftRadius: GLASS_RETICLE.radius,
    },
    cornerTR: {
      top: 0,
      right: 0,
      borderTopWidth: GLASS_RETICLE.stroke,
      borderRightWidth: GLASS_RETICLE.stroke,
      borderTopRightRadius: GLASS_RETICLE.radius,
    },
    cornerBL: {
      bottom: 0,
      left: 0,
      borderBottomWidth: GLASS_RETICLE.stroke,
      borderLeftWidth: GLASS_RETICLE.stroke,
      borderBottomLeftRadius: GLASS_RETICLE.radius,
    },
    cornerBR: {
      bottom: 0,
      right: 0,
      borderBottomWidth: GLASS_RETICLE.stroke,
      borderRightWidth: GLASS_RETICLE.stroke,
      borderBottomRightRadius: GLASS_RETICLE.radius,
    },
    // .reticle .beam: 12 in from each side, 2pt, the mint with its glow.
    scanLine: {
      position: 'absolute',
      left: 12,
      right: 12,
      top: 0,
      height: 2,
      borderRadius: 1,
      backgroundColor: SCAN_MINT,
      shadowColor: SCAN_MINT,
      shadowOpacity: 1,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 0 },
      opacity: 1,
    },
    // The status words as the board's .ios-pill.glass [715]: 30pt, radius 15, 13/600.
    caption: {
      marginTop: 16,
      marginHorizontal: 16,
      minHeight: 30,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: cam.edge,
      backgroundColor: cam.fill,
      alignItems: 'center',
      gap: 2,
    },
    reticleLabel: { ...lg.font.displaySemi, fontSize: 13, letterSpacing: 0, color: cam.ink },
    hint: { ...lg.font.displayRegular, fontSize: 13, letterSpacing: 0, color: cam.ink },
    // .ios-sheet [740] over the camera: 8pt in from the sides, radius 36, the
    // 8/18/22 padding; its material is a GlassSheetBackdrop drawn inside it.
    sheet: {
      position: 'absolute',
      left: m.inset,
      right: m.inset,
      maxHeight: '75%',
      paddingTop: m.paddingTop,
      paddingHorizontal: m.paddingHorizontal,
      paddingBottom: 14,
      borderRadius: m.radius,
      backgroundColor: 'transparent',
      borderWidth: 0,
      borderColor: 'transparent',
    },
    grabber: {
      alignSelf: 'center',
      width: m.grabberWidth,
      height: m.grabberHeight,
      borderRadius: 3,
      marginTop: 2,
      marginBottom: 10,
      backgroundColor: lg.ios.sep,
    },
    headerRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
    // .thumb at 64pt, radius 16 (the board's found sheet).
    thumb: { width: 64, height: 64, borderRadius: 16, borderWidth: 0, borderColor: 'transparent' },
    thumbPlaceholder: { backgroundColor: lg.g.surface3 },
    thumbPlaceholderText: text(10, '400', lg.c.ink3),
    sheetName: { ...text(19, '700', lg.c.ink), lineHeight: 24, letterSpacing: -0.3 },
    sheetSku: { color: lg.c.ink3, fontSize: 12, marginTop: 2 },
    statRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
    // Each figure a tile on --ios-fill (.ios-group, padding 10/12, radius 16).
    stat: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 16,
      backgroundColor: lg.ios.fill,
    },
    statLabel: text(12, '400', lg.c.ink3),
    statValue: {
      ...text(24, '700', lg.c.ink),
      lineHeight: 30,
      fontVariant: ['tabular-nums'],
      marginTop: 0,
    },
    statValueLow: { color: lg.c.warnText },
    statValueMuted: {
      ...text(20, '700', lg.c.ink),
      lineHeight: 26,
      fontVariant: ['tabular-nums'],
      marginTop: 2,
    },
    unconfirmedNote: { ...text(12, '600', lg.c.warnText), marginTop: 2 },
    // Where it is: one grouped well on --ios-fill.
    locationBox: {
      marginTop: 8,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 16,
      borderWidth: 0,
      borderColor: 'transparent',
      backgroundColor: lg.ios.fill,
      gap: 8,
    },
    locLabel: text(13, '400', lg.c.ink3),
    locValue: text(15, '600', lg.c.ink),
    locNote: { ...text(13, '400', lg.c.ink3), lineHeight: 18 },
    // The crate's ring shows with no colour set (hollow), in the glass ink-3.
    crateDot: { borderColor: lg.c.ink3 },
    actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
    // The quick-adjust steps as the board's tinted buttons (.ios-btn.tinted [718], radius 20).
    actionBtn: {
      flex: 1,
      minHeight: 52,
      paddingVertical: 6,
      borderRadius: 20,
      borderWidth: 0,
      borderColor: 'transparent',
      backgroundColor: lg.g.accentWash,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionLabel: {
      ...lg.font.displaySemi,
      fontSize: 18,
      letterSpacing: 0,
      color: lg.g.accentText,
      fontVariant: ['tabular-nums'],
    },
    secondaryActions: { flexDirection: 'column', gap: 8, marginTop: 14 },
    pickerTitle: { ...text(19, '700', lg.c.ink), letterSpacing: -0.3 },
    pickerSubtitle: {
      ...text(13, '400', lg.c.ink3),
      lineHeight: 18,
      marginTop: 2,
      marginBottom: 12,
    },
    pickerRow: {
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 16,
      borderWidth: 0,
      borderColor: 'transparent',
      backgroundColor: lg.ios.fill,
      marginBottom: 8,
    },
    pickerRowTitle: text(16, '600', lg.c.ink),
    pickerRowSku: { color: lg.c.ink3, fontSize: 12, marginTop: 2 },
    pickerRowSubtitle: { ...text(13, '400', lg.c.ink3), marginTop: 2 },
    // The add cards are glass sheets 8pt in from the sides, as the result sheet.
    addWrap: { left: m.inset, right: m.inset },
    // Capture cover: the same glass sheet.
    coverCta: {
      position: 'absolute',
      bottom: 120,
      left: m.inset,
      right: m.inset,
      paddingTop: 18,
      paddingHorizontal: m.paddingHorizontal,
      paddingBottom: m.paddingBottom,
      borderRadius: m.radius,
      backgroundColor: 'transparent',
      borderWidth: 0,
      borderColor: 'transparent',
      alignItems: 'center',
    },
    coverHint: {
      ...text(15, '400', lg.c.ink2),
      lineHeight: 20,
      textAlign: 'center',
      marginBottom: 14,
    },
    // The camera-permission page over the scene.
    page: { flex: 1, backgroundColor: 'transparent' },
    permTitle: { ...text(22, '700', lg.c.ink), lineHeight: 28, textAlign: 'center' },
    permBody: { ...text(15, '400', lg.c.ink2), lineHeight: 20, textAlign: 'center', marginTop: 8 },
    centerText: text(15, '400', lg.c.ink3),
  } satisfies Record<string, ViewStyle | TextStyle>);
});
