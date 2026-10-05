import { formatOrgDate, formatOrgDateTime } from '../time/org-timezone';

import type {
  ChecklistIncompleteDetail,
  ChecklistInvalidDetail,
  ChecklistRunSummary,
  ChecklistStep,
  ReceiptChecklistState,
} from './receiving-checklist';

/**
 * Every word the receiving checklist shows, on the web and on the phone (one
 * set, plan section 6). Plain words; the guard test refuses "book" for a
 * quantity and any claim the product cannot stand behind (verified,
 * inspected, certified, compliant, approved, passed, sent, ticket, attached).
 */

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A whole number as people read it ("1,000,000"). */
function count(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';
}

/** A received quantity as people read it (base units may carry decimals). */
function qty(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '0';
}

export const RECEIVING_CHECKLIST_COPY = {
  // ── Posted panel (web) and Posted alert (phone) ──
  postedTitle: (receiptNumber: string) => `Receipt ${receiptNumber} posted.`,
  postedBody:
    'Recording the receiving checklist is optional. You can also do it later from Receipts on this purchase order.',
  recordChecklist: 'Record checklist',
  continueChecklist: 'Continue checklist',
  viewChecklist: 'View checklist',
  done: 'Done',
  /** Web: the post landed but starting the run did not. */
  startFailedAfterPostWeb:
    'The receipt is posted. The checklist can be recorded later from Receipts on this purchase order.',
  /** Phone: the same, in the screen's own words. */
  startFailedAfterPostPhone:
    'The receipt is saved. The checklist can be recorded later from Receipt history.',

  // ── Chips ──
  chipNoFailed: 'Checklist: no failed checks',
  chipFailed: (n: number) => (n === 1 ? 'Checklist: 1 failed check' : `Checklist: ${count(n)} failed checks`),
  chipInProgress: 'Checklist in progress',
  chipNotRecorded: 'Checklist not recorded',
  chipUnavailable: "Checklist status didn't load",

  // ── The run page ──
  runHeading: (receiptNumber: string, poNumber: string, supplier: string | null) =>
    `Receiving checklist · ${receiptNumber} · ${poNumber}${supplier ? ` · ${supplier}` : ''}`,
  versionLine: (versionNumber: number, title: string) => `Version ${versionNumber} · ${title}`,
  honesty:
    'This records what a person checked for this receipt. It does not change stock, the receipt or the purchase order.',
  aboutHeading: 'About this delivery',
  receivedOnReceipt: (units: number, lines: number) =>
    `Received on this receipt: ${qty(units)} ${plural(units, 'unit', 'units')} on ${count(lines)} ${plural(lines, 'line', 'lines')}.`,
  receivedInto: (warehouse: string) => `Received into: Staging at ${warehouse}.`,
  stockOwner: (names: readonly string[]) => `Stock owner on these items now: ${names.join(', ')}`,
  stockOwnerNone: 'No stock owner set on these items',
  stockOwnerUnavailable: "Stock owner didn't load",
  billTo: (name: string) => `Bill-to on this purchase order: ${name}`,
  stillToCome: (lines: number) =>
    `Still to come on this purchase order: ${count(lines)} ${plural(lines, 'line', 'lines')}.`,
  nothingToCome: 'Nothing is still to come on this purchase order.',
  stillToComeUnavailable: "What is still to come didn't load",
  reverseHint: 'If this receipt was posted in error, a manager can reverse it from Receipts on this purchase order.',
  instructions: (title: string) => `Instructions: ${title}`,

  // ── Steps ──
  pass: 'Pass',
  fail: 'Fail',
  notApplicable: 'Not applicable',
  whatWasWrong: 'What was wrong?',
  requiredToComplete: 'Required to complete',
  notes: 'Notes',
  runNote: 'Notes on this delivery',
  countPlaceholder: 'Number',
  textPlaceholder: 'Answer',

  // ── Buttons ──
  saveProgress: 'Save progress',
  completeChecklist: 'Complete checklist',
  completeConfirm: "Complete this checklist? Completed checklists can't be changed.",
  reload: 'Reload',
  saved: 'Progress saved.',
  completed: 'Checklist completed.',

  // ── States ──
  completedBy: (name: string, when: string) => `Completed by ${name} on ${when}`,
  startedBy: (name: string, when: string) => `Started by ${name} on ${when}`,
  recordedLate: (days: number) =>
    `Recorded ${count(days)} ${plural(days, 'day', 'days')} after the receipt was posted.`,
  reversedAfter: 'This receipt was reversed after the checklist was recorded.',
  reversedBefore: 'This receipt was reversed before the checklist was recorded.',
  keepsVersion: (newer: number, kept: number) =>
    `Version ${newer} was published after this checklist was started. This one keeps version ${kept}'s steps.`,
  readOnlyCompleted: "This checklist is completed. Completed checklists can't be changed.",
  readOnlyNotRecorder: 'Only a manager who can post receipts can record this checklist.',

  // ── Errors ──
  incompleteMissing: (labels: readonly string[]) =>
    `Answer every required step before completing: ${labels.join(', ')}.`,
  incompleteFailedNote: (labels: readonly string[]) => `Add a note to each failed check: ${labels.join(', ')}.`,
  incompletePhoto: (labels: readonly string[]) => `Add a photo or scan for: ${labels.join(', ')}.`,
  runChanged:
    'Someone else saved this checklist after you opened it. Your answers are still on screen. Reload to see the saved version.',
  runCompletedBy: (name: string) => `This checklist was completed by ${name}. Completed checklists can't be changed.`,
  runCompleted: "This checklist was already completed. Completed checklists can't be changed.",
  noChecklist: 'There is no receiving checklist turned on.',
  receiptNotCheckable: "Reversal entries don't have a checklist. Open the original receipt.",
  receiptNotFound: 'That receipt was not found.',
  runNotFound: 'That checklist was not found.',
  moduleDisabled: 'Receiving is turned off for this organization.',
  notRecorder: 'Only a manager who can post receipts can record a receiving checklist.',
  notPublisher: 'Only a manager who can manage purchase orders can publish or turn off the receiving checklist.',
  publishChanged: 'Someone published a newer version while you were editing. Your edits are still here; reload to compare.',
  busy: 'The checklist is busy right now. Try again in a moment.',
  offline: 'Checklists need a connection. The receipt itself is already saved.',
  loadFailed: "The checklist didn't load.",

  // ── Editor ──
  editorTitle: 'Receiving checklist',
  editorEmpty: 'No receiving checklist yet. It is offered after a receipt posts and is always optional.',
  startSuggested: 'Start from suggested steps',
  startBlank: 'Start blank',
  publishVersion: (n: number) => `Publish version ${n}`,
  publishConfirm: (n: number) =>
    `Receipts posted from now on offer version ${n}. Checklists already started keep the version they started with.`,
  published: (n: number) => `Version ${n} published.`,
  turnOff: 'Turn off',
  turnOffConfirm: 'Receipts will stop offering a checklist. Recorded checklists stay on their receipts.',
  turnedOff: 'The receiving checklist is turned off.',
  liveVersion: (n: number) => `Version ${n} is turned on.`,
  noLiveVersion: 'No receiving checklist is turned on.',
  history: 'Earlier versions',
  addStep: 'Add step',
  removeStep: (n: number) => `Remove step ${n}`,
  moveStepUp: (n: number) => `Move step ${n} up`,
  moveStepDown: (n: number) => `Move step ${n} down`,
  stepLabel: 'Step',
  stepHelp: 'Help (optional)',
  stepKind: 'Answer',
  stepRequired: 'Required',
  kindCheck: 'Pass, Fail or Not applicable',
  kindCount: 'A number',
  kindText: 'A short answer',
  titleLabel: 'Title',
  procedureLabel: 'Instructions (optional)',
  procedureNone: 'No procedure',
  readOnlyEditor: 'Only a manager who can manage purchase orders can change the receiving checklist.',
  procedureCard: 'Receiving checklist',
  procedureCardBody: 'The short checklist a manager can record after a receipt posts. Always optional.',
  runsOnVersion: (n: number) => `Recorded on ${count(n)} ${plural(n, 'receipt', 'receipts')}`,
} as const;

/** "Checklist: N failed checks" and friends, for a state; null means no chip. */
export function receiptChecklistChipText(state: ReceiptChecklistState): string | null {
  switch (state.kind) {
    case 'completed':
      return state.summary.failedChecks === 0
        ? RECEIVING_CHECKLIST_COPY.chipNoFailed
        : RECEIVING_CHECKLIST_COPY.chipFailed(state.summary.failedChecks);
    case 'in_progress':
      return RECEIVING_CHECKLIST_COPY.chipInProgress;
    case 'not_recorded':
      return RECEIVING_CHECKLIST_COPY.chipNotRecorded;
    case 'unavailable':
      return RECEIVING_CHECKLIST_COPY.chipUnavailable;
    case 'none':
      return null;
  }
}

/** A tone for the chip, so colour is never the only signal (the text carries it). */
export function receiptChecklistChipTone(state: ReceiptChecklistState): 'ok' | 'warn' | 'muted' | null {
  switch (state.kind) {
    case 'completed':
      return state.summary.failedChecks === 0 ? 'ok' : 'warn';
    case 'in_progress':
    case 'not_recorded':
      return 'muted';
    case 'unavailable':
      return 'warn';
    case 'none':
      return null;
  }
}

/** The action label for receiptChecklistAction's answer. */
export function receiptChecklistActionLabel(action: 'record' | 'continue' | 'view'): string {
  return action === 'record'
    ? RECEIVING_CHECKLIST_COPY.recordChecklist
    : action === 'continue'
      ? RECEIVING_CHECKLIST_COPY.continueChecklist
      : RECEIVING_CHECKLIST_COPY.viewChecklist;
}

/** "October 5, 2026 at 3:04 PM" in the organization's time zone. */
export function checklistWhen(iso: string, tz: string): string {
  return formatOrgDateTime(iso, { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }, tz);
}

/**
 * "Recorded N days after the receipt was posted." when the run started more
 * than a day after the receipt; N counts calendar days in the organization's
 * time zone (at least 1). Null otherwise.
 */
export function lateRecordLabel(receiptAt: string, recordedAt: string, tz: string): string | null {
  const a = Date.parse(receiptAt);
  const b = Date.parse(recordedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b - a <= 24 * 60 * 60 * 1000) return null;
  const day = (ms: number) => {
    const s = formatOrgDate(new Date(ms), { year: 'numeric', month: '2-digit', day: '2-digit' }, tz);
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : NaN;
  };
  const da = day(a);
  const db = day(b);
  const days = Number.isNaN(da) || Number.isNaN(db) ? Math.floor((b - a) / 86_400_000) : Math.round((db - da) / 86_400_000);
  return RECEIVING_CHECKLIST_COPY.recordedLate(Math.max(1, days));
}

/** A step's label by key, or the key itself when unknown. */
function labelOf(steps: readonly ChecklistStep[], key: string | undefined): string {
  return steps.find((s) => s.key === key)?.label ?? key ?? '';
}

/** A step's label by 1-based position (publish refusals name the position). */
function stepWord(n: number | undefined): string {
  return n === undefined ? 'A step' : `Step ${n}`;
}

/**
 * The sentence for a checklist_invalid refusal. `steps` labels result keys
 * (save); publish refusals name the step by its position.
 */
export function describeChecklistInvalid(detail: ChecklistInvalidDetail, steps: readonly ChecklistStep[] = []): string {
  const at = labelOf(steps, detail.key);
  switch (detail.reason) {
    case 'not_a_list':
      return 'Add at least one step.';
    case 'step_count':
      return 'A checklist has 1 to 20 steps.';
    case 'not_an_object':
    case 'required_not_boolean':
      return `${stepWord(detail.step)} isn't valid.`;
    case 'unknown_kind':
      return `${stepWord(detail.step)}: choose Pass, Fail or Not applicable, a number, or a short answer.`;
    case 'photo_not_available':
      return `${stepWord(detail.step)}: photo steps aren't available yet.`;
    case 'label_required':
      return `${stepWord(detail.step)} needs a label.`;
    case 'label_too_long':
      return `${stepWord(detail.step)}: the label can be up to 120 characters.`;
    case 'help_not_text':
    case 'help_too_long':
      return `${stepWord(detail.step)}: the help can be up to 300 characters.`;
    case 'title_required':
      return 'Give the checklist a title.';
    case 'title_too_long':
      return 'The title can be up to 80 characters.';
    case 'procedure_not_available':
      return 'That procedure is archived or no longer available. Choose another or none.';
    case 'unknown_binding':
      return 'That kind of checklist is not available.';
    case 'unknown_step':
    case 'answer_not_an_object':
      return 'An answer does not match this checklist. Reload and try again.';
    case 'not_a_check_answer':
      return `${at}: choose Pass, Fail or Not applicable.`;
    case 'not_a_whole_number':
      return `${at}: enter a whole number.`;
    case 'count_out_of_range':
      return `${at}: enter a number from 0 to 1,000,000.`;
    case 'text_not_text':
      return `${at}: the answer isn't valid.`;
    case 'text_too_long':
      return `${at}: the answer can be up to 500 characters.`;
    case 'photo_takes_no_value':
      return `${at}: a photo step takes no typed answer.`;
    case 'note_not_text':
    case 'note_too_long':
      return `${at}: the note can be up to 300 characters.`;
    case 'run_note_too_long':
      return 'Notes on this delivery can be up to 1,000 characters.';
    case 'required':
      return 'This save could not be read as it was. Try again.';
  }
}

/** The sentences for a checklist_incomplete refusal, naming the steps. */
export function describeChecklistIncomplete(
  detail: ChecklistIncompleteDetail,
  steps: readonly ChecklistStep[],
): string {
  const parts: string[] = [];
  const names = (keys: readonly string[]) => keys.map((k) => labelOf(steps, k));
  if (detail.missing.length > 0) parts.push(RECEIVING_CHECKLIST_COPY.incompleteMissing(names(detail.missing)));
  if (detail.failedWithoutNote.length > 0) {
    parts.push(RECEIVING_CHECKLIST_COPY.incompleteFailedNote(names(detail.failedWithoutNote)));
  }
  if (detail.photoStepsWithoutPhoto.length > 0) {
    parts.push(RECEIVING_CHECKLIST_COPY.incompletePhoto(names(detail.photoStepsWithoutPhoto)));
  }
  return parts.join(' ');
}

/** "3 of 4 required steps answered" for a run header. */
export function runProgressLine(summary: ChecklistRunSummary): string {
  if (summary.requiredTotal === 0) {
    return `${count(summary.answered)} of ${count(summary.total)} ${plural(summary.total, 'step', 'steps')} answered`;
  }
  return `${count(summary.requiredAnswered)} of ${count(summary.requiredTotal)} required ${plural(summary.requiredTotal, 'step', 'steps')} answered`;
}

/** Every reader-facing string in this module, filled with sample values, for the wording guard. */
export function receivingChecklistCopySamples(): string[] {
  const c = RECEIVING_CHECKLIST_COPY;
  const out: string[] = [];
  for (const v of Object.values(c)) if (typeof v === 'string') out.push(v);
  out.push(
    c.postedTitle('R-1001'),
    c.chipFailed(1),
    c.chipFailed(3),
    c.runHeading('R-1001', 'PO-2026-0052', 'Acme Supply'),
    c.runHeading('R-1001', 'PO-2026-0052', null),
    c.versionLine(2, 'Delivery checks'),
    c.receivedOnReceipt(48, 3),
    c.receivedOnReceipt(1, 1),
    c.receivedInto('Main warehouse'),
    c.stockOwner(['North Charter', 'South Charter']),
    c.billTo('North Charter'),
    c.stillToCome(2),
    c.stillToCome(1),
    c.instructions('Receiving SOP'),
    c.completedBy('Pat Lee', 'October 5, 2026 at 3:04 PM'),
    c.startedBy('Pat Lee', 'October 5, 2026 at 3:04 PM'),
    c.recordedLate(1),
    c.recordedLate(4),
    c.keepsVersion(3, 2),
    c.incompleteMissing(['Packing slip matches this purchase order']),
    c.incompleteFailedNote(['Boxes arrived undamaged']),
    c.incompletePhoto(['Photo or scan of the packing slip']),
    c.runCompletedBy('Pat Lee'),
    c.publishVersion(2),
    c.publishConfirm(2),
    c.published(2),
    c.liveVersion(2),
    c.removeStep(2),
    c.moveStepUp(2),
    c.moveStepDown(2),
    c.runsOnVersion(1),
    c.runsOnVersion(5),
  );
  return out;
}
