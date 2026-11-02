'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isControlFlow } from '@/lib/control-flow';
import { requestUnconfirmedMessage } from '@/lib/request-failure';
import { createRestorePointAction } from '@/server/actions/restore-points';

/** "Create restore point" — captures a snapshot now, with an optional label. */
export function CreateRestorePointButton() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [label, setLabel] = React.useState('');

  async function create() {
    setBusy(true);
    let r: Awaited<ReturnType<typeof createRestorePointAction>>;
    try {
      r = await createRestorePointAction({ label: label.trim() || undefined });
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      // Sent again, a restore point that was made is made twice.
      toast.error(
        requestUnconfirmedMessage(e, 'the restore point was created', 'the restore points list'),
      );
      return;
    } finally {
      setBusy(false);
    }
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success(
      `Restore point created — ${r.data.itemCount} items${r.data.capped ? ' (capped)' : ''}.`,
    );
    setLabel('');
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Optional label (e.g. before bulk edit)"
        aria-label="Restore point label (optional)"
        className="min-w-0 max-w-xs flex-1 basis-56"
        disabled={busy}
      />
      <Button onClick={create} disabled={busy}>
        {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
        Create restore point
      </Button>
    </div>
  );
}
