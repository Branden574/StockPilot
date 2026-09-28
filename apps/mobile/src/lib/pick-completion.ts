/**
 * THE CONFIRM BEFORE A PICK IS COMPLETED, ON THE PHONE (F2-2).
 *
 * On SO-000100 a pick completed with the pen line at 0 of 60 and no prompt.
 * The phone's digital pick now shows core's completion confirm ("Before you
 * complete picking") whenever something will come up short, the pick would
 * fail, an item could not be checked, or stock could not be checked at all:
 * the confirm is never skipped for want of facts.
 *
 * WHAT IT SAYS IS CORE'S: digitalPickCompletionConfirm (readiness-copy.ts),
 * the web digital pick's own. It projects what the picker entered against
 * the order's readiness (core projectCompletePicking) and words it with
 * describeCompletionConfirm; when readiness is missing, failed or about
 * another set of lines, it names what was entered short and says stock
 * couldn't be checked.
 *
 * What lives here is the phone's half: the confirm as an `Alert.alert`
 * message and buttons. Core's labels, "Review short lines" (goes back to the
 * first short line) and "Complete picking" (goes ahead; the server decides,
 * as always).
 *
 * Pure: no React Native import.
 */

import type { CompletionConfirmCopy } from '@stockpilot/core';

import type { ConfirmButton } from './order-departure';

/** The confirm's message: its paragraphs, each on its own. */
export function completionConfirmMessage(copy: CompletionConfirmCopy): string {
  return copy.paragraphs.join('\n\n');
}

/**
 * The confirm's buttons: "Review short lines" (the cancel button, so the safe
 * choice is the default one; it hands the line to look at to `onReview`),
 * then "Complete picking".
 */
export function completionConfirmButtons(
  copy: CompletionConfirmCopy,
  handlers: { onReview: (lineId: string | null) => void; onComplete: () => void },
): ConfirmButton[] {
  return [
    { text: copy.reviewLabel, style: 'cancel', onPress: () => handlers.onReview(copy.focusLineId) },
    { text: copy.confirmLabel, onPress: handlers.onComplete },
  ];
}
