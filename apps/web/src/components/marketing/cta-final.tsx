import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';

export function FinalCta() {
  return (
    <section className="container mx-auto max-w-7xl px-4 pb-24 sm:px-6">
      <div className="relative overflow-hidden rounded-3xl border bg-gradient-to-br from-primary/10 via-blue-500/10 to-violet-500/10 p-10 text-center sm:p-16">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid opacity-40 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
        <div className="relative">
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
            Ready to ditch the spreadsheet?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-balance text-muted-foreground">
            14 days, no card, full Pro features. See if StockPilot earns a permanent spot in your stack.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Button asChild variant="gradient" size="xl">
              <Link href="/signup">
                Start free trial
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="xl">
              <Link href="/contact">Talk to sales</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
