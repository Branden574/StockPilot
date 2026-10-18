import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { IconMark } from '@/components/ui/icon-mark';

/**
 * The one 404 for every unknown URL and every notFound() (a token miss
 * included: one generic page, so a missing record and a forbidden one look
 * the same). Full screen on the page colour, in the redesign's type: the
 * mono "404" eyebrow, a 28px Inter Tight heading, ink-3 copy, one action.
 */
export default function NotFound() {
  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <IconMark />
      <div>
        <p className="text-muted-foreground font-mono text-[12px] font-medium uppercase tracking-[0.1em]">
          404
        </p>
        <h1 className="mt-2 font-display text-[28px] font-medium leading-tight tracking-[-0.025em] sm:text-[32px]">
          Page not found
        </h1>
        <p className="text-muted-foreground mt-2 text-[13.5px]">
          The page you're looking for doesn't exist or moved.
        </p>
      </div>
      <Button asChild>
        <Link href="/">Back to home</Link>
      </Button>
    </div>
  );
}
