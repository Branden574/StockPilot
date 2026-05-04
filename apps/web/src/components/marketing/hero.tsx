'use client';

import {
  ArrowRight,
  ArrowLeftRight,
  Bell,
  BookOpen,
  Boxes,
  ClipboardList,
  Cog,
  Home,
  MapPin,
  Users,
} from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Sparkline } from '@/components/ui/sparkline';
import { StockBar } from '@/components/ui/stock-bar';
import { SAMPLE_ITEMS } from '@/components/marketing/sample-data';
import { cn } from '@/lib/utils';

export function Hero() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-[1280px] px-8 pb-16 pt-24 text-center sm:pt-28">
        <span
          className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[11.5px] text-[var(--ed-ink-3)]"
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" />
          v3.0 — Cycle counts, lot tracking, and a faster cmd palette
        </span>

        <h1 className="mx-auto max-w-4xl font-display text-[clamp(48px,7vw,88px)] font-medium leading-[0.96] tracking-[-0.04em] text-balance">
          Inventory software
          <br />
          <span className="font-serif-italic text-[var(--ed-ink-3)]">quiet enough</span> to actually use.
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.5] text-[var(--ed-ink-3)] text-balance">
          StockPilot is the internal inventory platform for our charters and warehouses. Counts,
          costs, and movements you can trust — without the dashboard slop.
        </p>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          <Button asChild size="lg" className="gap-1.5">
            <Link href="/signin">
              Sign in to your workspace <ArrowRight className="h-3 w-3" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="gap-1.5">
            <Link href="/signin">
              <BookOpen className="h-3 w-3" />
              Need access? Ask your admin
            </Link>
          </Button>
        </div>

        <div className="mx-auto mt-10 max-w-[1080px]">
          <HeroFrame />
        </div>
      </div>
    </section>
  );
}

function HeroFrame() {
  return (
    <div className="overflow-hidden rounded-[14px] border border-border bg-card shadow-[0_24px_48px_-16px_rgba(14,15,13,0.18),_0_8px_16px_-8px_rgba(14,15,13,0.08)]">
      {/* Browser chrome */}
      <div className="flex h-9 items-center gap-1.5 border-b border-border bg-background px-4">
        <span className="frame-dot" />
        <span className="frame-dot" />
        <span className="frame-dot" />
        <span className="ml-3 font-mono text-[10.5px] text-[var(--ed-ink-4)]">
          stockpilot.dev/lonsdale/inventory
        </span>
      </div>

      <div className="grid min-h-[360px] grid-cols-[200px_1fr] text-left">
        {/* Sidebar mini */}
        <aside className="border-r border-border bg-background p-3.5">
          {[
            { icon: Home, label: 'Overview' },
            { icon: Boxes, label: 'Items', active: true },
            { icon: ArrowLeftRight, label: 'Movements' },
            { icon: ClipboardList, label: 'Purchase orders' },
            { icon: MapPin, label: 'Locations' },
            { icon: Bell, label: 'Notifications' },
            { icon: Users, label: 'Team' },
            { icon: Cog, label: 'Settings' },
          ].map(({ icon: Icon, label, active }) => (
            <div
              key={label}
              className={cn(
                'mb-0.5 flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12px]',
                active
                  ? 'border border-border bg-card text-foreground'
                  : 'border border-transparent text-[var(--ed-ink-3)]',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </div>
          ))}
        </aside>

        {/* Items table */}
        <div className="p-5">
          <h3 className="font-display text-[18px] tracking-[-0.01em]">Items</h3>
          <p className="mb-3.5 text-[11px] text-[var(--ed-ink-4)]">17 SKUs · $52,408 on hand</p>

          <div className="overflow-hidden rounded-[10px] border border-border">
            <table className="w-full text-[11.5px]">
              <thead>
                <tr className="border-b border-border bg-card text-left">
                  {['Item', 'On hand', 'Coverage', '14-day'].map((h, i) => (
                    <th
                      key={h}
                      className={cn(
                        'h-9 px-3 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]',
                        i >= 1 && 'text-right',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SAMPLE_ITEMS.slice(0, 6).map((it) => (
                  <tr key={it.sku} className="border-b border-border last:border-0">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span
                          aria-hidden
                          className="h-[22px] w-[22px] shrink-0 rounded-[4px] border border-border"
                          style={{
                            background:
                              'repeating-linear-gradient(45deg, hsl(var(--border)) 0 1px, transparent 1px 6px), hsl(var(--muted))',
                          }}
                        />
                        <div>
                          <div className="leading-tight">{it.name}</div>
                          <div className="font-mono text-[10px] text-[var(--ed-ink-3)] tracking-[-0.01em]">
                            {it.sku}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      {it.stock} <span className="text-[var(--ed-ink-4)]">{it.uom}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <StockBar stock={it.stock} par={it.par} status={it.status} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Sparkline data={it.series} width={56} height={18} tone={it.trend} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
