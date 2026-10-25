import type {
  ChecklistResults,
  ChecklistStep,
  ChecklistStepDraft,
  ChecklistStepKind,
} from './receiving-checklist';

/**
 * WHAT A CHECKLIST FORM HOLDS, ON THE WEB AND THE PHONE (F4-1).
 *
 * The web run page and the phone run screen keep each answer as typed text
 * until it is sent, and both editors keep a staged list of steps. These are
 * the ONE copy of the rules that turn one into the other (pattern #26: a
 * second copy in each app would drift), so the web form, the web editor and
 * the phone screens import them from here.
 */

/** One step's answer as a form holds it: a count is text until it is sent. */
export interface ChecklistAnswerDraft {
  value: string;
  note: string;
}

export type ChecklistAnswerDrafts = Record<string, ChecklistAnswerDraft>;

/** The form's starting answers, from what the run holds. */
export function checklistDraftsFrom(
  steps: readonly ChecklistStep[],
  results: ChecklistResults,
): ChecklistAnswerDrafts {
  const out: ChecklistAnswerDrafts = {};
  for (const s of steps) {
    const a = results[s.key];
    out[s.key] = {
      value: a?.value === undefined ? '' : String(a.value),
      note: a?.note ?? '',
    };
  }
  return out;
}

/**
 * The answers to send, from the form. A count that is not a whole number is
 * sent as typed text, so core (and the database) refuse it by name instead of
 * the form guessing a number. A text answer is sent as typed (the server
 * trims it); a step with neither an answer nor a note is left out.
 */
export function checklistResultsFromDrafts(
  steps: readonly ChecklistStep[],
  drafts: ChecklistAnswerDrafts,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of steps) {
    const d = drafts[s.key];
    if (!d) continue;
    const answer: Record<string, unknown> = {};
    const v = d.value.trim();
    if (v !== '') {
      if (s.kind === 'count') answer.value = /^\d+$/.test(v) ? Number(v) : v;
      else answer.value = s.kind === 'text' ? d.value : v;
    }
    if (d.note.trim() !== '') answer.note = d.note;
    if (Object.keys(answer).length > 0) out[s.key] = answer;
  }
  return out;
}

/** Whether two sets of drafts hold the same answers (the leave guard's "unsaved"). */
export function checklistDraftsEqual(a: ChecklistAnswerDrafts, b: ChecklistAnswerDrafts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] ?? { value: '', note: '' };
    const y = b[k] ?? { value: '', note: '' };
    if (x.value !== y.value || x.note !== y.note) return false;
  }
  return true;
}

/** A step as an editor holds it; `uid` keys the row only, the server assigns step keys. */
export interface ChecklistEditorStep {
  uid: string;
  kind: ChecklistStepKind;
  label: string;
  help: string;
  required: boolean;
}

let uidSeq = 0;

/** Editor rows from step drafts (the live version's steps, or the suggested ones). */
export function checklistEditorStepsFrom(
  drafts: ReadonlyArray<ChecklistStepDraft>,
): ChecklistEditorStep[] {
  return drafts.map((d) => ({
    uid: `step-${(uidSeq += 1)}`,
    kind: d.kind,
    label: d.label,
    help: d.help ?? '',
    required: d.required === true,
  }));
}

/** What publish sends: the steps without the editor's row keys, a blank help as null. */
export function checklistPublishPayload(
  steps: readonly ChecklistEditorStep[],
): Array<{ kind: ChecklistStepKind; label: string; help: string | null; required: boolean }> {
  return steps.map((s) => ({
    kind: s.kind,
    label: s.label,
    help: s.help.trim() === '' ? null : s.help,
    required: s.required,
  }));
}

/** Move one step up (-1) or down (+1); out of range leaves the list as it is. */
export function moveChecklistStep<T>(steps: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return [...steps];
  const next = [...steps];
  const [s] = next.splice(index, 1);
  next.splice(to, 0, s as T);
  return next;
}
