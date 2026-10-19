'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Loader2, TriangleAlert } from 'lucide-react';

import { useStepUp } from '@/components/auth/step-up-modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  restoreFromPointAction,
  restorePointSkuChangesAction,
} from '@/server/actions/restore-points';
import type { RestorePointSkuChanges } from '@/server/services/restore-points';

import { RESTORE_SKU_COPY } from './restore-sku-warning-copy';

/**
 * Per-row "Restore" — opens an inline confirm where the operator must type
 * RESTORE. The action re-gates (owner/admin + Business + MFA step-up). A
 * pre-restore snapshot is taken automatically, so this is undoable.
 *
 * When the fresh MFA step-up has lapsed the action returns `aal2_required`; we
 * prompt for the authenticator code in-place (no sign-out) and retry.
 *
 * Opening the row first asks which records changed SKU since the point (Ungroup
 * D1 b). A point taken before restore points carried record ids matches by SKU
 * and rack, so the row names those records BEFORE the typed confirm.
 */
export function RestoreSnapshotButton({
  id,
  when,
  createdAt,
}: {
  id: string;
  /** The point's time as words, for callers that format it themselves. */
  when?: string;
  /**
   * The point's time (ISO). The Backups page passes this instead of `when`,
   * so the time in "roll back to …" is the VIEWER's (CONFLICTS D13): the page
   * is a server component and formatted it in the server's zone (UTC on
   * Vercel). The sentence only shows after a click, long after hydration, so
   * formatting it here can never mismatch the server HTML.
   */
  createdAt?: string;
}) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [skuCheck, setSkuCheck] = React.useState<
    | { state: 'idle' | 'checking' }
    | { state: 'failed'; noAuditAccess?: boolean }
    | { state: 'done'; data: RestorePointSkuChanges }
  >({ state: 'idle' });

  async function openRow() {
    setOpen(true);
    setSkuCheck({ state: 'checking' });
    try {
      const r = await restorePointSkuChangesAction({ id });
      setSkuCheck(
        r.ok
          ? { state: 'done', data: r.data }
          : {
              state: 'failed',
              // The admin cannot view the audit log the check reads (DATA-1 (2)).
              noAuditAccess: r.error.details?.reason === 'audit_log_hidden',
            },
      );
    } catch {
      setSkuCheck({ state: 'failed' });
    }
  }

  // The warning is a version 1 point's only guard, so Confirm waits for the
  // check: on only once it answered (the warning, or nothing to warn about) or
  // failed (which says so). Never while it is still on its way.
  const checkSettled = skuCheck.state === 'done' || skuCheck.state === 'failed';

  async function run() {
    if (!checkSettled) return;
    setBusy(true);
    const payload = { id, confirm };
    let r = await restoreFromPointAction(payload);
    // Fresh MFA step-up needed → prompt for the authenticator code in-place
    // (no sign-out) and retry with the identical payload.
    if (!r.ok && r.error.details?.reason === 'aal2_required') {
      if (!(await stepUp.ensure())) {
        setBusy(false);
        return;
      }
      r = await restoreFromPointAction(payload);
    }
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    const d = r.data;
    toast.success(
      `Restored: ${d.updated} updated, ${d.recreated} re-created, ${d.quantityAdjusted} quantities reset` +
        (d.extrasFlagged ? ` · ${d.extrasFlagged} extra item(s) flagged` : '') +
        (d.failures ? ` · ${d.failures} failed` : ''),
    );
    setOpen(false);
    setConfirm('');
    setSkuCheck({ state: 'idle' });
    router.refresh();
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => void openRow()}>
        Restore
      </Button>
    );
  }

  const whenText = createdAt ? new Date(createdAt).toLocaleString() : (when ?? '');
  const changes = skuCheck.state === 'done' ? skuCheck.data.changes : [];
  // PR stage fix round 1 (F3): the check reads at most SKU_CHANGES_SCAN audit
  // rows, and the split rows it leaves out count against that limit, so a
  // check cut off there may have named nothing. That is never an all-clear.
  const cutOff = skuCheck.state === 'done' && skuCheck.data.truncated;
  // The warnings stay ABOVE the typed confirm, and Confirm stays disabled
  // until the check has answered (Ungroup D1 b). The amber lines carry an icon
  // so the warning never relies on colour alone.
  return (
    <div className="ml-auto flex max-w-[460px] flex-col items-stretch gap-2 text-left">
      {stepUp.modal}
      {skuCheck.state === 'checking' ? (
        <p
          role="status"
          className="text-muted-foreground flex items-start gap-1.5 text-left text-[12px]"
        >
          <Loader2 aria-hidden className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
          <span>{RESTORE_SKU_COPY.checking}</span>
        </p>
      ) : null}
      {skuCheck.state === 'failed' ? (
        <p className="text-warning flex items-start gap-1.5 text-left text-[12px]">
          <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {skuCheck.noAuditAccess ? RESTORE_SKU_COPY.noAuditAccess : RESTORE_SKU_COPY.failed}
          </span>
        </p>
      ) : null}
      {cutOff && changes.length === 0 ? (
        <p className="text-warning flex items-start gap-1.5 text-left text-[12px]">
          <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{RESTORE_SKU_COPY.cutOff}</span>
        </p>
      ) : null}
      {skuCheck.state === 'done' && changes.length > 0 ? (
        <div
          role="alert"
          className="border-warning/40 bg-warning-wash text-foreground rounded-md border p-2.5 text-left text-[12px]"
        >
          <p className="text-warning flex items-start gap-1.5 font-semibold">
            <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{RESTORE_SKU_COPY.heading}</span>
          </p>
          <p className="mt-1">{RESTORE_SKU_COPY.body}</p>
          <ul className="mt-1 list-disc pl-4">
            {changes.map((c, i) => (
              <li key={c.itemId ?? i}>{RESTORE_SKU_COPY.line(c)}</li>
            ))}
            {skuCheck.data.more > 0 || cutOff ? (
              <li>{RESTORE_SKU_COPY.more(skuCheck.data.more, skuCheck.data.truncated)}</li>
            ) : null}
          </ul>
          <p className="mt-1">{RESTORE_SKU_COPY.advice}</p>
        </div>
      ) : null}
      {/* 8 px apart: the 28 px buttons' 44 px touch areas (coarse pointers)
          must not overlap. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-muted-foreground text-[12px]">
          Type <span className="text-foreground font-mono font-semibold">RESTORE</span> to roll back
          to {whenText}:
        </span>
        <Input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="RESTORE"
          aria-label={`Type RESTORE to roll back to ${whenText}`}
          autoComplete="off"
          spellCheck={false}
          className="h-7 w-28 font-mono text-[12px]"
          disabled={busy}
        />
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={run}
          disabled={busy || !checkSettled || confirm !== 'RESTORE'}
        >
          {busy ? 'Restoring…' : 'Confirm'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setConfirm('');
            setSkuCheck({ state: 'idle' });
          }}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
