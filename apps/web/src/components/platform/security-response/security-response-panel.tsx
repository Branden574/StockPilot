'use client';

import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';

import {
  SECURITY_RESPONSE_CARD_LEVELS,
  SECURITY_RESPONSE_WORDS,
  securityResponseCard,
  securityResponseStepShown,
  type SecurityResponseCard,
  type SecurityResponseCardId,
  type SecurityResponseItem,
  type SecurityResponsePlace,
} from '@stockpilot/core';

import type { SecurityResponsePanelProps } from './security-response-host';
import { SecurityResponseLevelBadge } from './security-response-level';

/**
 * THE HOW-TO-RESPOND PANEL: one card in a dialog over the right side of the
 * page (the app's Sheet, so it has the page's own look in Classic and in
 * Liquid Glass, which styles every sheet by its data-glass mark). On top,
 * the entry it was opened from, in the words that entry already shows; then
 * the card's five parts. An Act now card shows "If one got through" first.
 *
 * The only module that imports the cards' text (core's
 * security-response-cards.ts). It is loaded by the host on the first press,
 * never in a page's first load.
 *
 * A step's place is a link when it is a console page the platform admin can
 * open, its `<organization id>` filled from the entry; a place in the
 * organization's own app (after Act as this org) is text, never a link. A
 * link is never prefetched: an organization's page writes a viewed_org row
 * to the platform audit when it is opened.
 *
 * Escape and the Close buttons close it; focus stays inside while it is open
 * (the dialog's own trap) and goes back to the control that opened it, or,
 * when that control has left the page, to the heading of its list.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_SLOT = '<organization id>';

/** A console route with the entry's organization filled in, or null when it cannot be (no organization). */
export function filledRoute(route: string, organizationId: string | null): string | null {
  if (!route.includes(ORG_SLOT)) return route;
  if (organizationId === null || !UUID_RE.test(organizationId)) return null;
  return route.replace(ORG_SLOT, organizationId);
}

const LINK = 'text-foreground underline underline-offset-2 hover:text-ink-2';

/** Focus on an element still on the page that may not take focus of its own (a heading): from code only. */
function focusNear(el: HTMLElement | null): void {
  if (!el || !el.isConnected) return;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus();
}

function Place({
  place,
  organizationId,
}: {
  place: SecurityResponsePlace;
  organizationId: string | null;
}) {
  if (place.afterActAs) {
    return (
      <p data-part="place" data-after-act-as="" className="text-muted-foreground mt-1 text-[12px]">
        {SECURITY_RESPONSE_WORDS.afterActAs}: {place.way}{' '}
        <code className="font-mono text-[11.5px]">{place.route}</code>
      </p>
    );
  }
  const href = filledRoute(place.route, organizationId);
  return (
    <p data-part="place" className="text-muted-foreground mt-1 text-[12px]">
      {href ? (
        <Link href={href} prefetch={false} className={LINK}>
          {place.way}
        </Link>
      ) : (
        <>
          {place.way} <code className="font-mono text-[11.5px]">{place.route}</code>
        </>
      )}
    </p>
  );
}

function Steps({
  items,
  organizationId,
  onSeeCard,
}: {
  items: readonly SecurityResponseItem[];
  organizationId: string | null;
  onSeeCard: (id: SecurityResponseCardId) => void;
}) {
  if (items.length === 0) {
    return <p className="text-foreground">{SECURITY_RESPONSE_WORDS.nothingToDo}</p>;
  }
  return (
    <ol className="marker:text-muted-foreground list-decimal space-y-2.5 pl-5">
      {items.map((item, i) => {
        const step = securityResponseStepShown(item);
        return (
          <li key={i} data-step={step.id ?? 'own'} className="pl-1">
            <p className="text-foreground">
              {step.lead ? <span className="font-medium">{step.lead} </span> : null}
              {step.text}
            </p>
            {step.place ? <Place place={step.place} organizationId={organizationId} /> : null}
            {step.seeCard ? (
              <button
                type="button"
                data-see-card={step.seeCard}
                onClick={() => onSeeCard(step.seeCard!)}
                className={`mt-1 text-left text-[12.5px] font-medium ${LINK} focus-visible:ring-ring rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2`}
              >
                {SECURITY_RESPONSE_WORDS.seeCard}: {securityResponseCard(step.seeCard).title}
              </button>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function Part({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} data-part={id} className="flex flex-col gap-1.5">
      <h3
        id={headingId}
        className="text-muted-foreground text-[11.5px] font-semibold uppercase tracking-[0.06em]"
      >
        {title}
      </h3>
      <div className="text-[13.5px] leading-relaxed">{children}</div>
    </section>
  );
}

/** Whether a card names a place that opens only after Act as this org. */
function usesActAs(card: SecurityResponseCard): boolean {
  return [...card.doNow, ...card.ifGotThrough].some(
    (item) => securityResponseStepShown(item).place?.afterActAs === true,
  );
}

export function SecurityResponsePanel({
  request,
  open,
  onOpenChange,
  returnFocusTo,
  fallbackFocusTo,
}: SecurityResponsePanelProps) {
  // The cards opened in this panel, the first being the entry's: Back goes one down.
  const [trail, setTrail] = React.useState<SecurityResponseCardId[]>([request.cardId]);
  const cardId = trail[trail.length - 1]!;
  const card = securityResponseCard(cardId);
  const level = SECURITY_RESPONSE_CARD_LEVELS[cardId];
  const titleRef = React.useRef<HTMLHeadingElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const moved = React.useRef(false);

  React.useEffect(() => {
    // After moving to another card (not on opening), the reader starts at its title.
    if (!moved.current) return;
    bodyRef.current?.scrollTo?.({ top: 0 });
    titleRef.current?.focus();
  }, [cardId]);

  const go = (id: SecurityResponseCardId) => {
    moved.current = true;
    setTrail((t) => [...t, id]);
  };
  const back = () => {
    moved.current = true;
    setTrail((t) => (t.length > 1 ? t.slice(0, -1) : t));
  };

  const { context } = request;
  // Exactly one organization, by a real id: its name is a link, and its routes are filled in.
  const organizationId =
    request.organizationId !== null && UUID_RE.test(request.organizationId)
      ? request.organizationId
      : null;
  const several = organizationId === null && (request.organizations ?? 0) > 1;
  const facts: Array<[string, string]> = [
    [SECURITY_RESPONSE_WORDS.kind, context.kind],
    [SECURITY_RESPONSE_WORDS.where, context.place],
    [SECURITY_RESPONSE_WORDS.when, context.time],
    [SECURITY_RESPONSE_WORDS.organization, context.organization],
  ].filter((f): f is [string, string] => typeof f[1] === 'string' && f[1].length > 0);
  // The time's exact instant in UTC, when the entry gave one that says more than the time shown.
  const utc =
    context.timeUtc && context.time && !context.time.endsWith(' UTC') ? context.timeUtc : null;

  const parts = {
    what: (
      <Part key="what" id="what-this-is" title={SECURITY_RESPONSE_WORDS.whatThisIs}>
        <p className="text-foreground">{card.whatThisIs}</p>
      </Part>
    ),
    did: (
      <Part key="did" id="already-did" title={SECURITY_RESPONSE_WORDS.alreadyDid}>
        <ul className="marker:text-muted-foreground text-foreground list-disc space-y-1.5 pl-5">
          {card.alreadyDid.map((line) => (
            <li key={line} className="pl-1">
              {line}
            </li>
          ))}
        </ul>
      </Part>
    ),
    now: (
      <Part key="now" id="do-now" title={SECURITY_RESPONSE_WORDS.doNow}>
        <Steps items={card.doNow} organizationId={organizationId} onSeeCard={go} />
      </Part>
    ),
    through: (
      <Part key="through" id="if-got-through" title={SECURITY_RESPONSE_WORDS.ifGotThrough}>
        <Steps items={card.ifGotThrough} organizationId={organizationId} onSeeCard={go} />
      </Part>
    ),
    limits: (
      <Part key="limits" id="cannot-tell" title={SECURITY_RESPONSE_WORDS.cannotTell}>
        <p className="text-foreground">{card.cannotTell}</p>
      </Part>
    ),
  };
  // An Act now card leads with what to do if one got through.
  const order =
    level === 'act_now'
      ? [parts.through, parts.what, parts.did, parts.now, parts.limits]
      : [parts.what, parts.did, parts.now, parts.through, parts.limits];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        hideClose
        data-testid="security-response-panel"
        data-card={cardId}
        className="flex h-full flex-col gap-0 p-0"
        onCloseAutoFocus={(event) => {
          // Back to the control that opened it, when it is still on the page.
          event.preventDefault();
          const to = returnFocusTo.current;
          if (to && to.isConnected) to.focus();
          // Else (a poll moved its entry out of the list) to the list's heading (review S1).
          else focusNear(fallbackFocusTo?.current ?? null);
        }}
      >
        <div className="flex items-start gap-3 border-b px-5 pb-4 pt-5 sm:px-6">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <SheetDescription className="text-muted-foreground text-[11.5px] font-semibold uppercase tracking-[0.06em]">
              {SECURITY_RESPONSE_WORDS.open}
            </SheetDescription>
            <SheetTitle
              ref={titleRef}
              tabIndex={-1}
              className="text-foreground text-[19px] leading-snug focus-visible:outline-none"
            >
              {card.title}
            </SheetTitle>
            <div>
              <SecurityResponseLevelBadge level={level} />
            </div>
          </div>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-mr-2 -mt-1 shrink-0 max-sm:h-11 max-sm:w-11"
            >
              <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                />
              </svg>
              <span className="sr-only">{SECURITY_RESPONSE_WORDS.close}</span>
            </Button>
          </SheetClose>
        </div>

        {facts.length > 0 ? (
          <div
            data-testid="security-response-context"
            className="bg-muted/40 border-b px-5 py-3 sm:px-6"
          >
            <p className="text-muted-foreground mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em]">
              {SECURITY_RESPONSE_WORDS.contextTitle}
            </p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12.5px]">
              {facts.map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd
                    className="text-foreground min-w-0 [overflow-wrap:anywhere]"
                    title={label === SECURITY_RESPONSE_WORDS.when && utc ? utc : undefined}
                  >
                    {label === SECURITY_RESPONSE_WORDS.organization && organizationId !== null ? (
                      // Never prefetched: opening an organization's page writes a viewed_org row to the audit.
                      <Link
                        href={`/platform/orgs/${organizationId}`}
                        prefetch={false}
                        className={LINK}
                      >
                        {value}
                      </Link>
                    ) : (
                      value
                    )}
                    {label === SECURITY_RESPONSE_WORDS.when && utc ? (
                      <span className="sr-only"> ({utc})</span>
                    ) : null}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
            {several ? (
              <p
                data-testid="security-response-several-organizations"
                className="text-muted-foreground mt-2 text-[12px] leading-relaxed"
              >
                {SECURITY_RESPONSE_WORDS.severalOrganizations(request.organizations ?? 0)}
              </p>
            ) : null}
          </div>
        ) : null}

        <div
          ref={bodyRef}
          data-testid="security-response-body"
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5 sm:px-6"
        >
          {order}
          {usesActAs(card) ? (
            <p
              data-testid="security-response-act-as-note"
              className="text-muted-foreground border-t pt-4 text-[12px] leading-relaxed"
            >
              {SECURITY_RESPONSE_WORDS.actAsNote}
            </p>
          ) : null}
        </div>

        {trail.length > 1 ? (
          <div className="flex items-center border-t px-5 py-3 sm:px-6">
            <Button type="button" variant="outline" onClick={back} className="max-sm:h-11">
              {SECURITY_RESPONSE_WORDS.back}
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
