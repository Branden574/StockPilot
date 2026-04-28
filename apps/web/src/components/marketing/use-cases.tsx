'use client';

import { motion } from 'framer-motion';
import {
  Briefcase,
  Building,
  Car,
  GraduationCap,
  Hammer,
  HeartHandshake,
  type LucideIcon,
  ShoppingBag,
  Stethoscope,
  Truck,
  Warehouse,
} from 'lucide-react';

interface UseCase {
  icon: LucideIcon;
  title: string;
  body: string;
}

const CASES: UseCase[] = [
  { icon: ShoppingBag, title: 'Ecommerce sellers', body: 'Sync stock across SKUs and channels.' },
  { icon: Warehouse, title: 'Warehouses', body: 'Bin-level tracking. Faster picks.' },
  { icon: Building, title: 'Retail stores', body: 'POS-aware stock counts.' },
  { icon: Truck, title: 'Field service teams', body: 'Track parts in vehicles and job sites.' },
  { icon: GraduationCap, title: 'Schools', body: 'Loanable equipment and supply rooms.' },
  { icon: Car, title: 'Auto + detailing', body: 'Per-bay supply tracking.' },
  { icon: Briefcase, title: 'Offices', body: 'IT assets, badges, swag.' },
  { icon: Hammer, title: 'Construction', body: 'Tools and materials by job.' },
  { icon: HeartHandshake, title: 'Nonprofits', body: 'Donations and distribution logs.' },
  { icon: Stethoscope, title: 'Medical / dental', body: 'Supplies with expiry tracking.' },
];

export function UseCases() {
  return (
    <section id="use-cases" className="container mx-auto max-w-7xl px-4 py-24 sm:px-6">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">
          Use cases
        </p>
        <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
          One tool. Every kind of stuff.
        </h2>
        <p className="mt-4 text-balance text-muted-foreground">
          From bin-level warehouse picking to a tray of detailing supplies, StockPilot bends to fit your operation.
        </p>
      </div>

      <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {CASES.map((u, i) => (
          <motion.div
            key={u.title}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.4, delay: (i % 5) * 0.04, ease: 'easeOut' }}
            className="rounded-xl border bg-card p-4 transition-colors hover:bg-accent/30"
          >
            <u.icon className="h-5 w-5 text-primary" />
            <p className="mt-3 text-sm font-semibold">{u.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{u.body}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
