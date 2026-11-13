import { StyleSheet } from 'react-native';

import { FONT, type Palette } from '../../../lib/theme';

import type { GlassLook } from './use-glass';

/**
 * A screen's Classic style set with its Liquid Glass overrides laid over it,
 * key by key (each key: the Classic style, then the glass one, flattened).
 * Keys the glass set does not name are Classic's own objects.
 *
 * A screen that keeps one `styles` object picks it in ONE place,
 *
 *   const styles = lg ? withGlass(SCREEN_STYLES[mode], glassFor(lg)) : SCREEN_STYLES[mode];
 *
 * so every element keeps its `style={styles.x}` exactly as Classic writes it
 * and the Classic projection of the file (classic-projection.ts) is the file
 * before Liquid Glass. Merged once per (Classic set, glass set): useTheme()
 * hands out one look object per state, so this allocates once per look.
 */
const memo = new WeakMap<object, WeakMap<object, object>>();

export function withGlass<
  C extends Record<string, object>,
  G extends Partial<Record<keyof C, object>>,
>(classic: C, glass: G): C {
  let byGlass = memo.get(classic);
  if (!byGlass) {
    byGlass = new WeakMap();
    memo.set(classic, byGlass);
  }
  const hit = byGlass.get(glass);
  if (hit) return hit as C;
  const merged: Record<string, object> = { ...classic };
  for (const key of Object.keys(glass)) {
    const over = (glass as Record<string, object | undefined>)[key];
    if (!over) continue;
    const base = (classic as Record<string, object | undefined>)[key];
    merged[key] = base ? (StyleSheet.flatten([base, over]) as object) : over;
  }
  byGlass.set(glass, merged);
  return merged as C;
}

/** Classic's family names back to their roles (FONT's keys). */
const ROLE_OF_FAMILY = new Map(
  (Object.keys(FONT) as (keyof typeof FONT)[]).map((role) => [FONT[role], role] as const),
);

/** A style with Classic's face swapped for the glass face of the same role. */
function refaced(style: object, lg: GlassLook): object {
  const family = (style as { fontFamily?: unknown }).fontFamily;
  const role = typeof family === 'string' ? ROLE_OF_FAMILY.get(family) : undefined;
  return role ? { ...style, ...lg.font[role] } : style;
}

/**
 * A `style` prop a caller hands a text primitive, drawn in the glass face of
 * its role: `<Body style={{ fontFamily: FONT.display }}>` is a call site's
 * Classic weight choice, and the caller's style is laid last, so without this
 * the Classic face would win in Liquid Glass. Anything else passes through.
 */
export function facedProp<S>(lg: GlassLook, style: S): S {
  if (!style || typeof style !== 'object') return style;
  const flat = StyleSheet.flatten(style as never) as object | undefined;
  return (flat ? refaced(flat, lg) : style) as S;
}

const recipes = new WeakMap<object, WeakMap<GlassLook, object>>();

/**
 * A screen's Classic style recipe drawn for Liquid Glass. The recipe is the
 * screen's own `makeStyles(c: Palette)`, run on the glass palette (lg.c: the
 * same names), so no Classic colour can reach glass through it; each Classic
 * face is swapped for the glass face of its role (lg.font: the system face,
 * references stay mono); and the screen's glass shape is laid over it key by
 * key. A screen picks its set in ONE place,
 *
 *   const styles = lg ? glassRecipe(lg, makeStyles, glassShapeFor) : X_STYLES[mode];
 *
 * so every element keeps Classic's `style={styles.x}` and the Classic
 * projection is the file before Liquid Glass. Made once per (recipe, look);
 * a recipe always comes with the same shape.
 */
export function glassRecipe<C extends Record<string, object>>(
  lg: GlassLook,
  make: (c: Palette) => C,
  shape?: (lg: GlassLook) => Partial<Record<keyof C, object>>,
): C {
  let byLook = recipes.get(make);
  if (!byLook) {
    byLook = new WeakMap();
    recipes.set(make, byLook);
  }
  const hit = byLook.get(lg);
  if (hit) return hit as C;
  const drawn = make(lg.c) as Record<string, object>;
  const out: Record<string, object> = {};
  for (const key of Object.keys(drawn)) out[key] = refaced(drawn[key]!, lg);
  const over = (shape ? shape(lg) : {}) as Record<string, object | undefined>;
  for (const key of Object.keys(over)) {
    const o = over[key];
    if (!o) continue;
    out[key] = out[key] ? (StyleSheet.flatten([out[key], o]) as object) : o;
  }
  byLook.set(lg, out);
  return out as C;
}
