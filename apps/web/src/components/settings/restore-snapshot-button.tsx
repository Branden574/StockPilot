'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useStepUp } from '@/components/auth/step-up-modal';
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
export function RestoreSnapshotButton({ id, when }: { id: string; when: string }) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [skuCheck, setSkuCheck] = React.useState<
    { state: 'idle' | 'checking' | 'failed' } | { state: 'done'; data: RestorePointSkuChanges }
  >({ state: 'idle' });

  async function openRow() {
    setOpen(true);
    setSkuCheck({ state: 'checking' });
    try {
      const r = await restorePointSkuChangesAction({ id });
      setSkuCheck(r.ok ? { state: 'done', data: r.data } : { state: 'failed' });
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
      <button
        type="button"
        onClick={() => void openRow()}
        className="hover:bg-muted rounded-md border px-2 py-1 text-xs font-medium"
      >
        Restore
      </button>
    );
  }

  const changes = skuCheck.state === 'done' ? skuCheck.data.changes : [];
  return (
    <>
      {stepUp.modal}
      {skuCheck.state === 'checking' ? (
        <p role="status" className="text-muted-foreground mb-2 text-left text-[11px]">
          {RESTORE_SKU_COPY.checking}
        </p>
      ) : null}
      {skuCheck.state === 'failed' ? (
        <p className="mb-2 text-left text-[11px] text-amber-700 dark:text-amber-400">
          {RESTORE_SKU_COPY.failed}
        </p>
      ) : null}
      {skuCheck.state === 'done' && changes.length > 0 ? (
        <div
          role="alert"
          className="mb-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-left text-[11px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="font-semibold">{RESTORE_SKU_COPY.heading}</p>
          <p className="mt-1">{RESTORE_SKU_COPY.body}</p>
          <ul className="mt-1 list-disc pl-4">
            {changes.map((c, i) => (
              <li key={c.itemId ?? i}>{RESTORE_SKU_COPY.line(c)}</li>
            ))}
            {skuCheck.data.more > 0 ? (
              <li>{RESTORE_SKU_COPY.more(skuCheck.data.more, skuCheck.data.truncated)}</li>
            ) : null}
          </ul>
          <p className="mt-1">{RESTORE_SKU_COPY.advice}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-muted-foreground text-[11px]">
          Type <span className="font-mono font-semibold">RESTORE</span> to roll back to {when}:
        </span>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="RESTORE"
          className="bg-background h-7 w-24 rounded-md border px-2 text-xs outline-none"
          disabled={busy}
        />
        <button
          type="button"
          onClick={run}
          disabled={busy || !checkSettled || confirm !== 'RESTORE'}
          className="bg-destructive text-destructive-foreground rounded-md px-2 py-1 text-xs font-semibold disabled:opacity-50"
        >
          {busy ? 'Restoring…' : 'Confirm'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setConfirm('');
            setSkuCheck({ state: 'idle' });
          }}
          disabled={busy}
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          Cancel
        </button>
      </div>
    </>
  );
}
