import { cn } from '@/lib/utils';

/**
 * A native select in the Input recipe (32 px, the stronger hairline, the
 * focus ring; 44 px and 16 px text on a phone). The console keeps its native
 * selects: their keyboard, form and screen-reader behaviour is the browser's
 * own, and the tests drive them as native selects.
 */
export const PLATFORM_SELECT_CLASS = cn(
  'bg-card h-8 w-full rounded-md border border-[var(--ed-line-strong)] px-2 text-[13px] transition-colors',
  'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
  'disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 max-sm:text-base',
);
