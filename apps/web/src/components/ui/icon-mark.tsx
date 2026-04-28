import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Quiet editorial brand mark — solid ink square with a rotated outlined
 * shape inside, replacing the gradient-blue logo from Phase 1.
 */
export function IconMark({ className, size = 22 }: { className?: string; size?: number }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-display font-semibold tracking-tight', className)}>
      <span
        className="relative grid place-items-center rounded-[5px] bg-foreground text-background"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <span
          className="absolute"
          style={{
            inset: Math.max(3, size * 0.18),
            borderRadius: 2,
            border: '1.25px solid currentColor',
            color: 'hsl(var(--background))',
            borderBottomColor: 'transparent',
            borderRightColor: 'transparent',
            transform: 'rotate(45deg)',
          }}
        />
      </span>
      <span className="text-[14px] tracking-[-0.02em]">StockPilot</span>
    </span>
  );
}
