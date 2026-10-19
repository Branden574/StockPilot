import { cn } from '@/lib/utils';

/**
 * The returns screens' shared look (redesign P4.B3), as class strings so the
 * workbench, its exchange half, the create dialog and the requester form all
 * draw a choice, a card label and a replacement the same way.
 *
 * The controls stay NATIVE inputs (the area notes: "native radio semantics,
 * restyle, do not replace with unlabeled tiles"): the browser keeps the arrow
 * keys, a label's click, form posting and `checked`. Only the look follows the
 * shared primitives (components/ui/radio-group.tsx and checkbox.tsx).
 */

/** A native radio drawn as the shared RadioGroup dot: a faint-ink ring that
 *  fills with an ink centre when chosen; the browser's own radio in forced
 *  colors, where the fill would not show. Every radio here sits in a choice
 *  row or tile that draws the keyboard focus ring (choiceRowClass, the
 *  requester's tiles), so the dot draws none of its own: one ring per focus,
 *  as the shared RadioGroup's card look has it. */
export const nativeRadioClass = cn(
  'bg-card size-4 shrink-0 appearance-none rounded-full border border-[var(--ed-ink-4)] transition-colors',
  'checked:border-foreground checked:bg-foreground checked:shadow-[inset_0_0_0_3px_hsl(var(--card))]',
  'forced-colors:appearance-auto disabled:cursor-not-allowed focus-visible:outline-none',
);

/**
 * A native checkbox drawn as the shared Checkbox's box (components/ui/
 * checkbox.tsx, DESIGN-SPEC 6.21): 20 x 20, radius 5, the card colour with a
 * faint-ink edge when empty; the ink fill with the CSS tick (bottom and right
 * borders turned 45 degrees, in the page colour) when ticked. It stays an
 * <input type="checkbox">, so `checked`, a label's click, Space and form
 * posting are the browser's. The tick is drawn with borders, which forced
 * colors keeps, so a ticked box still shows its tick there.
 */
export const nativeCheckboxClass = cn(
  'bg-card relative size-5 shrink-0 cursor-pointer appearance-none rounded-[5px] border border-[var(--ed-ink-4)] transition-colors hover:border-[var(--ed-ink-3)]',
  'checked:border-foreground checked:bg-foreground checked:hover:border-foreground',
  "after:border-background after:absolute after:left-[6px] after:top-[2.5px] after:hidden after:h-[11px] after:w-[6px] after:rotate-45 after:border-b-2 after:border-r-2 after:content-[''] checked:after:block",
  'disabled:cursor-not-allowed disabled:opacity-50',
  'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
);

/**
 * A labelled choice row holding a native radio (a disposition, a destination,
 * a replacement, a site): the RadioGroup `card` look. The chosen row takes an
 * ink edge (never colour alone: the dot fills too), the row shows the keyboard
 * focus ring of the radio inside it.
 */
export function choiceRowClass({
  checked,
  disabled = false,
}: {
  checked: boolean;
  disabled?: boolean;
}): string {
  return cn(
    'bg-card rounded-md border text-[13px] transition-colors',
    'has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-background has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2',
    checked
      ? 'border-foreground shadow-[0_0_0_1px_hsl(var(--foreground))]'
      : 'border-border hover:border-[var(--ed-line-strong)]',
    disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
  );
}

/** A card's small uppercase label (RETURNING, REPLACEMENT, RETURN DISPOSITION):
 *  the page header's eyebrow recipe (DESIGN-SPEC 6.1), 11 / 500, +0.1em. The
 *  words are core's, already in capitals. */
export const eyebrowClass =
  'text-muted-foreground text-[11px] font-medium uppercase leading-[16.5px] tracking-[0.1em]';

/** The plain card (DESIGN-SPEC 6.7): the elevated surface, a hairline, radius 8. */
export const cardClass = 'border-border bg-card text-card-foreground rounded-lg border';

/** The REPLACEMENT side of a returned line: the card with the accent rail
 *  (the selected-row rail of DESIGN-SPEC 6.18), beside its arrow and label. */
export const replacementCardClass = cn(cardClass, 'border-l-accent border-l-[3px]');
