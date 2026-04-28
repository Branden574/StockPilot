'use client';

import { motion } from 'framer-motion';
import {
  Bell,
  Building2,
  ClipboardList,
  LineChart,
  type LucideIcon,
  PackageSearch,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Users,
} from 'lucide-react';

import { cn } from '@/lib/utils';

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
  iconClass?: string;
}

const FEATURES: Feature[] = [
  {
    icon: ScanLine,
    title: 'Barcode + QR scanning',
    body: 'Scan items with the camera in any modern phone. Adjust stock with one tap.',
    iconClass: 'from-primary to-blue-500',
  },
  {
    icon: Building2,
    title: 'Multi-location stock',
    body: 'Track quantities per warehouse, room, shelf, vehicle, or job site.',
    iconClass: 'from-violet-500 to-fuchsia-500',
  },
  {
    icon: Bell,
    title: 'Low-stock alerts',
    body: 'Reorder points trigger email + push so you never run out.',
    iconClass: 'from-amber-500 to-orange-500',
  },
  {
    icon: ClipboardList,
    title: 'Purchase orders',
    body: 'Draft, send, and receive POs. Stock updates automatically on receipt.',
    iconClass: 'from-emerald-500 to-green-500',
  },
  {
    icon: LineChart,
    title: 'Reports & analytics',
    body: 'Inventory value, top movers, slow movers — exportable in one click.',
    iconClass: 'from-sky-500 to-cyan-500',
  },
  {
    icon: Users,
    title: 'Team & roles',
    body: 'Owners, admins, managers, staff, viewers — least-privilege by default.',
    iconClass: 'from-rose-500 to-pink-500',
  },
  {
    icon: Smartphone,
    title: 'Native iOS + Android',
    body: 'Built with Expo. Same data, same speed, on every device.',
    iconClass: 'from-indigo-500 to-blue-500',
  },
  {
    icon: PackageSearch,
    title: 'CSV import / export',
    body: 'Bring your existing spreadsheet. Validate, dry-run, then import.',
    iconClass: 'from-teal-500 to-emerald-500',
  },
  {
    icon: ShieldCheck,
    title: 'Enterprise-grade security',
    body: 'Postgres RLS, audit logs, SSO-ready. Your data, isolated.',
    iconClass: 'from-slate-500 to-zinc-500',
  },
];

export function FeatureGrid() {
  return (
    <section id="features" className="container mx-auto max-w-7xl px-4 py-24 sm:px-6">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          Everything you need
        </p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
          The basics, perfected. The hard parts, handled.
        </h2>
        <p className="mt-4 text-balance text-muted-foreground">
          From the first scan to the 50,000th SKU, StockPilot stays fast, clean, and out of your way.
        </p>
      </div>

      <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.45, delay: i * 0.05, ease: 'easeOut' }}
            className="group relative overflow-hidden rounded-xl border bg-card p-6 transition-shadow hover:shadow-md"
          >
            <div
              className={cn(
                'mb-4 grid h-10 w-10 place-items-center rounded-lg bg-gradient-to-br text-white shadow-sm',
                f.iconClass,
              )}
            >
              <f.icon className="h-5 w-5" />
            </div>
            <h3 className="text-base font-semibold">{f.title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
