'use client';

import { ArrowDown, ArrowUp, Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection } from '@/components/patterns/detail-section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useUnsavedWork } from '@/lib/unsaved-work';
import {
  publishReceivingChecklistAction,
  retireReceivingChecklistAction,
} from '@/server/actions/receiving-checklist';

import {
  CHECKLIST_LIMITS,
  CHECKLIST_PUBLISHABLE_KINDS,
  checklistEditorStepsFrom,
  checklistKindLabel,
  checklistPublishPayload,
  checklistVersionMetaLine,
  describeChecklistInvalid,
  normalizeChecklistSteps,
  normalizeChecklistTitle,
  RECEIVING_CHECKLIST_COPY,
  moveChecklistStep,
  SUGGESTED_RECEIVING_STEPS,
  type ChecklistEditorStep,
  type ChecklistStepKind,
} from '@stockpilot/core';

import type {
  ChecklistEditorView,
  ChecklistVersionView,
} from '@/server/services/receiving-checklist';

const C = RECEIVING_CHECKLIST_COPY;

type EditorStep = ChecklistEditorStep;

/** A native select in the redesign's control look (the settings panels'). */
const SELECT =
  'bg-card text-foreground flex h-8 rounded-md border border-[var(--ed-line-strong)] px-2.5 text-[13px] transition-colors focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 max-sm:text-base';

/**
 * The receiving checklist editor (F4-1): the live version read only, "Start
 * from suggested steps" or "Start blank" when there is none, a staged draft
 * (title, steps added, removed and moved, kind, required and help per step,
 * an optional procedure as instructions), "Publish version N" with a confirm,
 * "Turn off" with a confirm, and the earlier versions. Only a publisher sees
 * the actions; the database refuses everyone else anyway.
 */
export function ReceivingChecklistEditor({ editor }: { editor: ChecklistEditorView }) {
  const router = useRouter();
  const canPublish = editor.gate.canPublishChecklist;
  const live = editor.live;

  const [editing, setEditing] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [steps, setSteps] = React.useState<EditorStep[]>([]);
  const [procedureId, setProcedureId] = React.useState<string>('');
  const [error, setError] = React.useState<{
    message: string;
    step: number | null;
    changed: boolean;
  } | null>(null);
  const [confirm, setConfirm] = React.useState<'publish' | 'turn_off' | null>(null);
  const [busy, setBusy] = React.useState(false);
  const pending = React.useRef<{ payload: string; clientPublishId: string } | null>(null);
  /**
   * The live version the staged edits started from (desk check F2), sent as
   * the expected id: a version someone else published meanwhile is refused
   * (checklist_changed) instead of being replaced by edits made from an older
   * one. A refresh never moves it; only Reload after that refusal re-bases
   * the edits, on the version the reload brought.
   */
  const [baseId, setBaseId] = React.useState<string | null>(null);
  /** The props Reload was pressed on; the next, newer props re-base the edits. */
  const [reloadFrom, setReloadFrom] = React.useState<ChecklistEditorView | null>(null);
  if (reloadFrom !== null && reloadFrom !== editor) {
    setReloadFrom(null);
    setBaseId(editor.live?.id ?? null);
    setError(null);
  }

  useUnsavedWork('receiving-checklist-editor', C.editorTitle, () => editing || busy);

  function reload() {
    setReloadFrom(editor);
    router.refresh();
  }

  function begin(from: 'suggested' | 'blank' | 'live') {
    setError(null);
    setBaseId(live?.id ?? null);
    if (from === 'live' && live) {
      setTitle(live.title);
      setSteps(
        checklistEditorStepsFrom(
          live.steps.map((s) => ({
            kind: s.kind,
            label: s.label,
            help: s.help,
            required: s.required,
          })),
        ),
      );
      setProcedureId(live.procedureId ?? '');
    } else if (from === 'suggested') {
      setTitle(live?.title ?? 'Receiving checklist');
      setSteps(checklistEditorStepsFrom(SUGGESTED_RECEIVING_STEPS));
      setProcedureId('');
    } else {
      setTitle(live?.title ?? 'Receiving checklist');
      setSteps(checklistEditorStepsFrom([{ kind: 'check', label: '', required: true }]));
      setProcedureId('');
    }
    setEditing(true);
  }

  const update = (uid: string, patch: Partial<EditorStep>) =>
    setSteps((list) => list.map((s) => (s.uid === uid ? { ...s, ...patch } : s)));

  /** Checked here in the server's words before anything is sent. */
  function localCheck(): string | null {
    const t = normalizeChecklistTitle(title);
    if (!t.ok) return describeChecklistInvalid(t.detail);
    const r = normalizeChecklistSteps(checklistPublishPayload(steps));
    if (!r.ok) {
      setError({
        message: describeChecklistInvalid(r.detail),
        step: r.detail.step ?? null,
        changed: false,
      });
      return '';
    }
    return null;
  }

  function askPublish() {
    setError(null);
    const problem = localCheck();
    if (problem === '') return;
    if (problem) {
      setError({ message: problem, step: null, changed: false });
      return;
    }
    setConfirm('publish');
  }

  async function publish() {
    setConfirm(null);
    if (busy) return;
    const body = {
      title,
      steps: checklistPublishPayload(steps),
      procedureId: procedureId || null,
      expectedCurrentId: baseId,
    };
    const payload = JSON.stringify(body);
    if (!pending.current || pending.current.payload !== payload) {
      pending.current = { payload, clientPublishId: crypto.randomUUID() };
    }
    setBusy(true);
    let res: Awaited<ReturnType<typeof publishReceivingChecklistAction>>;
    try {
      res = await publishReceivingChecklistAction({
        ...body,
        clientPublishId: pending.current.clientPublishId,
      });
    } catch {
      // The reply was lost, so the version may have been published. The id is
      // kept: publishing the same edits again is answered as that publish.
      setBusy(false);
      setError({ message: C.didNotGoThrough, step: null, changed: false });
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const d = res.error.details as { reason?: string; step?: number } | undefined;
      setError({
        message: d?.reason === 'checklist_changed' ? C.publishChanged : res.error.message,
        step: typeof d?.step === 'number' ? d.step : null,
        changed: d?.reason === 'checklist_changed',
      });
      return;
    }
    pending.current = null;
    setEditing(false);
    toast.success(C.published(res.data.versionNumber));
    router.refresh();
  }

  async function turnOff() {
    setConfirm(null);
    if (!live || busy) return;
    setBusy(true);
    let res: Awaited<ReturnType<typeof retireReceivingChecklistAction>>;
    try {
      res = await retireReceivingChecklistAction({ versionId: live.id });
    } catch {
      setBusy(false);
      setError({ message: C.didNotGoThrough, step: null, changed: false });
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const d = res.error.details as { reason?: string } | undefined;
      setError({
        message: d?.reason === 'checklist_changed' ? C.publishChanged : res.error.message,
        step: null,
        changed: true,
      });
      return;
    }
    toast.success(C.turnedOff);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {/* aria-labelledby makes each section a region named by its heading
          (DetailSection only puts the id on the heading). */}
      {!editing && (
        <DetailSection
          headingId="live-checklist"
          aria-labelledby="live-checklist"
          title={live ? `${C.liveVersion(live.versionNumber)} ${live.title}` : C.noLiveVersion}
          footer={
            canPublish ? (
              <div className="flex flex-wrap gap-2">
                {live ? (
                  <>
                    <Button
                      type="button"
                      variant="gradient"
                      onClick={() => begin('live')}
                      disabled={busy}
                    >
                      {C.prepareVersion(editor.nextVersionNumber)}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setConfirm('turn_off')}
                      disabled={busy}
                    >
                      {C.turnOff}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button type="button" variant="gradient" onClick={() => begin('suggested')}>
                      {C.startSuggested}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => begin('blank')}>
                      {C.startBlank}
                    </Button>
                  </>
                )}
              </div>
            ) : undefined
          }
        >
          {live ? (
            <VersionDetails version={live} timeZone={editor.timeZone} />
          ) : (
            <p className="text-muted-foreground text-[13.5px] leading-[20.25px]">{C.editorEmpty}</p>
          )}
          {!canPublish && (
            <p className="text-muted-foreground mt-3 text-[12.5px] leading-[18.75px]">
              {C.readOnlyEditor}
            </p>
          )}
        </DetailSection>
      )}

      {editing && (
        <DetailSection
          aria-label={C.publishVersion(editor.nextVersionNumber)}
          bodyClassName="space-y-4"
          footer={
            <div className="flex flex-wrap gap-2">
              {/* Publishing commits the version in front of you: the ink
                  button (DESIGN-SPEC 6.2). While it is out, the spinner shows
                  beside the words, so the button keeps its name. */}
              <Button type="button" variant="default" onClick={askPublish} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {C.publishVersion(editor.nextVersionNumber)}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          }
        >
          <div className="space-y-1.5">
            <Label htmlFor="checklist-title">{C.titleLabel}</Label>
            <Input
              id="checklist-title"
              value={title}
              maxLength={CHECKLIST_LIMITS.title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li
                key={s.uid}
                className={`bg-card rounded-lg border p-3 ${error?.step === i + 1 ? 'border-destructive' : 'border-border'}`}
              >
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground mt-1.5 w-6 font-mono text-[12.5px] tabular-nums">
                    {i + 1}.
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <Input
                      aria-label={`${C.stepLabel} ${i + 1}`}
                      value={s.label}
                      maxLength={CHECKLIST_LIMITS.label}
                      onChange={(e) => update(s.uid, { label: e.target.value })}
                    />
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <label className="flex items-center gap-2">
                        <span className="text-muted-foreground text-[12.5px]">{C.stepKind}</span>
                        <select
                          className={SELECT}
                          value={s.kind}
                          onChange={(e) =>
                            update(s.uid, { kind: e.target.value as ChecklistStepKind })
                          }
                        >
                          {CHECKLIST_PUBLISHABLE_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {checklistKindLabel(k)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {/* The shared checkbox: the tick and the word are one
                          control, named for its step. */}
                      <Checkbox
                        checked={s.required}
                        onCheckedChange={(next) => update(s.uid, { required: next })}
                        aria-label={`${C.stepRequired}, ${C.stepLabel.toLowerCase()} ${i + 1}`}
                      >
                        {C.stepRequired}
                      </Checkbox>
                    </div>
                    <Input
                      aria-label={`${C.stepHelp}, ${C.stepLabel.toLowerCase()} ${i + 1}`}
                      placeholder={C.stepHelp}
                      value={s.help}
                      maxLength={CHECKLIST_LIMITS.help}
                      onChange={(e) => update(s.uid, { help: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={C.moveStepUp(i + 1)}
                      disabled={i === 0}
                      onClick={() => setSteps((l) => moveChecklistStep(l, i, -1))}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={C.moveStepDown(i + 1)}
                      disabled={i === steps.length - 1}
                      onClick={() => setSteps((l) => moveChecklistStep(l, i, 1))}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={C.removeStep(i + 1)}
                      disabled={steps.length <= 1}
                      onClick={() => setSteps((l) => l.filter((x) => x.uid !== s.uid))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="outline"
            disabled={steps.length >= CHECKLIST_LIMITS.maxSteps}
            onClick={() =>
              setSteps((l) => [
                ...l,
                ...checklistEditorStepsFrom([{ kind: 'check', label: '', required: false }]),
              ])
            }
          >
            <Plus /> {C.addStep}
          </Button>
          {editor.proceduresUnavailable && (
            <p className="text-muted-foreground text-[13.5px] leading-[20.25px]">
              {C.proceduresUnavailable}
            </p>
          )}
          {editor.procedures && editor.procedures.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="checklist-procedure">{C.procedureLabel}</Label>
              <select
                id="checklist-procedure"
                className={`${SELECT} w-full`}
                value={procedureId}
                onChange={(e) => setProcedureId(e.target.value)}
              >
                <option value="">{C.procedureNone}</option>
                {editor.procedures.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
          )}
        </DetailSection>
      )}

      {error && (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive-wash text-destructive flex items-start gap-2 rounded-md border px-3 py-2.5 text-[13px] leading-[19.5px]"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
            <p>{error.message}</p>
            {error.changed && (
              <Button type="button" variant="outline" size="sm" onClick={reload}>
                {C.reload}
              </Button>
            )}
          </div>
        </div>
      )}

      {editor.history.length > 0 && (
        <DetailSection
          headingId="checklist-history"
          aria-labelledby="checklist-history"
          title={C.history}
          flush
        >
          <ul className="divide-border divide-y">
            {editor.history.map((v) => (
              <li key={v.id}>
                <details className="group px-[18px] py-2.5">
                  <summary className="text-foreground cursor-pointer text-[13.5px] leading-[20.25px]">
                    {C.versionLine(v.versionNumber, v.title)}
                  </summary>
                  <VersionDetails version={v} timeZone={editor.timeZone} />
                </details>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === 'turn_off' ? C.turnOff : C.publishVersion(editor.nextVersionNumber)}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'turn_off'
                ? C.turnOffConfirm
                : C.publishConfirm(editor.nextVersionNumber)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm === 'turn_off' ? 'destructive' : 'default'}
              onClick={() => void (confirm === 'turn_off' ? turnOff() : publish())}
            >
              {confirm === 'turn_off' ? C.turnOff : C.publishVersion(editor.nextVersionNumber)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function VersionDetails({
  version,
  timeZone,
}: {
  version: ChecklistVersionView;
  timeZone: string;
}) {
  return (
    <div className="mt-2 space-y-2 text-[13.5px] leading-[20.25px]">
      <ol className="list-decimal space-y-1 pl-5">
        {version.steps.map((s) => (
          <li key={s.key}>
            {s.label}
            <span className="text-muted-foreground"> · {checklistKindLabel(s.kind)}</span>
            {s.required && <span className="text-muted-foreground"> · {C.stepRequired}</span>}
            {s.help && (
              <span className="text-muted-foreground block text-[12.5px] leading-[18.75px]">
                {s.help}
              </span>
            )}
          </li>
        ))}
      </ol>
      {version.procedureTitle && (
        <p className="text-muted-foreground">{C.instructions(version.procedureTitle)}</p>
      )}
      <p className="text-muted-foreground text-[12.5px] leading-[18.75px]">
        {checklistVersionMetaLine(version, timeZone)}
      </p>
    </div>
  );
}
