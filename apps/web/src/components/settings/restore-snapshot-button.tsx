'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useStepUp } from '@/components/auth/step-up-modal';
import { restoreFromPointAction } from '@/server/actions/restore-points';

/**
 * Per-row "Restore" — opens an inline confirm where the operator must type
 * RESTORE. The action re-gates (owner/admin + Business + MFA step-up). A
 * pre-restore snapshot is taken automatically, so this is undoable.
 *
 * When the fresh MFA step-up has lapsed the action returns `aal2_required`; we
 * prompt for the authenticator code in-place (no sign-out) and retry.
 */
export function RestoreSnapshotButton({ id, when }: { id: string; when: string }) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function run() {
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
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hover:bg-muted rounded-md border px-2 py-1 text-xs font-medium"
      >
        Restore
      </button>
    );
  }

  return (
    <>
      {stepUp.modal}
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
          disabled={busy || confirm !== 'RESTORE'}
          className="bg-destructive text-destructive-foreground rounded-md px-2 py-1 text-xs font-semibold disabled:opacity-50"
        >
          {busy ? 'Restoring…' : 'Confirm'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setConfirm('');
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
