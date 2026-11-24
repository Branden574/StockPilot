'use client';

import * as React from 'react';

import { SECURITY_PAGES_CLOCK, ZonedWords } from '@/components/platform/zoned-time';
import { formatMomentInZone } from '@/lib/platform/dates';
import { readSecurityEventSamplesAction } from '@/server/actions/platform/security-event-samples';

import {
  readSecurityEventSamplesResult,
  runtimeTimeZone,
  securityEventReasonLabel,
  securityEventSamplesAskFor,
  SECURITY_EVENT_SAMPLES_FAILED,
  SECURITY_EVENT_SAMPLES_FIRST,
  SECURITY_EVENT_SAMPLES_WORDS as W,
  usableTimeZone,
  type SecurityEventSampleTarget,
  type SecurityEventSamplesAsk,
  type SecurityEventSamplesEntry,
  type SecurityEventSamplesResult,
  type SecurityEventSamplesView,
} from '@stockpilot/core';

/**
 * "WHAT WAS ASKED FOR" IN THE HOW-TO-RESPOND PANEL (security tools part 5,
 * stage 3b): for an exploit-attempt entry, the scrubbed paths scanners asked
 * for in its hour and kind (or every kind in the last 24 hours, for a card
 * opened from the map's legend), each with its count, its method and, when
 * there was one, its query string under "What was sent".
 *
 * Read once, when the panel opens (this section mounts with it): never with
 * the page, never on a timer. The read is the panel's Server Action, behind
 * the console's own rule.
 *
 * EVERY PATH AND QUERY STRING HERE IS TEXT A STRANGER CHOSE. It is rendered
 * as React text only, in a monospace box that breaks anywhere: never a link,
 * never markup, never in a title, an href or an accessible name
 * (security-response-samples.test.tsx and security-panels-no-raw-html.guard.test.ts).
 *
 * The section is a region named by its heading; loading it moves no focus,
 * and "Show all" is one button that stays where it is when pressed.
 */

type State =
  { at: 'loading' } | { at: 'too_old' } | { at: 'done'; result: SecurityEventSamplesResult };

/** A country's English name, else its code. Small on purpose: the panel's chunk carries no map data. */
function countryWords(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

/** One read for one mount: a second run of the effect (React's development check) reuses it. */
function useSamples(ask: SecurityEventSamplesAsk | null): SecurityEventSamplesResult | null {
  const pending = React.useRef<Promise<SecurityEventSamplesResult> | null>(null);
  const [result, setResult] = React.useState<SecurityEventSamplesResult | null>(null);
  React.useEffect(() => {
    if (ask === null) return;
    pending.current ??= readSecurityEventSamplesAction(ask).then(
      (raw) => readSecurityEventSamplesResult(raw),
      () => SECURITY_EVENT_SAMPLES_FAILED,
    );
    let live = true;
    void pending.current.then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, [ask]);
  return result;
}

const MONO = 'text-foreground font-mono text-[12px] leading-snug [overflow-wrap:anywhere]';

function Target({ target, showKind }: { target: SecurityEventSampleTarget; showKind: boolean }) {
  return (
    <li
      data-sample-target=""
      className="bg-muted/40 flex flex-col gap-1.5 rounded-md border px-3 py-2"
    >
      <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span data-sample-path="" className={`${MONO} min-w-0`}>
          {target.target}
        </span>
        <span className="text-muted-foreground shrink-0 text-[12px] tabular-nums">
          {W.requests(target.events)}
        </span>
      </p>
      {showKind ? (
        <p className="text-muted-foreground text-[12px]">
          {securityEventReasonLabel(target.reason)}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {target.pairs.map((pair, i) => (
          <li key={i} data-sample-pair="" className="flex flex-col gap-0.5 text-[12px]">
            <span className="text-muted-foreground flex flex-wrap gap-x-2">
              <span className="text-foreground font-mono">{pair.method}</span>
              <span className="tabular-nums">{W.requests(pair.events)}</span>
            </span>
            {pair.sample !== null ? (
              <span className="flex min-w-0 flex-col">
                <span className="text-muted-foreground text-[11.5px]">{W.sent}</span>
                <span data-sample-query="" className={MONO}>
                  {pair.sample}
                </span>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {target.pairsTruncated ? (
        <p className="text-muted-foreground text-[12px]">{W.pairsTruncated}</p>
      ) : null}
    </li>
  );
}

function List({ view, oneKind }: { view: SecurityEventSamplesView; oneKind: string | null }) {
  const [all, setAll] = React.useState(false);
  const listId = React.useId();
  const more = view.targets.length > SECURITY_EVENT_SAMPLES_FIRST;
  const shown = all || !more ? view.targets : view.targets.slice(0, SECURITY_EVENT_SAMPLES_FIRST);
  // One kind: its own overflow line only. Every kind: each kind's, by its name.
  const overflows = view.moreThanListed.filter((o) => oneKind === null || o.reason === oneKind);
  return (
    <>
      {view.targets.length === 0 ? (
        <p data-testid="security-event-samples-none" className="text-foreground">
          {W.none} <span className="text-muted-foreground">{W.noneWhy}</span>
        </p>
      ) : (
        <ol id={listId} className="flex flex-col gap-2">
          {shown.map((t) => (
            <Target key={`${t.reason} ${t.target}`} target={t} showKind={oneKind === null} />
          ))}
        </ol>
      )}
      {more ? (
        <div>
          <button
            type="button"
            aria-expanded={all}
            aria-controls={listId}
            onClick={() => setAll((v) => !v)}
            className="text-foreground focus-visible:ring-ring rounded-sm text-[12.5px] font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 max-sm:min-h-11"
          >
            {all ? W.showFirst(SECURITY_EVENT_SAMPLES_FIRST) : W.showAll(view.targets.length)}
          </button>
        </div>
      ) : null}
      {view.targetsTruncated ? (
        <p className="text-muted-foreground text-[12px]">
          {W.targetsTruncated(view.listedTargets, view.targets.length)}
        </p>
      ) : null}
      {overflows.map((o) => (
        <p key={o.reason} data-sample-overflow="" className="text-muted-foreground text-[12px]">
          {W.overflow(
            o,
            view.country !== null,
            oneKind === null ? securityEventReasonLabel(o.reason) : undefined,
          )}
        </p>
      ))}
      {view.targets.length > 0 ? (
        <p className="text-muted-foreground border-t pt-2 text-[12px] leading-relaxed">
          {W.removed}
        </p>
      ) : null}
    </>
  );
}

export function SecurityResponseSamples({ entry }: { entry: SecurityEventSamplesEntry }) {
  const headingId = React.useId();
  // Decided once, when the panel opens: the ask, or why there is none.
  const [plan] = React.useState(() => securityEventSamplesAskFor(entry, Date.now()));
  const ask = plan.ok ? plan.ask : null;
  const result = useSamples(ask);
  const state: State = !plan.ok
    ? plan.why === 'too_old'
      ? { at: 'too_old' }
      : { at: 'done', result: SECURITY_EVENT_SAMPLES_FAILED }
    : result === null
      ? { at: 'loading' }
      : { at: 'done', result };

  const zone = usableTimeZone(entry.timeZone) ?? runtimeTimeZone();
  const moment = (at: string | number) => formatMomentInZone(at, zone, SECURITY_PAGES_CLOCK);
  let windowLine: React.ReactNode = null;
  if (ask !== null) {
    if (ask.hour === null) {
      windowLine = W.lastDay;
    } else {
      const to = Date.parse(ask.hour) + 3_600_000;
      windowLine = (
        <ZonedWords at={[ask.hour, to]} text={W.hourWindow(moment(ask.hour), moment(to))} />
      );
    }
  }
  const view = state.at === 'done' && state.result.ok ? state.result.view : null;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={state.at === 'loading'}
      data-testid="security-event-samples"
      data-state={
        state.at === 'done' ? (state.result.ok ? 'shown' : state.result.reason) : state.at
      }
      className="flex flex-col gap-2"
    >
      <h3
        id={headingId}
        className="text-muted-foreground text-[11.5px] font-semibold uppercase tracking-[0.06em]"
      >
        {W.title}
      </h3>
      <div className="flex flex-col gap-2 text-[13px] leading-relaxed">
        {windowLine !== null ? (
          <p className="text-muted-foreground text-[12px]">{windowLine}</p>
        ) : null}
        {ask?.country ? (
          <p className="text-muted-foreground text-[12px]">
            {W.inCountry(countryWords(ask.country))}
          </p>
        ) : null}
        {view?.windowFrom ? (
          <p className="text-muted-foreground text-[12px]">
            <ZonedWords at={view.windowFrom} text={W.windowFrom(moment(view.windowFrom))} />
          </p>
        ) : null}
        {state.at === 'loading' ? <p className="text-muted-foreground">{W.loading}</p> : null}
        {state.at === 'too_old' ? <p className="text-foreground">{W.tooOld}</p> : null}
        {state.at === 'done' && !state.result.ok ? (
          <p className="text-foreground">
            {state.result.reason === 'refused' ? W.refused : W.couldNotCheck}
          </p>
        ) : null}
        {view !== null ? <List view={view} oneKind={ask?.reason ?? null} /> : null}
      </div>
    </section>
  );
}
