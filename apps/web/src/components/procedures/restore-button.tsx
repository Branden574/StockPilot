'use client';

import { Loader2, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { isControlFlow } from '@/lib/control-flow';
import { requestFailedMessage } from '@/lib/request-failure';
import { restoreProcedureAction } from '@/server/actions/procedures';

/**
 * Restore action for an archived procedure. Mirrors ArchiveButton in
 * shape but uses the `primary` tone of the shared DestructiveConfirm
 * primitive — restore isn't destructive, it's an inverse.
 */
export function RestoreButton({ procedureId, title }: { procedureId: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // Why the last try failed, inside the confirm (a toast sits behind it).
  // Cleared on open and on each try.
  const [error, setError] = React.useState<string | null>(null);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await restoreProcedureAction(procedureId);
      if (!res.ok) {
        setError(res.error.message);
        toast.error(res.error.message);
        return;
      }
      // Closed only once it worked: a failure keeps the confirm open, with
      // the reason inside it, and Cancel closes it.
      setOpen(false);
      toast.success('Procedure restored.');
      router.refresh();
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      const message = requestFailedMessage(e, 'restore the procedure');
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {busy ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
        )}
        Restore
      </Button>
      <DestructiveConfirm
        open={open}
        onOpenChange={setOpen}
        title={`Restore "${title}"?`}
        description="This brings the procedure back into the active list."
        confirmLabel="Restore"
        tone="primary"
        pending={busy}
        error={error}
        onConfirm={onConfirm}
      />
    </>
  );
}
