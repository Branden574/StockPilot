'use client';

import { Loader2, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { isControlFlow } from '@/lib/control-flow';
import { requestFailedMessage } from '@/lib/request-failure';
import { restoreBundleAction } from '@/server/actions/bundles';

/**
 * Restore button for archived bundles. Pairs with ArchiveBundleButton —
 * the two appear in mutually exclusive views (Active vs Archived). The
 * restore confirm uses the shared DestructiveConfirm primitive in
 * `primary` tone so it doesn't look like a red-flag action.
 */
export function RestoreBundleButton({
  bundleId,
  bundleName,
}: {
  bundleId: string;
  bundleName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  async function confirmRestore() {
    setBusy(true);
    let res: Awaited<ReturnType<typeof restoreBundleAction>>;
    try {
      res = await restoreBundleAction(bundleId);
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      toast.error(requestFailedMessage(e, 'restore the bundle'));
      return;
    } finally {
      setBusy(false);
    }
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setOpen(false);
    toast.success(`"${bundleName}" restored.`);
    router.refresh();
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={busy}>
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" />
        )}
        Restore
      </Button>
      <DestructiveConfirm
        open={open}
        onOpenChange={setOpen}
        title={`Restore "${bundleName}"?`}
        description="This brings the bundle back into the active list."
        confirmLabel="Restore"
        tone="primary"
        pending={busy}
        onConfirm={confirmRestore}
      />
    </>
  );
}
