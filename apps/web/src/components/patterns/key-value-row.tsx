import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Label / value rows (DESIGN-SPEC 6.7): 9 x 18 padding, the label quiet on the
 * left, the value in ink on the right, a hairline between rows.
 *
 * Semantics are a description list: `KeyValueList` is the `<dl>`, each
 * `KeyValueRow` a `<div>` holding one `<dt>` and one `<dd>`, so a screen reader
 * announces each value with its label. Put rows only inside a `KeyValueList`.
 */
export function KeyValueList({ className, ...props }: React.ComponentProps<'dl'>) {
  return (
    <dl data-slot="key-value-list" className={cn('divide-border divide-y', className)} {...props} />
  );
}

export interface KeyValueRowProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  label: React.ReactNode;
  children?: React.ReactNode;
  labelClassName?: string;
  valueClassName?: string;
}

export function KeyValueRow({
  label,
  children,
  className,
  labelClassName,
  valueClassName,
  ...props
}: KeyValueRowProps) {
  return (
    <div
      data-slot="key-value-row"
      className={cn(
        'flex min-w-0 items-baseline justify-between gap-4 px-[18px] py-[9px] text-[13.5px] leading-[20.25px]',
        className,
      )}
      {...props}
    >
      <dt className={cn('text-muted-foreground shrink-0', labelClassName)}>{label}</dt>
      <dd
        className={cn(
          'text-foreground min-w-0 text-right tabular-nums [overflow-wrap:anywhere]',
          valueClassName,
        )}
      >
        {children}
      </dd>
    </div>
  );
}
