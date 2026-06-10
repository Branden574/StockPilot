'use client';

import * as React from 'react';

import { useScrollyProgress } from '@/lib/hooks/use-scrolly-progress';

/**
 * Third pinned chapter — the order lifecycle, revealed step by step as you
 * scroll. A different scene type from the two SVG chapters (a sequential
 * "pipeline fills in"): six steps slide in at fixed `--p` milestones while a
 * connector line fills from the top. Every animated value interpolates off the
 * shared `--p` CSS var via calc/clamp, so nothing touches the React tree during
 * scroll. Honors prefers-reduced-motion (pins to a mid-scene resting state).
 */
const STEPS: Array<{ title: string; body: string }> = [
  { title: 'Request', body: 'A team member submits an order from the catalog — on the web app or their phone.' },
  { title: 'Approve', body: 'A manager approves it; stock is reserved against the warehouse the instant they do.' },
  { title: 'Pick', body: 'Pick slip generated. Scan items off the shelf — quantities reconcile as you go.' },
  { title: 'Pack & stage', body: 'Packing slips print, the order is staged for pickup or delivery.' },
  { title: 'Deliver', body: 'Out for delivery with live map tracking, or handed off at the dock.' },
  { title: 'Signed & closed', body: 'Proof of delivery + signature captured. The audit trail closes the loop.' },
];

export function ScrollyPipeline() {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  useScrollyProgress({ trackRef, stageRef });

  return (
    <section
      ref={trackRef}
      aria-label="One order, end to end"
      className="relative"
      style={{ height: '240vh' }}
    >
      <div
        ref={stageRef}
        className="sticky top-0 flex h-screen w-full items-center justify-center overflow-hidden px-8"
        style={{ ['--p' as string]: '0' } as React.CSSProperties}
      >
        <div className="w-full max-w-[620px]">
          <div className="pl-head">
            <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--ed-ink-4)]">
              — One order, end to end
            </p>
            <h2 className="mt-2 font-display text-[clamp(32px,4.5vw,52px)] font-medium leading-[1.0] tracking-[-0.03em] text-balance">
              From request to{' '}
              <span className="font-serif-italic text-[var(--ed-ink-3)]">receiving dock.</span>
            </h2>
          </div>

          <ol className="relative mt-10">
            {/* Connector rail + the fill that tracks scroll progress */}
            <span className="absolute bottom-3 left-[13px] top-3 w-px bg-border" aria-hidden />
            <span
              className="pl-fill absolute left-[13px] top-3 w-px origin-top bg-foreground"
              style={{ bottom: '0.75rem' }}
              aria-hidden
            />
            {STEPS.map((s, i) => (
              <li key={s.title} className={`pl-step pl-step-${i + 1} relative flex gap-4 pb-7 last:pb-0`}>
                <span className="relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border border-border bg-background font-mono text-[11px] tabular-nums">
                  {i + 1}
                </span>
                <div className="pt-0.5">
                  <h3 className="font-display text-[18px] font-medium tracking-[-0.01em]">{s.title}</h3>
                  <p className="mt-1 text-[13px] leading-[1.55] text-[var(--ed-ink-3)]">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <style>{`
          .pl-head { opacity: clamp(0, calc(var(--p) * 8 + 0.15), 1); transform: translate3d(0, calc(max(0px, (0.06 - var(--p)) * 50px)), 0); }
          .pl-fill { transform: scaleY(clamp(0, calc(var(--p) * 1.18), 1)); }
          .pl-step { opacity: 0; transform: translate3d(14px, 0, 0); }
          .pl-step-1 { opacity: clamp(0, calc((var(--p) - 0.06) * 12), 1); transform: translate3d(calc(max(0px, (0.10 - var(--p)) * 50px)), 0, 0); }
          .pl-step-2 { opacity: clamp(0, calc((var(--p) - 0.18) * 12), 1); transform: translate3d(calc(max(0px, (0.22 - var(--p)) * 50px)), 0, 0); }
          .pl-step-3 { opacity: clamp(0, calc((var(--p) - 0.30) * 12), 1); transform: translate3d(calc(max(0px, (0.34 - var(--p)) * 50px)), 0, 0); }
          .pl-step-4 { opacity: clamp(0, calc((var(--p) - 0.42) * 12), 1); transform: translate3d(calc(max(0px, (0.46 - var(--p)) * 50px)), 0, 0); }
          .pl-step-5 { opacity: clamp(0, calc((var(--p) - 0.54) * 12), 1); transform: translate3d(calc(max(0px, (0.58 - var(--p)) * 50px)), 0, 0); }
          .pl-step-6 { opacity: clamp(0, calc((var(--p) - 0.66) * 12), 1); transform: translate3d(calc(max(0px, (0.70 - var(--p)) * 50px)), 0, 0); }
          @media (prefers-reduced-motion: reduce) {
            .pl-head, .pl-fill, .pl-step, .pl-step-1, .pl-step-2, .pl-step-3, .pl-step-4, .pl-step-5, .pl-step-6 { transition: none !important; }
          }
        `}</style>
      </div>
    </section>
  );
}
