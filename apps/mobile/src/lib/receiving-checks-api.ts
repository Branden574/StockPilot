import {
  isUuid,
  parseStoredResults,
  parseStoredSteps,
  RECEIVING_CHECKLIST_COPY,
  VERIFICATION_SESSION_ENDED_COPY,
  type ChecklistResults,
  type ChecklistRunLite,
  type ChecklistStep,
  type ChecklistStepKind,
  type ChecklistVersionLite,
  type ReceivingGate,
} from '@stockpilot/core';

import { api } from './api';
import { CONNECTION_FAILURE_COPY, REQUEST_TIMED_OUT_COPY } from './connection-copy';

/**
 * THE RECEIVING CHECKLIST ON THE PHONE (F4-1): thin typed wrappers over the
 * Bearer routes the web's ReceivingChecklistService answers, so the phone and
 * the web apply one set of rules:
 *
 *   GET  /api/v1/po/<id>/receiving-checks        versions + this PO's runs (chips)
 *   POST /api/v1/receipts/<id>/receiving-check   start (or reopen) a receipt's run
 *   GET  /api/v1/receiving-checks/<id>           one run for its screen
 *   POST /api/v1/receiving-checks/<id>           save, or complete
 *   GET  /api/v1/receiving-checklist             the editor
 *   POST /api/v1/receiving-checklist            publish the next version
 *   POST /api/v1/receiving-checklist/retire      turn it off
 *
 * Every answer is read strictly: a shape this build does not expect throws
 * ReceivingChecksResponseError and is shown as a failure, never as an empty
 * checklist. Nothing here is cached: the checklist is online only (plan 8,
 * risk 12), and a screen keeps what it already shows when the connection
 * drops.
 */

const C = RECEIVING_CHECKLIST_COPY;

/** Thrown when a route answers in a shape this build cannot read. */
export class ReceivingChecksResponseError extends Error {
  constructor() {
    super('The server sent an unexpected answer.');
    this.name = 'ReceivingChecksResponseError';
  }
}

/** Thrown before any request when an id is not a uuid (a malformed link). */
export class ReceivingChecksRequestError extends Error {
  constructor() {
    super('This link is not valid.');
    this.name = 'ReceivingChecksRequestError';
  }
}

// ── Shapes ─────────────────────────────────────────────────────────────────

/** The org's versions and this PO's runs; ok false = the server's reads failed. */
export type PhonePoChecks =
  { ok: true; versions: ChecklistVersionLite[]; runs: ChecklistRunLite[] } | { ok: false };

export type AboutClaim<T> = { kind: 'ok'; value: T } | { kind: 'unavailable' };

export interface PhoneReceivingRun {
  run: {
    id: string;
    status: 'in_progress' | 'completed';
    results: ChecklistResults;
    note: string | null;
    revision: number;
    startedAt: string;
    startedByName: string;
    completedAt: string | null;
    completedByName: string | null;
  };
  version: {
    id: string;
    versionNumber: number;
    title: string;
    steps: ChecklistStep[];
    procedure: { id: string; title: string } | null;
  };
  newerVersionNumber: number | null;
  receipt: {
    id: string;
    receiptNumber: string;
    status: string;
    receivedAt: string;
    reversedAt: string | null;
  };
  po: { id: string; poNumber: string; supplierName: string | null };
  about: {
    lineCount: number;
    warehouse: AboutClaim<string | null>;
    stockOwner: AboutClaim<string[]>;
    billTo: AboutClaim<string | null>;
    stillToCome: AboutClaim<number>;
  };
  lines: { itemName: string; sku: string; qtyReceived: number; qtyAccepted: number }[];
  canRecord: boolean;
  timeZone: string;
}

export interface PhoneSavedRun {
  id: string;
  status: 'in_progress' | 'completed';
  revision: number;
  results: ChecklistResults;
  note: string | null;
  completedAt: string | null;
}

export interface PhoneChecklistVersion {
  id: string;
  versionNumber: number;
  title: string;
  steps: ChecklistStep[];
  procedureId: string | null;
  procedureTitle: string | null;
  publishedAt: string;
  publishedByName: string;
  retiredAt: string | null;
  retiredByName: string | null;
  runCount: number | null;
}

export interface PhoneChecklistEditor {
  live: PhoneChecklistVersion | null;
  history: PhoneChecklistVersion[];
  nextVersionNumber: number;
  gate: ReceivingGate;
  procedures: { id: string; title: string }[] | null;
  proceduresUnavailable: boolean;
  timeZone: string;
}

export interface StartedRun {
  runId: string;
  created: boolean;
  versionNumber: number | null;
}

// ── Readers (strict) ───────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function obj(v: unknown): Obj {
  if (!isObj(v)) throw new ReceivingChecksResponseError();
  return v;
}
function str(v: unknown): string {
  if (typeof v !== 'string') throw new ReceivingChecksResponseError();
  return v;
}
function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return str(v);
}
function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ReceivingChecksResponseError();
  return v;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return num(v);
}
function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new ReceivingChecksResponseError();
  return v;
}
function list(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ReceivingChecksResponseError();
  return v;
}
function runStatus(v: unknown): 'in_progress' | 'completed' {
  if (v !== 'in_progress' && v !== 'completed') throw new ReceivingChecksResponseError();
  return v;
}
/** A version's steps: an array is required; core keeps only well-formed steps. */
function steps(v: unknown): ChecklistStep[] {
  return parseStoredSteps(list(v));
}
function claim<T>(v: unknown, read: (x: unknown) => T): AboutClaim<T> {
  const o = obj(v);
  if (o.kind === 'unavailable') return { kind: 'unavailable' };
  if (o.kind === 'ok') return { kind: 'ok', value: read(o.value) };
  throw new ReceivingChecksResponseError();
}

function versionLite(v: unknown): ChecklistVersionLite {
  const o = obj(v);
  return {
    id: str(o.id),
    versionNumber: num(o.versionNumber),
    title: str(o.title),
    steps: steps(o.steps),
    publishedAt: str(o.publishedAt),
    retiredAt: strOrNull(o.retiredAt),
  };
}

function runLite(v: unknown): ChecklistRunLite {
  const o = obj(v);
  return {
    id: str(o.id),
    receiptId: strOrNull(o.receiptId),
    versionId: str(o.versionId),
    status: runStatus(o.status),
    results: parseStoredResults(o.results),
    startedAt: str(o.startedAt),
    startedByName: str(o.startedByName),
    completedAt: strOrNull(o.completedAt),
    completedByName: strOrNull(o.completedByName),
  };
}

/** GET /api/v1/po/<id>/receiving-checks: `{ checks }`. */
export function parsePoChecks(res: unknown): PhonePoChecks {
  const checks = obj(obj(res).checks);
  if (checks.ok === false) return { ok: false };
  if (checks.ok !== true) throw new ReceivingChecksResponseError();
  return {
    ok: true,
    versions: list(checks.versions).map(versionLite),
    runs: list(checks.runs).map(runLite),
  };
}

/** GET /api/v1/receiving-checks/<id>: `{ run }`. */
export function parseReceivingRun(res: unknown): PhoneReceivingRun {
  const v = obj(obj(res).run);
  const run = obj(v.run);
  const version = obj(v.version);
  const receipt = obj(v.receipt);
  const po = obj(v.po);
  const about = obj(v.about);
  const procedure = version.procedure === null ? null : obj(version.procedure);
  return {
    run: {
      id: str(run.id),
      status: runStatus(run.status),
      results: parseStoredResults(run.results),
      note: strOrNull(run.note),
      revision: num(run.revision),
      startedAt: str(run.startedAt),
      startedByName: str(run.startedByName),
      completedAt: strOrNull(run.completedAt),
      completedByName: strOrNull(run.completedByName),
    },
    version: {
      id: str(version.id),
      versionNumber: num(version.versionNumber),
      title: str(version.title),
      steps: steps(version.steps),
      procedure: procedure ? { id: str(procedure.id), title: str(procedure.title) } : null,
    },
    newerVersionNumber: numOrNull(v.newerVersionNumber),
    receipt: {
      id: str(receipt.id),
      receiptNumber: str(receipt.receiptNumber),
      status: str(receipt.status),
      receivedAt: str(receipt.receivedAt),
      reversedAt: strOrNull(receipt.reversedAt),
    },
    po: { id: str(po.id), poNumber: str(po.poNumber), supplierName: strOrNull(po.supplierName) },
    about: {
      lineCount: num(about.lineCount),
      warehouse: claim(about.warehouse, strOrNull),
      stockOwner: claim(about.stockOwner, (x) => list(x).map(str)),
      billTo: claim(about.billTo, strOrNull),
      stillToCome: claim(about.stillToCome, num),
    },
    lines: list(v.lines).map((l) => {
      const o = obj(l);
      return {
        itemName: str(o.itemName),
        sku: str(o.sku),
        qtyReceived: num(o.qtyReceived),
        qtyAccepted: num(o.qtyAccepted),
      };
    }),
    canRecord: bool(v.canRecord),
    timeZone: str(v.timeZone),
  };
}

/** POST /api/v1/receiving-checks/<id>: `{ run: { id, status, revision, results, note, completedAt } }`. */
export function parseSavedRun(res: unknown): PhoneSavedRun {
  const r = obj(obj(res).run);
  return {
    id: str(r.id),
    status: runStatus(r.status),
    revision: num(r.revision),
    results: parseStoredResults(r.results),
    note: strOrNull(r.note),
    completedAt: strOrNull(r.completedAt),
  };
}

/** POST /api/v1/receipts/<id>/receiving-check: `{ runId, created, versionNumber }`. */
export function parseStartedRun(res: unknown): StartedRun {
  const o = obj(res);
  const runId = str(o.runId);
  if (!isUuid(runId)) throw new ReceivingChecksResponseError();
  return { runId, created: bool(o.created), versionNumber: numOrNull(o.versionNumber) };
}

function editorVersion(v: unknown): PhoneChecklistVersion {
  const o = obj(v);
  return {
    id: str(o.id),
    versionNumber: num(o.versionNumber),
    title: str(o.title),
    steps: steps(o.steps),
    procedureId: strOrNull(o.procedureId),
    procedureTitle: strOrNull(o.procedureTitle),
    publishedAt: str(o.publishedAt),
    publishedByName: str(o.publishedByName),
    retiredAt: strOrNull(o.retiredAt),
    retiredByName: strOrNull(o.retiredByName),
    runCount: numOrNull(o.runCount),
  };
}

/** GET /api/v1/receiving-checklist: `{ editor }`. */
export function parseChecklistEditor(res: unknown): PhoneChecklistEditor {
  const e = obj(obj(res).editor);
  const g = obj(e.gate);
  return {
    live: e.live === null ? null : editorVersion(e.live),
    history: list(e.history).map(editorVersion),
    nextVersionNumber: num(e.nextVersionNumber),
    gate: {
      canPostReceipt: bool(g.canPostReceipt),
      canRecordChecklist: bool(g.canRecordChecklist),
      canPublishChecklist: bool(g.canPublishChecklist),
      canAddPoFile: bool(g.canAddPoFile),
    },
    procedures:
      e.procedures === null
        ? null
        : list(e.procedures).map((p) => {
            const o = obj(p);
            return { id: str(o.id), title: str(o.title) };
          }),
    proceduresUnavailable: bool(e.proceduresUnavailable),
    timeZone: str(e.timeZone),
  };
}

/** POST /api/v1/receiving-checklist: `{ version }` (only its id and number are used). */
export function parsePublished(res: unknown): { id: string; versionNumber: number } {
  const v = obj(obj(res).version);
  return { id: str(v.id), versionNumber: num(v.versionNumber) };
}

/** POST /api/v1/receiving-checklist/retire: `{ retired: { id, versionNumber } }`. */
export function parseRetired(res: unknown): { id: string; versionNumber: number } {
  const v = obj(obj(res).retired);
  return { id: str(v.id), versionNumber: num(v.versionNumber) };
}

// ── Calls ──────────────────────────────────────────────────────────────────

function idOrThrow(id: string): string {
  if (!isUuid(id)) throw new ReceivingChecksRequestError();
  return id;
}

export async function getPoChecks(poId: string): Promise<PhonePoChecks> {
  return parsePoChecks(await api<unknown>(`/api/v1/po/${idOrThrow(poId)}/receiving-checks`));
}

export async function startReceivingCheck(receiptId: string): Promise<StartedRun> {
  return parseStartedRun(
    await api<unknown>(`/api/v1/receipts/${idOrThrow(receiptId)}/receiving-check`, {
      method: 'POST',
    }),
  );
}

export async function getReceivingRun(runId: string): Promise<PhoneReceivingRun> {
  return parseReceivingRun(await api<unknown>(`/api/v1/receiving-checks/${idOrThrow(runId)}`));
}

export interface SaveRunBody {
  results: Record<string, unknown>;
  note: string | null;
  expectedRevision: number;
  saveId: string;
  complete: boolean;
}

export async function saveReceivingRun(runId: string, body: SaveRunBody): Promise<PhoneSavedRun> {
  return parseSavedRun(
    await api<unknown>(`/api/v1/receiving-checks/${idOrThrow(runId)}`, { method: 'POST', body }),
  );
}

export async function getChecklistEditor(): Promise<PhoneChecklistEditor> {
  return parseChecklistEditor(await api<unknown>('/api/v1/receiving-checklist'));
}

export interface PublishBody {
  title: string;
  steps: { kind: ChecklistStepKind; label: string; help: string | null; required: boolean }[];
  procedureId: string | null;
  expectedCurrentId: string | null;
  clientPublishId: string;
}

export async function publishChecklist(
  body: PublishBody,
): Promise<{ id: string; versionNumber: number }> {
  return parsePublished(
    await api<unknown>('/api/v1/receiving-checklist', { method: 'POST', body }),
  );
}

export async function retireChecklist(
  versionId: string,
): Promise<{ id: string; versionNumber: number }> {
  return parseRetired(
    await api<unknown>('/api/v1/receiving-checklist/retire', {
      method: 'POST',
      body: { versionId: idOrThrow(versionId) },
    }),
  );
}

// ── Refusals in words ──────────────────────────────────────────────────────

/** The route's `details.reason`, when it sent one. */
export function checklistErrorReason(e: unknown): string | null {
  const details = isObj(e) ? e.details : undefined;
  return isObj(details) && typeof details.reason === 'string' ? details.reason : null;
}

/** The step keys an incomplete refusal names, to mark them on screen. */
export function checklistIncompleteKeys(e: unknown): {
  missing: string[];
  failedWithoutNote: string[];
} {
  const details = isObj(e) ? e.details : undefined;
  const keys = (v: unknown) =>
    Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  return isObj(details) && details.reason === 'checklist_incomplete'
    ? { missing: keys(details.missing), failedWithoutNote: keys(details.failedWithoutNote) }
    : { missing: [], failedWithoutNote: [] };
}

/** The step key an invalid answer names, to mark it on screen. */
export function checklistInvalidKey(e: unknown): string | null {
  const details = isObj(e) ? e.details : undefined;
  return isObj(details) && details.reason === 'checklist_invalid' && typeof details.key === 'string'
    ? details.key
    : null;
}

/** The step number (1-based) an invalid publish names, to mark it in the editor. */
export function checklistInvalidStep(e: unknown): number | null {
  const details = isObj(e) ? e.details : undefined;
  return isObj(details) &&
    details.reason === 'checklist_invalid' &&
    typeof details.step === 'number'
    ? details.step
    : null;
}

/** The refusals worded from the reason alone (the server's sentence is the same words). */
const REASON_COPY: Record<string, string> = {
  module_disabled: C.moduleDisabled,
  not_recorder: C.notRecorder,
  not_publisher: C.notPublisher,
  checklist_changed: C.publishChanged,
  no_checklist: C.noChecklist,
  receipt_not_checkable: C.receiptNotCheckable,
  checklist_run_changed: C.runChanged,
  busy: C.busy,
};

/**
 * The sentence for a failed checklist request. No status means no answer at
 * all: the phone's one sentence for it (connection-copy.ts), never the network
 * layer's text; a reason the routes send reads in core's words; a sentence the
 * server wrote that names steps or a person (incomplete, invalid, completed by)
 * is shown as sent; a bare code never is.
 */
export function describeChecklistError(e: unknown, fallback: string): string {
  const status = isObj(e) && typeof e.status === 'number' ? e.status : null;
  if (status === null) {
    if (
      e instanceof ReceivingChecksResponseError ||
      e instanceof ReceivingChecksRequestError ||
      (e instanceof Error && e.message === REQUEST_TIMED_OUT_COPY)
    ) {
      return (e as Error).message;
    }
    return CONNECTION_FAILURE_COPY;
  }
  if (status === 401) return VERIFICATION_SESSION_ENDED_COPY;
  const reason = checklistErrorReason(e);
  if (reason !== null && reason in REASON_COPY) return REASON_COPY[reason] as string;
  const raw = e instanceof Error && e.message ? e.message : null;
  // A lone snake_case token is a code, not a sentence.
  const sentence = raw !== null && !/^[a-z0-9_]+$/.test(raw) ? raw : null;
  if (reason === 'checklist_run_completed') return sentence ?? C.runCompleted;
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return 'The server had a problem. Try again in a moment.';
  return sentence ?? fallback;
}
