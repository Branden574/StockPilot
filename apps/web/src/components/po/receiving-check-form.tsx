'use client';

import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useUnsavedWork } from '@/lib/unsaved-work';
import { saveReceivingCheckAction } from '@/server/actions/receiving-checklist';

import {
  CHECKLIST_LIMITS,
  checklistWhen,
  describeChecklistIncomplete,
  describeChecklistInvalid,
  isRunCompletable,
  lateRecordLabel,
  normalizeChecklistResults,
  normalizeRunNote,
  RECEIVING_CHECKLIST_COPY,
  validateRunForCompletion,
  type ChecklistResults,
  type ChecklistStep,
} from '@stockpilot/core';

import type { ReceivingRunView } from '@/server/services/receiving-checklist';

const C = RECEIVING_CHECKLIST_COPY;

/** One step's answer as the form holds it (a count is text until sent). */
interface Draft {
  value: string;
  note: string;
}

type Drafts = Record<string, Draft>;

function draftsFrom(steps: readonly ChecklistStep[], results: ChecklistResults): Drafts {
  const out: Drafts = {};
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
 * the form guessing a number.
 */
export function resultsFromDrafts(
  steps: readonly ChecklistStep[],
  drafts: Drafts,
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

type FormError =
  | { kind: 'changed'; message: string }
  | { kind: 'completed'; message: string }
  | { kind: 'incomplete'; message: string; missing: string[]; failedWithoutNote: string[] }
  | { kind: 'invalid'; message: string; key: string | null }
  | { kind: 'other'; message: string };

/**
 * A receiving checklist run (F4-1): "About this delivery", the steps, notes,
 * Save progress and Complete checklist. The answers stay on screen through
 * any refusal (a newer save by someone else is reloaded only when asked), and
 * a completed run, or one this person may not record, is read only.
 */
export function ReceivingCheckForm({ view }: { view: ReceivingRunView }) {
  const router = useRouter();
  const steps = view.version.steps;
  const tz = view.timeZone;
  const readOnly = view.run.status === 'completed' || !view.canRecord;

  const initial = React.useMemo(
    () => draftsFrom(steps, view.run.results),
    [steps, view.run.results],
  );
  const [drafts, setDrafts] = React.useState<Drafts>(initial);
  const [note, setNote] = React.useState(view.run.note ?? '');
  const [saved, setSaved] = React.useState({ drafts: initial, note: view.run.note ?? '' });
  const [busy, setBusy] = React.useState<'save' | 'complete' | null>(null);
  const [error, setError] = React.useState<FormError | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const pending = React.useRef<{ payload: string; saveId: string } | null>(null);

  const dirty = JSON.stringify(drafts) !== JSON.stringify(saved.drafts) || note !== saved.note;
  useUnsavedWork(
    'receiving-check',
    `Receiving checklist ${view.receipt.receiptNumber}`,
    () => busy !== null || dirty,
  );

  const setDraft = (key: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [key]: { ...(d[key] ?? { value: '', note: '' }), ...patch } }));

  async function send(complete: boolean) {
    if (busy) return;
    setError(null);
    const results = resultsFromDrafts(steps, drafts);
    // Said before anything is sent, in the same words the server would use.
    const local = normalizeChecklistResults(steps, results);
    if (!local.ok) {
      setError({
        kind: 'invalid',
        message: describeChecklistInvalid(local.detail, steps),
        key: local.detail.key ?? null,
      });
      return;
    }
    const runNote = normalizeRunNote(note);
    if (!runNote.ok) {
      setError({
        kind: 'invalid',
        message: describeChecklistInvalid(runNote.detail, steps),
        key: null,
      });
      return;
    }
    if (complete) {
      const incomplete = validateRunForCompletion(steps, local.value);
      if (!isRunCompletable(incomplete)) {
        setError({
          kind: 'incomplete',
          message: describeChecklistIncomplete(incomplete, steps),
          missing: incomplete.missing,
          failedWithoutNote: incomplete.failedWithoutNote,
        });
        return;
      }
    }
    // One save id per payload: resending the same answers after a lost reply
    // is answered as a replay; changed answers are a new save.
    const payload = JSON.stringify({ results, note, complete, revision: view.run.revision });
    if (!pending.current || pending.current.payload !== payload) {
      pending.current = { payload, saveId: crypto.randomUUID() };
    }
    setBusy(complete ? 'complete' : 'save');
    let res: Awaited<ReturnType<typeof saveReceivingCheckAction>>;
    try {
      res = await saveReceivingCheckAction(view.run.id, {
        results,
        note: note.trim() === '' ? null : note,
        expectedRevision: view.run.revision,
        saveId: pending.current.saveId,
        complete,
      });
    } catch {
      // The reply was lost, so the save may have landed. The save id is kept:
      // sending the same answers again is answered as that save, not a second.
      setBusy(null);
      setError({ kind: 'other', message: C.didNotGoThrough });
      return;
    }
    setBusy(null);
    if (!res.ok) {
      const reason = (res.error.details as { reason?: string } | undefined)?.reason;
      if (reason === 'checklist_run_changed') setError({ kind: 'changed', message: C.runChanged });
      else if (reason === 'checklist_run_completed')
        setError({ kind: 'completed', message: res.error.message });
      else if (reason === 'checklist_incomplete') {
        const d = res.error.details as { missing?: string[]; failedWithoutNote?: string[] };
        setError({
          kind: 'incomplete',
          message: res.error.message,
          missing: d.missing ?? [],
          failedWithoutNote: d.failedWithoutNote ?? [],
        });
      } else if (reason === 'checklist_invalid') {
        setError({
          kind: 'invalid',
          message: res.error.message,
          key: (res.error.details as { key?: string }).key ?? null,
        });
      } else setError({ kind: 'other', message: res.error.message });
      return;
    }
    pending.current = null;
    setSaved({ drafts, note });
    toast.success(complete ? C.completed : C.saved);
    router.refresh();
  }

  const missing = new Set(error?.kind === 'incomplete' ? error.missing : []);
  const needsNote = new Set(error?.kind === 'incomplete' ? error.failedWithoutNote : []);
  const badKey = error?.kind === 'invalid' ? error.key : null;
  const anyFail = steps.some((s) => s.kind === 'check' && drafts[s.key]?.value === 'fail');
  const late = lateRecordLabel(view.receipt.receivedAt, view.run.startedAt, tz);

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">{C.honesty}</p>

      <section
        aria-labelledby="about-delivery"
        className="border-border bg-card rounded-xl border p-4 text-sm"
      >
        <h2 id="about-delivery" className="mb-2 font-medium">
          {C.aboutHeading}
        </h2>
        <ul className="space-y-1">
          <li>{C.receivedOnReceipt(view.about.unitsReceived, view.about.lineCount)}</li>
          {view.about.warehouseName && <li>{C.receivedInto(view.about.warehouseName)}</li>}
          <li>
            {view.about.stockOwner.kind === 'unavailable'
              ? C.stockOwnerUnavailable
              : view.about.stockOwner.value.length === 0
                ? C.stockOwnerNone
                : C.stockOwner(view.about.stockOwner.value)}
          </li>
          {view.about.billTo.kind === 'ok' && view.about.billTo.value && (
            <li>{C.billTo(view.about.billTo.value)}</li>
          )}
          <li>
            {view.about.stillToCome.kind === 'unavailable'
              ? C.stillToComeUnavailable
              : view.about.stillToCome.value === 0
                ? C.nothingToCome
                : C.stillToCome(view.about.stillToCome.value)}
          </li>
          {anyFail && <li className="text-amber-700 dark:text-amber-300">{C.reverseHint}</li>}
        </ul>
        {view.lines.length > 0 && (
          <ul className="text-muted-foreground mt-3 space-y-0.5 text-xs">
            {view.lines.map((l, i) => (
              <li key={i}>
                {l.itemName}
                {l.sku ? ` · ${l.sku}` : ''} · {l.qtyReceived.toLocaleString('en-US')}
              </li>
            ))}
          </ul>
        )}
        {view.version.procedure && (
          <p className="mt-3">
            <Link className="underline" href={`/dashboard/procedures/${view.version.procedure.id}`}>
              {C.instructions(view.version.procedure.title)}
            </Link>
          </p>
        )}
      </section>

      <div className="text-muted-foreground space-y-1 text-sm">
        <p>{C.startedBy(view.run.startedByName, checklistWhen(view.run.startedAt, tz))}</p>
        {view.run.status === 'completed' && view.run.completedAt && (
          <p className="text-foreground flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
            {C.completedBy(
              view.run.completedByName ?? '—',
              checklistWhen(view.run.completedAt, tz),
            )}
          </p>
        )}
        {late && <p>{late}</p>}
        {view.receipt.reversedAt && (
          <p>
            {Date.parse(view.run.startedAt) < Date.parse(view.receipt.reversedAt)
              ? C.reversedAfter
              : C.reversedBefore}
          </p>
        )}
        {view.newerVersionNumber !== null && view.run.status !== 'completed' && (
          <p>{C.keepsVersion(view.newerVersionNumber, view.version.versionNumber)}</p>
        )}
        {view.run.status !== 'completed' && !view.canRecord && <p>{C.readOnlyNotRecorder}</p>}
      </div>

      <ol className="space-y-4">
        {steps.map((s, i) => {
          const d = drafts[s.key] ?? { value: '', note: '' };
          const flagged = missing.has(s.key) || needsNote.has(s.key) || badKey === s.key;
          const noteId = `note-${s.key}`;
          return (
            <li
              key={s.key}
              className={`rounded-xl border p-4 ${flagged ? 'border-destructive' : 'border-border'}`}
              data-step={s.key}
            >
              <fieldset disabled={readOnly || busy !== null}>
                <legend className="font-medium">
                  {i + 1}. {s.label}
                  {s.required && (
                    <span className="text-muted-foreground ml-2 text-xs">
                      ({C.requiredToComplete})
                    </span>
                  )}
                </legend>
                {s.help && <p className="text-muted-foreground mt-1 text-xs">{s.help}</p>}
                <div className="mt-3">
                  {s.kind === 'check' && (
                    <div role="radiogroup" aria-label={s.label} className="flex flex-wrap gap-2">
                      {(
                        [
                          ['pass', C.pass],
                          ['fail', C.fail],
                          ['na', C.notApplicable],
                        ] as const
                      ).map(([v, label]) => (
                        <label
                          key={v}
                          className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm ${
                            d.value === v
                              ? 'border-foreground bg-muted font-medium'
                              : 'border-border'
                          }`}
                        >
                          <input
                            type="radio"
                            name={`answer-${s.key}`}
                            value={v}
                            checked={d.value === v}
                            onChange={() => setDraft(s.key, { value: v })}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  )}
                  {s.kind === 'count' && (
                    <Input
                      inputMode="numeric"
                      aria-label={s.label}
                      placeholder={C.countPlaceholder}
                      className="max-w-40"
                      value={d.value}
                      onChange={(e) => setDraft(s.key, { value: e.target.value })}
                    />
                  )}
                  {s.kind === 'text' && (
                    <Textarea
                      aria-label={s.label}
                      placeholder={C.textPlaceholder}
                      rows={2}
                      maxLength={CHECKLIST_LIMITS.text}
                      value={d.value}
                      onChange={(e) => setDraft(s.key, { value: e.target.value })}
                    />
                  )}
                </div>
                <div className="mt-3 space-y-1">
                  <Label htmlFor={noteId} className="text-muted-foreground text-xs">
                    {s.kind === 'check' && d.value === 'fail' ? C.whatWasWrong : C.notes}
                  </Label>
                  <Input
                    id={noteId}
                    maxLength={CHECKLIST_LIMITS.note}
                    value={d.note}
                    onChange={(e) => setDraft(s.key, { note: e.target.value })}
                  />
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>

      <div className="space-y-1">
        <Label htmlFor="run-note">{C.runNote}</Label>
        <Textarea
          id="run-note"
          rows={3}
          maxLength={CHECKLIST_LIMITS.runNote}
          value={note}
          disabled={readOnly || busy !== null}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="border-destructive/40 text-destructive flex items-start gap-2 rounded-md border p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-2">
            <p>{error.message}</p>
            {(error.kind === 'changed' || error.kind === 'completed') && (
              <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
                {C.reload}
              </Button>
            )}
          </div>
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => send(false)}
            disabled={busy !== null}
          >
            {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : C.saveProgress}
          </Button>
          <Button
            type="button"
            variant="gradient"
            onClick={() => setConfirmOpen(true)}
            disabled={busy !== null}
          >
            {busy === 'complete' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              C.completeChecklist
            )}
          </Button>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{C.completeChecklist}</DialogTitle>
            <DialogDescription>{C.completeConfirm}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="gradient"
              onClick={() => {
                setConfirmOpen(false);
                void send(true);
              }}
            >
              {C.completeChecklist}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
