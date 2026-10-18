'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The shared on/off switch for settings that apply at once (module toggles,
 * notification and digest preferences). A <button role="switch"> with
 * aria-checked; Space and Enter press it.
 *
 * Controlled only: the caller owns `checked`. For an optimistic save the caller
 * flips its own value, sets `pending` while the save is out, and puts the old
 * value back if the save is refused; the switch simply draws what it is given.
 * While `pending` the switch says it is busy, keeps focus and its place (it is
 * not disabled, so a keyboard user is not dropped), and ignores presses, so one
 * save cannot overtake another. Use `disabled` when it cannot change at all.
 *
 * Look: a 36 x 20 track, ink when on and the faint ink when off (both read at
 * 3:1 or better against the card, so the off state is visible in dark too),
 * with a 16 px thumb. On phones and coarse pointers the hit area grows to at
 * least 44 x 44 without moving anything, like Button. In forced colors the
 * track keeps a system-colour edge and the thumb a system-colour fill, so the
 * thumb's side still shows on or off.
 */
export interface SwitchProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'role' | 'type' | 'value' | 'defaultValue' | 'onChange' | 'aria-checked'
> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** The accessible name when no visible label is tied to the switch. */
  label?: string;
  /** A save for this switch is in flight: busy, focusable, presses ignored. */
  pending?: boolean;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked,
    onCheckedChange,
    label,
    pending = false,
    className,
    onClick,
    'aria-label': ariaLabel,
    ...props
  },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ?? ariaLabel}
      aria-busy={pending || undefined}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || pending) return;
        onCheckedChange?.(!checked);
      }}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        "pointer-coarse:before:content-[''] before:absolute before:left-1/2 before:top-1/2 before:size-full before:min-h-11 before:min-w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-none max-sm:before:content-['']",
        checked ? 'bg-primary' : 'bg-[var(--ed-ink-4)]',
        // Forced colors (Windows High Contrast) drop backgrounds, which left
        // neither the track nor the thumb: the track takes a system-colour edge
        // and the thumb a system-colour fill, so its position shows the state.
        'forced-colors:border forced-colors:border-[ButtonText]',
        pending && 'cursor-progress opacity-60',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none inline-block h-4 w-4 rounded-full transition-transform',
          'forced-colors:bg-[ButtonText] forced-colors:forced-color-adjust-none',
          checked ? 'bg-primary-foreground translate-x-[18px]' : 'translate-x-0.5 bg-white',
        )}
      />
    </button>
  );
});
Switch.displayName = 'Switch';
