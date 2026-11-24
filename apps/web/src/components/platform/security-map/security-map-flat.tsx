'use client';

import * as React from 'react';

import { SECURITY_MAP_WORDS } from '@stockpilot/core';

import {
  FLIGHT_MAX_MS,
  FLIGHT_MIN_MS,
  LIVE_PERIOD_MS,
  REPLAY_FLIGHT_MS,
  REPLAY_SPREAD_MS,
  RING_MS,
  arcOffset,
  sourceMarkSize,
  type ArcTiming,
} from './globe-math';
import { CATEGORY_LOOKS, PANEL, type DrawnArc, type MarkShape } from './map-model';
import {
  FLAT_HEIGHT,
  FLAT_WIDTH,
  STOCKPILOT_LON_LAT,
  flatArcPath,
  flatDotsPath,
  projectFlat,
} from './world-geometry';

/**
 * THE FLAT MAP: the fallback view (no WebGL, a lost context, or the viewer's
 * choice), in the globe's palette on the same dark stage. The land is ONE
 * path of dots; each arc is a curve from its country to StockPilot with,
 * while the play moves, a short bright head (and a soft glow under it) that
 * runs along it and a pulse where it starts and lands.
 *
 * Every movement is CSS animation, so the global reduced-motion rule
 * (app/globals.css) stills it even if a script did not; the island also
 * draws no head and no pulse when anything stops the play. The drawing is
 * aria-hidden: the table under the map holds the same numbers.
 *
 * Blocked and flagged are told apart by more than colour: a blocked arc is a
 * solid line with a filled mark, a flagged one a thinner dashed line with a
 * hollow mark. Each category's mark has its own shape.
 */

/** The land's dots and StockPilot's outer ring: the globe's own blues. */
const FLAT_LAND = '#5c99ff';
const FLAT_RING = '#9cc2ff';

/** A live head's flight on the flat map: the middle of the globe's range. */
const FLAT_FLIGHT_MS = (FLIGHT_MIN_MS + FLIGHT_MAX_MS) / 2;

/** The keyframes and classes of the flat map, scoped by their sm- names. */
export const FLAT_MAP_CSS = `
.sm-head{fill:none;stroke-linecap:round;stroke-dasharray:0.16 1.2;stroke-dashoffset:-1;}
.sm-head-glow{opacity:0.3;}
.sm-head-live{animation:sm-travel-live ${LIVE_PERIOD_MS}ms linear infinite;}
.sm-head-replay{animation:sm-travel-once ${REPLAY_FLIGHT_MS}ms linear 1 both;}
.sm-pulse{opacity:0;transform-box:fill-box;transform-origin:center;}
.sm-pulse-live{animation:sm-pulse ${LIVE_PERIOD_MS}ms ease-out infinite;}
.sm-pulse-replay{animation:sm-pulse-once ${RING_MS}ms ease-out 1 both;}
@keyframes sm-travel-live{0%{stroke-dashoffset:0.16}${((FLAT_FLIGHT_MS * 1.16) / LIVE_PERIOD_MS) * 100}%{stroke-dashoffset:-1}100%{stroke-dashoffset:-1}}
@keyframes sm-travel-once{from{stroke-dashoffset:0.16}to{stroke-dashoffset:-1}}
@keyframes sm-pulse{0%{opacity:0.95;transform:scale(0.3)}${(RING_MS / LIVE_PERIOD_MS) * 100}%{opacity:0;transform:scale(1)}100%{opacity:0;transform:scale(1)}}
@keyframes sm-pulse-once{from{opacity:0.95;transform:scale(0.3)}to{opacity:0;transform:scale(1)}}
`;

/** The mark of a category's shape, centred on (x, y), `r` across its half. */
export function markPath(shape: MarkShape, x: number, y: number, r: number): string {
  const f = (n: number) => (Math.round(n * 10) / 10).toString();
  switch (shape) {
    case 'circle':
      return `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
    case 'diamond':
      return `M${f(x)} ${f(y - r * 1.2)}L${f(x + r * 1.2)} ${f(y)}L${f(x)} ${f(y + r * 1.2)}L${f(x - r * 1.2)} ${f(y)}Z`;
    case 'square':
      return `M${f(x - r)} ${f(y - r)}h${f(2 * r)}v${f(2 * r)}h${f(-2 * r)}Z`;
    case 'triangle':
      return `M${f(x)} ${f(y - r * 1.2)}L${f(x + r * 1.1)} ${f(y + r * 0.8)}L${f(x - r * 1.1)} ${f(y + r * 0.8)}Z`;
    default: {
      const points = Array.from({ length: 6 }, (_, k) => {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        return `${f(x + Math.cos(a) * r * 1.1)} ${f(y + Math.sin(a) * r * 1.1)}`;
      });
      return `M${points.join('L')}Z`;
    }
  }
}

export function SecurityMapFlat({
  arcs,
  timing,
  stepKey,
}: {
  arcs: readonly DrawnArc[];
  timing: ArcTiming;
  /** Changes with each replay step, so its arcs start their run again. */
  stepKey: number;
}) {
  const moving = timing !== 'still';
  const [hx, hy] = projectFlat(STOCKPILOT_LON_LAT[0], STOCKPILOT_LON_LAT[1]);
  return (
    <svg
      viewBox={`0 0 ${FLAT_WIDTH} ${FLAT_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
      data-testid="security-map-flat"
      className="block h-full w-full"
    >
      <path
        d={flatDotsPath()}
        fill="none"
        stroke={FLAT_LAND}
        strokeOpacity={0.55}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      <g key={stepKey}>
        {arcs.map(({ arc, from }) => {
          const look = CATEGORY_LOOKS[arc.category];
          const d = flatArcPath(from, STOCKPILOT_LON_LAT);
          const flagged = arc.outcome === 'flagged';
          const width = (flagged ? 0.6 : 1) * (0.8 + arc.width * 0.55);
          const [x, y] = projectFlat(from[0], from[1]);
          const offset = arcOffset(arc.key);
          const delay = timing === 'live' ? -offset * LIVE_PERIOD_MS : offset * REPLAY_SPREAD_MS;
          const landDelay =
            timing === 'live'
              ? FLAT_FLIGHT_MS - offset * LIVE_PERIOD_MS
              : offset * REPLAY_SPREAD_MS + REPLAY_FLIGHT_MS;
          const shape = markPath(look.shape, x, y, sourceMarkSize(arc.width) / 2.6);
          return (
            <g key={arc.key} data-arc={arc.key} data-outcome={arc.outcome}>
              <path
                d={d}
                fill="none"
                stroke={look.hex}
                strokeWidth={width}
                strokeOpacity={moving ? 0.32 : 0.75}
                strokeDasharray={flagged ? '5 4' : undefined}
                strokeLinecap="round"
              />
              {moving ? (
                <>
                  <path
                    d={d}
                    pathLength={1}
                    className={`sm-head sm-head-glow ${timing === 'live' ? 'sm-head-live' : 'sm-head-replay'}`}
                    stroke={look.hex}
                    strokeWidth={width + 7}
                    style={{ animationDelay: `${Math.round(delay)}ms` }}
                  />
                  <path
                    d={d}
                    pathLength={1}
                    className={`sm-head ${timing === 'live' ? 'sm-head-live' : 'sm-head-replay'}`}
                    stroke={look.hex}
                    strokeWidth={width + 1.6}
                    style={{ animationDelay: `${Math.round(delay)}ms` }}
                  />
                </>
              ) : null}
              {moving ? (
                <>
                  <circle
                    cx={x}
                    cy={y}
                    r={14}
                    fill="none"
                    stroke={look.hex}
                    strokeWidth={1.5}
                    className={`sm-pulse ${timing === 'live' ? 'sm-pulse-live' : 'sm-pulse-replay'}`}
                    style={{ animationDelay: `${Math.round(delay)}ms` }}
                  />
                  <circle
                    cx={hx}
                    cy={hy}
                    r={14}
                    fill="none"
                    stroke={look.hex}
                    strokeWidth={1.5}
                    className={`sm-pulse ${timing === 'live' ? 'sm-pulse-live' : 'sm-pulse-replay'}`}
                    style={{ animationDelay: `${Math.round(landDelay)}ms` }}
                  />
                </>
              ) : null}
              <path
                d={shape}
                data-mark={flagged ? 'hollow' : 'filled'}
                fill={flagged ? 'none' : look.hex}
                stroke={look.hex}
                strokeWidth={flagged ? 1.6 : 0}
              />
            </g>
          );
        })}
      </g>
      <g data-testid="security-map-stockpilot">
        <circle
          cx={hx}
          cy={hy}
          r={13}
          fill="none"
          stroke={FLAT_RING}
          strokeOpacity={0.35}
          strokeWidth={1}
        />
        <circle cx={hx} cy={hy} r={7} fill="none" stroke={PANEL.stockpilot} strokeWidth={1.4} />
        <circle cx={hx} cy={hy} r={5} fill={PANEL.stockpilot} fillOpacity={0.18} />
        <circle cx={hx} cy={hy} r={2.8} fill={PANEL.stockpilot} />
        <text
          x={hx + 10}
          y={hy - 10}
          fill={PANEL.stockpilot}
          fontSize={13}
          fontWeight={600}
          style={{ paintOrder: 'stroke' }}
          stroke="rgba(3,6,14,0.85)"
          strokeWidth={3}
        >
          {SECURITY_MAP_WORDS.stockpilot}
        </text>
      </g>
    </svg>
  );
}
