import Link from 'next/link';

import { Button } from '@/components/ui/button';

export function FinalCta() {
  return (
    <section className="mx-auto max-w-[1280px] px-8 pb-0 pt-[72px]">
      <div className="rounded-[14px] border border-border bg-card px-12 py-14 text-center">
        <h2 className="mx-auto font-display text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-balance">
          Sign in to keep working.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-[16px] leading-[1.5] text-[var(--ed-ink-3)]">
          Counts, transfers, receiving, and reorder alerts — all scoped to your assigned warehouse.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button asChild size="lg">
            <Link href="/signin">Sign in</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
