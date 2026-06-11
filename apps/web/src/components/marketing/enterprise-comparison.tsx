'use client';

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { useInView } from '@/lib/hooks/use-in-view';
import { cn } from '@/lib/utils';

// vs. the heavy WMS/ERP tier (NetSuite — Oracle-owned — SAP, Oracle SCM,
// Manhattan, Blue Yonder, Infor, Dynamics). They HAVE the features; the honest,
// and far more persuasive, contrast is cost / speed / complexity. Dollar figures
// are deliberately RANGES with a "varies by deployment" footnote — defensible
// while still landing the gap.
const ROWS: Array<{ axis: string; us: string; them: string }> = [
  { axis: 'Live in', us: 'The same afternoon', them: '6–18 month rollouts' },
  { axis: 'Setup', us: 'Self-serve — no consultants', them: 'Statement of work, integrator, training' },
  { axis: 'Mobile', us: 'Native app, included day one', them: 'Add-on or third-party module' },
  { axis: 'Experience', us: 'Modern and fast, no training', them: 'Powerful, but legacy and heavy' },
  { axis: 'Upgrades', us: 'Continuous + automatic', them: 'Costly, scheduled upgrade projects' },
];

export function EnterpriseComparison() {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <section className="border-t border-border bg-[color-mix(in_oklab,_hsl(var(--card))_55%,_transparent)]">
      <div ref={ref} className="mx-auto max-w-[1280px] px-8 py-[72px]">
        <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ed-ink-4)]">
          — Versus the big platforms
        </p>
        <h2 className="max-w-3xl font-display text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-balance">
          Enterprise capability.{' '}
          <span className="font-serif-italic text-[var(--ed-ink-3)]">Without the enterprise tax.</span>
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[var(--ed-ink-3)]">
          The Oracle-owned NetSuite, SAP, Manhattan, Blue Yonder — the suites a big warehouse runs
          on — can do all of this too. After a six-figure contract and the better part of a year
          standing it up. Here&apos;s the math.
        </p>

        {/* Pricing gap — the centerpiece */}
        <div className="mt-9 grid gap-4 sm:grid-cols-2">
          <div
            className={cn(
              'reveal-up flex flex-col rounded-2xl border-2 border-foreground bg-card p-7',
              inView && 'is-in',
            )}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
              StockPilot
            </div>
            <div className="mt-3 font-display text-[clamp(40px,6vw,64px)] font-medium leading-none tracking-[-0.03em]">
              from $149<span className="align-baseline text-[24px] text-[var(--ed-ink-3)]">/mo</span>
            </div>
            <div className="mt-2 text-[13px] leading-relaxed text-[var(--ed-ink-3)]">
              ≈ <span className="text-foreground font-medium">$1,788 a year</span> — every feature,
              every site you run, your whole team. Live this afternoon.
            </div>
          </div>

          <div
            className={cn(
              'reveal-up flex flex-col rounded-2xl border border-border bg-[color-mix(in_oklab,_hsl(var(--card))_50%,_transparent)] p-7',
              inView && 'is-in',
            )}
            style={{ transitionDelay: '80ms' }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
              NetSuite · SAP · Oracle · Manhattan
            </div>
            <div className="mt-3 font-display text-[clamp(40px,6vw,64px)] font-medium leading-none tracking-[-0.03em] text-[var(--ed-ink-3)]">
              $100k–$250k<span className="align-baseline text-[24px]">+/yr</span>
            </div>
            <div className="mt-2 text-[13px] leading-relaxed text-[var(--ed-ink-3)]">
              Plus a <span className="text-foreground font-medium">6–18 month implementation</span>,
              integrator fees, and per-seat licensing — before anyone scans a thing.
            </div>
          </div>
        </div>

        <p className="mt-5 font-display text-[clamp(18px,2.2vw,26px)] font-medium leading-snug tracking-[-0.02em]">
          The same operations.{' '}
          <span className="font-serif-italic text-[var(--ed-ink-3)]">
            A rounding error next to six figures a year.
          </span>
        </p>

        {/* Supporting contrast rows */}
        <div className="mt-9 grid gap-px overflow-hidden rounded-[12px] border border-border bg-border">
          <div className="grid grid-cols-[1fr_1.3fr_1.3fr] bg-card">
            <div className="px-4 py-3.5 sm:px-6">&nbsp;</div>
            <div className="bg-foreground px-4 py-3.5 text-[12px] font-semibold text-background sm:px-6">
              StockPilot
            </div>
            <div className="px-4 py-3.5 text-[12px] font-medium text-[var(--ed-ink-3)] sm:px-6">
              Legacy enterprise platforms
            </div>
          </div>
          {ROWS.map((r, i) => (
            <div
              key={r.axis}
              className={cn('reveal-up grid grid-cols-[1fr_1.3fr_1.3fr] bg-background', inView && 'is-in')}
              style={{ transitionDelay: `${160 + i * 50}ms` }}
            >
              <div className="px-4 py-3.5 text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-4)] sm:px-6">
                {r.axis}
              </div>
              <div className="bg-[color-mix(in_oklab,_hsl(var(--foreground))_4%,_transparent)] px-4 py-3.5 text-[13px] leading-snug sm:px-6">
                {r.us}
              </div>
              <div className="px-4 py-3.5 text-[13px] leading-snug text-[var(--ed-ink-3)] sm:px-6">
                {r.them}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Button asChild size="lg">
            <Link href="/signin">Start today</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/pricing">See pricing</Link>
          </Button>
        </div>

        <p className="mt-5 text-[11px] leading-relaxed text-[var(--ed-ink-4)]">
          NetSuite is an Oracle company. &ldquo;Legacy enterprise platforms&rdquo; refers to NetSuite,
          SAP, Oracle SCM, Manhattan, Blue Yonder, Infor, Microsoft Dynamics, and similar WMS/ERP
          suites. Dollar figures are general industry ranges for that tier — actual pricing,
          timelines, and capabilities vary by modules, seats, and deployment. StockPilot pricing is
          illustrative; see our pricing page.
        </p>
      </div>
    </section>
  );
}
