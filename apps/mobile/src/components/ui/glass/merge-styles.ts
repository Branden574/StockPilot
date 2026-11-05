import { StyleSheet } from 'react-native';

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
