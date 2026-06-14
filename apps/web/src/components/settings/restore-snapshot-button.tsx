'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { restoreFromPointAction } from '@/server/actions/restore-points';

/**
 * Per-row "Restore" — opens an inline confirm where the operator must type
 * RESTORE. The action re-gates (owner/admin + Business + MFA step-up). A
 * pre-restore snapshot is taken automatically, so this is undoable.
 */
export function RestoreSnapshotButton({ id, when }: { id: string; when: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function run() {
    setBusy(true);
    const r = await restoreFromPointAction({ id, confirm });
    setBusy(false);
    if (!r.ok) {
      if (r.error.details?.reason === 'aal2_required') {
        toast.error('Re-authenticate with MFA, then try again.');
      } else {
        toast.error(r.error.message);
      }
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
        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
      >
        Restore
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-[11px] text-muted-foreground">
        Type <span className="font-mono font-semibold">RESTORE</span> to roll back to {when}:
      </span>
      <input
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="RESTORE"
        className="h-7 w-24 rounded-md border bg-background px-2 text-xs outline-none"
        disabled={busy}
      />
      <button
        type="button"
        onClick={run}
        disabled={busy || confirm !== 'RESTORE'}
        className="rounded-md bg-destructive px-2 py-1 text-xs font-semibold text-destructive-foreground disabled:opacity-50"
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
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        Cancel
      </button>
    </div>
  );
}
