'use client';

import * as LabelPrimitive from '@radix-ui/react-label';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

// Field labels at the control-label size (13 px / 500, DESIGN-SPEC 3).
const labelVariants = cva(
  'text-[13px] font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
);

/**
 * An arbitrary size (text-[11px]) sets no line height of its own, and twMerge
 * drops the base leading-none beside any font size, so a resized Label would
 * inherit the surrounding line height. Re-add leading-none after an arbitrary
 * length size unless the caller sets its own leading. Named sizes (text-xs)
 * carry their own designed line height and are left as they are.
 */
const ARBITRARY_SIZE = /(?:^|\s)text-\[\d*\.?\d+(?:px|rem|em)\](?=\s|$)/;
const OWN_LEADING = /(?:^|\s)leading-/;

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      labelVariants(),
      className,
      typeof className === 'string' &&
        ARBITRARY_SIZE.test(className) &&
        !OWN_LEADING.test(className) &&
        'leading-none',
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;
