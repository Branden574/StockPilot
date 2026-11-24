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
  securityMapCutWords,
  securityMapNewerThanTotals,
  securityMapNotes,
  securityMapPillWords,
  securityMapRefusedWindowWords,
  securityMapShortenedWords,
  securityMapStopReason,
  securityMapStopWords,
  runtimeTimeZone,
  usableTimeZone,
} from '@stockpilot/core';

import { SecurityResponseHost } from '../security-response/security-response-host';
import { ZonedWords } from '../zoned-time';

import type { StageInsets } from './globe-renderer';
import {
  drawnArcs,
  focusOf,
  heatByCountry,
  localDayStart,
  notOnMapWords,
  planDrawnArcs,
  sourceLabels,
  stageHeightFor,
  stageOf,
  stageSpan,
  tickerRowOf,
  viewShown,
  type GlobeState,
  type MapViewChoice,
} from './map-model';
import { SecurityMapFlat, FLAT_MAP_CSS } from './security-map-flat';
import { SecurityMapGlobe } from './security-map-globe';
import {
  SecurityMapCounters,
  SecurityMapZone,
  SecurityMapCountryTable,
  SecurityMapFeedList,
  SecurityMapFlaggedList,
  SecurityMapLegend,
  SecurityMapModePill,
  SecurityMapNotes,
  SecurityMapStageLegend,
  SecurityMapTicker,
  SecurityMapViewControls,
  STAGE_CSS,
} from './security-map-panels';
import { useSecurityMapPoll, type SecurityMapPoll } from './use-security-map-poll';

/**
 * THE ATTACK MAP, in the browser: the island the section loads with
 * next/dynamic (ssr: false). It holds the reads (use-security-map-poll.ts),
 * core's playback plan, and the views: the globe (the main view, drawn still
 * under reduced motion), the flat map (no WebGL, a lost context, or the
 * viewer's choice), and under them the legend, the notes, the feed and the
 * table, which is the accessible version of the drawing.
 *
 * The stage is the page's hero: full width, dark in both appearances. On it,
 * only short things: the mode pill (top left), the view controls (top
 * right), on a wide screen the flagged list (right edge), the legend
 * (bottom left) and the newest entry (bottom centre). The long sentences are
 * in the caption under it. On a phone the pill alone is on the stage.
 *
 * Every number and sentence is core's. Nothing here decides what is true:
 * only what is on the screen this moment.
 */

export interface SecurityMapClientProps {
  /** The server's first read of the whole window, read again here before it is trusted. */
  initial: unknown;
  /** The read the page polls. The Server Action unless a test hands another. */
  poll?: SecurityMapPoll;
  /**
   * The zone the viewer chose (their organization's Timezone setting, read on
   * the server after the gate), or null for none: the browser's zone then.
   * Every time on the map is printed in it, and its midnight starts the day.
   */
  timeZone?: string | null;
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

/** Whether a media query matches, kept up to date. `fallback` before the browser can say. */
function useMedia(query: string, fallback: boolean): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** From this width the flagged list is a panel inside the stage's right edge. */
const WIDE = '(min-width: 1100px)';
/** Below this width (a phone) the stage carries the pill alone. */
const NOT_PHONE = '(min-width: 640px)';

/** The in-stage flagged panel's width and its margin from the stage's edge, in CSS pixels. */
const PANEL_WIDTH = 304;
const PANEL_MARGIN = 14;
/** The strip at the stage's bottom the legend and the ticker take, which no label may cover. */
const STAGE_BOTTOM_BAR_PX = 76;

export function SecurityMapClient({
  initial,
  poll = pollPlatformSecurityMapAction,
  timeZone = null,
}: SecurityMapClientProps) {
  // The chosen zone, else the browser's. The island renders only in the
  // browser (ssr: false), so the browser's zone never meets a server render.
  const zone = React.useMemo(() => usableTimeZone(timeZone) ?? runtimeTimeZone(), [timeZone]);
  const hidden = useDocumentHidden();
  const reducedMotion = useMedia(REDUCED_MOTION, true);
  const wide = useMedia(WIDE, false);
  const notPhone = useMedia(NOT_PHONE, false);
  const { state, plan } = useSecurityMapPoll(initial, poll, hidden, zone);
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
  // the globe faces (the whole play's sources, so it does not swing at each
  // hour of the replay): worked out again only when one of those changes, so
  // the globe is handed the same arcs between reads.
  const stage = React.useMemo(() => {
    const on = stageOf(plan, stop, step.index);
    const drawn = drawnArcs(on.arcs);
    return { ...on, drawn, heat: heatByCountry(drawn) };
  }, [plan, stop, step.index]);
  const stopped = stop !== null && stop !== 'hidden';
  const target = React.useMemo(() => focusOf(planDrawnArcs(plan, stopped)), [plan, stopped]);
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

  const shown = viewShown(choice, globe);
  const startedAt = stage.timing === 'replay' ? step.startedAt : liveStartedAt;
  const labels = React.useMemo(
    () => sourceLabels(stage.drawn, state.whole),
    [stage.drawn, state.whole],
  );
  // The ticker: the newest feed entry the stage draws this moment. The live
  // play's ten minutes start at the newest read's liveFrom (core's plan uses
  // the same read).
  const newest =
    state.recent &&
    (!state.whole || Date.parse(state.recent.generatedAt) >= Date.parse(state.whole.generatedAt))
      ? state.recent
      : state.whole;
  const tickerRow = tickerRowOf(
    state.feed,
    stage.drawn,
    stageSpan(plan, stage, newest?.liveFrom ?? null),
    plan.mode === 'live',
  );

  // The viewer's day as of the newest read: once it has turned since the
  // whole window was counted, the day's counter says so until the new day is read.
  const dayStartNow =
    state.lastPollAt === null ? null : localDayStart(new Date(state.lastPollAt), zone);
  const counters = securityMapCounters(state.whole, state.dayStartAsked, {
    dayStartNow,
    timeZone: zone,
    now: state.lastPollAt ?? undefined,
  });
  const shortened = securityMapShortenedWords(state.whole, zone);
  const legend = securityMapLegend(state.whole);
  const flaggedWords = securityMapFlaggedListWords(
    state.whole,
    state.flaggedFeed,
    state.flaggedCut,
  );
  const notes = state.whole ? securityMapNotes(state.whole) : [];
  const notOnMap = state.whole ? notOnMapWords(state.whole) : null;
  // "More happened than ... can draw", of the play on screen only (lab walk 2, note A).
  const cutNote = securityMapCutWords(plan);
  const noteLines = [...notes, ...(cutNote ? [cutNote] : []), ...(notOnMap ? [notOnMap] : [])];
  // The feed or the live play holds entries newer than the totals (a poll brought
  // them): the totals are being counted again, and nothing says "nothing" meanwhile.
  const behind = securityMapNewerThanTotals(
    state.whole,
    [...state.feed, ...state.flaggedFeed],
    state.recent,
  );
  const empty = securityMapEmptyWords(state.whole, behind);
  const stepIndex = Math.max(0, stage.stepIndex);
  const modeWords = securityMapModeWords(plan, state.whole, stepIndex, zone);
  const pill = securityMapPillWords(plan, stop, state.health, stepIndex, zone);
  const stopWords = securityMapStopWords(stop, state.health, zone);
  // The instants those words name, for their exact UTC beside them.
  const replayStep =
    plan.mode === 'replay'
      ? plan.steps[Math.max(0, Math.min(stepIndex, plan.steps.length - 1))]
      : undefined;
  const stepAt = replayStep ? [replayStep.fromMs, replayStep.toMs] : null;
  const lastGoodAt = state.health.lastGoodAt;
  const pillAt =
    pill.kind === 'not_updating'
      ? lastGoodAt === null
        ? null
        : [lastGoodAt]
      : pill.kind === 'replay'
        ? stepAt
        : null;
  const refused = state.refusedWindow ? securityMapRefusedWindowWords(state.refusedWindow) : null;

  // The stage's height: everything from the counters to the caption's end
  // above the fold, the stage made shorter first (map-model stageHeightFor).
  // Worked out again when the window, the caption or anything above changes.
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const captionRef = React.useRef<HTMLDivElement | null>(null);
  const [stageHeight, setStageHeight] = React.useState<number | null>(null);
  React.useEffect(() => {
    const root = rootRef.current;
    const stageEl = stageRef.current;
    const captionEl = captionRef.current;
    if (!notPhone || !root || !stageEl || !captionEl || typeof window === 'undefined') {
      setStageHeight(null);
      return undefined;
    }
    const fit = () => {
      const stageBox = stageEl.getBoundingClientRect();
      const captionBox = captionEl.getBoundingClientRect();
      const next = stageHeightFor({
        viewport: window.innerHeight,
        stageTop: stageBox.top + window.scrollY,
        below: captionBox.bottom - stageBox.bottom,
      });
      setStageHeight((now) => (now !== null && Math.abs(now - next) < 1 ? now : next));
    };
    fit();
    window.addEventListener('resize', fit);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(root);
    observer?.observe(captionEl);
    return () => {
      window.removeEventListener('resize', fit);
      observer?.disconnect();
    };
  }, [notPhone]);

  const onUnavailable = React.useCallback(() => setGlobe('unavailable'), []);
  const onLost = React.useCallback(() => setGlobe('lost'), []);

  const insets = React.useMemo<StageInsets>(
    () => ({
      topLeft: notPhone ? { w: 300, h: 56 } : { w: 220, h: 48 },
      right: wide ? PANEL_WIDTH + PANEL_MARGIN * 2 : 0,
      bottom: notPhone ? STAGE_BOTTOM_BAR_PX : 0,
    }),
    [wide, notPhone],
  );

  const controls = (
    <SecurityMapViewControls
      paused={paused}
      onPause={() => setPaused((p) => !p)}
      view={shown.view}
      globeOffered={shown.globeOffered}
      onView={setChoice}
      tone={notPhone ? 'stage' : 'page'}
    />
  );
  const flaggedList = (
    <SecurityMapFlaggedList
      rows={state.flaggedFeed}
      words={flaggedWords}
      tone={wide ? 'stage' : 'page'}
    />
  );

  return (
    <SecurityMapZone.Provider value={zone}>
      <SecurityResponseHost>
        <div ref={rootRef} className="flex min-w-0 flex-col gap-2" data-testid="security-map">
          <style>{FLAT_MAP_CSS + STAGE_CSS}</style>

          {shortened ? (
            <p
              data-testid="security-map-shortened"
              className="border-border bg-muted text-foreground rounded-md border px-3 py-2 text-[13px] font-medium"
            >
              <ZonedWords at={state.whole?.from ?? null} text={shortened} />
            </p>
          ) : null}

          <SecurityMapCounters counters={counters} noteAt={state.whole?.from ?? null} />
          {/* Beside the counters too, when they are behind the feed (lab walk 3, F2):
              the same condition as the line under the stage, which stays. Always
              there and its height kept (two lines on a phone), so nothing moves
              when it fills. The one live region for this news (polite); the line
              under the stage is not one. */}
          <p
            aria-live="polite"
            data-testid="security-map-counters-recounting"
            className="text-muted-foreground min-h-8 text-[12px] leading-4 sm:min-h-4"
          >
            {behind ? SECURITY_MAP_WORDS.countersRecounting : null}
          </p>

          <div
            ref={stageRef}
            data-testid="security-map-stage"
            data-layout={wide ? 'wide' : notPhone ? 'medium' : 'phone'}
            className="sm-stage relative h-[420px] w-full min-w-0 overflow-hidden rounded-xl sm:h-[clamp(420px,68vh,760px)]"
            style={notPhone && stageHeight !== null ? { height: stageHeight } : undefined}
          >
            <div className="absolute inset-0" aria-hidden="true">
              {shown.view === 'globe' ? (
                <SecurityMapGlobe
                  arcs={stage.drawn}
                  timing={stage.timing}
                  startedAt={startedAt}
                  stepMs={SECURITY_MAP_REPLAY_STEP_MS}
                  target={target}
                  mayTurn={stop === null || stop === 'nothing_to_play'}
                  still={reducedMotion}
                  hidden={hidden}
                  heat={stage.heat}
                  labels={labels}
                  showLabels={notPhone}
                  insets={insets}
                  onUnavailable={onUnavailable}
                  onLost={onLost}
                />
              ) : (
                <div
                  className="flex h-full w-full items-center justify-center p-3 sm:p-6"
                  style={wide ? { paddingRight: PANEL_WIDTH + PANEL_MARGIN * 2 } : undefined}
                >
                  <SecurityMapFlat
                    arcs={stage.drawn}
                    timing={stage.timing}
                    stepKey={stage.timing === 'replay' ? step.index : 0}
                  />
                </div>
              )}
            </div>
            <div className="sm-vignette pointer-events-none absolute inset-0" aria-hidden="true" />

            <div className="absolute left-3 top-3 sm:left-4 sm:top-4">
              <SecurityMapModePill pill={pill} at={pillAt} />
            </div>
            {notPhone ? (
              <div className="absolute right-3 top-3 sm:right-4 sm:top-4">{controls}</div>
            ) : null}
            {wide ? (
              <div
                className="absolute bottom-[68px] top-[62px] flex flex-col"
                style={{ right: PANEL_MARGIN, width: PANEL_WIDTH }}
              >
                {flaggedList}
              </div>
            ) : null}
            {notPhone ? (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-4 px-4 pb-3.5"
                aria-hidden="true"
              >
                <SecurityMapStageLegend items={legend} view={shown.view} />
                <SecurityMapTicker
                  row={tickerRow}
                  reserveRight={wide ? PANEL_WIDTH + PANEL_MARGIN : 0}
                />
              </div>
            ) : null}
          </div>

          {notPhone ? null : <div className="flex flex-wrap gap-2">{controls}</div>}
          <div className="flex min-w-0">
            <div
              ref={captionRef}
              className="text-muted-foreground grid min-w-0 flex-1 gap-x-8 text-[12.5px] leading-snug lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"
              data-testid="security-map-caption"
            >
              {/* Always there, so a screen reader is told when the map stops and why
              (review S9): "Not updating since ...", "Sign in again". Polite. */}
              <div role="status" data-testid="security-map-stop-status" className="lg:col-span-2">
                {stopWords ? (
                  <p data-testid="security-map-stop" className="text-foreground mb-1 font-medium">
                    <ZonedWords
                      at={stop === 'not_updating' && lastGoodAt !== null ? [lastGoodAt] : null}
                      text={stopWords}
                    />
                  </p>
                ) : null}
              </div>
              {/* Not a live region (lab walk 3, F2): the line beside the counters is
                  the one that announces this, so a screen reader hears it once. */}
              {behind ? (
                <p
                  data-testid="security-map-recounting"
                  className="text-foreground mb-1 lg:col-span-2"
                >
                  {SECURITY_MAP_WORDS.recounting}
                </p>
              ) : null}
              <div className="flex min-w-0 flex-col gap-1">
                <p data-testid="security-map-mode">
                  <ZonedWords at={stepAt} text={modeWords} />
                </p>
                {shown.note ? <p data-testid="security-map-view-note">{shown.note}</p> : null}
              </div>
              <p className="mt-1 lg:mt-0">
                <ZonedWords
                  at={state.whole?.generatedAt ?? null}
                  text={securityMapAsOfWords(state.whole, zone, state.wholeFailures > 0)}
                />
              </p>
            </div>
          </div>

          {wide ? null : flaggedList}

          {refused ? <p className="text-destructive text-[13px]">{refused}</p> : null}
          {empty ? <p className="text-foreground text-[13px]">{empty}</p> : null}

          <SecurityMapLegend items={legend} />
          <SecurityMapNotes lines={noteLines} />

          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <SecurityMapFeedList title={SECURITY_MAP_WORDS.feedTitle} rows={state.feed} />
            <SecurityMapCountryTable whole={state.whole} behind={behind} />
          </div>
        </div>
      </SecurityResponseHost>
    </SecurityMapZone.Provider>
  );
}
