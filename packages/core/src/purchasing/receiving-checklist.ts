import { z } from 'zod';

/**
 * RECEIVING CHECKLIST (F4-1): the rules every surface shares.
 *
 * A manager publishes a short, versioned checklist for deliveries; after a
 * receipt posts (or later, from its receipt) a manager records a run of it.
 * The database is authoritative (migration *_receiving_checklist.sql:
 * _checklist_normalize_steps, _checklist_validate_results and the completion
 * rule inside checklist_run_save). This module states the same rules for the
 * web and the phone, so a form can say what is wrong before it sends, and the
 * case table at the bottom is run here AND in the pgTAP suite (each case name
 * is a `-- case: <name>` marker there; a guard test fails when the two drift).
 *
 * Text is trimmed of spaces, tabs and line breaks only (the SQL btrim set), and
 * lengths are counted in characters as Postgres counts them (code points), so
 * both sides agree on every boundary.
 */

export const CHECKLIST_STEP_KINDS = ['check', 'count', 'text', 'photo'] as const;
export type ChecklistStepKind = (typeof CHECKLIST_STEP_KINDS)[number];

/** The kinds a publish accepts before F4-2 (photo steps arrive with photo links). */
export const CHECKLIST_PUBLISHABLE_KINDS: readonly ChecklistStepKind[] = ['check', 'count', 'text'];

export const CHECK_ANSWERS = ['pass', 'fail', 'na'] as const;
export type CheckAnswer = (typeof CHECK_ANSWERS)[number];

/** The one binding in use: a run per receipt. The tables allow others later. */
export const RECEIVING_CHECKLIST_BINDING = 'receiving' as const;

export const CHECKLIST_LIMITS = {
  minSteps: 1,
  maxSteps: 20,
  title: 80,
  label: 120,
  help: 300,
  text: 500,
  note: 300,
  runNote: 1000,
  countMax: 1_000_000,
} as const;

export interface ChecklistStep {
  /** s1..sN, assigned by the server by position. */
  key: string;
  kind: ChecklistStepKind;
  label: string;
  help: string | null;
  required: boolean;
}

/** A step as the editor builds it (no key: the server assigns keys). */
export interface ChecklistStepDraft {
  kind: ChecklistStepKind;
  label: string;
  help?: string | null;
  required?: boolean;
}

export interface ChecklistAnswer {
  value?: CheckAnswer | number | string;
  note?: string;
}

/** Answers by step key. A step with no answer and no note is absent. */
export type ChecklistResults = Record<string, ChecklistAnswer>;

export type ChecklistInvalidField =
  | 'steps'
  | 'title'
  | 'procedure'
  | 'binding'
  | 'results'
  | 'note'
  | 'saveId'
  | 'expectedRevision';

export type ChecklistInvalidReason =
  | 'not_a_list'
  | 'step_count'
  | 'not_an_object'
  | 'unknown_kind'
  | 'photo_not_available'
  | 'label_required'
  | 'label_too_long'
  | 'help_not_text'
  | 'help_too_long'
  | 'required_not_boolean'
  | 'title_required'
  | 'title_too_long'
  | 'procedure_not_available'
  | 'unknown_binding'
  | 'unknown_step'
  | 'answer_not_an_object'
  | 'not_a_check_answer'
  | 'not_a_whole_number'
  | 'count_out_of_range'
  | 'text_not_text'
  | 'text_too_long'
  | 'photo_takes_no_value'
  | 'note_not_text'
  | 'note_too_long'
  | 'run_note_too_long'
  | 'required';

export const CHECKLIST_INVALID_REASONS: readonly ChecklistInvalidReason[] = [
  'not_a_list',
  'step_count',
  'not_an_object',
  'unknown_kind',
  'photo_not_available',
  'label_required',
  'label_too_long',
  'help_not_text',
  'help_too_long',
  'required_not_boolean',
  'title_required',
  'title_too_long',
  'procedure_not_available',
  'unknown_binding',
  'unknown_step',
  'answer_not_an_object',
  'not_a_check_answer',
  'not_a_whole_number',
  'count_out_of_range',
  'text_not_text',
  'text_too_long',
  'photo_takes_no_value',
  'note_not_text',
  'note_too_long',
  'run_note_too_long',
  'required',
];

/** checklist_invalid's detail: the field, the step (1-based) or answer key, the reason. */
export interface ChecklistInvalidDetail {
  field: ChecklistInvalidField;
  reason: ChecklistInvalidReason;
  step?: number;
  key?: string;
}

/** checklist_incomplete's detail: step keys, in step order. */
export interface ChecklistIncompleteDetail {
  missing: string[];
  failedWithoutNote: string[];
  photoStepsWithoutPhoto: string[];
}

export type ChecklistCheck<T> = { ok: true; value: T } | { ok: false; detail: ChecklistInvalidDetail };

const WS = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

/** Trim as the SQL does: spaces, tabs, line feeds, carriage returns, form feeds, vertical tabs. */
export function trimChecklistText(s: string): string {
  return s.replace(WS, '');
}

/** Characters as Postgres's char_length counts them (code points, not UTF-16 units). */
export function checklistTextLength(s: string): number {
  return Array.from(s).length;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const invalid = (detail: ChecklistInvalidDetail): { ok: false; detail: ChecklistInvalidDetail } => ({
  ok: false,
  detail,
});

/**
 * Steps as the server stores them (_checklist_normalize_steps): keys s1..sN by
 * position, only kind, label, help and required, text trimmed. Client keys and
 * unknown fields are dropped.
 */
export function normalizeChecklistSteps(
  input: unknown,
  opts: { allowPhoto?: boolean } = {},
): ChecklistCheck<ChecklistStep[]> {
  if (!Array.isArray(input)) return invalid({ field: 'steps', reason: 'not_a_list' });
  if (input.length < CHECKLIST_LIMITS.minSteps || input.length > CHECKLIST_LIMITS.maxSteps) {
    return invalid({ field: 'steps', reason: 'step_count' });
  }
  const out: ChecklistStep[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const step = i + 1;
    const raw = input[i];
    if (!isPlainObject(raw)) return invalid({ field: 'steps', step, reason: 'not_an_object' });
    const kind = raw.kind;
    if (typeof kind !== 'string' || !(CHECKLIST_STEP_KINDS as readonly string[]).includes(kind)) {
      return invalid({ field: 'steps', step, reason: 'unknown_kind' });
    }
    if (kind === 'photo' && !opts.allowPhoto) {
      return invalid({ field: 'steps', step, reason: 'photo_not_available' });
    }
    if (typeof raw.label !== 'string') return invalid({ field: 'steps', step, reason: 'label_required' });
    const label = trimChecklistText(raw.label);
    if (checklistTextLength(label) === 0) return invalid({ field: 'steps', step, reason: 'label_required' });
    if (checklistTextLength(label) > CHECKLIST_LIMITS.label) {
      return invalid({ field: 'steps', step, reason: 'label_too_long' });
    }
    let help: string | null = null;
    if (typeof raw.help === 'string') {
      const h = trimChecklistText(raw.help);
      help = h.length > 0 ? h : null;
      if (help !== null && checklistTextLength(help) > CHECKLIST_LIMITS.help) {
        return invalid({ field: 'steps', step, reason: 'help_too_long' });
      }
    } else if (raw.help !== undefined && raw.help !== null) {
      return invalid({ field: 'steps', step, reason: 'help_not_text' });
    }
    let required = false;
    if (typeof raw.required === 'boolean') required = raw.required;
    else if (raw.required !== undefined && raw.required !== null) {
      return invalid({ field: 'steps', step, reason: 'required_not_boolean' });
    }
    out.push({ key: `s${step}`, kind: kind as ChecklistStepKind, label, help, required });
  }
  return { ok: true, value: out };
}

/** The title as checklist_publish stores it: trimmed, 1 to 80 characters. */
export function normalizeChecklistTitle(input: unknown): ChecklistCheck<string> {
  const title = trimChecklistText(typeof input === 'string' ? input : '');
  if (checklistTextLength(title) === 0) return invalid({ field: 'title', reason: 'title_required' });
  if (checklistTextLength(title) > CHECKLIST_LIMITS.title) return invalid({ field: 'title', reason: 'title_too_long' });
  return { ok: true, value: title };
}

/**
 * Answers as the server stores them (_checklist_validate_results): every key a
 * step of the version, each value of its step's kind, notes up to 300
 * characters, text trimmed, a blank answer or note left out, and a step with
 * neither left out. Keys are checked in key order, as the SQL iterates them.
 */
export function normalizeChecklistResults(
  steps: readonly ChecklistStep[],
  input: unknown,
): ChecklistCheck<ChecklistResults> {
  if (!isPlainObject(input)) return invalid({ field: 'results', reason: 'not_an_object' });
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const out: ChecklistResults = {};
  for (const key of Object.keys(input).sort(byteOrder)) {
    const step = byKey.get(key);
    if (!step) return invalid({ field: 'results', key, reason: 'unknown_step' });
    const answer = input[key];
    if (!isPlainObject(answer)) return invalid({ field: 'results', key, reason: 'answer_not_an_object' });
    const clean: ChecklistAnswer = {};
    const value = answer.value;
    if (value !== undefined && value !== null) {
      if (step.kind === 'check') {
        if (typeof value !== 'string' || !(CHECK_ANSWERS as readonly string[]).includes(value)) {
          return invalid({ field: 'results', key, reason: 'not_a_check_answer' });
        }
        clean.value = value as CheckAnswer;
      } else if (step.kind === 'count') {
        if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
          return invalid({ field: 'results', key, reason: 'not_a_whole_number' });
        }
        if (value < 0 || value > CHECKLIST_LIMITS.countMax) {
          return invalid({ field: 'results', key, reason: 'count_out_of_range' });
        }
        clean.value = value;
      } else if (step.kind === 'text') {
        if (typeof value !== 'string') return invalid({ field: 'results', key, reason: 'text_not_text' });
        const text = trimChecklistText(value);
        if (checklistTextLength(text) > CHECKLIST_LIMITS.text) {
          return invalid({ field: 'results', key, reason: 'text_too_long' });
        }
        if (text.length > 0) clean.value = text;
      } else {
        return invalid({ field: 'results', key, reason: 'photo_takes_no_value' });
      }
    }
    const note = answer.note;
    if (typeof note === 'string') {
      const n = trimChecklistText(note);
      if (checklistTextLength(n) > CHECKLIST_LIMITS.note) {
        return invalid({ field: 'results', key, reason: 'note_too_long' });
      }
      if (n.length > 0) clean.note = n;
    } else if (note !== undefined && note !== null) {
      return invalid({ field: 'results', key, reason: 'note_not_text' });
    }
    if (clean.value !== undefined || clean.note !== undefined) out[key] = clean;
  }
  return { ok: true, value: out };
}

/** The run note as checklist_run_save stores it: trimmed, blank is none, up to 1,000. */
export function normalizeRunNote(input: string | null | undefined): ChecklistCheck<string | null> {
  const note = trimChecklistText(input ?? '');
  if (checklistTextLength(note) > CHECKLIST_LIMITS.runNote) {
    return invalid({ field: 'note', reason: 'run_note_too_long' });
  }
  return { ok: true, value: note.length > 0 ? note : null };
}

/** Postgres's text order for ASCII keys (jsonb_each ... order by key, "C"-like for s1..s20). */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What stops a run from completing (the rule inside checklist_run_save): a
 * required step (not a photo step) with no value; a check answered Fail with
 * no note; a required photo step with no linked photo (none can be linked
 * before F4-2). "Not applicable" is an answer. Keys in step order.
 */
export function validateRunForCompletion(
  steps: readonly ChecklistStep[],
  results: ChecklistResults,
  linkedPhotosByStep: Readonly<Record<string, number>> = {},
): ChecklistIncompleteDetail {
  const missing: string[] = [];
  const failedWithoutNote: string[] = [];
  const photoStepsWithoutPhoto: string[] = [];
  for (const s of steps) {
    const a = results[s.key];
    if (s.kind === 'photo') {
      if (s.required && (linkedPhotosByStep[s.key] ?? 0) === 0) photoStepsWithoutPhoto.push(s.key);
      continue;
    }
    if (s.required && (a === undefined || a.value === undefined)) missing.push(s.key);
    if (s.kind === 'check' && a?.value === 'fail' && a.note === undefined) failedWithoutNote.push(s.key);
  }
  return { missing, failedWithoutNote, photoStepsWithoutPhoto };
}

export function isRunCompletable(d: ChecklistIncompleteDetail): boolean {
  return d.missing.length === 0 && d.failedWithoutNote.length === 0 && d.photoStepsWithoutPhoto.length === 0;
}

export interface ChecklistRunSummary {
  total: number;
  answered: number;
  requiredTotal: number;
  requiredAnswered: number;
  failedChecks: number;
  linkedPhotos: number;
}

/** Counts for a chip or a header: failed checks, required steps answered, photos. */
export function summarizeRun(
  steps: readonly ChecklistStep[],
  results: ChecklistResults,
  linkedPhotos = 0,
): ChecklistRunSummary {
  let answered = 0;
  let requiredTotal = 0;
  let requiredAnswered = 0;
  let failedChecks = 0;
  for (const s of steps) {
    const a = results[s.key];
    const has = a !== undefined && a.value !== undefined;
    if (has) answered += 1;
    if (s.required && s.kind !== 'photo') {
      requiredTotal += 1;
      if (has) requiredAnswered += 1;
    }
    if (s.kind === 'check' && a?.value === 'fail') failedChecks += 1;
  }
  return { total: steps.length, answered, requiredTotal, requiredAnswered, failedChecks, linkedPhotos };
}

// ── Displayed state, per receipt ───────────────────────────────────────────

/** A version as the PO page and the phone read it. */
export interface ChecklistVersionLite {
  id: string;
  versionNumber: number;
  title: string;
  steps: ChecklistStep[];
  publishedAt: string;
  retiredAt: string | null;
}

/** A run as the PO page and the phone read it (names already labelled). */
export interface ChecklistRunLite {
  id: string;
  receiptId: string | null;
  versionId: string;
  status: 'in_progress' | 'completed';
  results: ChecklistResults;
  startedAt: string;
  startedByName: string;
  completedAt: string | null;
  completedByName: string | null;
}

export type ReceiptChecklistState =
  | {
      kind: 'completed';
      runId: string;
      summary: ChecklistRunSummary;
      completedAt: string | null;
      completedByName: string | null;
    }
  | {
      kind: 'in_progress';
      runId: string;
      summary: ChecklistRunSummary;
      startedAt: string;
      startedByName: string;
    }
  | { kind: 'not_recorded' }
  | { kind: 'none' }
  | { kind: 'unavailable' };

/** The live version (never more than one; the database keeps it so). */
export function liveChecklistVersion<T extends { retiredAt: string | null }>(versions: readonly T[]): T | null {
  return versions.find((v) => v.retiredAt === null) ?? null;
}

/** A version was live at that instant: published at or before it, retired after it. */
export function versionLiveAt(v: { publishedAt: string; retiredAt: string | null }, at: string): boolean {
  const t = Date.parse(at);
  const from = Date.parse(v.publishedAt);
  if (Number.isNaN(t) || Number.isNaN(from) || from > t) return false;
  if (v.retiredAt === null) return true;
  const to = Date.parse(v.retiredAt);
  return Number.isNaN(to) ? false : t < to;
}

/**
 * One receipt's checklist state.
 *   - completed / in_progress: it has a run (summaries from summarizeRun);
 *   - not_recorded: no run, the receipt is posted or reversed, and a version
 *     was live when it was received;
 *   - none: no run otherwise (receipts from before any checklist, reversal
 *     rows): no chip, older receipts are never nagged;
 *   - unavailable: the versions or the runs did not load. Never shown as
 *     "not recorded".
 */
export function receiptChecklistState(input: {
  receipt: { id: string; status: string; receivedAt: string };
  versions: readonly ChecklistVersionLite[] | null;
  runs: readonly ChecklistRunLite[] | null;
}): ReceiptChecklistState {
  const { receipt, versions, runs } = input;
  if (versions === null || runs === null) return { kind: 'unavailable' };
  const run = runs.find((r) => r.receiptId === receipt.id) ?? null;
  if (run) {
    const version = versions.find((v) => v.id === run.versionId);
    if (!version) return { kind: 'unavailable' };
    const summary = summarizeRun(version.steps, run.results);
    if (run.status === 'completed') {
      return {
        kind: 'completed',
        runId: run.id,
        summary,
        completedAt: run.completedAt,
        completedByName: run.completedByName,
      };
    }
    return {
      kind: 'in_progress',
      runId: run.id,
      summary,
      startedAt: run.startedAt,
      startedByName: run.startedByName,
    };
  }
  if (receipt.status !== 'posted' && receipt.status !== 'reversed') return { kind: 'none' };
  return versions.some((v) => versionLiveAt(v, receipt.receivedAt)) ? { kind: 'not_recorded' } : { kind: 'none' };
}

export type ReceiptChecklistAction = 'record' | 'continue' | 'view';

/**
 * What a receipt card offers. "Record checklist" only when a version is live
 * now, the person may record (receivingGate().canRecordChecklist) and the
 * receipt is posted or reversed; "Continue" for an open run they may record;
 * "View" for any run. Nothing when the state did not load.
 */
export function receiptChecklistAction(input: {
  state: ReceiptChecklistState;
  receiptStatus: string;
  liveNow: boolean;
  canRecord: boolean;
}): ReceiptChecklistAction | null {
  const { state } = input;
  if (state.kind === 'unavailable') return null;
  if (state.kind === 'completed') return 'view';
  if (state.kind === 'in_progress') return input.canRecord ? 'continue' : 'view';
  const checkable = input.receiptStatus === 'posted' || input.receiptStatus === 'reversed';
  return input.liveNow && input.canRecord && checkable ? 'record' : null;
}

// ── Suggested steps (offered by "Start from suggested steps", never seeded) ─

/** From L4L's real reversal reasons (wrong items, wrong charter, miscounts). */
export const SUGGESTED_RECEIVING_STEPS: readonly ChecklistStepDraft[] = [
  { kind: 'check', label: 'Packing slip matches this purchase order', required: true },
  { kind: 'check', label: 'Items and quantities match the packing slip', required: true },
  { kind: 'check', label: 'Stock owner (charter) on these items is right for this delivery', required: false },
  { kind: 'check', label: 'Boxes arrived undamaged', required: true },
  { kind: 'count', label: 'Number of boxes received', required: false },
  { kind: 'text', label: 'Anything missing, extra or damaged?', required: false },
];

/** The suggested photo step; offered once photo steps exist (F4-2). */
export const SUGGESTED_RECEIVING_PHOTO_STEP: ChecklistStepDraft = {
  kind: 'photo',
  label: 'Photo or scan of the packing slip',
  required: false,
};

// ── Request bodies (web actions, API routes and the phone send these) ──────
// Loose on purpose: the database refuses precisely (with the step and the
// reason) and the app maps its answer. These bound the size of what is sent.

const uuid = z.string().uuid();

export const checklistStepsInputSchema = z
  .array(
    z
      .object({
        kind: z.string().max(40),
        label: z.string().max(2000),
        help: z.string().max(4000).nullish(),
        required: z.boolean().optional(),
      })
      .passthrough(),
  )
  .max(100);

export const checklistResultsSchema = z.record(
  z.string().max(40),
  z
    .object({
      value: z.union([z.string().max(4000), z.number(), z.null()]).optional(),
      note: z.union([z.string().max(4000), z.null()]).optional(),
    })
    .passthrough(),
);

export const checklistPublishBodySchema = z.object({
  title: z.string().max(1000),
  steps: checklistStepsInputSchema,
  procedureId: uuid.nullish(),
  expectedCurrentId: uuid.nullable(),
  clientPublishId: uuid,
});
export type ChecklistPublishBody = z.infer<typeof checklistPublishBodySchema>;

export const checklistRetireBodySchema = z.object({ versionId: uuid });
export type ChecklistRetireBody = z.infer<typeof checklistRetireBodySchema>;

export const checklistSaveBodySchema = z.object({
  results: checklistResultsSchema,
  note: z.string().max(8000).nullish(),
  expectedRevision: z.number().int().min(0),
  saveId: uuid,
  complete: z.boolean(),
});
export type ChecklistSaveBody = z.infer<typeof checklistSaveBodySchema>;

/**
 * The stored step list, read back from the database (jsonb). Anything that is
 * not a well-formed stored step is dropped, so a reader never trusts a shape it
 * did not check.
 */
export function parseStoredSteps(raw: unknown): ChecklistStep[] {
  if (!Array.isArray(raw)) return [];
  const out: ChecklistStep[] = [];
  for (const s of raw) {
    if (!isPlainObject(s)) continue;
    const { key, kind, label, help, required } = s;
    if (typeof key !== 'string' || typeof label !== 'string') continue;
    if (typeof kind !== 'string' || !(CHECKLIST_STEP_KINDS as readonly string[]).includes(kind)) continue;
    out.push({
      key,
      kind: kind as ChecklistStepKind,
      label,
      help: typeof help === 'string' ? help : null,
      required: required === true,
    });
  }
  return out;
}

/** The stored results, read back from the database (jsonb), kept to known shapes. */
export function parseStoredResults(raw: unknown): ChecklistResults {
  if (!isPlainObject(raw)) return {};
  const out: ChecklistResults = {};
  for (const [key, a] of Object.entries(raw)) {
    if (!isPlainObject(a)) continue;
    const clean: ChecklistAnswer = {};
    if (typeof a.value === 'string' || typeof a.value === 'number') clean.value = a.value as ChecklistAnswer['value'];
    if (typeof a.note === 'string') clean.note = a.note;
    if (clean.value !== undefined || clean.note !== undefined) out[key] = clean;
  }
  return out;
}

/**
 * checklist_invalid's detail from the database, read defensively: only the
 * known fields and reasons survive (the app never echoes database text).
 */
export function parseChecklistInvalidDetail(raw: unknown): ChecklistInvalidDetail | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(v)) return null;
  const fields: readonly string[] = ['steps', 'title', 'procedure', 'binding', 'results', 'note', 'saveId', 'expectedRevision'];
  if (typeof v.field !== 'string' || !fields.includes(v.field)) return null;
  if (typeof v.reason !== 'string' || !(CHECKLIST_INVALID_REASONS as readonly string[]).includes(v.reason)) return null;
  const out: ChecklistInvalidDetail = {
    field: v.field as ChecklistInvalidField,
    reason: v.reason as ChecklistInvalidReason,
  };
  if (typeof v.step === 'number' && Number.isInteger(v.step) && v.step >= 1 && v.step <= 100) out.step = v.step;
  if (typeof v.key === 'string' && /^s\d{1,3}$/.test(v.key)) out.key = v.key;
  return out;
}

/**
 * checklist_incomplete's detail from the database, kept to the keys of the
 * run's own steps (built from our own keys, never from database text).
 */
export function parseChecklistIncompleteDetail(
  raw: unknown,
  steps: readonly ChecklistStep[],
): ChecklistIncompleteDetail {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
  }
  const known = new Set(steps.map((s) => s.key));
  const pick = (x: unknown): string[] =>
    Array.isArray(x) ? steps.map((s) => s.key).filter((k) => x.includes(k) && known.has(k)) : [];
  const o = isPlainObject(v) ? v : {};
  return {
    missing: pick(o.missing),
    failedWithoutNote: pick(o.failedWithoutNote),
    photoStepsWithoutPhoto: pick(o.photoStepsWithoutPhoto),
  };
}

// ── The case table shared with pgTAP ───────────────────────────────────────

/** A fixed version for the result and completion cases: s1 required check,
 *  s2 check, s3 count, s4 text. The pgTAP suite publishes the same four. */
export const CASE_TABLE_STEPS: readonly ChecklistStep[] = [
  { key: 's1', kind: 'check', label: 'Packing slip matches this purchase order', help: null, required: true },
  { key: 's2', kind: 'check', label: 'Boxes arrived undamaged', help: null, required: false },
  { key: 's3', kind: 'count', label: 'Number of boxes received', help: null, required: false },
  { key: 's4', kind: 'text', label: 'Anything missing, extra or damaged?', help: null, required: false },
];

export type ReceivingChecklistCase =
  | {
      name: string;
      target: 'steps';
      input: unknown;
      expect: { ok: true; steps?: ChecklistStep[] } | { ok: false; reason: ChecklistInvalidReason; step?: number };
    }
  | {
      name: string;
      target: 'title';
      input: unknown;
      expect: { ok: true; title: string } | { ok: false; reason: ChecklistInvalidReason };
    }
  | {
      name: string;
      target: 'results';
      input: unknown;
      expect: { ok: true; results: ChecklistResults } | { ok: false; reason: ChecklistInvalidReason; key: string };
    }
  | {
      name: string;
      target: 'complete';
      input: ChecklistResults;
      expect: ChecklistIncompleteDetail;
    };

const okStep = (): Record<string, unknown> => ({ kind: 'check', label: 'Slip matches' });

/**
 * The cases both sides must agree on. Each name is a `-- case: <name>` marker
 * in the pgTAP suite, right above the assertion that runs it against the
 * database (steps and titles through checklist_publish, results and
 * completions through checklist_run_save on CASE_TABLE_STEPS).
 */
export function receivingChecklistCases(): ReceivingChecklistCase[] {
  return [
    { name: 'steps_zero', target: 'steps', input: [], expect: { ok: false, reason: 'step_count' } },
    {
      name: 'steps_twenty_one',
      target: 'steps',
      input: Array.from({ length: 21 }, okStep),
      expect: { ok: false, reason: 'step_count' },
    },
    {
      name: 'steps_photo_kind',
      target: 'steps',
      input: [okStep(), { kind: 'photo', label: 'Slip photo' }],
      expect: { ok: false, reason: 'photo_not_available', step: 2 },
    },
    {
      name: 'steps_unknown_kind',
      target: 'steps',
      input: [{ kind: 'scale', label: 'Weight' }],
      expect: { ok: false, reason: 'unknown_kind', step: 1 },
    },
    {
      name: 'steps_blank_label',
      target: 'steps',
      input: [okStep(), okStep(), { kind: 'check', label: ' \t ' }],
      expect: { ok: false, reason: 'label_required', step: 3 },
    },
    {
      name: 'steps_label_121',
      target: 'steps',
      input: [{ kind: 'check', label: 'L'.repeat(121) }],
      expect: { ok: false, reason: 'label_too_long', step: 1 },
    },
    {
      name: 'steps_help_301',
      target: 'steps',
      input: [{ kind: 'text', label: 'Notes', help: 'H'.repeat(301) }],
      expect: { ok: false, reason: 'help_too_long', step: 1 },
    },
    {
      name: 'steps_required_not_boolean',
      target: 'steps',
      input: [{ kind: 'check', label: 'Slip matches', required: 'yes' }],
      expect: { ok: false, reason: 'required_not_boolean', step: 1 },
    },
    {
      name: 'steps_normalised',
      target: 'steps',
      input: [
        { key: 'zz', kind: 'check', label: '  Slip matches  ', required: true, colour: 'red' },
        { kind: 'count', label: 'Boxes', help: '   ' },
        { kind: 'text', label: 'L'.repeat(120), help: 'H'.repeat(300) },
      ],
      expect: {
        ok: true,
        steps: [
          { key: 's1', kind: 'check', label: 'Slip matches', help: null, required: true },
          { key: 's2', kind: 'count', label: 'Boxes', help: null, required: false },
          { key: 's3', kind: 'text', label: 'L'.repeat(120), help: 'H'.repeat(300), required: false },
        ],
      },
    },
    { name: 'title_blank', target: 'title', input: '   ', expect: { ok: false, reason: 'title_required' } },
    { name: 'title_81', target: 'title', input: 'T'.repeat(81), expect: { ok: false, reason: 'title_too_long' } },
    { name: 'title_80_trimmed', target: 'title', input: `  ${'T'.repeat(80)}  `, expect: { ok: true, title: 'T'.repeat(80) } },
    {
      name: 'results_unknown_key',
      target: 'results',
      input: { s9: { value: 'pass' } },
      expect: { ok: false, reason: 'unknown_step', key: 's9' },
    },
    {
      name: 'results_maybe',
      target: 'results',
      input: { s1: { value: 'maybe' } },
      expect: { ok: false, reason: 'not_a_check_answer', key: 's1' },
    },
    {
      name: 'results_fraction',
      target: 'results',
      input: { s3: { value: 1.5 } },
      expect: { ok: false, reason: 'not_a_whole_number', key: 's3' },
    },
    {
      name: 'results_negative',
      target: 'results',
      input: { s3: { value: -1 } },
      expect: { ok: false, reason: 'count_out_of_range', key: 's3' },
    },
    {
      name: 'results_over_a_million',
      target: 'results',
      input: { s3: { value: 1_000_001 } },
      expect: { ok: false, reason: 'count_out_of_range', key: 's3' },
    },
    {
      name: 'results_count_as_text',
      target: 'results',
      input: { s3: { value: '12' } },
      expect: { ok: false, reason: 'not_a_whole_number', key: 's3' },
    },
    {
      name: 'results_text_501',
      target: 'results',
      input: { s4: { value: 'x'.repeat(501) } },
      expect: { ok: false, reason: 'text_too_long', key: 's4' },
    },
    {
      name: 'results_note_301',
      target: 'results',
      input: { s2: { value: 'pass', note: 'n'.repeat(301) } },
      expect: { ok: false, reason: 'note_too_long', key: 's2' },
    },
    {
      name: 'results_partial_ok',
      target: 'results',
      input: { s1: { value: 'pass' }, s3: { value: 12 }, s4: { value: '  one box short  ' } },
      expect: { ok: true, results: { s1: { value: 'pass' }, s3: { value: 12 }, s4: { value: 'one box short' } } },
    },
    {
      name: 'results_blank_left_out',
      target: 'results',
      input: { s2: { value: null, note: '   ' }, s4: { value: '  ' } },
      expect: { ok: true, results: {} },
    },
    {
      name: 'results_limits_ok',
      target: 'results',
      input: { s2: { value: 'na', note: 'n'.repeat(300) }, s3: { value: 1_000_000 }, s4: { value: 'x'.repeat(500) } },
      expect: {
        ok: true,
        results: { s2: { value: 'na', note: 'n'.repeat(300) }, s3: { value: 1_000_000 }, s4: { value: 'x'.repeat(500) } },
      },
    },
    {
      name: 'complete_missing_required',
      target: 'complete',
      input: { s2: { value: 'pass' } },
      expect: { missing: ['s1'], failedWithoutNote: [], photoStepsWithoutPhoto: [] },
    },
    {
      name: 'complete_fail_without_note',
      target: 'complete',
      input: { s1: { value: 'pass' }, s2: { value: 'fail' } },
      expect: { missing: [], failedWithoutNote: ['s2'], photoStepsWithoutPhoto: [] },
    },
    {
      name: 'complete_both_lists',
      target: 'complete',
      input: { s2: { value: 'fail' } },
      expect: { missing: ['s1'], failedWithoutNote: ['s2'], photoStepsWithoutPhoto: [] },
    },
    {
      name: 'complete_not_applicable_counts',
      target: 'complete',
      input: { s1: { value: 'na' } },
      expect: { missing: [], failedWithoutNote: [], photoStepsWithoutPhoto: [] },
    },
    {
      name: 'complete_fail_with_note',
      target: 'complete',
      input: { s1: { value: 'fail', note: 'Two boxes crushed' } },
      expect: { missing: [], failedWithoutNote: [], photoStepsWithoutPhoto: [] },
    },
  ];
}
