import * as React from 'react';

import { cn } from '@/lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

/**
 * Multi-line field in the Input recipe: 13 px text, the stronger hairline and a
 * visible focus ring; 16 px text below sm (no iOS focus zoom), even when the
 * caller sets a smaller desktop size.
 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          'bg-card flex min-h-[80px] w-full rounded-md border border-[var(--ed-line-strong)] px-2.5 py-2 text-[13px] transition-colors',
          'placeholder:text-muted-foreground',
          'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'max-sm:text-base',
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';
