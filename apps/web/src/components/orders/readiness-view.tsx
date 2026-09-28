import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Package,
  type LucideIcon,
} from 'lucide-react';

import {
  describeReadinessRollup,
  readinessCheckedAtCopy,
  readinessSummaryForRequester,
  REQUESTER_ALL_IN_STOCK_COPY,
  REQUESTER_WAITING_COPY,
  type OrderReadinessResult,
  type ReadinessAudience,
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
      /** The read failed: the headline says so and the button says Try again. */
      failed: boolean;
    }
  | {
      /** The requester: one sentence, no numbers. */
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
    const sentence = readinessSummaryForRequester(result);
    if (!sentence) return null;
    const [tone, icon]: [ReadinessTone, string] =
      sentence === REQUESTER_ALL_IN_STOCK_COPY
        ? ['success', 'check']
        : sentence === REQUESTER_WAITING_COPY
          ? ['warning', 'clock']
          : ['neutral', 'help'];
    return {
      mode: 'requester',
      sentence,
      tone,
      icon,
      checkedAt:
        result.state === 'ok' ? readinessCheckedAtCopy(result.assessment.observedAt, opts) : null,
      failed,
    };
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
    failed,
  };
}
