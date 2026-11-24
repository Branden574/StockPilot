'use client';

import Link from 'next/link';
import * as React from 'react';

import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import {
  SECURITY_MAP_AT_LEAST,
  SECURITY_MAP_COULD_NOT_CHECK,
  SECURITY_MAP_MARK_WORDS,
  SECURITY_MAP_WORDS,
  SECURITY_RESPONSE_GENERAL_CARD,
  SECURITY_RESPONSE_SIGN_IN_ALERT_CARD,
  securityConsoleCategoryLabel,
  securityEventReasonLabel,
  securityEventSourceLabel,
  securityResponseCardIdFor,
  securityResponseLevelFor,
  securityMapFeedWords,
  securityMapFlaggedWords,
  securityMapTableRows,
  securityMapTimesWords,
  type SecurityMapCounter,
  type SecurityMapFeedRow,
  type SecurityMapFlaggedRow,
  type SecurityMapFlaggedWords,
  type SecurityMapLegendItem,
  type SecurityMapPillKind,
  type SecurityMapWholeRead,
  type SecurityResponseCardId,
} from '@stockpilot/core';

import { PlatformTable } from '../platform-table';
import { SecurityResponseButton } from '../security-response/security-response-button';
import { ZonedTime, ZonedWords, exactUtcOf } from '../zoned-time';

import { LABEL_LEADER } from './globe-math';
import { markPath } from './security-map-flat';
import {
  CATEGORY_LOOKS,
  HIDDEN_KIND_LOOK,
  countryName,
  flaggedLookOf,
  type MapViewChoice,
  type MarkShape,
} from './map-model';
import { countryPoint } from './world-geometry';

/**
 * The words around the map: the counters, the legend, the notes, the feed
 * and the by-country table. Every sentence is core's (security-map.ts in
 * @stockpilot/core). A name from the record (an organization, a city) is put
 * on the page as plain text only.
 */

/**
 * The country labels on the globe: nearly solid, so they read over the
 * brightest land dots in either page appearance (the stage is dark in both):
 * the backdrop at least 88% opaque, its text at least 7:1 against it (lab
 * walk 2, F5; checked in the client test).
 */
export const LABEL_LOOK = {
  background: 'rgba(6,11,22,0.92)',
  homeBackground: 'rgba(9,15,29,0.94)',
  text: '#dbe6f7',
  count: '#b4c4dc',
  leader: 'rgba(170,196,240,0.7)',
} as const;

const LEADER_CSS = (['right', 'left', 'above', 'below'] as const)
  .map((side) => {
    const across = side === 'right' || side === 'left';
    const at =
      side === 'right'
        ? `left:-${LABEL_LEADER + 1}px;top:50%`
        : side === 'left'
          ? `right:-${LABEL_LEADER + 1}px;top:50%`
          : side === 'above'
            ? `bottom:-${LABEL_LEADER + 1}px;left:50%`
            : `top:-${LABEL_LEADER + 1}px;left:50%`;
    const size = across
      ? `width:${LABEL_LEADER}px;height:1px`
      : `width:1px;height:${LABEL_LEADER}px`;
    return `.sm-label[data-side=${side}]::before{display:block;${at};${size}}`;
  })
  .concat(
    // StockPilot's label may take a corner: its leader runs on the diagonal from that corner.
    (['below-right', 'below-left', 'above-right', 'above-left'] as const).map((side) => {
      const d = (LABEL_LEADER * Math.SQRT1_2).toFixed(2);
      const at =
        side === 'below-right'
          ? `left:-${d}px;top:-${d}px`
          : side === 'below-left'
            ? 'left:100%;top:0'
            : side === 'above-right'
              ? `left:-${d}px;top:calc(100% + ${d}px)`
              : 'left:100%;top:100%';
      const turn = side === 'below-right' || side === 'above-left' ? 45 : -45;
      return `.sm-label[data-side=${side}]::before{display:block;${at};width:${LABEL_LEADER}px;height:1px;transform:rotate(${turn}deg);transform-origin:0 0}`;
    }),
  )
  .join('\n');

/** The stage's own colours and keyframes (dark in both appearances), scoped by their sm- names. */
export const STAGE_CSS = `
.sm-stage{background:radial-gradient(ellipse 72% 68% at var(--sm-cx,50%) 47%,#0d1a36 0%,#08111f 40%,#050a13 74%,#03060b 100%);border:1px solid rgba(15,23,42,.16);box-shadow:0 1px 2px rgba(2,6,23,.08),0 22px 50px -24px rgba(2,6,23,.55);isolation:isolate;color-scheme:dark}
.dark .sm-stage{border-color:rgba(255,255,255,.08);box-shadow:0 0 0 1px rgba(0,0,0,.35),0 26px 60px -26px rgba(0,0,0,.85)}
.sm-stage[data-layout=wide]{--sm-cx:41%}
.sm-vignette{background:radial-gradient(ellipse 90% 82% at 45% 47%,transparent 56%,rgba(1,3,8,.6) 100%)}
.sm-glass{background:rgba(7,12,24,.74);border:1px solid rgba(160,190,240,.14);box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 8px 24px -12px rgba(0,0,0,.6)}
.sm-label{position:absolute;left:0;top:0;visibility:hidden;opacity:0;white-space:nowrap;display:flex;align-items:baseline;gap:6px;padding:3px 7px;border-radius:6px;font-size:11.5px;line-height:15px;color:${LABEL_LOOK.text};background:${LABEL_LOOK.background};border:1px solid rgba(160,190,240,.2);box-shadow:0 2px 8px -2px rgba(0,0,0,.6);will-change:transform,opacity}
.sm-label::before{content:'';position:absolute;display:none;background:${LABEL_LOOK.leader}}
${LEADER_CSS}
.sm-label-home{font-weight:600;font-size:12px;letter-spacing:.01em;background:${LABEL_LOOK.homeBackground};border-color:rgba(255,255,255,.3)}
.sm-label-count{font-family:var(--font-mono);font-size:11px;color:${LABEL_LOOK.count}}
.sm-dot-live{animation:sm-breathe 2.4s ease-in-out infinite}
.sm-ticker-line{animation:sm-rise .5s ease-out both}
.sm-fade-bottom{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 56px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 56px),transparent)}
.sm-fade-bottom:focus-within{-webkit-mask-image:none;mask-image:none}
@keyframes sm-breathe{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(74,222,128,.55)}50%{opacity:.55;box-shadow:0 0 0 5px rgba(74,222,128,0)}}
@keyframes sm-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.sm-dot-live,.sm-ticker-line{animation:none}}
`;

/** The stage's text colours. */
const ON_STAGE = { text: '#e8eef8', quiet: '#a3b3cb', line: 'rgba(160,190,240,.12)' } as const;

/*
 * A focus ring that shows on the keyboard only: a 2 px outline, a little off
 * the control, never clipped. The app's base rule draws focus as a box
 * shadow and turns the outline off; a box shadow is clipped by a scrolling
 * list and replaced by the stage's glass, so these turn the outline back on
 * (outline-solid) and the shadow ring off.
 */
const RING_OFF = 'focus-visible:ring-0 focus-visible:ring-offset-0';
const FOCUS_PAGE = `focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${RING_OFF}`;
const FOCUS_STAGE = `focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9cc3ff] ${RING_OFF}`;
/** Inside a scrolling list the ring is drawn just inside the row, so the list cannot clip it. */
const FOCUS_INSIDE = `focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${RING_OFF}`;

/** The dark tile a mark stands on, so the map's colours read the same on a light page. */
export const MARK_TILE = '#070c18';

/** A category's mark as a small picture beside its word: the colour is never the only sign. */
export function CategoryMark({
  shape,
  colour,
  hollow = false,
  tile = true,
  size = 16,
}: {
  shape: MarkShape;
  colour: string;
  hollow?: boolean;
  /** On a light page the mark stands on a dark tile; on the stage it needs none. */
  tile?: boolean;
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className="inline-block shrink-0 rounded-[4px]"
      style={tile ? { background: MARK_TILE } : undefined}
    >
      <path
        d={markPath(shape, 8, 8, 4.4)}
        fill={hollow ? 'none' : colour}
        stroke={colour}
        strokeWidth={hollow ? 1.9 : 0}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A count's words, with "at least" set small before the number: the number alone is large. */
function CountValue({ value }: { value: string }) {
  const floor = value.startsWith(`${SECURITY_MAP_AT_LEAST} `);
  const rest = floor ? value.slice(SECURITY_MAP_AT_LEAST.length + 1) : value;
  const isNumber = /^[\d,]+$/.test(rest);
  return (
    <>
      {floor ? (
        <>
          <span data-part="at-least" className="text-muted-foreground font-sans text-[12px]">
            {SECURITY_MAP_AT_LEAST}
          </span>{' '}
        </>
      ) : null}
      <span
        data-part="number"
        className={
          isNumber
            ? 'text-foreground font-mono text-[22px] font-medium tabular-nums leading-7'
            : 'text-foreground text-[15px] font-medium leading-7'
        }
      >
        {rest}
      </span>
    </>
  );
}

/**
 * The zone the map's times are in (the viewer's chosen zone, else the
 * browser's): set once by the island's client, read by every list here.
 */
export const SecurityMapZone = React.createContext<string>('UTC');

export function SecurityMapCounters({
  counters,
  noteAt = null,
}: {
  counters: readonly SecurityMapCounter[];
  /** The instant the day's note names ("Counted from ..."), for its exact UTC. */
  noteAt?: string | null;
}) {
  return (
    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
      {counters.map((c) => (
        <div
          key={c.id}
          data-counter={c.id}
          className="border-border bg-card flex min-w-0 flex-wrap items-center gap-x-3 rounded-lg border px-4 py-1.5"
        >
          <dt className="text-muted-foreground mr-auto text-[12px] leading-4">{c.label}</dt>
          <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <CountValue value={c.value} />
          </dd>
          {c.note && c.id === 'flagged_window' ? (
            <dd className="text-muted-foreground -ml-1.5 self-center pt-1 text-[11.5px]">
              {c.note}
            </dd>
          ) : null}
          {c.note && c.id !== 'flagged_window' ? (
            <dd className="text-muted-foreground basis-full text-[11.5px] leading-4">
              <ZonedWords at={c.id === 'blocked_today' ? noteAt : null} text={c.note} />
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

const PILL_LOOK: Record<
  SecurityMapPillKind,
  { dot: string; border: string; text: string; live?: boolean }
> = {
  live: { dot: '#4ade80', border: 'rgba(74,222,128,.35)', text: ON_STAGE.text, live: true },
  replay: { dot: '#8fb8ff', border: 'rgba(143,184,255,.35)', text: ON_STAGE.text },
  not_updating: { dot: '#f5b041', border: '#f5b041', text: '#fbd38d' },
  sign_in_again: { dot: '#f5b041', border: '#f5b041', text: '#fbd38d' },
  paused: { dot: '#a3b3cb', border: 'rgba(163,179,203,.4)', text: ON_STAGE.text },
  reduced_motion: { dot: '#a3b3cb', border: 'rgba(163,179,203,.4)', text: ON_STAGE.text },
  nothing_to_play: { dot: '#a3b3cb', border: 'rgba(163,179,203,.4)', text: ON_STAGE.text },
};

/**
 * The pill at the stage's top left: the play's mode or why it is not moving,
 * in a few words (core's). The full sentence is in the caption under the
 * stage and in its status region, so the pill is hidden from screen readers.
 */
export function SecurityMapModePill({
  pill,
  at = null,
}: {
  pill: { kind: SecurityMapPillKind; text: string };
  /** The instants its words name, for their exact UTC in the title. */
  at?: readonly number[] | null;
}) {
  const look = PILL_LOOK[pill.kind];
  return (
    <div
      data-testid="security-map-pill"
      data-kind={pill.kind}
      title={at ? (exactUtcOf(at) ?? undefined) : undefined}
      aria-hidden="true"
      className="sm-glass inline-flex h-8 items-center gap-2 rounded-full px-3 text-[12.5px] font-medium"
      style={{ borderColor: look.border, color: look.text }}
    >
      <span
        className={look.live ? 'sm-dot-live size-2 rounded-full' : 'size-2 rounded-full'}
        style={{ background: look.dot }}
      />
      <span className="whitespace-nowrap tabular-nums">{pill.text}</span>
    </div>
  );
}

/** Pause, and the choice of the globe or the flat map. On the stage they are dark; under it, the page's own. */
export function SecurityMapViewControls({
  paused,
  onPause,
  view,
  globeOffered,
  onView,
  tone,
}: {
  paused: boolean;
  onPause: () => void;
  view: MapViewChoice;
  globeOffered: boolean;
  onView: (view: MapViewChoice) => void;
  tone: 'stage' | 'page';
}) {
  const stage = tone === 'stage';
  const button = stage
    ? `px-3 text-[12.5px] leading-none text-[#e8eef8] hover:bg-white/10 ${FOCUS_STAGE}`
    : `text-foreground hover:bg-muted px-3 text-[13px] leading-none ${FOCUS_PAGE}`;
  const frame = stage ? 'sm-glass' : 'border-border bg-card border';
  // One row of one height: Pause and the Globe / Flat map pair are both 32 px boxes with the same
  // frame, and the pair's two buttons fill the space inside its frame, so nothing sticks out of it.
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="security-map-controls">
      <button type="button" onClick={onPause} className={`${frame} ${button} h-8 rounded-md`}>
        {paused ? SECURITY_MAP_WORDS.play : SECURITY_MAP_WORDS.pause}
      </button>
      <div
        role="group"
        aria-label={SECURITY_MAP_WORDS.viewLabel}
        className={`${frame} inline-flex h-8 items-stretch rounded-md p-0.5`}
      >
        {(['globe', 'flat'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            disabled={v === 'globe' && !globeOffered}
            onClick={() => onView(v)}
            className={`${button} rounded-[5px] disabled:cursor-not-allowed disabled:opacity-50 ${
              stage
                ? 'aria-pressed:bg-white aria-pressed:text-[#0a1020] aria-pressed:hover:bg-white'
                : 'aria-pressed:bg-foreground aria-pressed:text-background'
            }`}
          >
            {v === 'globe' ? SECURITY_MAP_WORDS.globe : SECURITY_MAP_WORDS.flat}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The short legend on the stage: the kinds with their marks, and what solid and dashed mean. */
export function SecurityMapStageLegend({
  items,
  view = 'globe',
}: {
  items: readonly SecurityMapLegendItem[];
  /** The view on screen: the line under the legend names it. */
  view?: 'globe' | 'flat';
}) {
  return (
    <div
      data-testid="security-map-stage-legend"
      className="sm-glass flex shrink-0 flex-col gap-1.5 rounded-lg px-3 py-2 text-[11.5px]"
      style={{ color: ON_STAGE.quiet }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {items.map((item) => {
          const look = CATEGORY_LOOKS[item.category];
          return (
            <span
              key={item.category}
              className="flex items-center gap-1.5"
              style={{ color: ON_STAGE.text }}
            >
              <CategoryMark shape={look.shape} colour={look.hex} tile={false} size={13} />
              {item.label}
            </span>
          );
        })}
        <span
          data-legend-alert=""
          className="flex items-center gap-1.5"
          style={{ color: ON_STAGE.text }}
        >
          <CategoryMark
            shape={HIDDEN_KIND_LOOK.shape}
            colour={HIDDEN_KIND_LOOK.hex}
            hollow
            tile={false}
            size={13}
          />
          {SECURITY_MAP_WORDS.legendSignInAlert}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5">
          <svg width={20} height={6} aria-hidden="true" focusable="false">
            <line
              x1={1}
              y1={3}
              x2={19}
              y2={3}
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            />
          </svg>
          {SECURITY_MAP_WORDS.legendBlocked}
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={20} height={6} aria-hidden="true" focusable="false">
            <line
              x1={1}
              y1={3}
              x2={19}
              y2={3}
              stroke="currentColor"
              strokeWidth={2}
              strokeDasharray="3.5 3"
            />
          </svg>
          {SECURITY_MAP_WORDS.legendFlagged}
        </span>
      </div>
      <p data-testid="security-map-legend-counts">{SECURITY_MAP_WORDS.legendCounts(view)}</p>
    </div>
  );
}

/**
 * The newest entry the map draws this moment (map-model tickerRowOf: its
 * country, kind and outcome are an arc on the stage, its minute in the span
 * drawn), in one line at the stage's bottom: outcome, what, where, when. It
 * fades in when it changes; nothing when no entry is drawn. Hidden from
 * screen readers: the feed under the map says the same.
 */
export function SecurityMapTicker({
  row,
  reserveRight,
}: {
  /** The newest entry the map draws this moment (map-model tickerRowOf), or null. */
  row: SecurityMapFeedRow | null;
  reserveRight: number;
}) {
  const zone = React.useContext(SecurityMapZone);
  if (!row) return <div className="flex-1" />;
  const w = securityMapFeedWords(row, zone);
  const look = CATEGORY_LOOKS[w.category];
  // Centred under the globe (the room left of `reserveRight`) when it fits;
  // a longer line takes the reserve first, so it can grow to the whole width
  // beside the legend before its reason's words are cut (lab walk 2, F7).
  return (
    <div className="flex min-w-0 flex-1" data-testid="security-map-ticker-room">
      <div className="min-w-0 flex-[1_1_0px]" />
      <p
        key={w.key}
        data-testid="security-map-ticker"
        className="sm-glass sm-ticker-line flex min-w-0 max-w-full shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-[12px]"
        style={{ color: ON_STAGE.text }}
      >
        <CategoryMark
          shape={look.shape}
          colour={look.hex}
          hollow={w.outcome === 'flagged'}
          tile={false}
          size={13}
        />
        <span className="shrink-0 font-medium">{w.outcomeLabel}</span>
        {/* The reason's words give way first; the place keeps up to 32 characters
            whole ("City, Country"), and only a longer one is cut (lab walk 2, F7). */}
        <span data-part="reason" className="min-w-0 truncate" style={{ color: ON_STAGE.quiet }}>
          {securityEventReasonLabel(w.reason)}
        </span>
        <span className="shrink-0" style={{ color: ON_STAGE.quiet }}>
          ·
        </span>
        <span
          data-part="place"
          className="max-w-[32ch] shrink-0 truncate"
          style={{ color: ON_STAGE.quiet }}
        >
          {placeOf(w)}
        </span>
        <span className="shrink-0 font-mono text-[11px]" style={{ color: ON_STAGE.quiet }}>
          <ZonedTime at={w.at} shown={w.time} />
        </span>
      </p>
      <div className="min-w-0" style={{ flex: `1 1 ${reserveRight}px` }} />
    </div>
  );
}

/** A kind's "How to respond": its general card (core's SECURITY_RESPONSE_GENERAL_CARD), no badge. */
function KindResponse({
  cardId,
  label,
}: {
  /** The general card of the kind (core's SECURITY_RESPONSE_GENERAL_CARD); none for a kind with none. */
  cardId: SecurityResponseCardId | null;
  label: string;
}) {
  if (cardId === null) return null;
  return (
    <div className="mt-1.5">
      <SecurityResponseButton
        showLevel={false}
        request={{
          cardId,
          what: label,
          context: { kind: label, place: null, time: null, organization: null },
          organizationId: null,
        }}
      />
    </div>
  );
}

export function SecurityMapLegend({ items }: { items: readonly SecurityMapLegendItem[] }) {
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => {
          const look = CATEGORY_LOOKS[item.category];
          return (
            <li key={item.category} data-legend={item.category} className="min-w-0">
              <p className="text-foreground flex items-center gap-2 text-[13px] font-medium">
                <CategoryMark shape={look.shape} colour={look.hex} />
                {item.label}
              </p>
              <p className="text-muted-foreground text-[12.5px]">
                {item.blocked} · {item.flagged}
              </p>
              {item.help ? <p className="text-muted-foreground text-[12px]">{item.help}</p> : null}
              <KindResponse
                cardId={SECURITY_RESPONSE_GENERAL_CARD[item.category]}
                label={item.label}
              />
            </li>
          );
        })}
        <li data-legend-alert="" className="min-w-0">
          <p className="text-foreground flex items-center gap-2 text-[13px] font-medium">
            <CategoryMark shape={HIDDEN_KIND_LOOK.shape} colour={HIDDEN_KIND_LOOK.hex} hollow />
            {SECURITY_MAP_WORDS.legendSignInAlert}
          </p>
          <p className="text-muted-foreground text-[12px]">
            {SECURITY_MAP_WORDS.legendSignInAlertHelp}
          </p>
          {/* The flagged sign-in alerts are of a kind the map does not show: its
              general card, called by the legend's own words. */}
          <KindResponse
            cardId={SECURITY_RESPONSE_SIGN_IN_ALERT_CARD}
            label={SECURITY_MAP_WORDS.legendSignInAlert}
          />
        </li>
      </ul>
      <ul className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-[12.5px]">
        <li className="flex items-center gap-2">
          <svg width={28} height={10} aria-hidden="true" focusable="false">
            <line x1={1} y1={5} x2={27} y2={5} stroke="currentColor" strokeWidth={2} />
          </svg>
          {SECURITY_MAP_MARK_WORDS.blocked}
        </li>
        <li className="flex items-center gap-2">
          <svg width={28} height={10} aria-hidden="true" focusable="false">
            <line
              x1={1}
              y1={5}
              x2={27}
              y2={5}
              stroke="currentColor"
              strokeWidth={1.2}
              strokeDasharray="4 3"
            />
          </svg>
          {SECURITY_MAP_MARK_WORDS.flagged}
        </li>
        <li className="flex items-center gap-2">
          <svg width={14} height={14} aria-hidden="true" focusable="false">
            <circle cx={7} cy={7} r={5} fill="none" stroke="currentColor" strokeWidth={1.2} />
            <circle cx={7} cy={7} r={2} fill="currentColor" />
          </svg>
          {SECURITY_MAP_WORDS.stockpilot}: where every line ends
        </li>
      </ul>
    </div>
  );
}

export function SecurityMapNotes({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="text-muted-foreground max-w-4xl list-disc space-y-1 pl-5 text-[12.5px]">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** Where an entry came from: city and country, or why there is no place. Nothing else. */
function placeOf(w: { flood: boolean; country: string | null; city: string | null }): string {
  if (w.flood) return SECURITY_MAP_WORDS.placeFlood;
  if (w.country === null) return SECURITY_MAP_WORDS.placeUnknown;
  return w.city ? `${w.city}, ${countryName(w.country)}` : countryName(w.country);
}

/** One entry of the feed: a button that opens its facts (a disclosure, never a live region). */
function FeedEntry({ row }: { row: SecurityMapFeedRow }) {
  const zone = React.useContext(SecurityMapZone);
  const w = securityMapFeedWords(row, zone);
  const when = <ZonedTime at={w.at} shown={w.time} />;
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const look = CATEGORY_LOOKS[w.category];
  const place = placeOf(w);
  const facts: Array<[string, React.ReactNode]> = [
    ['When', when],
    ['Kind', w.categoryLabel],
    ['Outcome', w.outcomeLabel],
    ['What', securityEventReasonLabel(w.reason)],
    ['Where', place],
    ['Source', securityEventSourceLabel(w.source)],
    ['Count', w.count],
    [
      'Organization',
      w.organizationId !== null ? (
        <>
          {w.organizationName ?? w.organizationId}{' '}
          <Link
            href={`/platform/orgs/${w.organizationId}`}
            // Never prefetched: opening an organization's page writes a
            // viewed_org row to the audit trail.
            prefetch={false}
            className="text-ink-2 hover:text-foreground underline underline-offset-2"
          >
            {SECURITY_MAP_WORDS.openOrganization}
          </Link>
        </>
      ) : (
        w.organizationWords
      ),
    ],
  ];
  const cardId = securityResponseCardIdFor(w.reason);
  return (
    <li className="border-border flex flex-wrap items-center border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={`hover:bg-muted/50 flex min-w-0 basis-full items-center gap-2 px-3 py-2 text-left text-[13px] ${FOCUS_INSIDE}`}
      >
        <CategoryMark shape={look.shape} colour={look.hex} hollow={w.outcome === 'flagged'} />
        <span className="text-muted-foreground shrink-0 font-mono text-[12px] tabular-nums">
          {when}
        </span>
        <span className="text-foreground min-w-0 truncate">
          {securityEventReasonLabel(w.reason)}
        </span>
        <span className="text-muted-foreground ml-auto shrink-0 text-[12px]">{w.outcomeLabel}</span>
      </button>
      {cardId !== null ? (
        <div className="flex shrink-0 px-3 pb-2 pl-9 pt-0.5 sm:pb-1.5">
          <SecurityResponseButton
            request={{
              cardId,
              what: securityEventReasonLabel(w.reason),
              context: {
                kind: w.categoryLabel,
                place,
                time: w.time,
                timeUtc: exactUtcOf(w.at),
                organization: w.organizationName ?? w.organizationId ?? w.organizationWords,
              },
              organizationId: w.organizationId,
              organizations: w.organizations,
            }}
          />
        </div>
      ) : null}
      <dl
        id={id}
        hidden={!open}
        className="grid basis-full gap-x-4 gap-y-1 px-3 pb-3 text-[12.5px] sm:grid-cols-[8rem_1fr]"
      >
        {facts.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-foreground min-w-0 [overflow-wrap:anywhere]">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </li>
  );
}

/** A flagged entry's organization in words: its name (its id when the name did not come), else "3 organizations" or "No organization". */
function flaggedOrganizationWords(w: SecurityMapFlaggedWords): string {
  return w.organizationName ?? w.organizationId ?? w.organizationWords ?? 'No organization';
}

/** The same on the entry's own line, where no label says what it is: "In 3 organizations". */
function flaggedOrganizationLine(w: SecurityMapFlaggedWords): string {
  return w.organizationId === null && w.organizations > 1
    ? `In ${flaggedOrganizationWords(w)}`
    : flaggedOrganizationWords(w);
}

/** The flagged rows with the Act now ones first, each group in its own order. */
export function actNowFirst<R extends SecurityMapFlaggedRow>(rows: readonly R[]): R[] {
  const now = (row: R) => securityResponseLevelFor(row[5]) === 'act_now';
  return [...rows.filter(now), ...rows.filter((row) => !now(row))];
}

/** How many entries a list shows before "Show all N". */
export const FEED_VISIBLE = 8;
export const FLAGGED_VISIBLE = 6;

/** The button under a list that shows the rest of it, or fewer again. */
function ShowAll({
  all,
  count,
  onToggle,
  controls,
  tone,
}: {
  all: boolean;
  count: number;
  onToggle: () => void;
  controls: string;
  tone: 'stage' | 'page';
}) {
  return (
    <button
      type="button"
      aria-expanded={all}
      aria-controls={controls}
      onClick={onToggle}
      data-testid="security-map-show-all"
      className={
        tone === 'stage'
          ? `self-start rounded-md px-2 py-1 text-[12px] font-medium text-[#9cc3ff] hover:bg-white/10 ${FOCUS_STAGE}`
          : `text-foreground hover:bg-muted self-start rounded-md px-2 py-1 text-[12.5px] font-medium underline-offset-2 hover:underline ${FOCUS_PAGE}`
      }
    >
      {all ? SECURITY_MAP_WORDS.showFewer : SECURITY_MAP_WORDS.showAll(count)}
    </button>
  );
}

/**
 * A list of feed entries, newest first, under its own title: the first
 * FEED_VISIBLE, fading out at the bottom, and "Show all N" when there are more.
 */
export function SecurityMapFeedList({
  title,
  rows,
}: {
  title: string;
  rows: readonly SecurityMapFeedRow[];
}) {
  const zone = React.useContext(SecurityMapZone);
  const headingId = React.useId();
  const listId = React.useId();
  const [all, setAll] = React.useState(false);
  const more = rows.length > FEED_VISIBLE;
  const shown = all || !more ? rows : rows.slice(0, FEED_VISIBLE);
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={headingId} className="text-foreground text-[13px] font-medium">
          {title}
        </h3>
        <p className="text-muted-foreground text-[12px]" data-testid="security-map-feed-times">
          {securityMapTimesWords(zone)}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">{SECURITY_MAP_WORDS.feedEmpty}</p>
      ) : (
        <>
          <ul
            id={listId}
            className={`border-border bg-card max-h-[34rem] overflow-y-auto rounded-lg border ${
              more && !all ? 'sm-fade-bottom' : ''
            }`}
          >
            {shown.map((row) => (
              <FeedEntry key={row[0]} row={row} />
            ))}
          </ul>
          {more ? (
            <ShowAll
              all={all}
              count={rows.length}
              onToggle={() => setAll((v) => !v)}
              controls={listId}
              tone="page"
            />
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * The newest flagged entries, so a flood of blocked entries never hides
 * them: on a wide screen a panel inside the stage's right edge (dark), below
 * that a card under the stage. Every kind is listed, the flagged sign-in
 * alerts too, though their kind is not drawn on the map: such an entry has
 * the grey mark and is named by its reason only, never by its kind. Each with
 * the mark a flagged arc starts from (hollow), its time, what it was in plain
 * words, where it came from (city and country only) and how many. No
 * organization, no source and no kind's name here: the rows carry none of
 * them (core's SecurityMapFlaggedRow), and a kind the map does not show comes
 * with no category at all. The first FLAGGED_VISIBLE show, fading out at the
 * bottom, with "Show all N" when there are more; the entries are not tab
 * stops (they do nothing).
 */
export function SecurityMapFlaggedList({
  rows,
  words,
  tone = 'page',
}: {
  rows: readonly SecurityMapFlaggedRow[];
  /** Core's line for what the list leaves out, or why it is empty; null when it says it all. */
  words: string | null;
  tone?: 'stage' | 'page';
}) {
  const zone = React.useContext(SecurityMapZone);
  const headingId = React.useId();
  const listId = React.useId();
  const [all, setAll] = React.useState(false);
  const stage = tone === 'stage';
  const more = rows.length > FLAGGED_VISIBLE;
  // Show all puts the Act now entries first (their level from the reason, here in the
  // browser: nothing new is sent); the short list keeps the newest first.
  const shown = !more ? rows : all ? actNowFirst(rows) : rows.slice(0, FLAGGED_VISIBLE);
  const strong = stage ? undefined : 'text-foreground';
  const quiet = stage ? undefined : 'text-muted-foreground';
  const strongStyle = stage ? { color: ON_STAGE.text } : undefined;
  const quietStyle = stage ? { color: ON_STAGE.quiet } : undefined;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="security-map-flagged"
      data-tone={tone}
      className={
        stage
          ? 'sm-glass flex max-h-full min-h-0 min-w-0 flex-col gap-2 rounded-xl p-3.5'
          : 'border-border bg-card flex min-w-0 flex-col gap-2 rounded-lg border p-3'
      }
    >
      <h3 id={headingId} className={`${strong ?? ''} text-[13px] font-medium`} style={strongStyle}>
        {SECURITY_MAP_WORDS.flaggedFeedTitle}
      </h3>
      <p className={`${quiet ?? ''} text-[11.5px] leading-snug`} style={quietStyle}>
        {SECURITY_MAP_WORDS.flaggedFeedNote} {securityMapTimesWords(zone)}
      </p>
      <p
        data-testid="security-map-flagged-split"
        className={`${quiet ?? ''} flex items-start gap-2 text-[11.5px] leading-snug`}
        style={quietStyle}
      >
        <span className="pt-px">
          <CategoryMark
            shape={HIDDEN_KIND_LOOK.shape}
            colour={HIDDEN_KIND_LOOK.hex}
            hollow
            tile={!stage}
          />
        </span>
        {SECURITY_MAP_WORDS.flaggedFeedSplit}
      </p>
      {rows.length === 0 ? null : (
        <ol
          id={listId}
          // A list that scrolls is a tab stop of its own in some browsers (its
          // entries are not): it gets the same ring as a control.
          className={`min-h-0 min-w-0 overflow-y-auto rounded-md ${
            stage ? `flex-auto ${FOCUS_STAGE}` : `max-h-[30rem] ${FOCUS_PAGE}`
          } ${more && !all ? 'sm-fade-bottom' : ''}`}
        >
          {shown.map((row) => {
            const w = securityMapFlaggedWords(row, zone);
            const look = flaggedLookOf(w.category);
            const cardId = securityResponseCardIdFor(row[5]);
            return (
              <li
                key={w.key}
                data-flagged-entry=""
                className={`flex min-w-0 gap-2 border-b text-[12.5px] last:border-b-0 ${
                  stage ? 'py-1.5' : 'border-border py-2'
                }`}
                style={stage ? { borderColor: ON_STAGE.line } : undefined}
              >
                <span className="pt-0.5">
                  <CategoryMark shape={look.shape} colour={look.hex} hollow tile={!stage} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span
                    className={`${strong ?? ''} min-w-0 [overflow-wrap:anywhere]`}
                    style={strongStyle}
                  >
                    {w.what}
                  </span>
                  <span
                    className={`${quiet ?? ''} min-w-0 text-[12px] [overflow-wrap:anywhere]`}
                    style={quietStyle}
                  >
                    {placeOf(w)}
                    {stage ? ' · ' : null}
                    {/* The time and the count stay together on one line ("at least N"
                        never breaks): the line wraps between the place and them. */}
                    {stage ? (
                      <span className="whitespace-nowrap font-mono text-[11px] tabular-nums">
                        <ZonedTime at={w.at} shown={w.time} /> · {w.count}
                      </span>
                    ) : null}
                  </span>
                  {stage ? null : (
                    <span
                      className={`${quiet ?? ''} whitespace-nowrap font-mono text-[11.5px] tabular-nums`}
                      style={quietStyle}
                    >
                      <ZonedTime at={w.at} shown={w.time} /> · {w.count}
                    </span>
                  )}
                  {/* Its organization, as the feed says it (review M1 reversed by the owner,
                      2026-11-24): the name, "3 organizations", or "No organization". */}
                  <span
                    data-flagged-organization=""
                    className={`${quiet ?? ''} min-w-0 text-[12px] [overflow-wrap:anywhere]`}
                    style={quietStyle}
                  >
                    {flaggedOrganizationLine(w)}
                  </span>
                  {cardId !== null ? (
                    <span className="mt-1.5 flex">
                      <SecurityResponseButton
                        tone={tone}
                        request={{
                          cardId,
                          what: w.what,
                          // The kind only when the map shows it: a hidden kind is never named.
                          context: {
                            kind:
                              w.category === null ? null : securityConsoleCategoryLabel(w.category),
                            place: placeOf(w),
                            time: w.time,
                            timeUtc: exactUtcOf(w.at),
                            organization: flaggedOrganizationWords(w),
                          },
                          organizationId: w.organizationId,
                          organizations: w.organizations,
                        }}
                      />
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {more ? (
        <ShowAll
          all={all}
          count={rows.length}
          onToggle={() => setAll((v) => !v)}
          controls={listId}
          tone={tone}
        />
      ) : null}
      {words ? (
        <p
          data-testid="security-map-flagged-words"
          className={`${quiet ?? ''} text-[12px] leading-snug`}
          style={quietStyle}
        >
          {words}
        </p>
      ) : null}
    </section>
  );
}

/** The by-country table: the map's numbers in full, and what a screen reader has in its place. */
export function SecurityMapCountryTable({
  whole,
  behind = false,
}: {
  whole: SecurityMapWholeRead | null;
  /** The kept lists hold entries newer than the totals: an empty table is being counted again. */
  behind?: boolean;
}) {
  const rows = whole ? securityMapTableRows(whole) : null;
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={SECURITY_MAP_WORDS.tableTitle}>
      <h3 className="text-foreground text-[13px] font-medium">{SECURITY_MAP_WORDS.tableTitle}</h3>
      <p className="text-muted-foreground text-[12px]">{SECURITY_MAP_WORDS.tableNote}</p>
      {rows === null ? (
        <p className="text-muted-foreground text-[13px]">{SECURITY_MAP_COULD_NOT_CHECK}.</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-[13px]" data-testid="security-map-table-empty">
          {behind ? SECURITY_MAP_WORDS.tableRecounting : SECURITY_MAP_WORDS.feedEmpty}
        </p>
      ) : (
        <PlatformTable label="Blocked and flagged events by country" minWidth={520}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Country</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Blocked</TableHead>
              <TableHead className="text-right">Flagged, not blocked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const look = CATEGORY_LOOKS[r.category];
              return (
                <TableRow key={r.key}>
                  <TableCell>
                    {countryName(r.country)}{' '}
                    <span className="text-muted-foreground font-mono text-[12px]">{r.country}</span>
                    {countryPoint(r.country) === null ? (
                      <span className="text-muted-foreground block text-[12px]">
                        Not on the map: no point for this code
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <CategoryMark shape={look.shape} colour={look.hex} />
                      {r.categoryLabel}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{r.blocked}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{r.flagged}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </PlatformTable>
      )}
    </section>
  );
}
