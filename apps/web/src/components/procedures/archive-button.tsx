'use client';

import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { isControlFlow } from '@/lib/control-flow';
import { requestFailedMessage } from '@/lib/request-failure';
import { archiveProcedureAction } from '@/server/actions/procedures';

interface ArchiveButtonProps {
  procedureId: string;
}

/**
 * Small destructive-confirm wrapper around `archiveProcedureAction`.
 * Sits in the detail-page header for manager+ users; after a successful
 * archive we route back to the list and toast a confirmation.
 */
export function ArchiveButton({ procedureId }: ArchiveButtonProps) {
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
      const res = await archiveProcedureAction(procedureId);
      if (!res.ok) {
        setError(res.error.message);
        toast.error(res.error.message);
        return;
      }
      // Closed only once it worked: a failure keeps the confirm open, with
      // the reason inside it, and Cancel closes it.
      setOpen(false);
      toast.success('Procedure archived.');
      router.push('/dashboard/procedures');
      router.refresh();
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      const message = requestFailedMessage(e, 'archive the procedure');
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
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="text-destructive hover:text-destructive"
      >
        <Trash2 className="mr-1 h-3.5 w-3.5" /> Archive
      </Button>
      <DestructiveConfirm
        open={open}
        onOpenChange={setOpen}
        title="Archive this procedure?"
        description={
          <>
            The procedure is hidden from the list. Existing videos and comments stay in storage. You
            can restore it from the <strong>Archived view</strong>.
          </>
        }
        confirmLabel="Archive"
        pending={busy}
        error={error}
        onConfirm={onConfirm}
      />
    </>
  );
}
