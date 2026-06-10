'use client';

import { useInView } from '@/lib/hooks/use-in-view';
import { cn } from '@/lib/utils';

// vs. the heavy WMS/ERP tier. NOT a feature checklist — those platforms have the
// features; the honest contrast is cost / speed / complexity, where StockPilot
// wins. Claims are general characterizations of enterprise WMS/ERP and are
// footnoted as varying by deployment (keeps a named comparison defensible).
const ROWS: Array<{ axis: string; us: string; them: string }> = [
  { axis: 'Pricing', us: 'A simple monthly plan', them: 'Six-figure licenses + implementation fees' },
  { axis: 'Live in', us: 'The same afternoon', them: '6–18 month rollouts' },
  { axis: 'Setup', us: 'Self-serve — no consultants', them: 'Statement of work, integrator, training program' },
  { axis: 'Mobile', us: 'Native app, included day one', them: 'Add-on or third-party module' },
  { axis: 'Experience', us: 'Modern and fast, no training', them: 'Powerful, but legacy and heavy' },
  { axis: 'Upgrades', us: 'Continuous + automatic', them: 'Costly, scheduled upgrade projects' },
];

export function EnterpriseComparison() {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <section className="border-t border-border bg-[color-mix(in_oklab,_hsl(var(--card))_55%,_transparent)]">
      <div className="mx-auto max-w-[1280px] px-8 py-[72px]">
        <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ed-ink-4)]">
          — Versus the big platforms
        </p>
        <h2 className="max-w-3xl font-display text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-balance">
          Enterprise capability.{' '}
          <span className="font-serif-italic text-[var(--ed-ink-3)]">Without the enterprise tax.</span>
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[var(--ed-ink-3)]">
          The large WMS and ERP suites can do all of this too — after a six-figure contract and the
          better part of a year standing it up. StockPilot gets you the operations that matter this
          afternoon.
        </p>

        <div ref={ref} className="mt-9 grid gap-px overflow-hidden rounded-[12px] border border-border bg-border">
          {/* Header */}
          <div className="grid grid-cols-[1fr_1.3fr_1.3fr] bg-card">
            <div className="px-4 py-3.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)] sm:px-6">
              &nbsp;
            </div>
            <div className="bg-foreground px-4 py-3.5 text-[12px] font-semibold text-background sm:px-6">
              StockPilot
            </div>
            <div className="px-4 py-3.5 text-[12px] font-medium text-[var(--ed-ink-3)] sm:px-6">
              Legacy enterprise platforms
            </div>
          </div>

          {/* Rows */}
          {ROWS.map((r, i) => (
            <div
              key={r.axis}
              className={cn(
                'reveal-up grid grid-cols-[1fr_1.3fr_1.3fr] bg-background',
                inView && 'is-in',
              )}
              style={{ transitionDelay: `${i * 50}ms` }}
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

        <p className="mt-3 text-[11px] leading-relaxed text-[var(--ed-ink-4)]">
          &ldquo;Legacy enterprise platforms&rdquo; = NetSuite, SAP, Manhattan, Blue Yonder, Infor,
          Microsoft Dynamics, and similar WMS/ERP suites. These are general characterizations of that
          tier; actual pricing, timelines, and capabilities vary by deployment and vendor.
        </p>
      </div>
    </section>
  );
}
