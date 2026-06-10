'use client';

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { useInView } from '@/lib/hooks/use-in-view';
import { cn } from '@/lib/utils';

export function FinalCta() {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <section className="mx-auto max-w-[1280px] px-8 pb-0 pt-[72px]">
      <div
        ref={ref}
        className={cn(
          'reveal-up rounded-[14px] border border-border bg-card px-12 py-14 text-center',
          inView && 'is-in',
        )}
      >
        <h2 className="mx-auto font-display text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-balance">
          Get your stock under control.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-[16px] leading-[1.5] text-[var(--ed-ink-3)]">
          Counts, transfers, receiving, reorder alerts, and a native mobile app — for every site you
          run. Start free.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button asChild size="lg">
            <Link href="/signin">Get started</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/pricing">See pricing</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
