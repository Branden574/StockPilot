'use client';

import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection } from '@/components/patterns/detail-section';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { useUnsavedWork } from '@/lib/unsaved-work';
import { saveReceivingCheckAction } from '@/server/actions/receiving-checklist';

import {
  CHECKLIST_LIMITS,
  checklistDraftsEqual,
  checklistDraftsFrom,
  checklistResultsFromDrafts,
  describeChecklistIncomplete,
  describeChecklistInvalid,
  isRunCompletable,
  normalizeChecklistResults,
  normalizeRunNote,
  RECEIVING_CHECKLIST_COPY,
  receivingRunAboutLines,
  receivingRunStatusLines,
  validateRunForCompletion,
  type ChecklistAnswerDraft,
  type ChecklistAnswerDrafts,
} from '@stockpilot/core';

import type { ReceivingRunView } from '@/server/services/receiving-checklist';

const C = RECEIVING_CHECKLIST_COPY;

type Draft = ChecklistAnswerDraft;
type Drafts = ChecklistAnswerDrafts;
/** A run as the server holds it: the page's view, or a save's answer. */
type SavedRunState = Pick<ReceivingRunView['run'], 'results' | 'note' | 'revision' | 'status'>;

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

  const [drafts, setDrafts] = React.useState<Drafts>(() =>
    checklistDraftsFrom(steps, view.run.results),
  );
  const [note, setNote] = React.useState(view.run.note ?? '');
  const [saved, setSaved] = React.useState(() => ({
    drafts: checklistDraftsFrom(steps, view.run.results),
    note: view.run.note ?? '',
  }));
  /**
   * The saved revision these answers are based on (desk check F3): what a save
   * names as expected, so a newer save by someone else is refused, never
   * overwritten. It moves only with this form's own save or with what it
   * adopts (a newer save while nothing is typed, or Reload).
   */
  const [base, setBase] = React.useState({ revision: view.run.revision, status: view.run.status });
  /** The newest revision the page has brought; a newer one is handled once. */
  const [seenRevision, setSeenRevision] = React.useState(view.run.revision);
  const [busy, setBusy] = React.useState<'save' | 'complete' | null>(null);
  const [error, setError] = React.useState<FormError | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const pending = React.useRef<{ payload: string; saveId: string } | null>(null);

  const dirty = !checklistDraftsEqual(drafts, saved.drafts) || note !== saved.note;
  const readOnly =
    view.run.status === 'completed' || base.status === 'completed' || !view.canRecord;
  useUnsavedWork(
    'receiving-check',
    `Receiving checklist ${view.receipt.receiptNumber}`,
    () => busy !== null || dirty,
  );

  /** Show what the server holds for this run, and base the next save on it. */
  function adopt(run: SavedRunState) {
    const fresh = checklistDraftsFrom(steps, run.results);
    setDrafts(fresh);
    setNote(run.note ?? '');
    setSaved({ drafts: fresh, note: run.note ?? '' });
    setBase({ revision: run.revision, status: run.status });
    setError(null);
  }

  // A newer save reached the page (someone else's, or a Reload's). Typed and
  // unsaved answers are never replaced: they stay, with the notice and Reload
  // (desk check F3). With nothing typed, the form shows the new save at once.
  // Not while this form's own save is in flight: its answer settles that.
  if (busy === null && view.run.revision > seenRevision) {
    setSeenRevision(view.run.revision);
    if (dirty) {
      setError(
        view.run.status === 'completed'
          ? {
              kind: 'completed',
              message: view.run.completedByName
                ? C.runCompletedBy(view.run.completedByName)
                : C.runCompleted,
            }
          : { kind: 'changed', message: C.runChanged },
      );
    } else {
      adopt(view.run);
    }
  }

  /** Reload: what the page holds now, then whatever the server holds. */
  function reload() {
    setSeenRevision((r) => Math.max(r, view.run.revision));
    adopt(view.run);
    router.refresh();
  }

  const setDraft = (key: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [key]: { ...(d[key] ?? { value: '', note: '' }), ...patch } }));

  async function send(complete: boolean) {
    if (busy) return;
    setError(null);
    const results = checklistResultsFromDrafts(steps, drafts);
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
    const payload = JSON.stringify({ results, note, complete, revision: base.revision });
    if (!pending.current || pending.current.payload !== payload) {
      pending.current = { payload, saveId: crypto.randomUUID() };
    }
    setBusy(complete ? 'complete' : 'save');
    let res: Awaited<ReturnType<typeof saveReceivingCheckAction>>;
    try {
      res = await saveReceivingCheckAction(view.run.id, {
        results,
        note: note.trim() === '' ? null : note,
        expectedRevision: base.revision,
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
    // What was saved, as the server stored it, is the new base; the page's
    // refresh then brings the same revision, or a newer one from someone else.
    setSeenRevision((r) => Math.max(r, res.data.revision));
    adopt(res.data);
    toast.success(complete ? C.completed : C.saved);
    router.refresh();
  }

  const missing = new Set(error?.kind === 'incomplete' ? error.missing : []);
  const needsNote = new Set(error?.kind === 'incomplete' ? error.failedWithoutNote : []);
  const badKey = error?.kind === 'invalid' ? error.key : null;
  const anyFail = steps.some((s) => s.kind === 'check' && drafts[s.key]?.value === 'fail');
  const aboutLines = receivingRunAboutLines(view.about, anyFail);
  const statusLines = receivingRunStatusLines(
    {
      run: view.run,
      receipt: view.receipt,
      versionNumber: view.version.versionNumber,
      newerVersionNumber: view.newerVersionNumber,
      canRecord: view.canRecord,
    },
    tz,
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-[13.5px] leading-[20.25px]">{C.honesty}</p>

      {/* aria-labelledby makes the section a region named by its heading
          (DetailSection only puts the id on the heading). */}
      <DetailSection
        headingId="about-delivery"
        aria-labelledby="about-delivery"
        title={C.aboutHeading}
        bodyClassName="text-[13.5px] leading-[20.25px]"
      >
        <ul className="space-y-1">
          {aboutLines.map((l, i) => (
            <li key={i} className={l.tone === 'warn' ? 'text-warning' : undefined}>
              {l.text}
            </li>
          ))}
        </ul>
        {view.lines.length > 0 && (
          <ul className="text-muted-foreground mt-3 space-y-0.5 text-[12.5px] leading-[18.75px]">
            {view.lines.map((l, i) => (
              <li key={i}>
                {l.itemName}
                {l.sku ? (
                  <>
                    {' · '}
                    <span className="font-mono text-[11.5px]">{l.sku}</span>
                  </>
                ) : null}{' '}
                · <span className="tabular-nums">{l.qtyReceived.toLocaleString('en-US')}</span>
              </li>
            ))}
          </ul>
        )}
        {view.version.procedure && (
          <p className="mt-3">
            <Link
              className="text-accent hover:text-foreground underline underline-offset-2 transition-colors"
              href={`/dashboard/procedures/${view.version.procedure.id}`}
            >
              {C.instructions(view.version.procedure.title)}
            </Link>
          </p>
        )}
      </DetailSection>

      <div className="text-muted-foreground space-y-1 text-[13.5px] leading-[20.25px]">
        {statusLines.map((l, i) =>
          l.tone === 'done' ? (
            <p key={i} className="text-foreground flex items-center gap-1.5">
              <CheckCircle2 className="text-success h-4 w-4 shrink-0" aria-hidden />
              {l.text}
            </p>
          ) : (
            <p key={i}>{l.text}</p>
          ),
        )}
      </div>

      <ol className="space-y-3">
        {steps.map((s, i) => {
          const d = drafts[s.key] ?? { value: '', note: '' };
          const flagged = missing.has(s.key) || needsNote.has(s.key) || badKey === s.key;
          const noteId = `note-${s.key}`;
          return (
            <li
              key={s.key}
              className={`bg-card rounded-lg border p-4 ${flagged ? 'border-destructive' : 'border-border'}`}
              data-step={s.key}
            >
              <fieldset disabled={readOnly || busy !== null}>
                <legend className="text-foreground text-[13.5px] font-medium leading-[20.25px]">
                  {i + 1}. {s.label}
                  {s.required && (
                    <span className="text-muted-foreground ml-2 text-[12px] font-normal">
                      ({C.requiredToComplete})
                    </span>
                  )}
                </legend>
                {s.help && (
                  <p className="text-muted-foreground mt-1 text-[12.5px] leading-[18.75px]">
                    {s.help}
                  </p>
                )}
                <div className="mt-3">
                  {s.kind === 'check' && (
                    // The shared card radios (CONFLICTS W4): the chosen
                    // answer is the ink edge and the ink dot, never a colour
                    // alone, and each option is 44 px tall.
                    <RadioGroup
                      variant="card"
                      name={`answer-${s.key}`}
                      aria-label={s.label}
                      value={d.value}
                      onValueChange={(v) => setDraft(s.key, { value: v })}
                      disabled={readOnly || busy !== null}
                      className="flex flex-wrap gap-2"
                    >
                      <RadioGroupItem value="pass" label={C.pass} />
                      <RadioGroupItem value="fail" label={C.fail} />
                      <RadioGroupItem value="na" label={C.notApplicable} />
                    </RadioGroup>
                  )}
                  {s.kind === 'count' && (
                    <Input
                      inputMode="numeric"
                      aria-label={s.label}
                      placeholder={C.countPlaceholder}
                      className="max-w-40 font-mono tabular-nums"
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
                <div className="mt-3 space-y-1.5">
                  <Label htmlFor={noteId} className="text-muted-foreground text-[12.5px]">
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

      <div className="space-y-1.5">
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
          className="border-destructive/30 bg-destructive-wash text-destructive flex items-start gap-2 rounded-md border px-3 py-2.5 text-[13px] leading-[19.5px]"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
            <p>{error.message}</p>
            {(error.kind === 'changed' || error.kind === 'completed') && (
              <Button type="button" variant="outline" size="sm" onClick={reload}>
                {C.reload}
              </Button>
            )}
          </div>
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          {/* While a call is out, the spinner shows beside the words, so
              each button keeps its name (the Receive dialog's rule). */}
          <Button
            type="button"
            variant="outline"
            onClick={() => send(false)}
            disabled={busy !== null}
          >
            {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {C.saveProgress}
          </Button>
          {/* Completing commits the run in front of you: the ink button
              (DESIGN-SPEC 6.2). */}
          <Button
            type="button"
            variant="default"
            onClick={() => setConfirmOpen(true)}
            disabled={busy !== null}
          >
            {busy === 'complete' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {C.completeChecklist}
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
              variant="default"
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
