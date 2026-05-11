'use client';

import { Archive, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { archiveBundleAction } from '@/server/actions/bundles';

export function ArchiveBundleButton({
  bundleId,
  bundleName,
}: {
  bundleId: string;
  bundleName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  async function confirmArchive() {
    setBusy(true);
    const res = await archiveBundleAction(bundleId);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setOpen(false);
    toast.success(`"${bundleName}" archived.`);
    router.refresh();
  }

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} disabled={busy}>
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Archive className="h-3.5 w-3.5" />
        )}
        Archive
      </Button>
      <DestructiveConfirm
        open={open}
        onOpenChange={setOpen}
        title={`Archive "${bundleName}"?`}
        description={
          <>
            The bundle is hidden from the active list. Existing distributions stay readable
            and on the audit trail. You can restore the bundle later from the{' '}
            <strong>Archived view</strong>.
          </>
        }
        confirmLabel="Archive"
        pending={busy}
        onConfirm={confirmArchive}
      />
    </>
  );
}
