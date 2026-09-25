import { AlertTriangle, Clock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';

import {
  EXCEPTION_FIRST_CHECK_PENDING_COPY,
  EXCEPTION_LIST_UNAVAILABLE_COPY,
  EXCEPTION_RULES,
  EXCEPTION_SYNC_INTERVAL_MINUTES,
  exceptionUncheckedRulesCopy,
  exceptionUnrecognizedCopy,
  formatOrgDateTime,
  occurrenceState,
  occurrenceStateLabel,
  recurrenceBadge,
  type ExceptionRule,
  type OccurrenceState,
} from '@stockpilot/core';

import type { ExceptionOccurrence, ExceptionSyncState } from '@/server/services/exception-occurrences';

/**
 * Display pieces shared by the Exceptions list and the occurrence page
 * (F1-1). Server-safe on purpose: no 'use client' here, so the pages can call
 * the plain helpers (recurring pattern #8). Every word comes from core, so the
 * web pages and the phone screens read the same.
 */

/** "Sep 24, 3:42 PM" in the org's time zone. */
export function exceptionTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  return formatOrgDateTime(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, timeZone);
}

/** The displayed state of an occurrence (core precedence). */
export function stateOf(o: ExceptionOccurrence, syncState: ExceptionSyncState | null): OccurrenceState {
  return occurrenceState(
    {
      resolvedAt: o.resolvedAt,
      resolvedReason: o.resolvedReason,
      acknowledgedAt: o.acknowledgedAt,
      acknowledgedBy: o.acknowledgedBy?.id ?? null,
      recount: o.recount,
    },
    syncState?.lastEvaluatedAt ?? null,
  );
}

export function StateChip({ state }: { state: OccurrenceState }) {
  const variant =
    state.kind === 'resolved' ? 'success' : state.kind === 'open' ? 'warning' : 'secondary';
  return (
    <Badge variant={variant} data-testid="occurrence-state">
      {occurrenceStateLabel(state)}
    </Badge>
  );
}

export function RecurrenceChip({ recurrenceIndex }: { recurrenceIndex: number }) {
  const label = recurrenceBadge(recurrenceIndex);
  return label ? <Badge variant="outline">{label}</Badge> : null;
}

export function SeverityChip({ rule }: { rule: ExceptionRule }) {
  const critical = EXCEPTION_RULES[rule].severity === 'critical';
  return (
    <Badge variant={critical ? 'destructive' : 'secondary'} className="gap-1">
      {critical && <AlertTriangle className="size-3" aria-hidden />}
      {critical ? 'Critical' : 'Warning'}
    </Badge>
  );
}

/** A failed read. Never an empty list: an empty Exceptions list reads as
 *  "nothing is wrong". */
export function ExceptionsUnavailable() {
  return (
    <div
      role="alert"
      className="border-warning/40 bg-warning/5 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
    >
      <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{EXCEPTION_LIST_UNAVAILABLE_COPY} Reload the page to try again.</p>
    </div>
  );
}

/** Before the org's first check: says so, and is never the all-clear state. */
export function FirstCheckPending() {
  return (
    <div role="status" className="bg-muted/40 flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
      <Clock className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{EXCEPTION_FIRST_CHECK_PENDING_COPY}</p>
    </div>
  );
}

/** The rules the last check could not vouch for (failed or truncated). Their
 *  silence is unknown, not clean. */
export function uncheckedRuleLabels(syncState: ExceptionSyncState): string[] {
  return [...new Set([...syncState.failedRules, ...syncState.truncatedRules])].map(
    (rule) => EXCEPTION_RULES[rule].label,
  );
}

/** The unchecked-rules sentence (core copy, the phone shows the same), or
 *  null when every check completed. A failed or truncated rule this build
 *  cannot name counts too: unknown is not clean. */
export function uncheckedRulesMessage(syncState: ExceptionSyncState): string | null {
  return exceptionUncheckedRulesCopy(uncheckedRuleLabels(syncState), syncState.unrecognizedUncheckedRules ?? 0);
}

export function UncheckedRulesBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="border-warning/40 bg-warning/5 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
    >
      <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{message}</p>
    </div>
  );
}

/** Open rows this build cannot word (a newer build's rule). Shown instead of
 *  the all-clear state, never alongside it. */
export function UnrecognizedNotice({ count }: { count: number }) {
  const text = exceptionUnrecognizedCopy(count);
  if (!text) return null;
  return (
    <div
      role="status"
      data-testid="exceptions-unrecognized"
      className="border-warning/40 bg-warning/5 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
    >
      <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{text}</p>
    </div>
  );
}

/** "Checked at <time>" and the cadence. */
export function CheckedAt({ syncState, timeZone }: { syncState: ExceptionSyncState; timeZone: string }) {
  return (
    <p className="text-muted-foreground text-xs">
      Checked at {exceptionTime(syncState.lastSyncedAt, timeZone)}. The system checks every{' '}
      {EXCEPTION_SYNC_INTERVAL_MINUTES} minutes and after each posted or cancelled count.
    </p>
  );
}
