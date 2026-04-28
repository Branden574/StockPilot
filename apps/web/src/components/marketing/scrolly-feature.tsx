'use client';

import { ArrowLeftRight, BarChart3, Search } from 'lucide-react';
import * as React from 'react';

import { Sparkline } from '@/components/ui/sparkline';
import { StockBar } from '@/components/ui/stock-bar';
import { SAMPLE_CHART_DAYS, SAMPLE_ITEMS, SAMPLE_MOVEMENTS } from '@/components/marketing/sample-data';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────
// Easings + helpers
// ─────────────────────────────────────────────────────────────────────
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const sub = (p: number, a: number, b: number) => Math.max(0, Math.min(1, (p - a) / (b - a)));

function useScrollProgress(ref: React.RefObject<HTMLElement | null>) {
  const [p, setP] = React.useState(0);
  React.useEffect(() => {
    const onScroll = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const total = r.height + vh;
      const passed = vh - r.top;
      setP(Math.max(0, Math.min(1, passed / total)));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [ref]);
  return p;
}

interface SceneProps {
  p: number;
}

// ─────────────────────────────────────────────────────────────────────
// Scenes
// ─────────────────────────────────────────────────────────────────────

function Scene1({ p }: SceneProps) {
  const items = SAMPLE_ITEMS.slice(0, 7);
  return (
    <div
      className="scn-card"
      style={{ transform: `translateY(${(1 - easeOut(p)) * 24}px)`, opacity: easeOut(p) }}
    >
      <SceneHead
        left={
          <>
            <span
              aria-hidden
              className="h-[14px] w-[14px] rounded-[3px]"
              style={{
                background:
                  'repeating-linear-gradient(45deg, hsl(var(--border)) 0 1px, transparent 1px 6px), hsl(var(--muted))',
              }}
            />
            <span className="text-[12px] font-medium">Items</span>
            <span className="font-mono text-[11px] text-[var(--ed-ink-3)]">17 SKUs · $52,408</span>
          </>
        }
        right={
          <span className="rounded-[3px] border border-border bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--ed-ink-3)]">
            ⌘K
          </span>
        }
      />
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="border-b border-border">
            <th className="h-9 pl-3.5 pr-3 text-left text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]">
              Item
            </th>
            <th className="h-9 px-3 text-right text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]">
              On hand
            </th>
            <th className="h-9 px-3 text-left text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]">
              Coverage
            </th>
            <th className="h-9 px-3 text-right text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]">
              Trend
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => {
            const local = sub(p, i * 0.06, i * 0.06 + 0.4);
            return (
              <tr
                key={it.sku}
                className="border-b border-border last:border-0"
                style={{ opacity: local, transform: `translateX(${(1 - local) * 12}px)` }}
              >
                <td className="py-2.5 pl-3.5 pr-3">
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
                      <div>{it.name}</div>
                      <div className="font-mono text-[10px] tracking-[-0.01em] text-[var(--ed-ink-3)]">
                        {it.sku}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-3 text-right font-mono tabular-nums">
                  {it.stock} <span className="text-[var(--ed-ink-4)]">{it.uom}</span>
                </td>
                <td className="px-3">
                  <StockBar stock={it.stock} par={it.par} status={it.status} />
                </td>
                <td className="px-3 text-right">
                  <Sparkline data={it.series} width={56} height={18} tone={it.trend} />
                </td>
                <td className="pl-3 pr-3.5 text-right">
                  <StatusPill status={it.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: 'ok' | 'warn' | 'crit' }) {
  const label = status === 'crit' ? 'Out' : status === 'warn' ? 'Low' : 'OK';
  return (
    <span
      className={cn('inline-flex h-5 items-center gap-1 rounded-[4px] px-1.5 text-[11px] font-medium', {
        'bg-[hsl(var(--accent)/0.18)] text-[hsl(var(--accent-foreground))]': status === 'ok',
        'bg-[hsl(var(--warning)/0.18)] text-[hsl(var(--warning-foreground))]': status === 'warn',
        'bg-[hsl(var(--destructive)/0.16)] text-[hsl(var(--destructive))]': status === 'crit',
      })}
    >
      <span className="h-1 w-1 rounded-full bg-current" />
      {label}
    </span>
  );
}

function Scene2({ p }: SceneProps) {
  const ms = SAMPLE_MOVEMENTS.slice(0, 6);
  return (
    <div className="scn-card">
      <SceneHead
        left={
          <>
            <ArrowLeftRight className="h-3.5 w-3.5" />
            <span className="text-[12px] font-medium">Movements · live</span>
          </>
        }
        right={
          <span className="inline-flex items-center gap-1.5 text-[10.5px] text-[hsl(var(--accent-foreground))]">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]"
              style={{ animation: 'scn-pulse-dot 1.6s infinite' }}
            />
            REC
          </span>
        }
      />
      <div className="py-1">
        {ms.map((m, i) => {
          const local = sub(p, i * 0.08, i * 0.08 + 0.45);
          const qty = Math.round(m.qty * easeOut(local));
          return (
            <div
              key={m.id}
              className={cn('grid items-center gap-3 px-4 py-2.5', i === ms.length - 1 ? '' : 'border-b border-border')}
              style={{
                gridTemplateColumns: '64px 1fr auto',
                opacity: local,
                transform: `translateY(${(1 - local) * 8}px)`,
              }}
            >
              <div className="font-mono text-[10.5px] text-[var(--ed-ink-3)]">
                {m.at.split(' · ')[1] ?? m.at}
              </div>
              <div>
                <div className="text-[11.5px]">
                  <span
                    className={cn('mr-1.5 inline-flex h-[18px] items-center rounded-[4px] px-1.5 text-[10px] font-medium', {
                      'bg-[hsl(var(--accent)/0.18)] text-[hsl(var(--accent-foreground))]': m.qty > 0,
                      'bg-muted text-[var(--ed-ink-3)]': m.qty <= 0,
                    })}
                  >
                    {m.type}
                  </span>
                  {m.item}
                </div>
                <div className="mt-0.5 font-mono text-[10px] tracking-[-0.01em] text-[var(--ed-ink-3)]">
                  {m.user} · {m.ref}
                </div>
              </div>
              <div
                className={cn('font-mono text-[12.5px] font-medium tabular-nums', {
                  'text-[hsl(var(--accent-foreground))]': m.qty > 0,
                  'text-[var(--ed-ink-3)]': m.qty <= 0,
                })}
              >
                {m.qty > 0 ? '+' : ''}
                {qty}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Scene3({ p }: SceneProps) {
  const w = 520;
  const h = 200;
  const padX = 12;
  const padY = 16;
  const data = SAMPLE_CHART_DAYS.slice(-24);
  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = (w - padX * 2) / (data.length - 1);
  const pts = data.map((d, i) => [
    padX + i * stepX,
    padY + (h - padY * 2) - ((d.value - min) / span) * (h - padY * 2),
  ] as const);
  const path = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(' ');
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const area =
    `M${first[0]},${h - padY} ` +
    pts.map((pt) => `L${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(' ') +
    ` L${last[0]},${h - padY} Z`;

  const drawP = easeOut(sub(p, 0, 0.6));
  const lineLen = 1200;
  const dashOffset = (1 - drawP) * lineLen;
  const toastP = easeOut(sub(p, 0.55, 0.85));

  return (
    <div className="scn-card">
      <SceneHead
        left={
          <>
            <BarChart3 className="h-3.5 w-3.5" />
            <span className="text-[12px] font-medium">Inventory value · 30 days</span>
          </>
        }
        right={<span className="font-mono text-[10.5px] text-[var(--ed-ink-3)]">USD · cost basis</span>}
      />
      <div className="relative px-3.5 pb-3.5 pt-2">
        <svg viewBox={`0 0 ${w} ${h}`} className="block h-[200px] w-full">
          {[0, 1, 2, 3, 4].map((i) => {
            const y = padY + (i * (h - padY * 2)) / 4;
            return (
              <line
                key={i}
                x1={padX}
                x2={w - padX}
                y1={y}
                y2={y}
                stroke="hsl(var(--border))"
                strokeDasharray="2 4"
              />
            );
          })}
          <path d={area} fill="hsl(var(--accent))" opacity={0.1 * drawP} />
          <path
            d={path}
            fill="none"
            stroke="hsl(var(--accent))"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={lineLen}
            strokeDashoffset={dashOffset}
          />
          {drawP > 0.95 && (
            <circle
              cx={last[0]}
              cy={last[1]}
              r={4}
              fill="hsl(var(--card))"
              stroke="hsl(var(--accent))"
              strokeWidth={1.6}
            />
          )}
        </svg>

        <div
          className="absolute right-6 top-7 w-[220px] rounded-[8px] border border-border bg-card p-3 shadow-[0_24px_48px_-16px_rgba(14,15,13,0.18)]"
          style={{
            opacity: toastP,
            transform: `translateY(${(1 - toastP) * 16}px) scale(${0.96 + 0.04 * toastP})`,
          }}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="inline-flex h-5 items-center gap-1 rounded-[4px] bg-[hsl(var(--destructive)/0.16)] px-1.5 text-[10px] font-medium text-[hsl(var(--destructive))]">
              <span className="h-1 w-1 rounded-full bg-current" />
              Critical
            </span>
            <span className="font-mono text-[10.5px] text-[var(--ed-ink-3)]">12 min ago</span>
          </div>
          <div className="text-[12px] font-medium">Nyeri Gichathaini AA out of stock</div>
          <div className="mt-0.5 text-[11px] text-[var(--ed-ink-3)]">12 wholesale subscribers waiting</div>
        </div>
      </div>
    </div>
  );
}

function Scene4({ p }: SceneProps) {
  const queryFull = 'receive yirgacheffe';
  const typedLen = Math.floor(easeOut(sub(p, 0, 0.45)) * queryFull.length);
  const typed = queryFull.slice(0, typedLen);

  const cmds = [
    { label: 'Receive stock…', section: 'Action · R' },
    { label: 'Yirgacheffe Konga', sub: 'GRN-ETH-YIR-G2', section: 'Item' },
    { label: 'Guji Hambela Natural', sub: 'GRN-ETH-GUJ-N1', section: 'Item' },
    { label: 'PO-1041 · Falcon Specialty', section: 'PO' },
  ];

  const hlP = sub(p, 0.45, 0.95);
  const hl = Math.min(cmds.length - 1, Math.floor(hlP * cmds.length * 0.95));

  return (
    <div className="scn-card" style={{ width: 520, maxWidth: '100%' }}>
      <div className="flex h-11 items-center gap-2.5 border-b border-border px-4 text-[13px]">
        <Search className="h-3.5 w-3.5 text-[var(--ed-ink-3)]" />
        <span>
          {typed}
          <span
            aria-hidden
            className="ml-px inline-block h-[14px] w-px bg-foreground align-middle"
            style={{ animation: 'scn-blink 1s steps(2, end) infinite' }}
          />
        </span>
      </div>
      <div className="p-1.5">
        {cmds.map((c, i) => (
          <div
            key={c.label}
            className={cn(
              'flex items-center gap-2.5 rounded-[5px] px-3 py-2 text-[12.5px] transition-colors',
              i === hl ? 'bg-muted text-foreground' : 'text-[var(--ed-ink-3)]',
            )}
          >
            <span>{c.label}</span>
            {c.sub && <span className="font-mono text-[10.5px] text-[var(--ed-ink-3)]">{c.sub}</span>}
            <span className="ml-auto font-mono text-[10.5px] text-[var(--ed-ink-4)]">{c.section}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-3.5 border-t border-border bg-muted px-3.5 py-2 text-[10.5px] text-[var(--ed-ink-4)]">
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span>
          <Kbd>↑↓</Kbd> navigate
        </span>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-[3px] border border-border bg-card px-1 py-px font-mono text-[10px] text-[var(--ed-ink-3)]">
      {children}
    </span>
  );
}

function SceneHead({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex h-10 items-center justify-between border-b border-border bg-background px-4">
      <div className="flex items-center gap-2">{left}</div>
      {right}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Section orchestrator
// ─────────────────────────────────────────────────────────────────────

interface SceneDef {
  eyebrow: string;
  title: React.ReactNode;
  body: string;
  Visual: React.ComponentType<SceneProps>;
}

const SCENES: SceneDef[] = [
  {
    eyebrow: '01 — Items',
    title: (
      <>
        SKUs <span className="font-serif-italic text-[var(--ed-ink-3)]">that mean something.</span>
      </>
    ),
    body: 'Origins, lots, par levels, sell prices, costs — all first-class. Sparklines and coverage on every row, by default.',
    Visual: Scene1,
  },
  {
    eyebrow: '02 — Movements',
    title: (
      <>
        Every count <span className="font-serif-italic text-[var(--ed-ink-3)]">has a reason.</span>
      </>
    ),
    body: 'Receive, sell, transfer, adjust, roast in, roast out. Each row is a quantity change you can stand behind, traceable to a person and a reference.',
    Visual: Scene2,
  },
  {
    eyebrow: '03 — Signal',
    title: (
      <>
        The chart <span className="font-serif-italic text-[var(--ed-ink-3)]">is the table.</span>
      </>
    ),
    body: "Trends, coverage, and weekly draw are inline — not buried two clicks deep. Critical alerts surface the moment they're true.",
    Visual: Scene3,
  },
  {
    eyebrow: '04 — Speed',
    title: (
      <>
        Cmd-K, <span className="font-serif-italic text-[var(--ed-ink-3)]">everywhere.</span>
      </>
    ),
    body: 'Jump to any item, run any action, kick off a count — without lifting your hands. Built for operators who already know what they want.',
    Visual: Scene4,
  },
];

export function ScrollyFeature() {
  const ref = React.useRef<HTMLElement | null>(null);
  const p = useScrollProgress(ref);

  const N = SCENES.length;
  const sceneIdx = Math.min(N - 1, Math.floor(p * N));
  const localP = p * N - sceneIdx;
  const fadeIn = easeInOut(Math.min(1, localP / 0.18));
  const fadeOutPrev = 1 - fadeIn;

  const ActiveVisual = SCENES[sceneIdx]!.Visual;
  const PrevVisual = sceneIdx > 0 ? SCENES[sceneIdx - 1]!.Visual : null;

  return (
    <section
      ref={ref}
      className="scrolly-section relative border-y border-border bg-warm-radial"
      style={{ height: `${100 + N * 70}vh` }}
    >
      <div className="scrolly-pin">
        <div className="mb-7 max-w-[720px] shrink-0">
          <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ed-ink-4)]">
            — Inside StockPilot
          </p>
          <h2 className="font-display text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-balance">
            Four ideas, <span className="font-serif-italic text-[var(--ed-ink-3)]">one quiet system.</span>
          </h2>
        </div>

        <div className="grid items-center gap-16 lg:grid-cols-[1fr_1.15fr]">
          <div className="relative h-[320px]">
            {SCENES.map((s, i) => {
              const isActive = i === sceneIdx;
              const isPrev = i === sceneIdx - 1 && localP < 0.18;
              let opacity = 0;
              let ty = 24;
              if (isActive) {
                opacity = fadeIn;
                ty = (1 - fadeIn) * 24;
              } else if (isPrev) {
                opacity = fadeOutPrev;
                ty = -fadeIn * 24;
              }
              return (
                <div
                  key={s.eyebrow}
                  className="absolute inset-0 flex flex-col justify-center"
                  style={{
                    opacity,
                    transform: `translateY(${ty}px)`,
                    pointerEvents: isActive ? 'auto' : 'none',
                  }}
                >
                  <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--ed-ink-4)]">
                    {s.eyebrow}
                  </div>
                  <h3 className="mb-4 font-display text-[clamp(36px,4.4vw,60px)] font-medium leading-[1.02] tracking-[-0.03em] text-balance">
                    {s.title}
                  </h3>
                  <p className="max-w-[460px] text-[16px] leading-[1.55] text-[var(--ed-ink-3)] text-pretty">
                    {s.body}
                  </p>
                </div>
              );
            })}

            <div className="absolute -bottom-14 left-0 flex gap-2">
              {SCENES.map((_, i) => {
                const isPassed = i < sceneIdx;
                const isActive = i === sceneIdx;
                const fill = isPassed ? 100 : isActive ? easeInOut(localP) * 100 : 0;
                return (
                  <span
                    key={i}
                    className="block h-0.5 w-9 overflow-hidden rounded-full bg-[var(--ed-line)]"
                  >
                    <span
                      className="block h-full bg-foreground transition-[width] duration-100"
                      style={{ width: `${fill}%` }}
                    />
                  </span>
                );
              })}
            </div>
          </div>

          <div className="relative flex h-[420px] items-center justify-center">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-10 rounded-[32px]"
              style={{
                background:
                  'radial-gradient(420px 320px at 50% 50%, color-mix(in oklab, hsl(var(--accent)) 10%, transparent), transparent 70%)',
              }}
            />
            {PrevVisual && localP < 0.18 && (
              <div
                className="absolute inset-0 flex items-center justify-center"
                style={{
                  opacity: fadeOutPrev,
                  transform: `translateY(${-fadeIn * 20}px) scale(${1 - fadeIn * 0.02})`,
                }}
              >
                <PrevVisual p={1} />
              </div>
            )}
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{
                opacity: fadeIn,
                transform: `translateY(${(1 - fadeIn) * 20}px) scale(${0.98 + fadeIn * 0.02})`,
              }}
            >
              <ActiveVisual p={localP} />
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        .scn-card {
          width: 540px;
          max-width: 96%;
          background: hsl(var(--card));
          border: 1px solid hsl(var(--border));
          border-radius: 12px;
          box-shadow:
            0 1px 0 rgba(14, 15, 13, 0.04),
            0 24px 48px -16px rgba(14, 15, 13, 0.18),
            0 8px 16px -8px rgba(14, 15, 13, 0.06);
          overflow: hidden;
        }
        .dark .scn-card {
          box-shadow:
            0 1px 0 rgba(0, 0, 0, 0.4),
            0 24px 48px -16px rgba(0, 0, 0, 0.7);
        }
      `}</style>
    </section>
  );
}
