'use client';

import * as React from 'react';

import { ConsoleFrame, StageInterior, type StageKey } from './console';
import { HERO_KPIS, ORDERED, PO, RECEIVED } from './fixture';
import { APP_ENTRY } from './nav';

import { capture } from '@/lib/analytics';

/**
 * The hero.
 *
 * The fixed cinematic ground (#sp-stage, #sp-poster, #sp-film) now lives in
 * cinema.tsx, which owns the film engine. The protected-hook notes moved with
 * it. What remains protected HERE is only that the hero must not introduce a
 * competing fixed layer at z-index >= 60, which would punch through the intro
 * curtain and register as an uncovered frame in every E2E coverage assertion.
 *
 * Historical note, kept because it is the trap most likely to be re-sprung:
 *
 *  1. `#sp-stage`'s background must stay `#0b0c0a`, byte-identical to `LI.ink`
 *     in lib/landing-intro/timeline.ts. The pre-hydration curtain and the intro
 *     overlay both paint that exact value, so a one-byte difference is a visible
 *     seam at the reveal. (The design doc's `#0c0c0e` is wrong and was
 *     deliberately overruled — the hero wins.)
 *  2. `<img id="sp-poster">` is what `watchReadiness()` waits on. It queries
 *     that id and expects an HTMLImageElement; if the LCP becomes a CSS
 *     background, a video, a canvas, or a next/image wrapper that loses the id,
 *     `heroImageReady()` resolves INSTANTLY with no error, `readyAt` collapses
 *     to ~0, and the intro lifts onto an unpainted hero. Keep it a real <img>,
 *     and keep the file on a raster extension — the E2E hard-cap test stalls a
 *     route glob covering png, jpg, jpeg, webp and avif to prove the 1500ms cap
 *     works, and an svg or data URI would pass that test while proving nothing.
 */

const TABS: { key: StageKey; label: string }[] = [
  { key: 'receive', label: 'Receiving' },
  { key: 'staging', label: 'Staging' },
  { key: 'put-away', label: 'Put-away' },
  { key: 'count', label: 'Count' },
];

export function Hero() {
  const [tab, setTab] = React.useState<StageKey>('receive');

  return (
    <>
      <section className="hero" id="hero">
        <div className="wrap">
          <p className="eyebrow">Warehouse operations</p>

          <h1>
            Your warehouse,
            <br />
            under control.
          </h1>

          <p className="lede">
            StockPilot is the system of record for physical stock — purchase orders,
            receiving, staging, put-away, counts and transfers, on one ledger that
            knows a crate sits on a rack.
          </p>

          <div className="hero-cta">
            <a
              className="btn primary"
              href={APP_ENTRY}
              onClick={() => capture('landing_app_entry_clicked', { where: 'hero' })}
            >
              Open app
            </a>
            <a className="btn ghost" href="#flow">
              See how it works <span aria-hidden>→</span>
            </a>
          </div>

          {/* Controls sit in PAGE space, never inside the product's own
              coordinate system — so nothing invites a click that does nothing. */}
          <div className="segmented" role="tablist" aria-label="Product surface">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                type="button"
                aria-selected={tab === t.key}
                className={tab === t.key ? 'on' : undefined}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="hero-kpis">
            {HERO_KPIS.map((k) => (
              <div className={`kpi${k.alarm ? ' alarm' : ''}`} key={k.label}>
                <span className="k">{k.label}</span>
                <span className={`v${k.mono ? ' mono' : ''}`}>{k.value}</span>
                <span className="f">{k.foot}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Inset from the left, sliced by the right edge, cut by the fold. The
            crop asserts the tool is larger than the frame can hold; scaling a
            whole enterprise screen down would just make it illegible. */}
        <div className="hero-console">
          <ConsoleFrame stage={tab} status={`${PO.number} · ${RECEIVED} of ${ORDERED} received`}>
            <StageInterior stage={tab} />
          </ConsoleFrame>
        </div>
      </section>

      <div className="hero-band" aria-label="At a glance">
        <div className="wrap">
          <dl>
            <div>
              <dt>Units received</dt>
              <dd className="mono">{RECEIVED}</dd>
            </div>
            <div>
              <dt>Put-away depth</dt>
              <dd className="mono">site · rack · row · crate</dd>
            </div>
            <div>
              <dt>Count variance</dt>
              <dd className="mono">stamped at count time</dd>
            </div>
            <div>
              <dt>Over-receipt</dt>
              <dd className="mono">recorded, not blocked</dd>
            </div>
          </dl>
        </div>
      </div>
    </>
  );
}
