'use client';

import * as React from 'react';

import { publishChapter } from './cinema';
import { ConsoleFrame, StageInterior } from './console';
import { STAGES } from './fixture';

/**
 * The seven-chapter operations story.
 *
 * Mechanism: CSS `position: sticky` pins the console, and an IntersectionObserver
 * advances a DISCRETE step index as each narrative block passes a band near the
 * middle of the viewport. There is deliberately no requestAnimationFrame scroll
 * handler and no scroll-position arithmetic anywhere in this file — the old
 * landing scrubbed a 546-frame bitmap sequence per frame, and that is exactly
 * the cost this replaces.
 *
 * Native scrolling is never intercepted. No wheel handler, no scroll snapping,
 * no "one gesture = one section". Scroll-linked state, not scroll hijacking.
 *
 * Wayfinding is dual-resolution: the rail shows all seven stages at once so the
 * reader can see the whole map, and the ledger keeps every stage's real figure
 * on screen permanently. Inactive rows reduce in value but are never erased and
 * never reflow — the ledger's height is fixed so it cannot shiver against the
 * pinned console as steps advance.
 *
 * Reduced motion and no-JS both resolve to the same place: every chapter's prose
 * is in the document, and the console renders a real stage rather than a blank.
 * The story is readable without a single transition running.
 */

export function OperationsStory() {
  const [active, setActive] = React.useState(0);
  const stepRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  React.useEffect(() => {
    const nodes = stepRefs.current.filter(Boolean) as HTMLDivElement[];
    if (nodes.length === 0) return;

    // A narrow band across the middle of the viewport. Whichever step occupies
    // it owns the console. Discrete — the observer fires on crossings, not on
    // every frame.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = Number((e.target as HTMLElement).dataset.i);
          if (Number.isNaN(i)) continue;
          setActive(i);
          // Tell the film which side of the frame the copy now occupies, so the
          // scrim darkens only that side instead of burying the whole shot.
          const stage = STAGES[i];
          if (stage) publishChapter(stage.key);
        }
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: 0 },
    );

    for (const n of nodes) io.observe(n);
    return () => io.disconnect();
  }, []);

  const current = STAGES[active];

  return (
    <section className="story" id="flow" aria-label="How stock moves through StockPilot">
      <div className="wrap story-head">
        <p className="eyebrow">Inbound to verified</p>
        <h2>
          Two hundred and forty units were ordered. Two hundred and thirty-eight
          arrived. Here is every place they are accounted for.
        </h2>
      </div>

      <div className="wrap story-grid">
        {/* ── narrative column: scrolls ── */}
        <div className="story-steps">
          {STAGES.map((s, i) => (
            <div
              className={`step${i === active ? ' on' : ''}`}
              key={s.code}
              data-i={i}
              ref={(el) => {
                stepRefs.current[i] = el;
              }}
            >
              <p className="step-code mono">
                {s.code} <span>{s.name}</span>
              </p>
              <h3>{s.claim}</h3>
              <p className="step-detail">{s.detail}</p>
            </div>
          ))}
        </div>

        {/* ── pinned column: never moves ── */}
        <div className="story-pin">
          <ol className="rail" aria-hidden>
            {STAGES.map((s, i) => (
              <li
                key={s.code}
                className={i < active ? 'done' : i === active ? 'now' : undefined}
              />
            ))}
          </ol>

          {current ? (
            <ConsoleFrame stage={current.key} status={`Stage ${current.code} of 07`}>
              <StageInterior stage={current.key} />
            </ConsoleFrame>
          ) : null}

          <ol className="ledger">
            {STAGES.map((s, i) => (
              <li key={s.code} className={i === active ? 'on' : i < active ? 'past' : undefined}>
                <span className="l-code mono">{s.code}</span>
                <span className="l-name">{s.name}</span>
                <span className="l-fig mono">{s.figure}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {/* ── mobile: one tap accordion, not seven viewport-heights of scroll ── */}
      <MobileStory />
    </section>
  );
}

/**
 * Mobile is a parallel composition, not a media-query squeeze. Scroll-driven
 * step advancement needs a tall runway per step, which manufactures an endless
 * page and fights iOS momentum scrolling and address-bar collapse. Tap instead.
 * Collapsed rows still carry a real figure, so the whole map is legible closed.
 */
function MobileStory() {
  const [open, setOpen] = React.useState(0);

  return (
    <div className="story-mobile">
      {STAGES.map((s, i) => {
        const isOpen = i === open;
        return (
          <div className={`m-step${isOpen ? ' on' : ''}`} key={s.code}>
            <h3>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={`m-panel-${s.code}`}
                id={`m-btn-${s.code}`}
                onClick={() => setOpen(isOpen ? -1 : i)}
              >
                <span className="m-code mono">{s.code}</span>
                <span className="m-name">{s.name}</span>
                <span className="m-fig mono">{s.figure}</span>
              </button>
            </h3>
            <div
              className="m-panel"
              id={`m-panel-${s.code}`}
              role="region"
              aria-labelledby={`m-btn-${s.code}`}
              hidden={!isOpen}
            >
              <p className="m-claim">{s.claim}</p>
              <p className="m-detail">{s.detail}</p>
              <ConsoleFrame stage={s.key}>
                <StageInterior stage={s.key} />
              </ConsoleFrame>
            </div>
          </div>
        );
      })}
    </div>
  );
}
