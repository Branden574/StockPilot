import * as React from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';
import { Check, Minus } from 'lucide-react-native';

// Relative imports on purpose (as in tones.ts): checkbox.test.ts loads this
// file in the node test runner, which does not resolve the `@/` alias.
import type { Palette } from '../../lib/theme';
import { useTheme } from '../../lib/use-theme';
import { Body } from './text';

/**
 * The shared phone checkbox (redesign package P2.5b), in two parts:
 *
 *   Checkbox      the whole control: a 22pt box and its label in one
 *                 Pressable that VoiceOver reads as a checkbox, with its
 *                 state and the label as its name.
 *   CheckboxMark  the box alone, drawn by a row that is itself the press
 *                 target (Items and Books rows, the count picker, the
 *                 exceptions cards, the shortfall PO lines). The ROW carries
 *                 accessibilityRole="checkbox" and accessibilityState
 *                 { checked } (and `disabled` when it can be off); the mark
 *                 draws the box and nothing else.
 *
 * NEVER PUT A Checkbox INSIDE ANOTHER PRESSABLE. iOS folds a Pressable and
 * everything in it into one VoiceOver element, so an inner checkbox can never
 * be reached, its state is never announced, and the two press handlers
 * compete for one touch. A row that is pressed as a whole draws a
 * CheckboxMark instead. (The web keeps the same pair for the same reason:
 * inventory-table.tsx `Checkbox` and the non-interactive `CheckGlyph`, after
 * a box nested in a row button toggled twice per click.) checkbox.test.ts
 * sweeps app/ and src/ for both rules.
 *
 * CONTROLLED. It keeps no state: it shows the `checked` it is given, and a
 * tap calls `onChange(next)` with `nextChecked(checked)`. Nothing changes on
 * screen until the caller passes the new value. A caller that toggles with an
 * updater (`setOn((v) => !v)`) can keep it and ignore `next`.
 *
 * THE TARGET is a real frame, not hitSlop: the Pressable is at least 44pt
 * tall and wide (minHeight / minWidth, so it still grows), with the 22pt box
 * centred in its first line. A frame because VoiceOver outlines and activates
 * the view's own bounds, so the target it shows is the one a finger can hit
 * (the IconChip `minTap` rule), and because React Native's hitSlop never
 * reaches past the parent's bounds and loses to an overlapping sibling, so in
 * a list or a sheet it can shrink without anyone seeing it.
 *
 * COLOURS are `checkboxTone`: a clear box is the card fill with the ink4 edge
 * (3.18:1 or more on the card and the page, both modes; ink4 is allowed here
 * because the edge is a mark, never words); a ticked or mixed box is the ink
 * fill with a paper tick or bar. Disabled is greyed out and still keeps every
 * edge at 3:1 or more on the card and the page: a ticked box turns the muted
 * ink3 with the paper tick (6.4:1 or more), a clear box fills with the grey
 * hair2 inside the same ink4 edge, the label turns ink3. The box never takes
 * an opacity, so the measured numbers are what is on screen (only a press
 * dims the whole Checkbox for a moment, as the shared Row does).
 * checkbox.test.ts pins every value and ratio in both modes.
 *
 * DYNAMIC TYPE (the policy in lib/theme.ts): the box is a View, so it stays
 * 22pt at every text size. The label is content, a sentence someone reads
 * before ticking it (GROUP_COPY.acknowledgeFamily), so it is the uncapped Body
 * and wraps with no line limit; no TYPE_CEILING applies because nothing here
 * is chrome text. The row's 44pt is a minHeight, never a height, so it grows
 * with the label, and `checkboxLayout` keeps the box centred on the label's
 * first line however tall that line becomes.
 */

/** A checkbox's value: ticked, clear, or 'mixed' (some, not all, of what it
 *  stands for: a select-all over a partly selected page). */
export type CheckboxValue = boolean | 'mixed';

/** The box, in points, at every text size. */
export const CHECKBOX_SIZE = 22;
/** The least a Checkbox's target measures each way (the iOS minimum). */
export const CHECKBOX_MIN_TARGET = 44;
/** The label: the Body primitive's default 14.5pt. */
export const CHECKBOX_LABEL_SIZE = 14.5;
/** Body draws its lines at 1.5 times the size (text.tsx; checkbox.test.ts
 *  fails if that changes, since the box is centred on the first line). */
const BODY_LINE_HEIGHT = 1.5;

/** The tick and the bar: 16pt glyphs, stroke 3 of lucide's 24 units (2pt). */
const GLYPH_SIZE = 16;
const GLYPH_STROKE = 3;

/**
 * What a tap asks for: a clear or a mixed box asks to be ticked, a ticked box
 * to be cleared (the web select-all's rule: a partly selected page selects
 * everything on it). The caller decides whether to apply it.
 */
export function nextChecked(value: CheckboxValue): boolean {
  return value !== true;
}

/** The colours a box (and a Checkbox's label) is drawn in. */
export interface CheckboxTone {
  /** Inside the box. */
  fill: string;
  /** The 1.5pt edge that tells the box from the row it sits on. */
  border: string;
  /** The tick or the mixed bar; null when the box is clear. */
  glyph: string | null;
  /** A Checkbox's label words (a row that draws a mark colours its own). */
  label: string;
}

/**
 * The checkbox's colours for one value and one mode's palette. The edge is
 * what tells the box from the card or the page it sits on, so that is the
 * pair held at 3:1; a disabled clear box greys its inside (hair2, a visible
 * step from the card in both modes) and keeps the same edge.
 */
export function checkboxTone(value: CheckboxValue, disabled: boolean, c: Palette): CheckboxTone {
  const label = disabled ? c.ink3 : c.ink;
  if (value === false) {
    return { fill: disabled ? c.hair2 : c.card, border: c.ink4, glyph: null, label };
  }
  const ink = disabled ? c.ink3 : c.ink;
  return { fill: ink, border: ink, glyph: c.paper, label };
}

/** Where a Checkbox puts its box and label at one text size, in points. */
export interface CheckboxLayout {
  /** The box's side: the same at every size. */
  box: number;
  /** The label's first line at this size. */
  firstLine: number;
  /** Space above the box, so it is centred on the label's first line. */
  boxTop: number;
  /** Space above the label, so a line shorter than the box is centred on it. */
  labelTop: number;
  /** Vertical padding that makes a one-line Checkbox the 44pt target. */
  padding: number;
}

/**
 * A Checkbox's layout at Dynamic Type scale `fontScale`. Only the label's line
 * grows (React Native scales a Text's lineHeight with its font); the box never
 * does. Anything that is not a finite, positive scale is read as the default
 * size, as `shouldStackRow` reads it.
 */
export function checkboxLayout(fontScale: number | null | undefined): CheckboxLayout {
  const scale =
    typeof fontScale === 'number' && Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const firstLine = CHECKBOX_LABEL_SIZE * BODY_LINE_HEIGHT * scale;
  const lead = Math.max(CHECKBOX_SIZE, firstLine);
  return {
    box: CHECKBOX_SIZE,
    firstLine,
    boxTop: (lead - CHECKBOX_SIZE) / 2,
    labelTop: (lead - firstLine) / 2,
    padding: Math.max(0, (CHECKBOX_MIN_TARGET - lead) / 2),
  };
}

/**
 * The box alone: no press handler, no role, hidden from VoiceOver, and it
 * never takes a touch (a tap on it lands on the row). Draw it inside the
 * Pressable that is pressed, and give THAT Pressable
 * accessibilityRole="checkbox" and accessibilityState={{ checked }} (with
 * `disabled` when the row can be off), so VoiceOver hears what the box shows.
 */
export function CheckboxMark({
  checked,
  disabled = false,
}: {
  checked: CheckboxValue;
  /** Draws the disabled look; the row decides what a tap does. */
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const tone = checkboxTone(checked, disabled, c);
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.box, { backgroundColor: tone.fill, borderColor: tone.border }]}
    >
      {tone.glyph === null ? null : checked === 'mixed' ? (
        <Minus size={GLYPH_SIZE} color={tone.glyph} strokeWidth={GLYPH_STROKE} />
      ) : (
        <Check size={GLYPH_SIZE} color={tone.glyph} strokeWidth={GLYPH_STROKE} />
      )}
    </View>
  );
}

/**
 * A checkbox with its label: one VoiceOver element, named by the label unless
 * `accessibilityLabel` says otherwise, then "checkbox" and its state:
 * "checked", "unchecked" or "mixed" (React Native's words for the role and
 * state), and "dimmed" while disabled. Never wrap it in a Pressable (see the
 * module note).
 */
export function Checkbox({
  checked,
  onChange,
  label,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  style,
}: {
  checked: CheckboxValue;
  /** Called with the value a tap asks for (`nextChecked(checked)`). */
  onChange: (next: boolean) => void;
  /** The words beside the box, and the spoken name. */
  label: string;
  /** A spoken name in place of the label, when the label alone is not
   *  enough. The label still shows. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Announced as dimmed, drawn in the disabled look, and a tap does nothing. */
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const tone = checkboxTone(checked, disabled, c);
  const layout = checkboxLayout(fontScale);
  return (
    <Pressable
      onPress={disabled ? undefined : () => onChange(nextChecked(checked))}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ checked, disabled }}
      style={({ pressed }) => [
        styles.row,
        { paddingVertical: layout.padding, opacity: pressed ? 0.7 : 1 },
        style,
      ]}
    >
      <View style={{ marginTop: layout.boxTop }}>
        <CheckboxMark checked={checked} disabled={disabled} />
      </View>
      <Body
        size={CHECKBOX_LABEL_SIZE}
        color={tone.label}
        style={[styles.label, { marginTop: layout.labelTop }]}
      >
        {label}
      </Body>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // minHeight / minWidth, never height: the target is at least 44pt and grows
  // with the label. Top-aligned, with checkboxLayout's offsets, so the box
  // stays beside the first line of a wrapped label.
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    minHeight: CHECKBOX_MIN_TARGET,
    minWidth: CHECKBOX_MIN_TARGET,
  },
  // A fixed width and height on purpose: the box holds no text, and it is
  // the one part that must not grow with Dynamic Type.
  box: {
    width: CHECKBOX_SIZE,
    height: CHECKBOX_SIZE,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // flexShrink, not flex: 1: the label keeps its own width and wraps when
  // the row is narrower, even in a parent with no set width.
  label: {
    flexShrink: 1,
    minWidth: 0,
  },
});
