'use client';

import * as React from 'react';

import { pollPlatformSecurityMapAction } from '@/server/actions/platform/security-map';

import {
  SECURITY_MAP_REPLAY_STEP_MS,
  SECURITY_MAP_WORDS,
  securityMapAsOfWords,
  securityMapCounters,
  securityMapEmptyWords,
  securityMapFlaggedListWords,
  securityMapLegend,
  securityMapModeWords,
  securityMapNotes,
  securityMapRefusedWindowWords,
  securityMapShortenedWords,
  securityMapStopReason,
  securityMapStopWords,
} from '@stockpilot/core';

import {
  PANEL,
  drawnArcs,
  focusOf,
  localDayStart,
  notOnMapWords,
  stageOf,
  viewShown,
  type GlobeState,
  type MapViewChoice,
} from './map-model';
import { SecurityMapFlat, FLAT_MAP_CSS } from './security-map-flat';
import { SecurityMapGlobe } from './security-map-globe';
import {
  SecurityMapCounters,
  SecurityMapCountryTable,
  SecurityMapFeedList,
  SecurityMapFlaggedList,
  SecurityMapLegend,
  SecurityMapNotes,
} from './security-map-panels';
import { useSecurityMapPoll, type SecurityMapPoll } from './use-security-map-poll';

/**
 * THE ATTACK MAP, in the browser: the island the section loads with
 * next/dynamic (ssr: false). It holds the reads (use-security-map-poll.ts),
 * core's playback plan, and the views: the globe (the main view), the flat
 * map (no WebGL, reduced motion, or the viewer's choice), and under them the
 * legend, the notes, the feed and the table, which is the accessible version
 * of the drawing.
 *
 * Every number and sentence is core's. Nothing here decides what is true:
 * only what is on the screen this moment.
 */

export interface SecurityMapClientProps {
  /** The server's first read of the whole window, read again here before it is trusted. */
  initial: unknown;
  /** The read the page polls. The Server Action unless a test hands another. */
  poll?: SecurityMapPoll;
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** Whether the tab is hidden. */
function useDocumentHidden(): boolean {
  return React.useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'hidden',
    () => false,
  );
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Whether the device asks for reduced motion, kept up to date when that setting changes. */
function useReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeReducedMotion,
    () => typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches,
    () => true,
  );
}

/** Words over the dark panel keep a shadow, so an arc behind them never hides them. */
const OVER_PANEL = '0 1px 3px rgba(0,0,0,0.9)';

const panelStyle: React.CSSProperties = {
  background: 'radial-gradient(120% 90% at 50% 38%, #0c1630 0%, #060b18 55%, #03050b 100%)',
};

export function SecurityMapClient({
  initial,
  poll = pollPlatformSecurityMapAction,
}: SecurityMapClientProps) {
  const hidden = useDocumentHidden();
  const reducedMotion = useReducedMotion();
  const { state, plan } = useSecurityMapPoll(initial, poll, hidden);
  const [paused, setPaused] = React.useState(false);
  const [choice, setChoice] = React.useState<MapViewChoice>('globe');
  const [globe, setGlobe] = React.useState<GlobeState>('ok');
  const stop = securityMapStopReason({
    mode: plan.mode,
    health: state.health,
    reducedMotion,
    paused,
    hidden,
  });

  // The replay's clock: one hour of the window every SECURITY_MAP_REPLAY_STEP_MS.
  const [step, setStep] = React.useState({ index: 0, startedAt: 0 });
  // What is on the map this moment, the arcs that have a place, and where
  // the globe turns to keep them in view: worked out again only when one of
  // those changes, so the globe is handed the same arcs between reads.
  const stage = React.useMemo(() => {
    const on = stageOf(plan, stop, step.index);
    const drawn = drawnArcs(on.arcs);
    return { ...on, drawn, focus: focusOf(drawn) };
  }, [plan, stop, step.index]);
  React.useEffect(() => {
    if (stage.timing !== 'replay') return undefined;
    const timer = setTimeout(
      () => setStep((s) => ({ index: s.index + 1, startedAt: performance.now() })),
      SECURITY_MAP_REPLAY_STEP_MS,
    );
    return () => clearTimeout(timer);
  }, [stage.timing, step.index]);
  // When the live play began, so its arcs keep their places in their loops across reads.
  const [liveStartedAt] = React.useState(() =>
    typeof performance === 'undefined' ? 0 : performance.now(),
  );

  const shown = viewShown(choice, reducedMotion, globe);
  const startedAt = stage.timing === 'replay' ? step.startedAt : liveStartedAt;

  // The viewer's day as of the newest read: once it has turned since the
  // whole window was counted, the day's counter says so until the new day is read.
  const dayStartNow = state.lastPollAt === null ? null : localDayStart(new Date(state.lastPollAt));
  const counters = securityMapCounters(state.whole, state.dayStartAsked, { dayStartNow });
  const shortened = securityMapShortenedWords(state.whole);
  const legend = securityMapLegend(state.whole);
  const flaggedWords = securityMapFlaggedListWords(
    state.whole,
    state.flaggedFeed,
    state.flaggedCut,
  );
  const notes = state.whole ? securityMapNotes(state.whole) : [];
  const notOnMap = state.whole ? notOnMapWords(state.whole) : null;
  const empty = securityMapEmptyWords(state.whole);
  const modeWords = securityMapModeWords(plan, state.whole, Math.max(0, stage.stepIndex));
  const stopWords = securityMapStopWords(stop, state.health);
  const refused = state.refusedWindow ? securityMapRefusedWindowWords(state.refusedWindow) : null;

  const onUnavailable = React.useCallback(() => setGlobe('unavailable'), []);
  const onLost = React.useCallback(() => setGlobe('lost'), []);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="security-map">
      <style>{FLAT_MAP_CSS}</style>

      {shortened ? (
        <p
          data-testid="security-map-shortened"
          className="border-border bg-muted text-foreground rounded-md border px-3 py-2 text-[13px] font-medium"
        >
          {shortened}
        </p>
      ) : null}

      <SecurityMapCounters counters={counters} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-[12.5px]">
          {securityMapAsOfWords(state.whole, undefined, state.wholeFailures > 0)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="border-border bg-card hover:bg-muted text-foreground h-8 rounded-md border px-3 text-[13px]"
          >
            {paused ? SECURITY_MAP_WORDS.play : SECURITY_MAP_WORDS.pause}
          </button>
          <div
            role="group"
            aria-label={SECURITY_MAP_WORDS.viewLabel}
            className="border-border bg-card inline-flex h-8 overflow-hidden rounded-md border"
          >
            {(['globe', 'flat'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={shown.view === v}
                disabled={v === 'globe' && !shown.globeOffered}
                onClick={() => setChoice(v)}
                className="aria-pressed:bg-foreground aria-pressed:text-background text-foreground px-3 text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {v === 'globe' ? SECURITY_MAP_WORDS.globe : SECURITY_MAP_WORDS.flat}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div
          className="relative h-[clamp(300px,52vw,600px)] w-full overflow-hidden rounded-lg"
          style={panelStyle}
        >
          <div className="absolute inset-0" aria-hidden="true">
            {shown.view === 'globe' ? (
              <SecurityMapGlobe
                arcs={stage.drawn}
                timing={stage.timing}
                startedAt={startedAt}
                focus={stage.focus}
                mayTurn={stop === null}
                hidden={hidden}
                onUnavailable={onUnavailable}
                onLost={onLost}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center p-3">
                <SecurityMapFlat
                  arcs={stage.drawn}
                  timing={stage.timing}
                  stepKey={stage.timing === 'replay' ? step.index : 0}
                />
              </div>
            )}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3 text-[12.5px] leading-snug sm:p-4">
            {/* Always there, so a screen reader is told when the map stops and why
                (review S9): "Not updating since ...", "Sign in again". Polite. */}
            <div role="status" data-testid="security-map-stop-status">
              {stopWords ? (
                <p
                  data-testid="security-map-stop"
                  className="max-w-3xl font-medium"
                  style={{ color: PANEL.stockpilot, textShadow: OVER_PANEL }}
                >
                  {stopWords}
                </p>
              ) : null}
            </div>
            <p
              data-testid="security-map-mode"
              className="max-w-3xl"
              style={{ color: PANEL.text, textShadow: OVER_PANEL }}
            >
              {modeWords}
            </p>
            {shown.note ? (
              <p className="max-w-3xl" style={{ color: PANEL.quiet, textShadow: OVER_PANEL }}>
                {shown.note}
              </p>
            ) : null}
          </div>
        </div>
        <SecurityMapFlaggedList rows={state.flaggedFeed} words={flaggedWords} />
      </div>

      {refused ? <p className="text-destructive text-[13px]">{refused}</p> : null}
      {empty ? <p className="text-foreground text-[13px]">{empty}</p> : null}

      <SecurityMapLegend items={legend} />
      <SecurityMapNotes lines={notOnMap ? [...notes, notOnMap] : notes} />

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <SecurityMapFeedList title={SECURITY_MAP_WORDS.feedTitle} rows={state.feed} />
        <SecurityMapCountryTable whole={state.whole} />
      </div>
    </div>
  );
}
