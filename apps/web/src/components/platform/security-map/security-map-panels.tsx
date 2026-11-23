'use client';

import Link from 'next/link';
import * as React from 'react';

import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import {
  SECURITY_MAP_COULD_NOT_CHECK,
  SECURITY_MAP_MARK_WORDS,
  SECURITY_MAP_WORDS,
  securityEventReasonLabel,
  securityEventSourceLabel,
  securityMapFeedWords,
  securityMapTableRows,
  type SecurityMapCounter,
  type SecurityMapFeedRow,
  type SecurityMapLegendItem,
  type SecurityMapWholeRead,
} from '@stockpilot/core';

import { PlatformTable } from '../platform-table';

import { markPath } from './security-map-flat';
import { CATEGORY_LOOKS, countryName, type MarkShape } from './map-model';
import { countryPoint } from './world-geometry';

/**
 * The words around the map: the counters, the legend, the notes, the feed
 * and the by-country table. Every sentence is core's (security-map.ts in
 * @stockpilot/core). A name from the record (an organization, a city) is put
 * on the page as plain text only.
 */

/** A category's mark as a small picture beside its word: the colour is never the only sign. */
export function CategoryMark({
  shape,
  colour,
  hollow = false,
}: {
  shape: MarkShape;
  colour: string;
  hollow?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      aria-hidden="true"
      focusable="false"
      className="inline-block shrink-0 rounded-sm"
      style={{ background: '#070c18' }}
    >
      <path
        d={markPath(shape, 8, 8, 4.6)}
        fill={hollow ? 'none' : colour}
        stroke={colour}
        strokeWidth={hollow ? 1.6 : 0}
      />
    </svg>
  );
}

export function SecurityMapCounters({ counters }: { counters: readonly SecurityMapCounter[] }) {
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {counters.map((c) => (
        <div
          key={c.id}
          data-counter={c.id}
          className="border-border bg-card rounded-lg border px-4 py-3"
        >
          <dt className="text-muted-foreground text-[12.5px]">{c.label}</dt>
          <dd className="text-foreground mt-1 font-mono text-[22px] font-medium tabular-nums leading-tight">
            {c.value}
          </dd>
          {c.note ? <dd className="text-muted-foreground text-[12px]">{c.note}</dd> : null}
        </div>
      ))}
    </dl>
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
            </li>
          );
        })}
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

/** One entry of the feed: a button that opens its facts (a disclosure, never a live region). */
function FeedEntry({ row }: { row: SecurityMapFeedRow }) {
  const w = securityMapFeedWords(row);
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const look = CATEGORY_LOOKS[w.category];
  const place = w.flood
    ? SECURITY_MAP_WORDS.placeFlood
    : w.country === null
      ? SECURITY_MAP_WORDS.placeUnknown
      : w.city
        ? `${w.city}, ${countryName(w.country)}`
        : countryName(w.country);
  const facts: Array<[string, React.ReactNode]> = [
    ['When', w.time],
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
  return (
    <li className="border-border border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-muted/50 flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[13px]"
      >
        <CategoryMark shape={look.shape} colour={look.hex} hollow={w.outcome === 'flagged'} />
        <span className="text-muted-foreground shrink-0 font-mono text-[12px] tabular-nums">
          {w.time}
        </span>
        <span className="text-foreground min-w-0 truncate">
          {securityEventReasonLabel(w.reason)}
        </span>
        <span className="text-muted-foreground ml-auto shrink-0 text-[12px]">{w.outcomeLabel}</span>
      </button>
      <dl
        id={id}
        hidden={!open}
        className="grid gap-x-4 gap-y-1 px-3 pb-3 text-[12.5px] sm:grid-cols-[8rem_1fr]"
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

/** A list of feed entries, newest first, under its own title. */
export function SecurityMapFeedList({
  title,
  rows,
}: {
  title: string;
  rows: readonly SecurityMapFeedRow[];
}) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={headingId} className="text-foreground text-[13px] font-medium">
          {title}
        </h3>
        <p className="text-muted-foreground text-[12px]">{SECURITY_MAP_WORDS.feedTimes}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">{SECURITY_MAP_WORDS.feedEmpty}</p>
      ) : (
        <ul className="border-border bg-card max-h-[34rem] overflow-y-auto rounded-lg border">
          {rows.map((row) => (
            <FeedEntry key={securityMapFeedWords(row).key} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The by-country table: the map's numbers in full, and what a screen reader has in its place. */
export function SecurityMapCountryTable({ whole }: { whole: SecurityMapWholeRead | null }) {
  const rows = whole ? securityMapTableRows(whole) : null;
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={SECURITY_MAP_WORDS.tableTitle}>
      <h3 className="text-foreground text-[13px] font-medium">{SECURITY_MAP_WORDS.tableTitle}</h3>
      <p className="text-muted-foreground text-[12px]">{SECURITY_MAP_WORDS.tableNote}</p>
      {rows === null ? (
        <p className="text-muted-foreground text-[13px]">{SECURITY_MAP_COULD_NOT_CHECK}.</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">{SECURITY_MAP_WORDS.feedEmpty}</p>
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
