'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  addVendorRiskMonths,
  VENDOR_RISK_ACTION_MAX,
  VENDOR_RISK_ITEM_ANSWER_WORDS,
  VENDOR_RISK_ITEM_STATUS_WORDS,
  VENDOR_RISK_ITEM_STATUSES,
  VENDOR_RISK_REFUSAL_WORDS,
  VENDOR_RISK_SEVERITY_WORDS,
  vendorRiskDueDateAllowed,
  vendorRiskQuestion,
  vendorRiskReasonCount,
  type VendorRiskItemStatus,
} from '@stockpilot/core';

import { useStepUp } from '@/components/auth/step-up-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  SUPPLIER_RISK_OWNER_NOT_ADMIN,
  supplierRiskDay,
  supplierRiskTextProblem,
} from '@/lib/supplier-risk/words';
import { updateSupplierRiskItemAction } from '@/server/actions/supplier-risk';
import type { SupplierRiskItem, SupplierRiskPerson } from '@/server/services/supplier-risk';

import { CleanTextField } from './clean-text-field';
import { SupplierRiskOutcomeNote } from './outcome-note';
import { ReasonField } from './reason-field';
import { NATIVE_SELECT } from './review-form';
import { sendWithStepUp, supplierRiskOutcomeOf, type SupplierRiskOutcome } from './step-up';
import { SupplierRiskTime } from './when';

const SEVERITY_TONE = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'warning',
  low: 'secondary',
} as const;

/**
 * The items of a finished review: one per gap, with its severity, what to do,
 * its owner (and "no longer an owner or admin" when that is so), its due date
 * and status, "Accepted by <name>: <reason>" for a risk accepted, and who
 * changed it last. Every name sits in <bdi>; every text is shown exactly as
 * written. With `canWrite` (an owner or admin on their own seat, the current
 * review), each item can be changed; a support seat sees no control. When it
 * was last changed is the day in the organization's zone (`timeZone`), drawn
 * the same on the server and in the browser.
 */
export function SupplierRiskItems({
  reviewId,
  items,
  people,
  canWrite,
  orgToday,
  timeZone,
}: {
  reviewId: string;
  items: SupplierRiskItem[];
  people: SupplierRiskPerson[];
  canWrite: boolean;
  orgToday: string;
  /** The organization's zone (resolved), for "Last changed". */
  timeZone: string;
}) {
  if (items.length === 0) {
    return <p className="text-ink-2 text-[13px]">No item: every question was answered Yes.</p>;
  }
  return (
    <ul className="divide-border divide-y" data-slot="supplier-risk-items">
      {items.map((item) => (
        <ItemRow
          key={item.id}
          reviewId={reviewId}
          item={item}
          people={people}
          canWrite={canWrite}
          orgToday={orgToday}
          timeZone={timeZone}
        />
      ))}
    </ul>
  );
}

function ItemRow({
  reviewId,
  item,
  people,
  canWrite,
  orgToday,
  timeZone,
}: {
  reviewId: string;
  item: SupplierRiskItem;
  people: SupplierRiskPerson[];
  canWrite: boolean;
  orgToday: string;
  timeZone: string;
}) {
  const [editing, setEditing] = React.useState(false);
  const question = vendorRiskQuestion(item.questionKey);
  return (
    <li className="space-y-2 py-3" data-item-id={item.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-foreground text-[13.5px] font-medium">
          {question?.text ?? item.questionKey}
        </h3>
        {item.severity ? (
          <Badge variant={SEVERITY_TONE[item.severity]}>
            {VENDOR_RISK_SEVERITY_WORDS[item.severity]}
          </Badge>
        ) : null}
      </div>
      <dl className="text-ink-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] leading-5 sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">Answer</dt>
        <dd>{item.answer ? VENDOR_RISK_ITEM_ANSWER_WORDS[item.answer] : '—'}</dd>
        <dt className="text-muted-foreground">Finding</dt>
        <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">
          {item.finding}
        </dd>
        <dt className="text-muted-foreground">What to do</dt>
        <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">
          {item.action}
        </dd>
        <dt className="text-muted-foreground">Owner</dt>
        <dd>
          {item.ownerName ? (
            <>
              <bdi>{item.ownerName}</bdi>
              {!item.ownerIsAdmin ? ` (${SUPPLIER_RISK_OWNER_NOT_ADMIN})` : null}
            </>
          ) : (
            'No owner yet'
          )}
        </dd>
        <dt className="text-muted-foreground">Due</dt>
        <dd>{supplierRiskDay(item.dueOn)}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{VENDOR_RISK_ITEM_STATUS_WORDS[item.status]}</dd>
      </dl>
      {item.status === 'accepted' && item.acceptedReason ? (
        <p className="text-ink-2 text-[13px]" data-slot="supplier-risk-accepted">
          Accepted by <bdi>{item.acceptedByName ?? 'Unknown'}</bdi>:{' '}
          <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {item.acceptedReason}
          </span>
        </p>
      ) : null}
      {item.changedByName ? (
        <p className="text-muted-foreground text-[12px]">
          Last changed by <bdi>{item.changedByName}</bdi> on{' '}
          <SupplierRiskTime at={item.changedAt} timeZone={timeZone} />.
        </p>
      ) : null}
      {canWrite ? (
        editing ? (
          <ItemEditor
            reviewId={reviewId}
            item={item}
            people={people}
            orgToday={orgToday}
            onDone={() => setEditing(false)}
          />
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setEditing(true)}
            aria-label={`Change the item: ${question?.text ?? item.questionKey}`}
          >
            Change
          </Button>
        )
      ) : null}
    </li>
  );
}

function ItemEditor({
  reviewId,
  item,
  people,
  orgToday,
  onDone,
}: {
  reviewId: string;
  item: SupplierRiskItem;
  people: SupplierRiskPerson[];
  orgToday: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [status, setStatus] = React.useState<VendorRiskItemStatus>(item.status);
  const [owner, setOwner] = React.useState(item.ownerUserId ?? '');
  const [dueOn, setDueOn] = React.useState(item.dueOn ?? '');
  const [action, setAction] = React.useState(item.action);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<SupplierRiskOutcome | null>(null);
  const formId = React.useId();
  const accepting = status === 'accepted';
  const needsReason = accepting && item.status !== 'accepted';
  // The current owner stays choosable even when no longer an owner or admin
  // (keeping them is allowed); a new owner must be a current one.
  const ownerListed = owner === '' || people.some((p) => p.userId === owner);

  function problem(): string | null {
    if (supplierRiskTextProblem(action, VENDOR_RISK_ACTION_MAX))
      return VENDOR_RISK_REFUSAL_WORDS.bad_item_text;
    if (dueOn && dueOn !== item.dueOn && !vendorRiskDueDateAllowed(dueOn, orgToday)) {
      return VENDOR_RISK_REFUSAL_WORDS.bad_item_due_on;
    }
    if (needsReason && !vendorRiskReasonCount(reason).ok)
      return VENDOR_RISK_REFUSAL_WORDS.bad_item_reason;
    if (accepting && reason && !vendorRiskReasonCount(reason).ok)
      return VENDOR_RISK_REFUSAL_WORDS.bad_item_reason;
    return null;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const p = problem();
    if (p) {
      setOutcome({ text: p, setUp: false, reload: false });
      return;
    }
    setBusy(true);
    setOutcome(null);
    const input = {
      reviewId,
      itemId: item.id,
      status,
      ownerUserId: owner || null,
      dueOn: dueOn || null,
      action: action !== item.action ? action : null,
      reason: accepting && reason ? reason : null,
    };
    const res = await sendWithStepUp(() => updateSupplierRiskItemAction(input), stepUp.ensure);
    setBusy(false);
    if (!res.ok) {
      setOutcome(supplierRiskOutcomeOf(res.error));
      return;
    }
    toast.success('Item saved.');
    onDone();
    router.refresh();
  }

  return (
    <>
      <form
        onSubmit={save}
        className="border-border bg-sunk space-y-3 rounded-md border p-3"
        noValidate
        aria-label="Change this item"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor={`${formId}-status`}>Status</Label>
            <select
              id={`${formId}-status`}
              className={NATIVE_SELECT}
              value={status}
              onChange={(e) => setStatus(e.target.value as VendorRiskItemStatus)}
            >
              {VENDOR_RISK_ITEM_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {VENDOR_RISK_ITEM_STATUS_WORDS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${formId}-owner`}>Owner (an owner or admin)</Label>
            <select
              id={`${formId}-owner`}
              className={NATIVE_SELECT}
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            >
              <option value="">No owner</option>
              {!ownerListed && item.ownerUserId ? (
                <option value={item.ownerUserId}>
                  {`${item.ownerName ?? 'Unknown'} (${SUPPLIER_RISK_OWNER_NOT_ADMIN})`}
                </option>
              ) : null}
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${formId}-due`}>Due</Label>
            <Input
              id={`${formId}-due`}
              type="date"
              value={dueOn}
              min={orgToday}
              max={addVendorRiskMonths(orgToday, 36)}
              onChange={(e) => setDueOn(e.target.value)}
            />
          </div>
        </div>
        <CleanTextField
          id={`${formId}-action`}
          label="What to do"
          max={VENDOR_RISK_ACTION_MAX}
          value={action}
          onChange={setAction}
        />
        {accepting ? (
          <ReasonField
            id={`${formId}-reason`}
            label={
              needsReason
                ? 'Why the risk is accepted'
                : 'A new reason (leave empty to keep the one given)'
            }
            help="Kept on the item with your name, and shown to the owners and admins."
            required={needsReason}
            value={reason}
            onChange={setReason}
          />
        ) : null}
        <SupplierRiskOutcomeNote outcome={outcome} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Saving…' : 'Save the item'}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
      {stepUp.modal}
    </>
  );
}
