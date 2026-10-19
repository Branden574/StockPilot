import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The body of one platform console page: the redesign's main area (28 px
 * top, 32 px sides, 64 px bottom; a 16 px gutter on a phone) with the content
 * centred at 1320 px and a 16 px gap between blocks. `narrow` is the single
 * column a form page uses.
 */
export function PlatformPage({
  width = 'wide',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & { width?: 'wide' | 'narrow' }) {
  return (
    <div
      data-slot="platform-page"
      className={cn(
        'mx-auto flex w-full min-w-0 flex-col gap-4 px-4 pb-16 pt-7 sm:px-8',
        width === 'narrow' ? 'max-w-[736px]' : 'max-w-[1320px]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
