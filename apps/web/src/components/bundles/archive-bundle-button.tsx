'use client';

import { Archive, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { isControlFlow } from '@/lib/control-flow';
import { requestFailedMessage } from '@/lib/request-failure';
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
    let res: Awaited<ReturnType<typeof archiveBundleAction>>;
    try {
      res = await archiveBundleAction(bundleId);
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      toast.error(requestFailedMessage(e, 'archive the bundle'));
      return;
    } finally {
      setBusy(false);
    }
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
            The bundle is hidden from the active list. Existing distributions stay readable and on
            the audit trail. You can restore the bundle later from the{' '}
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
