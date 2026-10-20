import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The redesign's buttons (DESIGN-SPEC 6.2): 32 px controls (28 small), radius 6,
 * 13 px / 500 labels. Variant names are unchanged, so every call site keeps its
 * meaning:
 * - `gradient`: the flat accent primary, for creating something at page level
 *   (+ New item, + Place order). The name stays because about a hundred call
 *   sites use it; the gradient itself is gone (no gradients in the redesign).
 * - `default`: the ink primary, for committing the work in front of you.
 * - `outline`: the secondary button (card fill, stronger hairline, hover fill).
 * - `ghost`: transparent, with the neutral hover fill.
 *
 * Every variant draws a 1 px border (transparent where the fill is the edge), so
 * filled and outlined buttons of one size are the same box. Hovers use the
 * neutral `bg-muted`, never the accent (accent text on an accent hover was
 * unreadable once the light accent deepened).
 *
 * Sizes: `lg` (48 px) and `xl` (56 px) stay as they were, for the deliberately
 * large calls to action whose own packages restyle them (Sign in, reset, MFA,
 * Create organization, Change password, Complete picking, Confirm & complete).
 *
 * Touch: on phones and on coarse pointers a transparent ::before grows the hit
 * area to at least 44 x 44 around the button without moving anything; the
 * visual size stays the desktop one. A later button's ::before paints over an
 * earlier neighbour, so in a dense group a tap on the edge of one button can
 * press the next. Such a group needs (44 - height) / 2 px between its buttons
 * (8 px for 28 px buttons, 6 px for 32 px ones), or a 44 px size below sm and
 * on coarse pointers (`max-sm:h-11 pointer-coarse:h-11`, as the jump-to-page
 * grid in pagination.tsx does).
 */
const buttonVariants = cva(
  [
    'relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    // The hit area: present only below sm and on coarse pointers.
    "before:absolute before:left-1/2 before:top-1/2 before:size-full before:min-h-11 before:min-w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-none max-sm:before:content-[''] pointer-coarse:before:content-['']",
  ].join(' '),
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border-[var(--ed-line-strong)] bg-card text-foreground hover:bg-muted',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-muted hover:text-foreground',
        link: 'text-accent underline-offset-4 hover:text-foreground hover:underline',
        gradient: 'bg-accent text-accent-ink hover:bg-accent/90',
      },
      size: {
        default: 'h-8 px-3.5 text-[13px]',
        sm: 'h-7 px-2.5 text-[12.5px]',
        lg: 'h-12 px-8 text-base',
        xl: 'h-14 px-10 text-base',
        icon: 'h-8 w-8',
      },
    },
    // The secondary button sits 2 px narrower than the filled ones (DESIGN-SPEC 6.2).
    compoundVariants: [{ variant: 'outline', size: 'default', className: 'px-3' }],
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
