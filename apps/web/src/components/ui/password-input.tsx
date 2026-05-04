'use client';

import { Eye, EyeOff } from 'lucide-react';
import * as React from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Password input with a show/hide toggle. Mirrors the regular <Input> API,
 * just wraps the field with a button on the right that flips the input
 * type between "password" and "text". Forwards refs so react-hook-form's
 * register() works exactly like the regular Input.
 */
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentPropsWithoutRef<typeof Input>, 'type'>
>(function PasswordInput({ className, ...props }, ref) {
  const [shown, setShown] = React.useState(false);
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={shown ? 'text' : 'password'}
        // Reserve room on the right edge for the eye toggle.
        className={cn('pr-10', className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        tabIndex={-1}
        className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2 grid h-7 w-7 place-items-center rounded-md transition-colors"
      >
        {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
});
