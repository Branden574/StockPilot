'use client';

import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
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

  async function onConfirm() {
    setBusy(true);
    try {
      const res = await archiveProcedureAction(procedureId);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success('Procedure archived.');
      router.push('/dashboard/procedures');
      router.refresh();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
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
            The procedure is hidden from the list. Existing videos and comments stay in
            storage. You can restore it from the <strong>Archived view</strong>.
          </>
        }
        confirmLabel="Archive"
        pending={busy}
        onConfirm={onConfirm}
      />
    </>
  );
}
