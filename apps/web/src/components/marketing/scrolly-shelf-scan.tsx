'use client';

import * as React from 'react';

import { useScrollyProgress } from '@/lib/hooks/use-scrolly-progress';

/**
 * Chapter 2 of the landing scrollytelling. Picks up where the warehouse
 * pin (ScrollyWarehouse) hands off and shows AI Shelf Scan in motion —
 * a phone enters, the viewfinder reveals a wireframe bookshelf, a
 * shutter "click" fires, then six ISBN match-cards cascade in alongside
 * the phone, ending with a "20 min → under 30 sec" comparison ribbon.
 *
 * Shares useScrollyProgress with ScrollyWarehouse. All animation lives
 * in CSS calc()/clamp() driven off the `--p` custom property, so no
 * per-frame React renders.
 *
 * reducedMotionValue: 0.7 lands the static frame in the late-middle of
 * the scene (cards + ribbon visible, phone settled) so prefers-reduced-
 * motion users still see the differentiator-moment composition.
 */
export function ScrollyShelfScan() {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  useScrollyProgress({ trackRef, stageRef, reducedMotionValue: 0.7 });

  return (
    <section
      ref={trackRef}
      aria-label="And the phone counts the shelf for you"
      className="shelf-track relative"
      style={{ height: '280vh' }}
    >
      <div
        ref={stageRef}
        className="shelf-stage sticky top-0 flex h-screen w-full items-center justify-center overflow-hidden"
        style={{ ['--p' as string]: '0' } as React.CSSProperties}
      >
        <FloorStreaks />
        <PhoneScene />
        <ResultCards />
        <FlashOverlay />
        <CountsToast />
        <StatRibbon />
        <ChapterTitle />
      </div>

      <style>{`
        .shelf-stage {
          background:
            radial-gradient(1200px 600px at 30% 50%, rgba(70,194,202,0.08), transparent 70%),
            radial-gradient(900px 500px at 80% 40%, rgba(255,122,69,0.06), transparent 70%);
        }
        /* Phone enters from far-right at p=0, settles mid-stage by p=0.18, */
        /* holds through the scan + reveal, drifts left slightly at the end. */
        .shelf-phone {
          transform: translate3d(
            calc((1 - clamp(0, calc(var(--p) * 6), 1)) * 60% + (max(0, calc(var(--p) - 0.8)) * -25%) * 1%),
            0,
            0
          );
          opacity: clamp(0, calc(var(--p) * 6), 1);
          will-change: transform, opacity;
        }
        /* Shutter flash — bright punch at p ~ 0.28, fades fast. */
        .shelf-flash {
          opacity: clamp(0, calc((0.32 - var(--p)) * 14 * calc((var(--p) - 0.22) * 14)), 0.85);
        }
        /* Books become slightly desaturated after capture to signal */
        /* "this frame was taken." */
        .shelf-books {
          opacity: clamp(0.45, calc(1 - var(--p) * 0.5), 1);
        }
        /* Six result cards cascade in between p=0.42 and p=0.72. Each card */
        /* gets a 0.05-progress-stagger. */
        .shelf-card { opacity: 0; transform: translate3d(60px, 0, 0); }
        .shelf-card-1 { opacity: clamp(0, min(calc((var(--p) - 0.40) * 12), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(calc(max(0px, (0.46 - var(--p)) * 200px)), 0, 0); }
        .shelf-card-2 { opacity: clamp(0, min(calc((var(--p) - 0.46) * 12), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(calc(max(0px, (0.52 - var(--p)) * 200px)), 0, 0); }
        .shelf-card-3 { opacity: clamp(0, min(calc((var(--p) - 0.52) * 12), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(calc(max(0px, (0.58 - var(--p)) * 200px)), 0, 0); }
        .shelf-card-4 { opacity: clamp(0, min(calc((var(--p) - 0.58) * 12), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(calc(max(0px, (0.64 - var(--p)) * 200px)), 0, 0); }
        .shelf-card-5 { opacity: clamp(0, min(calc((var(--p) - 0.64) * 12), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(calc(max(0px, (0.70 - var(--p)) * 200px)), 0, 0); }
        .shelf-card-6 { opacity: clamp(0, min(calc((var(--p) - 0.70) * 12), calc((0.96 - var(--p)) * 10)), 1); transform: translate3d(calc(max(0px, (0.76 - var(--p)) * 200px)), 0, 0); }
        /* "Counts updated" toast — slides up onto the phone after all 6 */
        /* cards have appeared. */
        .shelf-toast {
          opacity: clamp(0, min(calc((var(--p) - 0.76) * 12), calc((0.96 - var(--p)) * 10)), 1);
          transform: translate3d(0, calc(max(0px, (0.82 - var(--p)) * 30px)), 0);
        }
        /* Comparison ribbon rises from bottom as the chapter closes. */
        .shelf-ribbon {
          opacity: clamp(0, min(calc((var(--p) - 0.82) * 12), calc((0.97 - var(--p)) * 12)), 1);
          transform: translate3d(0, calc(max(0px, (0.88 - var(--p)) * 40px)), 0);
        }
        .shelf-chapter-title {
          opacity: clamp(0, calc(var(--p) * 6), 1);
          transform: translate3d(0, calc(max(0px, (0.06 - var(--p)) * 60px)), 0);
        }
        .shelf-streak {
          opacity: clamp(0, calc(var(--p) * 0.9 + 0.2), 1);
          transform: translate3d(calc(var(--p) * -6%), 0, 0);
        }
        @media (prefers-reduced-motion: reduce) {
          .shelf-phone, .shelf-flash, .shelf-card, .shelf-toast,
          .shelf-ribbon, .shelf-chapter-title, .shelf-streak {
            transition: none !important;
          }
        }
      `}</style>
    </section>
  );
}

function ChapterTitle() {
  // Anchored top-center so the title sits in the horizontal strip ABOVE
  // both the phone (lower-left) and the result-cards column (lower-right),
  // with neither competing for its space.
  return (
    <div className="shelf-chapter-title pointer-events-none absolute left-1/2 top-[6vh] z-30 w-[min(900px,92vw)] -translate-x-1/2 text-center">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--ed-ink-4)]">
        — Or you skip the count entirely.
      </p>
      <h2 className="mt-1.5 font-display text-[clamp(28px,3.6vw,44px)] font-medium leading-[1.05] tracking-[-0.03em] text-balance">
        And the phone <span className="font-serif-italic text-[var(--ed-ink-3)]">counts</span> the shelf for you.
      </h2>
    </div>
  );
}

function FloorStreaks() {
  // Mirror the warehouse chapter's streak pattern so the two pins feel
  // continuous — same colors, similar angle, just reflected slightly.
  return (
    <svg
      className="shelf-streak pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[55%] w-full"
      viewBox="0 0 1600 540"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="shelfStreakOrange" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff7a45" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ff7a45" stopOpacity="0.5" />
          <stop offset="1" stopColor="#ff7a45" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="shelfStreakTeal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#46c2ca" stopOpacity="0" />
          <stop offset="0.5" stopColor="#46c2ca" stopOpacity="0.5" />
          <stop offset="1" stopColor="#46c2ca" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g strokeLinecap="round" fill="none">
        <path d="M -50 540 Q 600 360 1650 220" stroke="url(#shelfStreakOrange)" strokeWidth="2.4" />
        <path d="M -50 490 Q 800 320 1650 180" stroke="url(#shelfStreakTeal)" strokeWidth="2.1" />
        <path d="M -50 440 Q 950 280 1650 150" stroke="url(#shelfStreakOrange)" strokeWidth="1.5" opacity="0.6" />
      </g>
    </svg>
  );
}

/**
 * The phone + viewfinder + wireframe bookshelf inside the viewfinder.
 * All strokes inherit currentColor for theme parity with the warehouse
 * chapter.
 */
function PhoneScene() {
  return (
    <div className="shelf-phone pointer-events-none absolute left-[10vw] top-[calc(50%+30px)] z-10 -translate-y-1/2 text-foreground">
      <svg
        viewBox="0 0 360 700"
        className="h-auto w-[min(320px,32vw)]"
        fill="none"
        aria-hidden
      >
        {/* Phone outline */}
        <g stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
          <rect x="20" y="20" width="320" height="660" rx="42" />
          {/* Speaker slot */}
          <line x1="150" y1="48" x2="210" y2="48" strokeWidth="2" />
          {/* Side buttons */}
          <line x1="20" y1="120" x2="20" y2="160" strokeWidth="2" />
          <line x1="20" y1="190" x2="20" y2="230" strokeWidth="2" />
          <line x1="340" y1="160" x2="340" y2="220" strokeWidth="2" />
        </g>

        {/* Viewfinder frame */}
        <g stroke="currentColor" strokeWidth="1.4" opacity="0.7">
          <rect x="40" y="80" width="280" height="540" rx="6" />
          {/* Corner crop marks */}
          {(
            [
              [52, 92],
              [308, 92],
              [52, 608],
              [308, 608],
            ] as const
          ).map(([x, y], i) => {
            const dx = x < 180 ? 12 : -12;
            const dy = y < 350 ? 12 : -12;
            return (
              <g key={i}>
                <line x1={x} y1={y} x2={x + dx} y2={y} />
                <line x1={x} y1={y} x2={x} y2={y + dy} />
              </g>
            );
          })}
          {/* Center reticle */}
          <circle cx="180" cy="350" r="3" fill="currentColor" />
          <line x1="170" y1="350" x2="178" y2="350" />
          <line x1="182" y1="350" x2="190" y2="350" />
          <line x1="180" y1="340" x2="180" y2="348" />
          <line x1="180" y1="352" x2="180" y2="360" />
        </g>

        {/* Wireframe bookshelf inside viewfinder */}
        <g className="shelf-books" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
          {/* Three shelf rows */}
          {[170, 350, 530].map((shelfY) => (
            <g key={shelfY}>
              <line x1="50" y1={shelfY} x2="310" y2={shelfY} strokeWidth="1.8" />
              {/* Book spines on this shelf — varied widths to read as real */}
              {[
                { x: 52, w: 16, h: 130 },
                { x: 72, w: 22, h: 145 },
                { x: 98, w: 18, h: 138 },
                { x: 120, w: 26, h: 150 },
                { x: 150, w: 14, h: 128 },
                { x: 168, w: 20, h: 142 },
                { x: 192, w: 24, h: 148 },
                { x: 220, w: 16, h: 132 },
                { x: 240, w: 22, h: 146 },
                { x: 266, w: 18, h: 138 },
                { x: 288, w: 20, h: 144 },
              ].map((b, i) => (
                <rect
                  key={i}
                  x={b.x}
                  y={shelfY - b.h}
                  width={b.w}
                  height={b.h}
                  opacity={0.75}
                />
              ))}
            </g>
          ))}
        </g>

        {/* Bottom action bar — capture button + flash icon */}
        <g stroke="currentColor" strokeWidth="1.4">
          <circle cx="180" cy="650" r="20" strokeWidth="2.2" />
          <circle cx="180" cy="650" r="14" strokeWidth="1.4" opacity="0.6" />
        </g>
      </svg>
    </div>
  );
}

function FlashOverlay() {
  // Brief white punch over the phone viewfinder at shutter time.
  return (
    <div
      className="shelf-flash pointer-events-none absolute left-[10vw] top-[calc(50%+30px)] z-20 -translate-y-1/2"
      style={{ width: 'min(320px, 32vw)' }}
    >
      <div
        className="rounded-[42px]"
        style={{
          aspectRatio: '360 / 700',
          background:
            'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.7), rgba(255,255,255,0) 65%)',
        }}
      />
    </div>
  );
}

function ResultCards() {
  const matches = [
    { isbn: '978-0-13-468599-1', title: 'Algebra I · Grade 9' },
    { isbn: '978-0-393-93991-1', title: 'Biology · Grade 10' },
    { isbn: '978-1-118-32976-5', title: 'World History · Grade 11' },
    { isbn: '978-0-13-484554-8', title: 'Geometry · Grade 10' },
    { isbn: '978-0-19-852345-1', title: 'US History · Grade 11' },
    { isbn: '978-0-321-99884-4', title: 'English Lit · Grade 12' },
  ];
  return (
    <div className="pointer-events-none absolute right-[6vw] top-[26vh] z-20 flex w-[min(360px,36vw)] flex-col gap-2">
      {matches.map((m, i) => (
        <Card key={m.isbn} index={i + 1} title={m.title} isbn={m.isbn} />
      ))}
    </div>
  );
}

function Card({ index, title, isbn }: { index: number; title: string; isbn: string }) {
  return (
    <div
      className={`shelf-card shelf-card-${index} flex items-center gap-3 rounded-xl border border-border bg-card/90 px-3.5 py-2.5 backdrop-blur-sm`}
    >
      <div
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-foreground" fill="none">
          <path
            d="M3 8.5l3.2 3.2L13 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="flex-1">
        <div className="text-[12.5px] font-medium leading-tight">{title}</div>
        <div className="font-mono text-[10px] text-[var(--ed-ink-4)]">{isbn}</div>
      </div>
      <div className="font-mono text-[10.5px] tabular-nums text-[var(--ed-ink-3)]">+1</div>
    </div>
  );
}

function CountsToast() {
  return (
    <div
      className="shelf-toast pointer-events-none absolute left-[10vw] z-30 flex w-[min(320px,32vw)] justify-center"
      style={{ top: 'calc(50% + 200px)' }}
    >
      <div className="flex items-center gap-2 rounded-full border border-border bg-card/95 px-3.5 py-1.5 backdrop-blur-sm">
        <span className="h-1.5 w-1.5 rounded-full bg-[#46c2ca]" />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ed-ink-4)]">
          Counts updated
        </span>
        <span className="font-mono text-[11px] tabular-nums">6 lines · 6.4s</span>
      </div>
    </div>
  );
}

function StatRibbon() {
  return (
    <div className="shelf-ribbon pointer-events-none absolute inset-x-0 bottom-[10vh] z-30 flex justify-center">
      <div className="grid w-[min(720px,90vw)] grid-cols-1 gap-3 rounded-xl border border-border bg-card/85 p-5 backdrop-blur-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ed-ink-4)]">
            Manual cycle count
          </span>
          <span className="font-display text-[26px] font-medium leading-none tracking-[-0.02em]">
            20 minutes <span className="text-[var(--ed-ink-3)]">/ shelf</span>
          </span>
        </div>
        <div className="flex flex-col gap-1 sm:border-l sm:border-border sm:pl-5">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#ff7a45]">
            AI Shelf Scan
          </span>
          <span className="font-display text-[26px] font-medium leading-none tracking-[-0.02em]">
            under 30 seconds <span className="text-[var(--ed-ink-3)]">/ shelf</span>
          </span>
        </div>
      </div>
    </div>
  );
}
