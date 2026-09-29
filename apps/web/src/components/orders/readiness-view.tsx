import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Package,
  PackageCheck,
  type LucideIcon,
} from 'lucide-react';

import {
  describeReadinessForRequester,
  describeReadinessRollup,
  putAwayLineOffer,
  putAwayStripOffer,
  stagingPutAwayHref,
  type OrderReadinessResult,
  type PutAwayAccess,
  type PutAwayTargets,
  type ReadinessAudience,
  type ReadinessLineAssessment,
  type ReadinessTone,
} from '@stockpilot/core';

/**
 * ORDER READINESS ON THE WEB ORDER PAGE (F2-1): the look shared by the strip
 * above the lines table (readiness-strip.tsx) and each line's cell
 * (readiness-line-cell.tsx), and the strip's words.
 *
 * No 'use client': the page (a server component) builds the strip's view here
 * and the client strip only renders it, so the words are composed once, on
 * the server, from core (readiness-copy.ts), the same functions the phone
 * calls. A state is never shown by colour alone: every tone comes with an icon
 * and words.
 */

/** Tailwind classes per core ReadinessTone: the strip's band, its words, and
 *  a line's chip. Light and dark. */
export const READINESS_TONE_STYLES: Readonly<
  Record<ReadinessTone, { band: string; text: string; chip: string }>
> = {
  success: {
    band: 'bg-emerald-50 dark:bg-emerald-950/30',
    text: 'text-emerald-800 dark:text-emerald-300',
    chip: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  warning: {
    band: 'bg-amber-50 dark:bg-amber-950/30',
    text: 'text-amber-800 dark:text-amber-300',
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  },
  info: {
    band: 'bg-sky-50 dark:bg-sky-950/30',
    text: 'text-sky-800 dark:text-sky-300',
    chip: 'border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-300',
  },
  danger: {
    band: 'bg-red-50 dark:bg-red-950/30',
    text: 'text-red-800 dark:text-red-300',
    chip: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  },
  neutral: {
    band: 'bg-muted/40',
    text: 'text-foreground',
    chip: 'border-border bg-muted/60 text-foreground',
  },
};

/** Core's generic icon keys (READINESS_STATES, PICKED_LINE_STATES). */
const ICONS: Readonly<Record<string, LucideIcon>> = {
  check: CheckCircle2,
  package: Package,
  clock: Clock,
  help: HelpCircle,
  alert: AlertTriangle,
  handed: PackageCheck,
};

export function ReadinessIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon] ?? HelpCircle;
  return <Icon className={className} aria-hidden />;
}

/** What the strip renders. Plain data, so it crosses to the client strip. */
export type ReadinessStripView =
  | {
      /** Approvers, pickers and buyers: the roll-up. */
      mode: 'full';
      headline: string;
      tone: ReadinessTone;
      icon: string;
      details: string[];
      neededBy: string | null;
      checkedAt: string | null;
      /** A failed read's reason under the headline (core
       *  readinessFailureDetail; the phone shows the same line). */
      detail: string | null;
      /** The read failed: the headline says so and the button says Try again. */
      failed: boolean;
    }
  | {
      /** The requester: one sentence, no numbers (core
       *  describeReadinessForRequester, the phone's card too). */
      mode: 'requester';
      sentence: string;
      tone: ReadinessTone;
      icon: string;
      checkedAt: string | null;
      failed: boolean;
    };

/**
 * The strip for a readiness result and the viewer's audience (core
 * readinessAudience). Null when nothing is shown: nobody outside the audience,
 * and nothing outside the to_pick phase.
 */
export function readinessStripView(
  result: OrderReadinessResult,
  audience: ReadinessAudience,
  opts: { timeZone: string },
): ReadinessStripView | null {
  const failed = result.state === 'failed';
  if (audience === 'none') return null;
  if (audience === 'requester') {
    const card = describeReadinessForRequester(result, opts);
    return card ? { mode: 'requester', ...card } : null;
  }
  const rollup = describeReadinessRollup(result, opts);
  if (!rollup) return null;
  return {
    mode: 'full',
    headline: rollup.headline,
    tone: rollup.tone,
    icon: rollup.icon,
    details: rollup.details,
    neededBy: rollup.neededBy,
    checkedAt: rollup.checkedAt,
    detail: rollup.detail,
    failed,
  };
}

/**
 * The strip's put-away offer (F2-3), as plain data for the client strip: a
 * link to the Staging list filtered to the order's items that need putting
 * away ("Put away 3 items"), or, for a viewer without `stock:transfer` (the
 * permission Place asserts) or `items:read` (the Staging page's own gate),
 * core's sentence naming what is missing. Null when nothing
 * needs putting away, or readiness was not checked (core putAwayTargets gives
 * null outside the to_pick phase and past the line cap).
 */
export type ReadinessStripPutAway =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'needs_permission'; message: string };

export function readinessStripPutAway(
  targets: PutAwayTargets | null,
  opts: { orderId: string; access: PutAwayAccess },
): ReadinessStripPutAway | null {
  const offer = putAwayStripOffer(targets, opts.access);
  if (offer.kind === 'link') {
    return {
      kind: 'link',
      label: offer.label,
      href: stagingPutAwayHref({ orderId: opts.orderId, itemIds: offer.itemIds }),
    };
  }
  if (offer.kind === 'needs_permission') return { kind: 'needs_permission', message: offer.message };
  return null;
}

/**
 * A readiness line's "Put away" link (F2-3): the Staging list filtered to the
 * line's item, from this order. Null when the line has nothing in Staging, or
 * when the viewer may not put stock away: the strip above says why once
 * (readinessStripPutAway), rather than every line repeating it.
 */
export function readinessLinePutAwayHref(
  line: ReadinessLineAssessment | null,
  opts: { orderId: string; access: PutAwayAccess },
): string | null {
  if (!line) return null;
  const offer = putAwayLineOffer(line, opts.access);
  return offer.kind === 'link' ? stagingPutAwayHref({ orderId: opts.orderId, itemIds: offer.itemIds }) : null;
}
