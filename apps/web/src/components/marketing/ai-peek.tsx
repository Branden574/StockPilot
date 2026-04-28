'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { Sparkles, Wand2 } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';

const SUGGESTIONS = [
  {
    type: 'reorder',
    text: 'Reorder 24 units of USB-C Cable 2m next Tuesday — projected stock-out in 6 days.',
  },
  {
    type: 'anomaly',
    text: 'SKU SP-PT-441 had 18 manual adjustments this week. Top reason: "damaged in transit". Worth a look.',
  },
  {
    type: 'forecast',
    text: 'Q3 demand for Mech Keyboards trends +22% YoY. Increase reorder qty from 25 → 35.',
  },
];

export function AiPeek() {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = React.useState(0);

  React.useEffect(() => {
    if (reduceMotion) return;
    const t = setInterval(() => {
      setActive((i) => (i + 1) % SUGGESTIONS.length);
    }, 3500);
    return () => clearInterval(t);
  }, [reduceMotion]);

  return (
    <section className="container mx-auto max-w-7xl px-4 py-24 sm:px-6">
      <div className="mx-auto max-w-2xl text-center">
        <Badge variant="outline" className="mx-auto mb-6 gap-1.5 bg-background/60 backdrop-blur">
          <Sparkles className="h-3 w-3 text-primary" />
          AI — preview
        </Badge>
        <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
          Soon, your inventory talks back.
        </h2>
        <p className="mt-4 text-balance text-muted-foreground">
          Demand forecasts, anomaly detection, and a chat that answers &ldquo;what should I reorder this
          week?&rdquo; — built on the same ledger your scans already feed.
        </p>
      </div>

      <div className="mx-auto mt-12 grid max-w-5xl gap-6 lg:grid-cols-2">
        {/* Chat preview */}
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-primary to-blue-500 text-primary-foreground">
              <Wand2 className="h-3.5 w-3.5" />
            </span>
            <p className="text-sm font-semibold">Ask your inventory</p>
          </div>

          <div className="space-y-2.5">
            <Bubble side="user">What's my projected stock-out for Q3?</Bubble>
            <Bubble side="assistant" delay={0.2}>
              Based on the last 90 days of stock movements, three SKUs will run out before Q3 ends:
            </Bubble>
            <Bubble side="assistant" delay={0.4}>
              <ul className="space-y-1 text-xs">
                <li>· <strong>USB-C Cable 2m</strong> — Aug 9 (24 days)</li>
                <li>· <strong>Toner 441</strong> — Aug 22 (37 days)</li>
                <li>· <strong>Power strip</strong> — Sept 14 (60 days)</li>
              </ul>
            </Bubble>
            <Bubble side="user" delay={0.7}>Draft POs for all three.</Bubble>
            <Bubble side="assistant" delay={0.9}>
              Drafted 3 POs in <span className="rounded bg-muted px-1 font-mono text-[10px]">draft</span> status. Review and send when ready.
            </Bubble>
          </div>
        </div>

        {/* Insights ticker */}
        <div className="rounded-2xl border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <p className="text-sm font-semibold">Suggestions</p>
          </div>

          <div className="space-y-2">
            {SUGGESTIONS.map((s, i) => (
              <motion.div
                key={s.text}
                animate={{
                  opacity: i === active ? 1 : 0.4,
                  scale: i === active ? 1 : 0.98,
                }}
                transition={{ duration: 0.3 }}
                className={
                  'rounded-xl border p-3 text-sm transition-colors ' +
                  (i === active ? 'border-primary/40 bg-primary/5' : 'bg-muted/30')
                }
              >
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {s.type}
                </p>
                <p className="mt-1">{s.text}</p>
              </motion.div>
            ))}
          </div>

          <p className="mt-5 text-xs text-muted-foreground">
            Available at launch on the Business plan.
          </p>
        </div>
      </div>
    </section>
  );
}

function Bubble({
  side,
  delay = 0,
  children,
}: {
  side: 'user' | 'assistant';
  delay?: number;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{ duration: 0.4, delay }}
      className={
        'flex ' + (side === 'user' ? 'justify-end' : 'justify-start')
      }
    >
      <div
        className={
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm ' +
          (side === 'user'
            ? 'bg-gradient-to-br from-primary to-blue-500 text-primary-foreground'
            : 'bg-muted text-foreground')
        }
      >
        {children}
      </div>
    </motion.div>
  );
}
