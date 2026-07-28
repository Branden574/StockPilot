import * as React from 'react';
import { StyleSheet, Text, View, type TextProps, type ViewStyle } from 'react-native';

import { FONT, TYPE_CEILING, capTo, resolveFontCap } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Dynamic Type policy for the four text primitives.
 *
 * CHROME CAPS (Display, Eyebrow, FieldLabel) are ceilings in points — see
 * `capTo` in lib/theme.ts. Eyebrow and FieldLabel render the same line but do
 * NOT share a ceiling: a section header is a landmark, a field label names the
 * box you are typing into, and only one of those can afford to be the smallest
 * text on screen. CONTENT (Body, Mono) has NO default cap: those two carry the
 * paragraphs, SKUs, barcodes, quantities and ETAs a warehouse user actually
 * reads, they live in ScrollViews, and letting them grow all the way is the
 * entire accessibility win. The `maxFontSizeMultiplier` prop exists on them
 * only so the handful of fixed-height-chrome call sites can opt in.
 *
 * OVERRIDE CONTRACT (all four): pass `maxFontSizeMultiplier={n}` to tighten or
 * loosen, and `maxFontSizeMultiplier={0}` — RN's documented "no limit"
 * sentinel — to opt out entirely. Resolution goes through `resolveFontCap` so
 * a falsy-check can never silently re-apply the default over that 0.
 */

/** Props every primitive forwards to its underlying <Text>. */
type SharedTextProps = Omit<TextProps, 'style' | 'children'>;

/** Shared by Eyebrow and FieldLabel — they differ only in their ceiling. */
type EyebrowProps = SharedTextProps & {
  children: React.ReactNode;
  style?: ViewStyle;
  prefix?: string;
  color?: string;
};

/**
 * Eyebrow — JetBrains Mono, 11pt, uppercase, 0.18em tracking, prefixed
 * with an em-dash. This is the brand signature line that sits above
 * every section title and on auth/empty states.
 *
 * Two lines by default, not one: eyebrows carry live counts
 * ("INVENTORY · 1,234 ITEMS", "RENTALS · 3 OUT · 1 OVERDUE") and it is
 * exactly that suffix which gets ellipsized away at larger text sizes. The
 * cap alone does not save it; the second line does.
 *
 * SECTION headers only. A label that names a form input is a FieldLabel —
 * different job, different ceiling.
 */
export function Eyebrow({
  children,
  style,
  prefix = '— ',
  color,
  maxFontSizeMultiplier,
  numberOfLines = 2,
  ...rest
}: EyebrowProps) {
  const { c } = useTheme();
  return (
    <View style={[styles.eyebrowWrap, style]}>
      <Text
        {...rest}
        style={[
          styles.eyebrow,
          { color: color ?? c.ink4 },
        ]}
        numberOfLines={numberOfLines}
        maxFontSizeMultiplier={resolveFontCap(
          maxFontSizeMultiplier,
          capTo(11, TYPE_CEILING.eyebrow),
        )}
      >
        {prefix}
        {children}
      </Text>
    </View>
  );
}

/**
 * FieldLabel — the name of a form field. Pixel-identical to Eyebrow (same
 * 11pt tracked uppercase mono line, same em-dash prefix, same two-line
 * reflow); the ONLY difference is the ceiling.
 *
 * It is a separate primitive rather than an `<Eyebrow variant="field">` prop
 * on purpose. The two differ by what the text *is*, not how it looks, and a
 * named export makes that greppable ("which labels name an input?") and
 * self-documenting at the call site. A variant prop would put the decision on
 * whoever writes the JSX, where the failure mode is silent omission — a new
 * field label that quietly inherits the section-header ceiling and is,
 * once again, the smallest thing on the form.
 *
 * See TYPE_CEILING.label for why 28 rather than eyebrow's 16.
 */
export function FieldLabel({ maxFontSizeMultiplier, ...rest }: EyebrowProps) {
  return (
    <Eyebrow
      {...rest}
      maxFontSizeMultiplier={resolveFontCap(
        maxFontSizeMultiplier,
        capTo(11, TYPE_CEILING.label),
      )}
    />
  );
}

/**
 * Display heading — Inter Tight 500, tracking -0.028em. Children can
 * embed <Em> for serif-italic emphasis spans (the brand signature).
 *
 * Capped to a 48pt ceiling by default. Because the cap is a ceiling and not a
 * multiplier, all 49 call sites (18–40pt) land in the same physical space:
 * 34pt grows 1.41x, 18pt grows 2.67x, and a 56pt hero grows not at all.
 */
export function Display({
  children,
  size = 32,
  style,
  color,
  maxFontSizeMultiplier,
  numberOfLines,
  ...rest
}: SharedTextProps & {
  children: React.ReactNode;
  size?: number;
  style?: TextProps['style'];
  color?: string;
}) {
  const { c } = useTheme();
  return (
    <Text
      {...rest}
      numberOfLines={numberOfLines}
      maxFontSizeMultiplier={resolveFontCap(
        maxFontSizeMultiplier,
        capTo(size, TYPE_CEILING.display),
      )}
      style={[
        {
          fontFamily: FONT.display,
          fontSize: size,
          lineHeight: size * 1.05,
          letterSpacing: -size * 0.028,
          color: color ?? c.ink,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/**
 * Em — italic emphasis span. Renders inline inside <Display> using
 * Instrument Serif Italic (weight 400) at the parent's size. RN
 * concatenates nested Text elements seamlessly so this acts like
 * an HTML <em>. Inherits the parent Display's cap.
 */
export function Em({ children, size }: { children: React.ReactNode; size?: number }) {
  return (
    <Text
      style={{
        fontFamily: FONT.serifItalic,
        fontWeight: '400',
        ...(size ? { fontSize: size, lineHeight: size * 1.05 } : null),
        letterSpacing: -0.4,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * Body — Inter Tight 400, 14.5pt, 1.5 line height, ink-3 muted.
 *
 * UNCAPPED BY DEFAULT, and it must stay that way: `lineHeight: size * 1.5` is
 * relative, so paragraphs simply get taller as they grow. If body copy ever
 * stops looking bigger at accessibility sizes, something here has been
 * over-clamped.
 */
export function Body({
  children,
  size = 14.5,
  muted = false,
  style,
  color,
  numberOfLines,
  maxFontSizeMultiplier,
  ...rest
}: SharedTextProps & {
  children: React.ReactNode;
  size?: number;
  muted?: boolean;
  style?: TextProps['style'];
  color?: string;
}) {
  const { c } = useTheme();
  return (
    <Text
      {...rest}
      numberOfLines={numberOfLines}
      // No policy default — see the module note. Chrome opts in per site.
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[
        {
          fontFamily: FONT.displayRegular,
          fontSize: size,
          lineHeight: size * 1.5,
          color: color ?? (muted ? c.ink3 : c.ink),
          letterSpacing: -size * 0.012,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/**
 * Mono — JetBrains Mono for SKUs, barcodes, numeric codes, ETAs.
 *
 * UNCAPPED BY DEFAULT: everything in that list is content, not chrome. The
 * chrome uses of Mono (pills, page numbers, micro-markers) opt in per site
 * with `capTo(size, TYPE_CEILING.chrome)`.
 */
export function Mono({
  children,
  size = 12,
  style,
  color,
  tracking = 0.04,
  upper = false,
  numberOfLines,
  maxFontSizeMultiplier,
  ...rest
}: SharedTextProps & {
  children: React.ReactNode;
  size?: number;
  style?: TextProps['style'];
  color?: string;
  tracking?: number;
  upper?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Text
      {...rest}
      numberOfLines={numberOfLines}
      // No policy default — see the module note. Chrome opts in per site.
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[
        {
          fontFamily: FONT.mono,
          fontSize: size,
          color: color ?? c.ink,
          letterSpacing: size * tracking,
          ...(upper ? { textTransform: 'uppercase' as const } : null),
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  eyebrowWrap: {
    alignSelf: 'flex-start',
    // Paired with numberOfLines={2}: without this the wrap refuses to yield
    // width to its row siblings and the second line never gets a chance.
    flexShrink: 1,
  },
  eyebrow: {
    fontFamily: FONT.mono,
    fontSize: 11,
    letterSpacing: 11 * 0.18,
    textTransform: 'uppercase',
    lineHeight: 11 * 1.2,
  },
});
