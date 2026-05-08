'use client';

import { Archive, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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

  async function archive() {
    if (!window.confirm(`Archive "${bundleName}"? Distributions stay readable.`)) {
      return;
    }
    setBusy(true);
    const res = await archiveBundleAction(bundleId);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Archived ${bundleName}.`);
    router.refresh();
  }

  return (
    <Button variant="ghost" onClick={archive} disabled={busy}>
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Archive className="h-3.5 w-3.5" />
      )}
      Archive
    </Button>
  );
}
