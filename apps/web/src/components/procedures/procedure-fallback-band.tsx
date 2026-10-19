import { BookOpen } from 'lucide-react';

import { cn } from '@/lib/utils';

/** Slate, the colour a procedure without a category has always drawn. */
export const PROCEDURE_FALLBACK_COLOR = '#475569';

/**
 * The no-video (or failed-thumbnail) media of a procedure card: a flat, quiet
 * surface instead of the old colour gradient (CONFLICTS area 20: no
 * decorative gradients), with the category's colour kept as a stripe along
 * the left edge and on the book icon, so the state stays visible and still
 * tells categories apart. Decorative: the card prints its title and category.
 */
export function ProcedureFallbackBand({
  color,
  className,
}: {
  color: string | null | undefined;
  className?: string;
}) {
  const tone = color ?? PROCEDURE_FALLBACK_COLOR;
  return (
    <span
      aria-hidden
      data-slot="procedure-fallback-band"
      className={cn('bg-sunk absolute inset-0 flex items-center justify-center', className)}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: tone }} />
      <BookOpen className="h-8 w-8" strokeWidth={1.5} style={{ color: tone }} />
    </span>
  );
}

/**
 * A category as a quiet outlined pill with its colour as a dot: the words
 * stay in ink 2 in both themes (a user-picked colour as text could fail
 * contrast), the colour stays the cue.
 */
export function ProcedureCategoryPill({
  name,
  color,
  className,
}: {
  name: string;
  color: string | null | undefined;
  className?: string;
}) {
  return (
    <span
      data-slot="procedure-category"
      className={cn(
        'border-line-strong text-ink-2 inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11.5px] font-medium leading-5',
        className,
      )}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? PROCEDURE_FALLBACK_COLOR }}
      />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}
