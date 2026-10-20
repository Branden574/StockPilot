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
  SHORTFALL_PO_FORBIDDEN_COPY,
  stagingPutAwayHref,
  type OrderReadinessResult,
  type PutAwayAccess,
  type PutAwayTargets,
  type ReadinessAudience,
  type ReadinessLineAssessment,
  type ReadinessTone,
  type ShortfallPoView,
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
 *  a line's chip. The redesign's tones (DESIGN-SPEC 6.10), which follow the
 *  theme on their own: success is the accent on its wash, warning and danger
 *  their own washes, info the neutral pill (ink 2 on the sunk fill with the
 *  stronger hairline: the palette has no blue), neutral the quiet outline.
 *  Every tone still comes with an icon and words. */
export const READINESS_TONE_STYLES: Readonly<
  Record<ReadinessTone, { band: string; text: string; chip: string }>
> = {
  success: {
    band: 'bg-success-wash',
    text: 'text-accent',
    chip: 'border-accent/30 bg-success-wash text-accent',
  },
  warning: {
    band: 'bg-warning-wash',
    text: 'text-warning',
    chip: 'border-warning/30 bg-warning-wash text-warning',
  },
  info: {
    band: 'bg-sunk',
    text: 'text-ink-2',
    chip: 'border-line-strong bg-sunk text-ink-2',
  },
  danger: {
    band: 'bg-destructive-wash',
    text: 'text-destructive',
    chip: 'border-destructive/30 bg-destructive-wash text-destructive',
  },
  neutral: {
    band: 'bg-sunk',
    text: 'text-foreground',
    chip: 'border-line-strong bg-card text-ink-2',
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
  opts: {
    timeZone: string;
    /** RX-2 review fix P6: an exchange replacement waiting for its returned
     *  item reads "Stock held … Picking waits for the returned item." and when
     *  picking starts (core describeReadinessRollup); the requester's card is
     *  unchanged. */
    replacementGate?: 'waiting' | 'open' | 'closed' | null;
    returnNumber?: string | null;
  },
): ReadinessStripView | null {
  const failed = result.state === 'failed';
  if (audience === 'none') return null;
  if (audience === 'requester') {
    const card = describeReadinessForRequester(result, { timeZone: opts.timeZone });
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

/**
 * The strip's "Draft PO for what is short" (F2-5), as plain data for the
 * client strip: the button that opens the page's dialog (mounted once, at the
 * top of the page) for a viewer who may draft (`canDraft`, core
 * canDraftShortfallPo: a manager holding purchase_orders:manage, the orders
 * and purchase_orders modules on; the page decides), or core's sentence for a
 * viewer on the full strip who is not a manager holding
 * purchase_orders:manage (`drafterRole` false). A manager holding it who still
 * may not draft (a module off) is told nothing: the sentence would name the
 * wrong reason. Null when nothing may be drafted: nothing is short, what is
 * short is already on a PO or a draft, readiness was not checked, or the
 * purchase-orders module is off (then readiness reads no POs at all, and the
 * view says so).
 */
export type ReadinessStripShortfallPo =
  | { kind: 'button'; orderId: string }
  | { kind: 'needs_permission'; message: string };

export function readinessStripShortfallPo(
  view: ShortfallPoView | null,
  opts: { orderId: string; canDraft: boolean; drafterRole: boolean },
): ReadinessStripShortfallPo | null {
  if (!view || view.draftableCount === 0) return null;
  if (opts.canDraft) return { kind: 'button', orderId: opts.orderId };
  return opts.drafterRole ? null : { kind: 'needs_permission', message: SHORTFALL_PO_FORBIDDEN_COPY };
}
