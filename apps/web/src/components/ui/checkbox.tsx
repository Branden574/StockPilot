'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The shared checkbox (DESIGN-SPEC 6.21; the owner's "make sure our check
 * boxes ... work in the redesign"). One control for the hand-rolled copies in
 * the Items and Books table, the bulk bar, the Staging table, the export
 * builder and the team manager; each owning package adopts it file by file
 * without changing what a click toggles or which test hooks exist.
 *
 * - A <button role="checkbox"> with aria-checked "true" / "false" / "mixed".
 *   Space and Enter press it, like the table's checkbox always has.
 * - A 20 x 20 box, radius 5 (the owner-tested hit target; a compact density
 *   never shrinks it): unchecked is the card colour with a faint-ink border;
 *   checked is the ink fill with a CSS tick in the page colour; mixed is the
 *   ink fill with a 10 x 2 bar.
 * - The accessible name: `label` when nothing visible names the box ("Select
 *   Blue T-shirt", "Select all rows on this page"); or visible `children`,
 *   which become part of the one control (the whole row toggles).
 * - One toggle per click. The click does not travel on to the parent, so a
 *   row that toggles on its own click cannot toggle a second time when the
 *   box itself is clicked (the owner's "3-4 clicks" report came from a box
 *   inside a toggling row button: two toggles per click, cancelling out).
 * - Never put it inside another button, link or option. Inside such a control
 *   use CheckboxGlyph (the picture only) and give that control
 *   role="checkbox". In development a nested Checkbox logs an error.
 */

/** The box, shared by the interactive Checkbox and the CheckboxGlyph picture so
 *  the two can never drift apart. The empty box is drawn in the faint ink, not
 *  the reference's stronger hairline: the border is the only thing that shows
 *  an empty checkbox is there, and the hairline read 1.3:1 on the dark card
 *  (the faint ink reads 3.3:1 in both themes, the WCAG 3:1 for a control). */
function boxClasses(filled: boolean): string {
  return cn(
    'inline-grid h-5 w-5 shrink-0 place-items-center rounded-[5px] border transition-colors',
    filled
      ? 'border-foreground bg-foreground'
      : 'border-[var(--ed-ink-4)] bg-card group-hover:border-[var(--ed-ink-3)]',
  );
}

/** The CSS-drawn tick: bottom and RIGHT borders turned +45 degrees. Bottom and
 *  left at -45 degrees draws the mirror image (the owner-reported "backwards
 *  checkmark"). */
function Tick() {
  return (
    <span
      aria-hidden
      className="border-background h-[11px] w-[6px] -translate-y-px rotate-45 border-b-2 border-r-2"
    />
  );
}

/** The mixed mark: a 10 x 2 bar. It is drawn with a background, which forced
 *  colors (Windows High Contrast) removes, so there it keeps a system-colour
 *  fill; otherwise a mixed select-all looked unchecked. (The tick is drawn
 *  with borders, which forced colors keeps.) */
function Bar() {
  return (
    <span
      aria-hidden
      className="bg-background h-[2px] w-[10px] rounded-full forced-colors:bg-[CanvasText] forced-colors:forced-color-adjust-none"
    />
  );
}

export interface CheckboxGlyphProps {
  checked: boolean;
  indeterminate?: boolean;
  className?: string;
}

/**
 * The checkbox picture with no behaviour, hidden from assistive technology.
 * For a row that is itself the control (a filter option, a menu row): the row
 * owns role="checkbox" and aria-checked, and draws this inside.
 */
export function CheckboxGlyph({ checked, indeterminate = false, className }: CheckboxGlyphProps) {
  return (
    <span aria-hidden className={cn(boxClasses(checked || indeterminate), className)}>
      {checked ? <Tick /> : indeterminate ? <Bar /> : null}
    </span>
  );
}

export interface CheckboxProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'role' | 'type' | 'value' | 'defaultValue' | 'onChange' | 'aria-checked'
> {
  checked: boolean;
  /** Some but not all (a header over a partly selected page). `checked` wins
   *  when both are set. */
  indeterminate?: boolean;
  /** Receives the next value, `!checked`: a mixed box becomes checked. */
  onCheckedChange?: (checked: boolean) => void;
  /** The accessible name when no visible text names the box. */
  label?: string;
  /** Visible text after the box; it is part of the one control. */
  children?: React.ReactNode;
}

/** The roles a Checkbox must not sit inside (they take the same click). */
const INTERACTIVE_ANCESTOR =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="radio"], [role="option"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  {
    checked,
    indeterminate = false,
    onCheckedChange,
    label,
    children,
    className,
    onClick,
    'aria-label': ariaLabel,
    ...props
  },
  forwardedRef,
) {
  const ownRef = React.useRef<HTMLButtonElement | null>(null);
  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      ownRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  React.useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const host = ownRef.current?.parentElement?.closest(INTERACTIVE_ANCESTOR);
    if (host) {
      console.error(
        `Checkbox: rendered inside another interactive element (<${host.tagName.toLowerCase()}>), so one click reaches both. Draw CheckboxGlyph inside that control instead, or move the Checkbox beside it.`,
      );
    }
  }, []);

  return (
    <button
      {...props}
      ref={setRef}
      type="button"
      role="checkbox"
      aria-checked={checked ? 'true' : indeterminate ? 'mixed' : 'false'}
      aria-label={label ?? ariaLabel}
      data-state={checked ? 'checked' : indeterminate ? 'indeterminate' : 'unchecked'}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.stopPropagation();
        onCheckedChange?.(!checked);
      }}
      className={cn(
        'group inline-flex shrink-0 items-center gap-2 rounded-[5px] text-left align-middle',
        'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        children != null && 'text-[13px]',
        className,
      )}
    >
      <CheckboxGlyph checked={checked} indeterminate={indeterminate} />
      {children}
    </button>
  );
});
Checkbox.displayName = 'Checkbox';
