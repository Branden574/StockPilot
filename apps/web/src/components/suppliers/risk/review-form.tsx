'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  evaluateVendorRisk,
  VENDOR_RISK_ACTION_MAX,
  VENDOR_RISK_ANSWER_WORDS,
  VENDOR_RISK_ANSWERS,
  VENDOR_RISK_DATA_LEVEL_WORDS,
  VENDOR_RISK_DATA_LEVELS,
  VENDOR_RISK_EVIDENCE_WORDS,
  VENDOR_RISK_FINDING_MAX,
  VENDOR_RISK_GROUP_WORDS,
  VENDOR_RISK_GROUPS,
  VENDOR_RISK_ITEM_ANSWER_WORDS,
  VENDOR_RISK_NOTE_MAX,
  VENDOR_RISK_REFUSAL_WORDS,
  VENDOR_RISK_RESULTS,
  VENDOR_RISK_RISK_WORDS,
  VENDOR_RISK_SEVERITY_WORDS,
  vendorRiskAnswersProblem,
  vendorRiskDefaultNextReview,
  vendorRiskDueDateAllowed,
  vendorRiskNextReviewAllowed,
  vendorRiskQuestion,
  vendorRiskQuestionsFor,
  vendorRiskReasonCount,
  addVendorRiskMonths,
  type VendorRiskAnswer,
  type VendorRiskAnswerEntry,
  type VendorRiskAnswers,
  type VendorRiskDataLevel,
  type VendorRiskQuestionKey,
  type VendorRiskResult,
} from '@stockpilot/core';

import { useStepUp } from '@/components/auth/step-up-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  supplierRiskDateIssue,
  supplierRiskDateIssueBlocks,
  supplierRiskDateIssueWords,
  supplierRiskLatestEvidenceDay,
} from '@/lib/supplier-risk/dates';
import {
  supplierRiskHardStopWords,
  supplierRiskResultTone,
  supplierRiskResultWords,
  supplierRiskTextProblem,
} from '@/lib/supplier-risk/words';
import {
  discardSupplierRiskDraftAction,
  finishSupplierRiskReviewAction,
  saveSupplierRiskDraftAction,
} from '@/server/actions/supplier-risk';
import type { SupplierRiskPerson } from '@/server/services/supplier-risk';

import { CleanTextField } from './clean-text-field';
import { SupplierRiskOutcomeNote } from './outcome-note';
import { ReasonField } from './reason-field';
import { sendWithStepUp, supplierRiskOutcomeOf, type SupplierRiskOutcome } from './step-up';

export const NATIVE_SELECT =
  'border-line-strong bg-card text-foreground focus-visible:ring-ring block h-8 w-full max-w-sm rounded-md border px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11 max-sm:text-base';

interface Entry {
  answer: VendorRiskAnswer | null;
  note: string;
  date: string;
}
type Entries = Partial<Record<VendorRiskQuestionKey, Entry>>;

interface ItemDraft {
  finding: string;
  action: string;
  ownerUserId: string;
  dueOn: string;
}

export interface SupplierRiskReviewFormProps {
  supplierId: string;
  supplierName: string;
  /** The organization's day (the review's day), 'YYYY-MM-DD'. */
  orgToday: string;
  /** The UTC day, 'YYYY-MM-DD' (the database's day for a future date). */
  utcToday: string;
  start: {
    dataLevel: VendorRiskDataLevel | null;
    answers: VendorRiskAnswers;
    from: 'draft' | 'current' | 'empty';
  };
  /** The open draft's updated_at as the page read it; null when there was none. */
  draftUpdatedAt: string | null;
  /** May save and finish (an owner or admin on their own seat, the supplier active). */
  canWrite: boolean;
  /** May discard the open draft (an owner or admin on their own seat, archived suppliers too). */
  canDiscard: boolean;
  people: SupplierRiskPerson[];
}

function entriesOf(answers: VendorRiskAnswers): Entries {
  const out: Entries = {};
  for (const [key, entry] of Object.entries(answers) as Array<
    [VendorRiskQuestionKey, VendorRiskAnswerEntry]
  >) {
    out[key] = { answer: entry.answer, note: entry.note ?? '', date: entry.date ?? '' };
  }
  return out;
}

/** The answers to send: only questions asked at this level, only what was given. */
function answersFor(level: VendorRiskDataLevel, entries: Entries): VendorRiskAnswers {
  const out: VendorRiskAnswers = {};
  for (const q of vendorRiskQuestionsFor(level)) {
    const e = entries[q.key];
    if (!e?.answer) continue;
    const entry: VendorRiskAnswerEntry = { answer: e.answer };
    if (e.note.length > 0) entry.note = e.note;
    if (q.date && e.date) entry.date = e.date;
    out[q.key] = entry;
  }
  return out;
}

/**
 * THE REVIEW FORM (client): what they hold, then the questions in the four
 * groups (the Student data group only with student data), each Yes / No /
 * Not shown to us with a note and, where the question has one, a date (needed
 * beside a Yes for the security report and the insurance). Beside it, the
 * result if finished now, with every reason the rules give (core's
 * evaluateVendorRisk, judged on the organization's day): a preview, since the
 * database works the result out itself at the finish.
 *
 * Save draft, Discard draft and Finish. Each is sent once: its button is off
 * while it is in flight. A finish sends the draft's updated_at as read, and
 * the server refuses when the draft moved since (the page offers Reload).
 * Notes, findings, actions and reasons are cleaned of hidden characters as
 * they are typed, and the cleaned text is what is shown. A support seat, or
 * an archived supplier, gets the form read-only (no Save or Finish).
 */
export function SupplierRiskReviewForm(props: SupplierRiskReviewFormProps) {
  const { supplierId, orgToday, utcToday, canWrite, canDiscard, people } = props;
  const router = useRouter();
  const stepUp = useStepUp();
  const [level, setLevel] = React.useState<VendorRiskDataLevel | null>(props.start.dataLevel);
  const [entries, setEntries] = React.useState<Entries>(() => entriesOf(props.start.answers));
  const [busy, setBusy] = React.useState<null | 'save' | 'finish' | 'discard'>(null);
  const [outcome, setOutcome] = React.useState<SupplierRiskOutcome | null>(null);
  const [finishing, setFinishing] = React.useState(false);
  const [nextReviewOn, setNextReviewOn] = React.useState('');
  const [overrideResult, setOverrideResult] = React.useState<VendorRiskResult | ''>('');
  const [overrideReason, setOverrideReason] = React.useState('');
  const [items, setItems] = React.useState<Partial<Record<VendorRiskQuestionKey, ItemDraft>>>({});
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const finishRef = React.useRef<HTMLHeadingElement>(null);
  const days = { orgToday, utcToday };
  const latestEvidenceDay = supplierRiskLatestEvidenceDay(utcToday);
  const readOnly = !canWrite;

  const answers = level ? answersFor(level, entries) : {};
  const evaluation = level ? evaluateVendorRisk(level, answers, { reviewedOn: orgToday }) : null;
  const asked = level ? vendorRiskQuestionsFor(level) : [];
  const override =
    overrideResult && evaluation && overrideResult !== evaluation.result ? overrideResult : null;

  function setEntry(key: VendorRiskQuestionKey, patch: Partial<Entry>) {
    setEntries((prev) => {
      const was = prev[key] ?? { answer: null, note: '', date: '' };
      return { ...prev, [key]: { ...was, ...patch } };
    });
  }

  /** What stops a save (finishing false) or a finish, in words; null when nothing does. */
  function problemWith(finish: boolean): string | null {
    if (!level) return VENDOR_RISK_REFUSAL_WORDS.bad_data_level;
    for (const q of asked) {
      const e = entries[q.key];
      if (!e) continue;
      if (e.note && supplierRiskTextProblem(e.note, VENDOR_RISK_NOTE_MAX)) {
        return `${q.text} ${VENDOR_RISK_REFUSAL_WORDS.answer_bad_note}`;
      }
      const issue = supplierRiskDateIssue(q, e, days);
      if (supplierRiskDateIssueBlocks(issue, finish))
        return `${q.text} ${supplierRiskDateIssueWords(issue)}`;
    }
    const problem = vendorRiskAnswersProblem(level, answers, finish, { utcToday });
    return problem ? VENDOR_RISK_REFUSAL_WORDS[problem] : null;
  }

  async function saveDraft() {
    if (busy) return;
    const problem = problemWith(false);
    if (problem || !level) {
      setOutcome({
        text: problem ?? VENDOR_RISK_REFUSAL_WORDS.bad_data_level,
        setUp: false,
        reload: false,
      });
      return;
    }
    setBusy('save');
    setOutcome(null);
    const res = await sendWithStepUp(
      () => saveSupplierRiskDraftAction({ supplierId, dataLevel: level, answers }),
      stepUp.ensure,
    );
    setBusy(null);
    if (!res.ok) {
      setOutcome(supplierRiskOutcomeOf(res.error));
      return;
    }
    toast.success('Draft saved.');
    router.refresh();
  }

  function openFinish() {
    const problem = problemWith(true);
    if (problem || !level || !evaluation) {
      setOutcome({
        text: problem ?? VENDOR_RISK_REFUSAL_WORDS.answers_incomplete,
        setUp: false,
        reload: false,
      });
      return;
    }
    setOutcome(null);
    setNextReviewOn((v) => v || vendorRiskDefaultNextReview(level, orgToday));
    setItems((prev) => {
      const next: Partial<Record<VendorRiskQuestionKey, ItemDraft>> = {};
      for (const s of evaluation.items) {
        next[s.questionKey] = prev[s.questionKey] ?? {
          finding: s.finding,
          action: s.action,
          ownerUserId: '',
          dueOn: '',
        };
      }
      return next;
    });
    setFinishing(true);
    requestAnimationFrame(() => finishRef.current?.focus());
  }

  function finishProblem(): string | null {
    const problem = problemWith(true);
    if (problem) return problem;
    if (!nextReviewOn || !vendorRiskNextReviewAllowed(nextReviewOn, orgToday)) {
      return VENDOR_RISK_REFUSAL_WORDS.bad_next_review_on;
    }
    if (override && !vendorRiskReasonCount(overrideReason).ok)
      return VENDOR_RISK_REFUSAL_WORDS.bad_override_reason;
    for (const s of evaluation?.items ?? []) {
      const d = items[s.questionKey];
      if (!d) return VENDOR_RISK_REFUSAL_WORDS.items_do_not_match_answers;
      if (
        supplierRiskTextProblem(d.finding, VENDOR_RISK_FINDING_MAX) ||
        supplierRiskTextProblem(d.action, VENDOR_RISK_ACTION_MAX)
      ) {
        return VENDOR_RISK_REFUSAL_WORDS.bad_item_text;
      }
      if (d.dueOn && !vendorRiskDueDateAllowed(d.dueOn, orgToday))
        return VENDOR_RISK_REFUSAL_WORDS.bad_item_due_on;
    }
    return null;
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !level || !evaluation) return;
    const problem = finishProblem();
    if (problem) {
      setOutcome({ text: problem, setUp: false, reload: false });
      return;
    }
    setBusy('finish');
    setOutcome(null);
    const payload = {
      supplierId,
      dataLevel: level,
      answers,
      nextReviewOn,
      overrideResult: override,
      overrideReason: override ? overrideReason : null,
      items: evaluation.items.map((s) => {
        const d = items[s.questionKey]!;
        return {
          questionKey: s.questionKey,
          finding: d.finding,
          action: d.action,
          ownerUserId: d.ownerUserId || null,
          dueOn: d.dueOn || null,
        };
      }),
      draftUpdatedAt: props.draftUpdatedAt,
    };
    const res = await sendWithStepUp(() => finishSupplierRiskReviewAction(payload), stepUp.ensure);
    setBusy(null);
    if (!res.ok) {
      setOutcome(supplierRiskOutcomeOf(res.error));
      return;
    }
    toast.success(`Review finished: ${supplierRiskResultWords(res.data.result)}.`);
    setFinishing(false);
    router.refresh();
  }

  async function discard() {
    if (busy) return;
    setBusy('discard');
    setOutcome(null);
    const res = await sendWithStepUp(
      () => discardSupplierRiskDraftAction({ supplierId }),
      stepUp.ensure,
    );
    setBusy(null);
    setConfirmDiscard(false);
    if (!res.ok) {
      setOutcome(supplierRiskOutcomeOf(res.error));
      return;
    }
    toast.success(res.data.discarded ? 'Draft discarded.' : 'There was no draft to discard.');
    router.refresh();
  }

  return (
    <div className="space-y-4" data-slot="supplier-risk-form">
      {props.start.from === 'draft' ? (
        <p className="text-ink-2 text-[13px]">
          This is the open draft. Nothing in it counts until the review is finished.
        </p>
      ) : props.start.from === 'current' && canWrite ? (
        <p className="text-ink-2 text-[13px]">
          These are the answers of the current review. Change what has changed, then save a draft or
          finish a new version.
        </p>
      ) : null}

      <fieldset className="border-border space-y-2 rounded-lg border p-4" disabled={readOnly}>
        <legend className="text-foreground px-1 text-[14px] font-medium">
          What they hold of ours
        </legend>
        <RadioGroup
          aria-label="What they hold of ours"
          value={level ?? ''}
          onValueChange={(v) => setLevel(v as VendorRiskDataLevel)}
          disabled={readOnly}
          variant="card"
        >
          {VENDOR_RISK_DATA_LEVELS.map((l) => (
            <RadioGroupItem
              key={l}
              value={l}
              label={VENDOR_RISK_DATA_LEVEL_WORDS[l].label}
              description={VENDOR_RISK_DATA_LEVEL_WORDS[l].description}
            />
          ))}
        </RadioGroup>
      </fieldset>

      {level && asked.length === 0 ? (
        <p className="text-ink-2 text-[13px]">
          No question is asked when they keep none of our data.
        </p>
      ) : null}

      {VENDOR_RISK_GROUPS.map((group) => {
        const questions = asked.filter((q) => q.group === group);
        if (questions.length === 0) return null;
        return (
          <section
            key={group}
            aria-labelledby={`group-${group}`}
            className="border-border bg-card space-y-3 rounded-lg border p-4"
            data-group={group}
          >
            <div>
              <h3 id={`group-${group}`} className="text-foreground text-[14px] font-medium">
                {VENDOR_RISK_GROUP_WORDS[group].title}
              </h3>
              <p className="text-muted-foreground text-[12.5px]">
                {VENDOR_RISK_GROUP_WORDS[group].description}
              </p>
            </div>
            {questions.map((q) => {
              const e = entries[q.key] ?? { answer: null, note: '', date: '' };
              const issue = supplierRiskDateIssue(q, e, days);
              const issueWords = supplierRiskDateIssueWords(issue);
              const judged = q.date?.maxAgeMonths != null;
              const dateId = `date-${q.key}`;
              return (
                <fieldset
                  key={q.key}
                  className="border-border space-y-2 border-t pt-3"
                  data-question={q.key}
                  disabled={readOnly}
                >
                  <legend className="text-foreground text-[13.5px] font-medium">{q.text}</legend>
                  <p className="text-muted-foreground text-[12.5px]">{q.help}</p>
                  <RadioGroup
                    aria-label={`Answer: ${q.text}`}
                    value={e.answer ?? ''}
                    onValueChange={(v) => setEntry(q.key, { answer: v as VendorRiskAnswer })}
                    disabled={readOnly}
                    className="grid-cols-1 sm:grid-cols-3"
                  >
                    {VENDOR_RISK_ANSWERS.map((a) => (
                      <RadioGroupItem key={a} value={a} label={VENDOR_RISK_ANSWER_WORDS[a]} />
                    ))}
                  </RadioGroup>
                  {q.date ? (
                    <div className="space-y-1">
                      <Label htmlFor={dateId}>
                        {q.date.label}
                        <span className="text-muted-foreground ml-1 font-normal">
                          {judged ? '(needed with Yes)' : '(optional)'}
                        </span>
                      </Label>
                      <Input
                        id={dateId}
                        type="date"
                        className="max-w-[12rem]"
                        value={e.date}
                        min="2000-01-01"
                        max={judged ? latestEvidenceDay : undefined}
                        required={judged && e.answer === 'yes'}
                        aria-required={judged && e.answer === 'yes' ? true : undefined}
                        aria-invalid={issue === 'future' || issue === 'bad' ? true : undefined}
                        aria-describedby={issueWords ? `${dateId}-issue` : undefined}
                        onChange={(ev) => setEntry(q.key, { date: ev.target.value })}
                      />
                      {issueWords ? (
                        <p
                          id={`${dateId}-issue`}
                          className={
                            issue === 'future' || issue === 'bad'
                              ? 'text-destructive text-[12.5px]'
                              : 'text-warning text-[12.5px]'
                          }
                        >
                          {issueWords}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <CleanTextField
                    id={`note-${q.key}`}
                    label="Note"
                    optional
                    max={VENDOR_RISK_NOTE_MAX}
                    value={e.note}
                    disabled={readOnly}
                    onChange={(note) => setEntry(q.key, { note })}
                  />
                </fieldset>
              );
            })}
          </section>
        );
      })}

      {evaluation ? (
        <section
          aria-labelledby="supplier-risk-preview"
          className="border-border bg-card space-y-2 rounded-lg border p-4"
          data-slot="supplier-risk-preview"
        >
          <h3 id="supplier-risk-preview" className="text-foreground text-[14px] font-medium">
            The result if the review were finished now
          </h3>
          <div aria-live="polite" className="space-y-2">
            <Badge variant={supplierRiskResultTone(evaluation.result)}>
              {supplierRiskResultWords(evaluation.result)}
            </Badge>
            <p className="text-muted-foreground text-[12.5px]">
              A preview by the rules below. When you finish, StockPilot works the result out again
              from the answers, and that is the one kept.
            </p>
            <ul
              className="text-ink-2 list-disc space-y-1 pl-5 text-[13px] leading-5"
              data-slot="supplier-risk-reasons"
            >
              <li>
                What they hold: {VENDOR_RISK_DATA_LEVEL_WORDS[evaluation.level].label}, so the
                starting risk is {VENDOR_RISK_RISK_WORDS[evaluation.startingRisk]}.
              </li>
              <li>
                Evidence: {VENDOR_RISK_EVIDENCE_WORDS[evaluation.evidence].label}.{' '}
                {VENDOR_RISK_EVIDENCE_WORDS[evaluation.evidence].description}
              </li>
              {evaluation.asked.length > 0 ? (
                <li>
                  {evaluation.gaps.length === 0
                    ? 'No gap: every question is answered Yes.'
                    : `${evaluation.gaps.length} of ${evaluation.asked.length} questions are gaps (No, Not shown to us, or out of date).`}
                </li>
              ) : null}
              {evaluation.missing.length > 0 ? (
                <li>
                  {evaluation.missing.length === 1
                    ? '1 question is not answered yet: it counts as Not shown to us.'
                    : `${evaluation.missing.length} questions are not answered yet: they count as Not shown to us.`}
                </li>
              ) : null}
              {evaluation.outOfDate.map((k) => (
                <li key={`ood-${k}`}>
                  Out of date, so counted as Not shown to us: {vendorRiskQuestion(k)?.text}
                </li>
              ))}
              {evaluation.hardStops.map((s) => (
                <li key={`stop-${s}`} className="text-destructive">
                  Hard stop: {supplierRiskHardStopWords(s)}
                </li>
              ))}
              {evaluation.pendingHardStops.map((s) => (
                <li key={`pending-${s}`}>
                  Not ruled out yet (not shown to us): {supplierRiskHardStopWords(s)}
                </li>
              ))}
              <li>Risk left: {VENDOR_RISK_RISK_WORDS[evaluation.residualRisk]}.</li>
            </ul>
          </div>
        </section>
      ) : null}

      <SupplierRiskOutcomeNote outcome={outcome} onReload={() => router.refresh()} />

      {canWrite || canDiscard ? (
        <div className="flex flex-wrap gap-2">
          {canWrite ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={saveDraft}
                disabled={busy !== null || !level}
              >
                {busy === 'save' ? 'Saving…' : 'Save draft'}
              </Button>
              <Button
                type="button"
                onClick={openFinish}
                disabled={busy !== null || !level || finishing}
              >
                Finish the review…
              </Button>
            </>
          ) : null}
          {canDiscard ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmDiscard(true)}
              disabled={busy !== null}
            >
              Discard draft
            </Button>
          ) : null}
        </div>
      ) : null}

      {finishing && canWrite && level && evaluation ? (
        <form
          onSubmit={finish}
          className="border-border bg-card space-y-4 rounded-lg border p-4"
          aria-labelledby="supplier-risk-finish"
          data-slot="supplier-risk-finish"
          noValidate
        >
          <h3
            id="supplier-risk-finish"
            ref={finishRef}
            tabIndex={-1}
            className="text-foreground text-[14px] font-medium"
          >
            Finish the review
          </h3>
          <p className="text-ink-2 text-[13px]">
            The rules give:{' '}
            <strong className="text-foreground font-medium">
              {supplierRiskResultWords(evaluation.result)}
            </strong>
            . The answers, the result and the items below are kept as a new version.
          </p>

          <div className="space-y-1">
            <Label htmlFor="next-review-on">Next review</Label>
            <Input
              id="next-review-on"
              type="date"
              className="max-w-[12rem]"
              value={nextReviewOn}
              min={orgToday}
              max={addVendorRiskMonths(orgToday, 36)}
              required
              onChange={(e) => setNextReviewOn(e.target.value)}
            />
            <p className="text-muted-foreground text-[12.5px]">
              The default is 12 months from today, or 6 with student data. A reminder goes to the
              owners and admins 30 days before and on the day.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="override-result">Set a different result</Label>
            <select
              id="override-result"
              className={NATIVE_SELECT}
              value={overrideResult}
              onChange={(e) => setOverrideResult(e.target.value as VendorRiskResult | '')}
            >
              <option value="">
                Keep the rules' result ({supplierRiskResultWords(evaluation.result)})
              </option>
              {VENDOR_RISK_RESULTS.filter((r) => r !== evaluation.result).map((r) => (
                <option key={r} value={r}>
                  {supplierRiskResultWords(r)}
                </option>
              ))}
            </select>
          </div>
          {override ? (
            <ReasonField
              id="override-reason"
              label="Why you set a different result"
              help="Kept with the review, and shown beside the result for everyone who reads it."
              value={overrideReason}
              onChange={setOverrideReason}
            />
          ) : null}

          {evaluation.items.length > 0 ? (
            <div className="space-y-3">
              <h4 className="text-foreground text-[13.5px] font-medium">Items: one for each gap</h4>
              {evaluation.items.map((s) => {
                const d = items[s.questionKey] ?? {
                  finding: s.finding,
                  action: s.action,
                  ownerUserId: '',
                  dueOn: '',
                };
                const setItem = (patch: Partial<ItemDraft>) =>
                  setItems((prev) => ({ ...prev, [s.questionKey]: { ...d, ...patch } }));
                return (
                  <fieldset
                    key={s.questionKey}
                    className="border-border space-y-2 border-t pt-3"
                    data-item={s.questionKey}
                  >
                    <legend className="text-foreground text-[13px] font-medium">
                      {vendorRiskQuestion(s.questionKey)?.text}
                    </legend>
                    <p className="text-muted-foreground text-[12.5px]">
                      {VENDOR_RISK_ITEM_ANSWER_WORDS[s.answer]} · Severity:{' '}
                      {VENDOR_RISK_SEVERITY_WORDS[s.severity]}
                    </p>
                    <CleanTextField
                      id={`finding-${s.questionKey}`}
                      label="Finding"
                      max={VENDOR_RISK_FINDING_MAX}
                      value={d.finding}
                      onChange={(finding) => setItem({ finding })}
                    />
                    <CleanTextField
                      id={`action-${s.questionKey}`}
                      label="What to do"
                      max={VENDOR_RISK_ACTION_MAX}
                      value={d.action}
                      onChange={(action) => setItem({ action })}
                    />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`owner-${s.questionKey}`}>Owner (an owner or admin)</Label>
                        <select
                          id={`owner-${s.questionKey}`}
                          className={NATIVE_SELECT}
                          value={d.ownerUserId}
                          onChange={(e) => setItem({ ownerUserId: e.target.value })}
                        >
                          <option value="">No owner yet</option>
                          {people.map((p) => (
                            <option key={p.userId} value={p.userId}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`due-${s.questionKey}`}>
                          Due <span className="text-muted-foreground font-normal">(optional)</span>
                        </Label>
                        <Input
                          id={`due-${s.questionKey}`}
                          type="date"
                          className="max-w-[12rem]"
                          value={d.dueOn}
                          min={orgToday}
                          max={addVendorRiskMonths(orgToday, 36)}
                          onChange={(e) => setItem({ dueOn: e.target.value })}
                        />
                      </div>
                    </div>
                  </fieldset>
                );
              })}
            </div>
          ) : (
            <p className="text-ink-2 text-[13px]">No item: every question is answered Yes.</p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy !== null}>
              {busy === 'finish' ? 'Finishing…' : 'Finish the review'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setFinishing(false)}
              disabled={busy !== null}
            >
              Not yet
            </Button>
          </div>
        </form>
      ) : null}

      <DestructiveConfirm
        open={confirmDiscard}
        onOpenChange={(v) => {
          if (!v) setConfirmDiscard(false);
        }}
        title="Discard the draft?"
        description="The draft's answers are deleted. Finished reviews are kept as they are."
        confirmLabel="Discard draft"
        pending={busy === 'discard'}
        onConfirm={discard}
      />
      {stepUp.modal}
    </div>
  );
}
