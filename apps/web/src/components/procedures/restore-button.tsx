'use client';

import { Loader2, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { restoreProcedureAction } from '@/server/actions/procedures';

/**
 * Restore action for an archived procedure. Mirrors ArchiveButton in
 * shape but uses the `primary` tone of the shared DestructiveConfirm
 * primitive — restore isn't destructive, it's an inverse.
 */
export function RestoreButton({
  procedureId,
  title,
}: {
  procedureId: string;
  title: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function onConfirm() {
    setBusy(true);
    try {
      const res = await restoreProcedureAction(procedureId);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success('Procedure restored.');
      router.refresh();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
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
        onConfirm={onConfirm}
      />
    </>
  );
}
