'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { Boxes, Camera, Check, Plus, ScanLine } from 'lucide-react';

export function MobileMockup() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-mesh opacity-50" />
      <div className="container relative mx-auto max-w-7xl px-4 py-24 sm:px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-primary">Native iOS &amp; Android</p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
              Scan with your phone. Stock updates everywhere.
            </h2>
            <p className="mt-4 text-balance text-muted-foreground">
              Built with Expo. Camera barcode + QR, image capture, push notifications, and offline-first
              support — all sharing the same data with the web app.
            </p>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                'Scan barcodes and QR codes with the device camera',
                'Adjust stock with a single tap',
                'Push alerts when stock dips below reorder point',
                'Snap photos straight into the item record',
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="relative flex h-[560px] items-center justify-center">
            <motion.div
              initial={reduceMotion ? false : { y: 30, opacity: 0, rotate: -6 }}
              whileInView={{ y: 0, opacity: 1, rotate: -6 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              className="absolute left-2 top-2"
            >
              <Phone variant="ios">
                <PhoneInventoryView />
              </Phone>
            </motion.div>
            <motion.div
              initial={reduceMotion ? false : { y: 30, opacity: 0, rotate: 6 }}
              whileInView={{ y: 0, opacity: 1, rotate: 6 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.6, delay: 0.15, ease: 'easeOut' }}
              className="absolute right-2 bottom-2"
            >
              <Phone variant="android">
                <PhoneScanView />
              </Phone>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Phone({ children, variant }: { children: React.ReactNode; variant: 'ios' | 'android' }) {
  return (
    <div className="relative w-[240px]">
      <div className="rounded-[2.4rem] border-[8px] border-zinc-900 bg-zinc-900 shadow-2xl">
        <div className="relative aspect-[9/19.5] overflow-hidden rounded-[1.7rem] bg-background">
          {variant === 'ios' && (
            <div className="absolute left-1/2 top-1.5 z-10 h-5 w-20 -translate-x-1/2 rounded-full bg-zinc-900" aria-hidden />
          )}
          {variant === 'android' && (
            <div className="absolute left-1/2 top-2 z-10 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-zinc-700" aria-hidden />
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

function PhoneInventoryView() {
  const items = [
    { name: 'Wireless Mouse', sku: 'SP-WM-001', qty: 124, status: 'in' },
    { name: 'USB-C Cable 2m', sku: 'SP-CB-220', qty: 8, status: 'low' },
    { name: 'Mech Keyboard', sku: 'SP-KB-913', qty: 56, status: 'in' },
    { name: 'Toner 441', sku: 'SP-PT-441', qty: 0, status: 'out' },
    { name: 'Power strip', sku: 'SP-PS-040', qty: 32, status: 'in' },
  ];
  return (
    <div className="flex h-full flex-col bg-background pt-8 text-foreground">
      <div className="px-4 pb-3">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Inventory</p>
        <h4 className="text-base font-semibold">Main warehouse</h4>
      </div>
      <div className="flex-1 space-y-1.5 overflow-hidden px-3">
        {items.map((it) => (
          <div key={it.sku} className="flex items-center gap-3 rounded-lg border bg-card px-2.5 py-2">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-muted text-muted-foreground">
              <Boxes className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-semibold">{it.name}</p>
              <p className="truncate font-mono text-[9px] text-muted-foreground">{it.sku}</p>
            </div>
            <div className="text-right">
              <p
                className={
                  'text-sm font-semibold tabular-nums ' +
                  (it.status === 'low' ? 'text-warning' : it.status === 'out' ? 'text-destructive' : '')
                }
              >
                {it.qty}
              </p>
            </div>
          </div>
        ))}
      </div>
      <div className="border-t bg-muted/30 px-3 py-2.5">
        <button className="flex w-full items-center justify-center gap-1.5 rounded-md bg-gradient-to-r from-primary to-blue-500 px-3 py-2 text-[11px] font-semibold text-primary-foreground">
          <Plus className="h-3 w-3" /> Add item
        </button>
      </div>
    </div>
  );
}

function PhoneScanView() {
  return (
    <div className="relative h-full bg-zinc-950 pt-8">
      <div className="px-4 pb-3 text-white">
        <p className="text-[9px] uppercase tracking-wider text-zinc-400">Scan</p>
        <h4 className="text-base font-semibold">Point at a barcode</h4>
      </div>
      <div className="relative mx-3 aspect-square overflow-hidden rounded-2xl bg-zinc-900">
        <div className="absolute inset-6 rounded-xl border-2 border-primary/60" aria-hidden />
        <motion.div
          aria-hidden
          className="absolute inset-x-8 top-12 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent"
          animate={{ y: [0, 100, 0] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
        />
        <Camera className="absolute right-3 top-3 h-3.5 w-3.5 text-zinc-500" />
      </div>
      <div className="mt-3 mx-3 rounded-xl bg-white/95 p-3 text-zinc-900 shadow">
        <div className="flex items-center gap-2">
          <ScanLine className="h-3.5 w-3.5 text-primary" />
          <p className="font-mono text-[10px] text-zinc-500">012345678905</p>
        </div>
        <p className="mt-1 text-xs font-semibold">USB-C Cable 2m</p>
        <div className="mt-2 flex gap-1.5">
          <button className="flex-1 rounded bg-zinc-100 py-1.5 text-[10px] font-semibold">−1</button>
          <button className="flex-1 rounded bg-gradient-to-r from-primary to-blue-500 py-1.5 text-[10px] font-semibold text-white">
            +5
          </button>
          <button className="flex-1 rounded bg-zinc-100 py-1.5 text-[10px] font-semibold">+25</button>
        </div>
      </div>
    </div>
  );
}
