import { Boxes } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * StockPilot wordmark + glyph. Use everywhere instead of raw text.
 */
export function IconMark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-display font-semibold tracking-tight', className)}>
      <span className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-primary to-blue-500 text-primary-foreground shadow-sm">
        <Boxes className="h-4 w-4" />
      </span>
      <span>StockPilot</span>
    </span>
  );
}
