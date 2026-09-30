import {
  countVarianceAcknowledgeHelp,
  countVarianceClearCopy,
  occurrenceState,
  recountAbilityOf,
  type CountConfirmBlock,
  type CountVarianceClearCopy,
  type OccurrenceState,
  type RecountAbility,
} from '@stockpilot/core';

import type { MobileExceptionDetail } from './exceptions-api';

/**
 * A COUNT DIFFERENCE ON THE PHONE (owner decision 2026-09-29, after EX-000059
 * was acknowledged in the belief that it would close): what the exception
 * screen's top WHAT CLEARS THIS section, its Acknowledge sheet and its
 * confirm sheet need, worked out once from the server's answer. Every word is
 * core's, so the phone and the web page read the same.
 *
 * Confirm this count ships in the phone now, DORMANT: it is offered only when
 * the server sends a countConfirm block (parseCountConfirm) whose canConfirm
 * is true. With no block the feature is off and nothing names Confirm. The
 * phone gets no second release for it, so this is the code the server will
 * wake.
 */

/** What the confirm sheet needs besides the occurrence. */
export interface ExceptionSheetConfirm {
  /** The server's block; null when the feature is off (never offered then). */
  block: CountConfirmBlock | null;
  /** Why Confirm is withheld when it is: the screen's reason line, else its
   *  sentence of what clears it. Null while it is offered. */
  unavailable: string | null;
  /** For wording a refusal (core describeConfirmError). */
  errorContext: { recount: RecountAbility; recountNumber: number | null; counterLabel: string | null };
}

export interface CountVarianceView {
  /** The top section's words (core countVarianceClearCopy). */
  clear: CountVarianceClearCopy;
  /** The Acknowledge sheet's help (core countVarianceAcknowledgeHelp). */
  acknowledgeHelp: string;
  confirm: ExceptionSheetConfirm;
}

/** The displayed state, with who confirmed a confirmed row. */
export function displayedStateOf(detail: Pick<MobileExceptionDetail, 'occurrence' | 'syncState'>): OccurrenceState {
  const o = detail.occurrence;
  return occurrenceState(
    {
      resolvedAt: o.resolvedAt,
      resolvedReason: o.resolvedReason,
      confirmedAs: o.confirmation?.as ?? null,
      acknowledgedAt: o.acknowledgedAt,
      acknowledgedBy: o.acknowledgedBy?.id ?? null,
      recount: o.recount,
    },
    detail.syncState?.lastEvaluatedAt ?? null,
  );
}

/**
 * The view for an OPEN count difference, or null for any other exception.
 * `online` is the LIVE network state: offline, an offered Confirm stays on
 * screen, disabled, with the reason (it is never queued).
 */
export function countVarianceView(detail: MobileExceptionDetail, opts: { online: boolean }): CountVarianceView | null {
  const o = detail.occurrence;
  if (o.rule !== 'count_variance' || o.resolvedAt !== null) return null;
  const displayed = displayedStateOf(detail);
  const block = detail.countConfirm;
  const clear = countVarianceClearCopy({
    facts: o.facts,
    displayed,
    recount: o.recount,
    canAct: o.canAct,
    canRecount: o.canRecount,
    recountUnavailableReason: o.recountUnavailableReason,
    confirm: block,
    online: opts.online,
    surface: 'phone',
  });
  const acknowledgeHelp = countVarianceAcknowledgeHelp({
    facts: o.facts,
    displayed,
    recount: o.recount,
    canRecount: o.canRecount,
    confirm: block,
  });
  return {
    clear,
    acknowledgeHelp,
    confirm: {
      block,
      unavailable: clear.offerConfirm ? null : (clear.reason ?? clear.options),
      errorContext: {
        recount: recountAbilityOf(o.canRecount, o.recountUnavailableReason),
        recountNumber: o.recount?.countNumber ?? null,
        counterLabel: block?.countedBy?.label?.trim() || null,
      },
    },
  };
}
