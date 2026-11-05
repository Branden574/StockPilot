import type { GlassIosTokens, GlassTokens } from '../../../lib/appearance/glass-tokens.generated';
import type { GlassTypeScale } from '../../../lib/theme';
import { useTheme, type ThemeValue } from '../../../lib/use-theme';

/** The theme while Liquid Glass is drawn: every glass field is present. */
export interface GlassLook extends ThemeValue {
  readonly style: 'liquid-glass';
  readonly g: GlassTokens;
  readonly ios: GlassIosTokens;
  readonly type: GlassTypeScale;
}

/**
 * The Liquid Glass look for a screen or primitive, or null in Classic (and
 * whenever the rollout is off: the provider then draws Classic).
 *
 * Every component that draws something different in Liquid Glass reads it
 * once, at the top, as `const lg = useGlass();`, and writes each difference
 * as `lg ? glass : classic` (or `lg && glass` inside a style array, a JSX
 * child or an object). That one binding is what the classic-projection pins
 * (src/lib/appearance/glass-classic-pins.test.ts) fold to null: with `lg`
 * null every touched file must be the code it was before Liquid Glass, so
 * Classic keeps today's elements, styles and order exactly.
 *
 * The returned object is useTheme()'s cached value for the state (one per
 * Design, scheme, material and scene), so it is a stable reference that
 * memoised rows and style arrays can depend on.
 */
export function useGlass(): GlassLook | null {
  const theme = useTheme();
  return theme.g !== null && theme.ios !== null && theme.type !== null
    ? (theme as GlassLook)
    : null;
}
