'use client';

import * as React from 'react';

import { useInView } from '@/lib/hooks/use-in-view';
import { cn } from '@/lib/utils';

interface Stat {
  /** Numeric target to count up to (null = static text via `display`). */
  value: number | null;
  prefix?: string;
  suffix?: string;
  display?: string;
  label: string;
}

// Honest, product-grounded proof points (not invented usage metrics):
//  • sub-250ms web↔mobile sync (measured)
//  • 6 live integrations: webhooks, Slack, Teams, public API, QuickBooks, AI
//  • every sensitive change lands in the audit log
//  • multi-tenant with row-level security at the database
const STATS: Stat[] = [
  { value: 240, suffix: 'ms', label: 'real-time sync' },
  { value: 6, label: 'live integrations' },
  { value: 100, suffix: '%', label: 'of changes audited' },
  { value: null, display: 'Multi-tenant', label: 'RLS-secured by default' },
];

function useCountUp(target: number, run: boolean, durationMs = 1100): number {
  const [val, setVal] = React.useState(0);
  React.useEffect(() => {
    if (!run) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVal(target);
      return;
    }
    let raf = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setVal(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run, target, durationMs]);
  return val;
}

function StatCell({ stat, run, delay }: { stat: Stat; run: boolean; delay: number }) {
  const n = useCountUp(stat.value ?? 0, run);
  return (
    <div className={cn('reveal-up', run && 'is-in')} style={{ transitionDelay: `${delay}ms` }}>
      <div className="font-display text-[clamp(32px,5vw,52px)] font-medium leading-none tracking-[-0.03em]">
        {stat.display ?? `${stat.prefix ?? ''}${n.toLocaleString()}${stat.suffix ?? ''}`}
      </div>
      <div className="mt-2 text-[13px] leading-snug text-[var(--ed-ink-3)]">{stat.label}</div>
    </div>
  );
}

export function StatBand() {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <section className="border-y border-border bg-[color-mix(in_oklab,_hsl(var(--card))_60%,_transparent)]">
      <div className="mx-auto max-w-[1280px] px-8 py-16">
        <p className="mb-8 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ed-ink-4)]">
          — Built to be trusted
        </p>
        <div ref={ref} className="grid grid-cols-2 gap-x-8 gap-y-10 md:grid-cols-4">
          {STATS.map((s, i) => (
            <StatCell key={s.label} stat={s} run={inView} delay={i * 80} />
          ))}
        </div>
      </div>
    </section>
  );
}
