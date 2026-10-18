import * as React from 'react';

import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

/** Types that are not a text field: they keep the size their caller gives them. */
const NOT_A_TEXT_FIELD = new Set([
  'checkbox',
  'radio',
  'range',
  'color',
  'button',
  'submit',
  'reset',
  'image',
  'hidden',
]);

/**
 * Text field (DESIGN-SPEC 6.3): 32 px, 13 px text, the stronger hairline and a
 * visible focus ring on desktop. Below sm every text field is 44 px tall with
 * 16 px text, even when its caller sets a smaller size for desktop: 16 px stops
 * iOS Safari from zooming the page when the field takes focus, and 44 px is a
 * thumb-sized target. (A caller's own text size used to win on phones and lose
 * on desktop, the opposite of what it asked for.) Native date and time pickers
 * follow the theme through the color-scheme next-themes sets on <html>.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          'bg-card flex h-8 w-full rounded-md border border-[var(--ed-line-strong)] px-2.5 py-1 text-[13px] transition-colors',
          'file:border-0 file:bg-transparent file:text-[13px] file:font-medium',
          'placeholder:text-muted-foreground',
          'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          type && NOT_A_TEXT_FIELD.has(type) ? null : 'max-sm:h-11 max-sm:text-base',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
