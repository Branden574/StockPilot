'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Boxes, ScanLine, Sparkles, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function Hero() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="relative overflow-hidden">
      {/* Mesh gradient + grid backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-mesh" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)] bg-grid"
      />

      <div className="container mx-auto max-w-7xl px-4 pb-16 pt-20 sm:px-6 sm:pt-28 lg:pb-24 lg:pt-36">
        <div className="mx-auto max-w-3xl text-center">
          <Badge variant="outline" className="mx-auto mb-6 gap-1.5 bg-background/60 backdrop-blur">
            <Sparkles className="h-3 w-3 text-primary" />
            Built for teams that move fast
          </Badge>

          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl lg:text-7xl">
            Inventory you'll
            <span className="relative mx-2 inline-block bg-gradient-to-r from-primary via-blue-500 to-violet-500 bg-clip-text text-transparent">
              actually
            </span>
            enjoy using.
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-balance text-base text-muted-foreground sm:text-lg">
            Track stock across locations, scan barcodes from your phone, and know exactly when to
            reorder — without spreadsheets, chaos, or 2014 software.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild variant="gradient" size="xl">
              <Link href="/signup">
                Start free
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="xl">
              <Link href="#features">See how it works</Link>
            </Button>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            14-day free trial · No credit card required · Cancel anytime
          </p>
        </div>

        {/* Floating preview cards */}
        <div className="relative mx-auto mt-16 max-w-5xl">
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
            className="relative aspect-[16/10] overflow-hidden rounded-2xl border border-border/60 bg-card/60 p-3 shadow-2xl backdrop-blur-xl ring-1 ring-foreground/5"
          >
            <DashboardMockup />
          </motion.div>

          <FloatingCard
            className="absolute -left-4 top-10 hidden md:flex"
            icon={<ScanLine className="h-4 w-4 text-primary" />}
            title="Scanned"
            value="1,242 items"
            delay={0.6}
          />
          <FloatingCard
            className="absolute -right-4 top-32 hidden md:flex"
            icon={<TrendingUp className="h-4 w-4 text-success" />}
            title="On hand"
            value="$184,920"
            delay={0.85}
          />
          <FloatingCard
            className="absolute -right-2 bottom-10 hidden md:flex"
            icon={<Boxes className="h-4 w-4 text-violet-500" />}
            title="Low stock"
            value="6 items"
            delay={1.05}
          />
        </div>
      </div>
    </section>
  );
}

function FloatingCard({
  className,
  icon,
  title,
  value,
  delay = 0,
}: {
  className?: string;
  icon: React.ReactNode;
  title: string;
  value: string;
  delay?: number;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.6, delay, ease: 'easeOut' }}
      className={cn(
        'glass flex items-center gap-3 rounded-xl px-4 py-3 shadow-lg',
        className,
      )}
    >
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-background/80 ring-1 ring-border">
        {icon}
      </div>
      <div className="text-left">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="text-sm font-semibold">{value}</p>
      </div>
    </motion.div>
  );
}

function DashboardMockup() {
  return (
    <div className="flex h-full overflow-hidden rounded-xl bg-background ring-1 ring-border">
      {/* Sidebar */}
      <div className="hidden w-48 shrink-0 border-r border-border bg-muted/30 p-3 sm:block">
        <div className="mb-4 flex items-center gap-2 px-2">
          <div className="h-6 w-6 rounded bg-gradient-to-br from-primary to-blue-500" />
          <div className="h-3 w-20 rounded bg-foreground/80" />
        </div>
        {['Dashboard', 'Inventory', 'Locations', 'Suppliers', 'Reports', 'Team', 'Settings'].map(
          (l, i) => (
            <div
              key={l}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs',
                i === 1 ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
              )}
            >
              <div className={cn('h-3 w-3 rounded-sm', i === 1 ? 'bg-primary/70' : 'bg-muted-foreground/40')} />
              {l}
            </div>
          ),
        )}
      </div>

      {/* Main */}
      <div className="flex-1 p-4">
        {/* Stat row */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: 'Items', value: '4,128' },
            { label: 'Value', value: '$184,920' },
            { label: 'Low stock', value: '6' },
            { label: 'Out', value: '2' },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border bg-card px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {s.label}
              </p>
              <p className="text-sm font-semibold">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Mini chart */}
        <div className="mt-3 flex h-24 items-end gap-1.5 rounded-lg border bg-card p-3">
          {[40, 55, 38, 70, 62, 90, 72, 88, 64, 78, 92, 70].map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm bg-gradient-to-t from-primary/30 to-primary/80"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>

        {/* Table */}
        <div className="mt-3 overflow-hidden rounded-lg border bg-card">
          <div className="grid grid-cols-12 gap-2 border-b bg-muted/40 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <div className="col-span-5">Item</div>
            <div className="col-span-2">SKU</div>
            <div className="col-span-2">Location</div>
            <div className="col-span-2">Qty</div>
            <div className="col-span-1 text-right">Status</div>
          </div>
          {[
            ['Wireless Mouse', 'SP-WM-001', 'Warehouse A', 124, 'In stock'],
            ['USB-C Cable 2m', 'SP-CB-220', 'Warehouse A', 8, 'Low'],
            ['Laser Printer Toner', 'SP-PT-441', 'Office', 0, 'Out'],
            ['Mech Keyboard', 'SP-KB-913', 'Warehouse B', 56, 'In stock'],
          ].map((row, i) => (
            <div
              key={i}
              className="grid grid-cols-12 gap-2 border-b px-3 py-2 text-xs last:border-b-0"
            >
              <div className="col-span-5 truncate">{row[0]}</div>
              <div className="col-span-2 truncate text-muted-foreground">{row[1]}</div>
              <div className="col-span-2 truncate text-muted-foreground">{row[2]}</div>
              <div className="col-span-2 font-medium">{row[3]}</div>
              <div className="col-span-1 text-right">
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px]',
                    row[4] === 'In stock' && 'bg-success/15 text-success',
                    row[4] === 'Low' && 'bg-warning/20 text-warning',
                    row[4] === 'Out' && 'bg-destructive/15 text-destructive',
                  )}
                >
                  {row[4]}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
