import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The missing-photo placeholder (DESIGN-SPEC 6.14): the app's diagonal hatch,
 * tokenized as hairline strokes on the sunk surface so it reads in both
 * themes. Decorative: the record's name is always printed beside it.
 */
export function MissingPhoto({ className, style, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden
      data-slot="missing-photo"
      className={cn('block h-full w-full', className)}
      style={{
        background:
          'repeating-linear-gradient(45deg, var(--ed-line) 0 1px, transparent 1px 6px), var(--ed-bg-sunk)',
        ...style,
      }}
      {...props}
    />
  );
}
