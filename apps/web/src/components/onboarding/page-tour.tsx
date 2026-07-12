'use client';

import { Sparkles, X } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import {
  getTourStateAction,
  recordTourOutcomeAction,
} from '@/lib/onboarding/actions';
import type { TourDefinition, TourStep } from '@/lib/onboarding/types';
import { capture } from '@/lib/analytics';

/**
 * Spotlight tour engine (owner PRD, spec §2/§12/§16). Mount <PageTour
 * tour={…} /> on a page: on a user's FIRST visit it offers (never forces) the
 * tour via a small prompt; completion/dismissal persist server-side (mig
 * 0259) so it offers exactly once per version, and the "Tour" pill stays for
 * replays. Steps target live DOM via selectors; unrendered targets are
 * skipped (missing modules/permissions must never break a tour).
 *
 * Accessibility: card is role=dialog with focus moved in; Esc dismisses,
 * ←/→ navigate; prefers-reduced-motion drops the movement transitions.
 */

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const fn = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return reduced;
}

/** Wait for a step's target to exist (dynamic content), up to ~4s. */
async function waitForTarget(selector: string): Promise<Element | null> {
  for (let i = 0; i < 16; i++) {
    const el = document.querySelector(selector);
    if (el) return el;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export function PageTour({ tour }: { tour: TourDefinition }) {
  const [phase, setPhase] = React.useState<'idle' | 'offer' | 'running'>('idle');
  const [stepIndex, setStepIndex] = React.useState(0);
  const [rect, setRect] = React.useState<Rect | null>(null);
  const [mounted, setMounted] = React.useState(false);
  const reduced = useReducedMotion();
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const targetRef = React.useRef<Element | null>(null);
  const stepIndexRef = React.useRef(0);

  React.useEffect(() => setMounted(true), []);

  // Offer once per version: neither completed nor dismissed at >= version.
  React.useEffect(() => {
    let cancelled = false;
    void getTourStateAction().then((state) => {
      if (cancelled) return;
      const done = state.completed[tour.id];
      const waved = state.dismissed[tour.id];
      const seen =
        (done && (done.v ?? 0) >= tour.version) ||
        (waved && (waved.v ?? 0) >= tour.version);
      // Never downgrade a deep-link-started tour back to an offer prompt.
      if (!seen) setPhase((p) => (p === 'idle' ? 'offer' : p));
    });
    return () => {
      cancelled = true;
    };
  }, [tour.id, tour.version]);

  const finish = React.useCallback(
    (outcome: 'completed' | 'dismissed') => {
      setPhase('idle');
      setStepIndex(0);
      setRect(null);
      capture(`tour_${outcome}`, { tourId: tour.id, version: tour.version, exitStep: stepIndexRef.current });
      void recordTourOutcomeAction({ tourId: tour.id, version: tour.version, outcome });
    },
    [tour.id, tour.version],
  );

  // Position the spotlight for the current step; skip absent targets.
  const goTo = React.useCallback(
    async (index: number, direction: 1 | -1 = 1) => {
      const steps = tour.steps;
      let i = index;
      while (i >= 0 && i < steps.length) {
        const step = steps[i]!;
        if (!step.target) {
          targetRef.current = null;
          setRect(null);
          stepIndexRef.current = i;
          setStepIndex(i);
          return;
        }
        const el = await waitForTarget(step.target);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'auto' });
          targetRef.current = el;
          const r = el.getBoundingClientRect();
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
          stepIndexRef.current = i;
          setStepIndex(i);
          return;
        }
        i += direction; // optional/unrendered target — skip in travel direction
      }
      finish('completed'); // walked off the end
    },
    [tour.steps, finish],
  );

  // Deep-link start: ?tour=<id> (Help center / workflow guides) launches
  // immediately — an explicit link outranks the offer-once persistence.
  React.useEffect(() => {
    const want = new URLSearchParams(window.location.search).get('tour');
    if (want === tour.id) {
      setPhase('running');
      capture('tour_started', { tourId: tour.id, via: 'deep_link' });
      void goTo(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [tour.id]);

  // Keep the spotlight glued to its element through scroll/resize.
  React.useEffect(() => {
    if (phase !== 'running') return;
    const sync = () => {
      const el = targetRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
    };
  }, [phase]);

  // Keyboard: Esc dismiss, arrows navigate. Focus the card per step.
  React.useEffect(() => {
    if (phase !== 'running') return;
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish('dismissed');
      if (e.key === 'ArrowRight') void goTo(stepIndex + 1, 1);
      if (e.key === 'ArrowLeft' && stepIndex > 0) void goTo(stepIndex - 1, -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, stepIndex, goTo, finish]);

  if (!mounted) return null;
  const step: TourStep | undefined = tour.steps[stepIndex];
  const transition = reduced ? 'none' : 'all 260ms ease';

  return (
    <>
      {/* Replay affordance — always available (PRD §10/§15). */}
      <button
        type="button"
        onClick={() => {
          setPhase('running');
          capture('tour_started', { tourId: tour.id, via: 'pill' });
          void goTo(0);
        }}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors"
        aria-label={`Start the ${tour.name} tour`}
      >
        <Sparkles className="size-3" /> Tour
      </button>

      {/* First-visit offer (never auto-launch a long tour). */}
      {phase === 'offer' &&
        createPortal(
          <div
            role="dialog"
            data-tour-open
            aria-label={`${tour.name} tour offer`}
            className="bg-card animate-in fade-in slide-in-from-bottom-2 fixed right-4 bottom-4 z-50 w-80 rounded-xl border p-4 shadow-lg"
          >
            <div className="flex items-start gap-2">
              <Sparkles className="text-primary mt-0.5 size-4 shrink-0" />
              <div className="text-sm">
                <p className="font-medium">New here? Take a quick tour.</p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {tour.steps.length} short steps — learn what everything on this page does.
                </p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setPhase('running');
                  capture('tour_started', { tourId: tour.id, via: 'offer' });
                  void goTo(0);
                }}
              >
                Start tour
              </Button>
              <Button size="sm" variant="ghost" onClick={() => finish('dismissed')}>
                No thanks
              </Button>
            </div>
          </div>,
          document.body,
        )}

      {/* Spotlight + step card. */}
      {phase === 'running' &&
        step &&
        createPortal(
          <div className="fixed inset-0 z-[70]" data-tour-open aria-live="polite">
            {/* Dimmer with a punched-out spotlight (giant box-shadow trick). */}
            <div
              aria-hidden
              style={{
                position: 'fixed',
                top: rect ? rect.top - 6 : '50%',
                left: rect ? rect.left - 6 : '50%',
                width: rect ? rect.width + 12 : 0,
                height: rect ? rect.height + 12 : 0,
                borderRadius: 10,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                transition,
                pointerEvents: 'none',
              }}
            />
            <div
              ref={cardRef}
              role="dialog"
              aria-modal="true"
              aria-label={step.title}
              tabIndex={-1}
              className="bg-card fixed z-[71] w-[min(360px,calc(100vw-32px))] rounded-xl border p-4 shadow-xl outline-none"
              style={{
                transition,
                ...(rect
                  ? step.placement === 'top' || rect.top > window.innerHeight * 0.6
                    ? { left: Math.min(rect.left, window.innerWidth - 380), bottom: window.innerHeight - rect.top + 14 }
                    : { left: Math.min(rect.left, window.innerWidth - 380), top: rect.top + rect.height + 14 }
                  : { left: '50%', top: '40%', transform: 'translate(-50%, -50%)' }),
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold">{step.title}</p>
                <button
                  type="button"
                  aria-label="Exit tour"
                  onClick={() => finish('dismissed')}
                  className="text-muted-foreground hover:text-foreground -m-1 p-1"
                >
                  <X className="size-4" />
                </button>
              </div>
              <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{step.body}</p>
              <div className="mt-3 flex items-center gap-2">
                {/* Progress dots (PRD §12). */}
                <div className="flex flex-1 items-center gap-1" aria-hidden>
                  {tour.steps.map((_, i) => (
                    <span
                      key={i}
                      className={
                        'h-1.5 rounded-full transition-all ' +
                        (i === stepIndex ? 'bg-primary w-4' : 'bg-muted w-1.5')
                      }
                    />
                  ))}
                </div>
                {stepIndex > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => void goTo(stepIndex - 1, -1)}>
                    Back
                  </Button>
                )}
                {stepIndex < tour.steps.length - 1 ? (
                  <Button size="sm" onClick={() => void goTo(stepIndex + 1, 1)}>
                    Next
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => finish('completed')}>
                    Done
                  </Button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
