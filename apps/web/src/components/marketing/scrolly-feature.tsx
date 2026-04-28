'use client';

import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import {
  ArrowLeftRight,
  Bell,
  type LucideIcon,
  ScanLine,
  TrendingUp,
} from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

interface Panel {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  body: string;
  tone: string;
}

const PANELS: Panel[] = [
  {
    icon: ScanLine,
    eyebrow: 'Scan',
    title: 'Point your phone. Stock updates.',
    body: 'Camera barcode + QR scanning. One tap to add, remove, or transfer. Ledger entries written automatically.',
    tone: 'from-primary to-blue-500',
  },
  {
    icon: ArrowLeftRight,
    eyebrow: 'Real-time',
    title: 'One source of truth, every device.',
    body: 'When someone scans on the warehouse floor, the dashboard updates instantly. No refresh, no sync button.',
    tone: 'from-violet-500 to-fuchsia-500',
  },
  {
    icon: Bell,
    eyebrow: 'Alerts',
    title: 'Reorder before you run out.',
    body: 'Set a reorder point per item. Low-stock email, push, and in-app notifications fire automatically.',
    tone: 'from-amber-500 to-orange-500',
  },
  {
    icon: TrendingUp,
    eyebrow: 'Insights',
    title: 'Know your top movers, slow movers, and value at a glance.',
    body: 'Inventory value over time, top movers, slow movers, supplier breakdowns. Exportable to CSV.',
    tone: 'from-emerald-500 to-green-500',
  },
];

export function ScrollyFeature() {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  if (reduceMotion) {
    return (
      <section className="container mx-auto max-w-7xl px-4 py-24 sm:px-6">
        <SectionHeader />
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {PANELS.map((p) => (
            <StaticPanel key={p.title} panel={p} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      ref={containerRef}
      className="relative"
      style={{ height: `${PANELS.length * 100}vh` }}
    >
      <div className="sticky top-0 flex h-screen items-center overflow-hidden">
        <div className="container mx-auto grid max-w-7xl grid-cols-1 items-center gap-10 px-4 lg:grid-cols-2 sm:px-6">
          {/* Left: text panels stack with crossfade based on scroll */}
          <div className="relative h-[420px] lg:h-[520px]">
            {PANELS.map((panel, i) => (
              <Panel
                key={panel.title}
                panel={panel}
                index={i}
                total={PANELS.length}
                progress={scrollYProgress}
              />
            ))}
          </div>

          {/* Right: visual stage that morphs */}
          <Stage progress={scrollYProgress} />
        </div>

        {/* Progress dots */}
        <div className="pointer-events-none absolute right-6 top-1/2 hidden -translate-y-1/2 flex-col gap-2 lg:flex">
          {PANELS.map((_, i) => (
            <Dot key={i} index={i} total={PANELS.length} progress={scrollYProgress} />
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionHeader() {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold uppercase tracking-wider text-primary">How it works</p>
      <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
        Built around the moments that actually matter.
      </h2>
    </div>
  );
}

function Panel({
  panel,
  index,
  total,
  progress,
}: {
  panel: Panel;
  index: number;
  total: number;
  progress: ReturnType<typeof useScroll>['scrollYProgress'];
}) {
  const slot = 1 / total;
  const start = index * slot;
  const peak = start + slot * 0.5;
  const end = start + slot;

  const opacity = useTransform(progress, [Math.max(start - 0.05, 0), peak, Math.min(end + 0.02, 1)], [0, 1, 0]);
  const y = useTransform(progress, [start, peak, end], [40, 0, -30]);

  return (
    <motion.div style={{ opacity, y }} className="absolute inset-0 flex flex-col justify-center">
      <span
        className={cn(
          'inline-flex w-fit items-center gap-2 rounded-full bg-gradient-to-r px-3 py-1 text-xs font-semibold uppercase tracking-wider text-white shadow-sm',
          panel.tone,
        )}
      >
        <panel.icon className="h-3.5 w-3.5" />
        {panel.eyebrow}
      </span>
      <h3 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
        {panel.title}
      </h3>
      <p className="mt-4 max-w-lg text-balance text-base text-muted-foreground sm:text-lg">
        {panel.body}
      </p>
    </motion.div>
  );
}

function StaticPanel({ panel }: { panel: Panel }) {
  return (
    <div className="rounded-2xl border bg-card p-8">
      <span
        className={cn(
          'inline-flex w-fit items-center gap-2 rounded-full bg-gradient-to-r px-3 py-1 text-xs font-semibold uppercase tracking-wider text-white',
          panel.tone,
        )}
      >
        <panel.icon className="h-3.5 w-3.5" />
        {panel.eyebrow}
      </span>
      <h3 className="mt-5 text-balance text-2xl font-semibold tracking-tight">{panel.title}</h3>
      <p className="mt-3 text-muted-foreground">{panel.body}</p>
    </div>
  );
}

function Dot({
  index,
  total,
  progress,
}: {
  index: number;
  total: number;
  progress: ReturnType<typeof useScroll>['scrollYProgress'];
}) {
  const slot = 1 / total;
  const peak = index * slot + slot * 0.5;
  const opacity = useTransform(progress, [peak - slot * 0.5, peak, peak + slot * 0.5], [0.3, 1, 0.3]);
  const scale = useTransform(progress, [peak - slot * 0.5, peak, peak + slot * 0.5], [1, 1.6, 1]);

  return (
    <motion.span
      style={{ opacity, scale }}
      className="block h-1.5 w-1.5 rounded-full bg-primary"
      aria-hidden
    />
  );
}

function Stage({
  progress,
}: {
  progress: ReturnType<typeof useScroll>['scrollYProgress'];
}) {
  // 4 visual stages — match panel index
  const scanOpacity = useTransform(progress, [0, 0.2, 0.25], [1, 1, 0]);
  const realtimeOpacity = useTransform(progress, [0.2, 0.3, 0.45, 0.5], [0, 1, 1, 0]);
  const alertOpacity = useTransform(progress, [0.45, 0.55, 0.7, 0.75], [0, 1, 1, 0]);
  const insightsOpacity = useTransform(progress, [0.7, 0.8, 1], [0, 1, 1]);

  return (
    <div className="relative aspect-[5/4] w-full overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-background to-muted/40 shadow-2xl ring-1 ring-foreground/5">
      <motion.div style={{ opacity: scanOpacity }} className="absolute inset-0">
        <ScanStage />
      </motion.div>
      <motion.div style={{ opacity: realtimeOpacity }} className="absolute inset-0">
        <RealtimeStage />
      </motion.div>
      <motion.div style={{ opacity: alertOpacity }} className="absolute inset-0">
        <AlertStage />
      </motion.div>
      <motion.div style={{ opacity: insightsOpacity }} className="absolute inset-0">
        <InsightsStage />
      </motion.div>
    </div>
  );
}

function ScanStage() {
  return (
    <div className="relative flex h-full items-center justify-center bg-zinc-950">
      <div className="relative h-3/4 w-1/3 overflow-hidden rounded-3xl border-4 border-zinc-800 bg-zinc-900">
        <div className="absolute inset-0">
          <div className="h-full w-full bg-[linear-gradient(180deg,#0c1024_0%,#0c1024_45%,#10142e_55%,#10142e_100%)]" />
        </div>
        {/* "scan line" */}
        <motion.div
          aria-hidden
          className="absolute inset-x-4 top-1/3 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent"
          animate={{ y: [0, 80, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        />
        {/* item card popping up */}
        <div className="absolute inset-x-2 bottom-2 rounded-xl bg-white/95 p-3 text-zinc-900 shadow-lg">
          <p className="text-[10px] font-mono text-zinc-500">SP-CB-220</p>
          <p className="text-xs font-semibold">USB-C Cable 2m</p>
          <div className="mt-1 flex items-center justify-between text-[10px]">
            <span className="text-zinc-600">On hand</span>
            <span className="font-semibold tabular-nums">8</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RealtimeStage() {
  return (
    <div className="grid h-full grid-cols-2 gap-2 bg-background p-4">
      <BrowserCard title="Warehouse view" qty={124} delta="+1" />
      <BrowserCard title="Office view" qty={124} delta="syncing…" highlight />
    </div>
  );
}

function BrowserCard({ title, qty, delta, highlight }: { title: string; qty: number; delta: string; highlight?: boolean }) {
  return (
    <div className={cn('flex flex-col rounded-xl border bg-card p-3 shadow-sm', highlight && 'ring-2 ring-primary/40')}>
      <div className="mb-2 flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-destructive/60" />
        <span className="h-2 w-2 rounded-full bg-warning/60" />
        <span className="h-2 w-2 rounded-full bg-success/60" />
        <span className="ml-2 text-[10px] text-muted-foreground">{title}</span>
      </div>
      <div className="rounded-md border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
        Wireless Mouse · SP-WM-001
      </div>
      <div className="mt-auto flex items-baseline justify-between">
        <span className="text-3xl font-semibold tabular-nums">{qty}</span>
        <span className={cn('text-xs font-medium', highlight ? 'text-primary' : 'text-success')}>{delta}</span>
      </div>
    </div>
  );
}

function AlertStage() {
  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-xs space-y-2">
        <NotifCard title="Low stock: USB-C Cable 2m" body="8 / 10 reorder point" tone="warning" />
        <NotifCard title="Out of stock: Toner 441" body="Zero on hand · auto-reorder draft created" tone="destructive" />
        <NotifCard title="PO #PO-2026-0042 received" body="Stock updated for 12 items" tone="success" />
      </div>
    </div>
  );
}

function NotifCard({ title, body, tone }: { title: string; body: string; tone: 'warning' | 'destructive' | 'success' }) {
  const dot = tone === 'warning' ? 'bg-warning' : tone === 'destructive' ? 'bg-destructive' : 'bg-success';
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3 shadow-sm">
      <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">{title}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function InsightsStage() {
  const bars = [40, 55, 38, 70, 62, 90, 72, 88, 64, 78, 92, 70];
  return (
    <div className="flex h-full flex-col gap-3 bg-background p-4">
      <div className="grid grid-cols-3 gap-2">
        {[
          { l: 'Value', v: '$184k' },
          { l: '↑ 30d', v: '+12%' },
          { l: 'Top mover', v: 'SP-WM-001' },
        ].map((s) => (
          <div key={s.l} className="rounded-lg border bg-card px-3 py-2">
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{s.l}</p>
            <p className="text-sm font-semibold">{s.v}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-1 items-end gap-1.5 rounded-lg border bg-card p-3">
        {bars.map((h, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm bg-gradient-to-t from-primary/30 to-primary/80"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
    </div>
  );
}
