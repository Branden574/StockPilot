'use client';

import { Loader2, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useHydrated } from '@/lib/use-hydrated';
import { restoreDeletedAction } from '@/server/actions/recovery';

type Entity = 'inventory_items' | 'categories' | 'locations' | 'suppliers';

export function RestoreButton({
  entity,
  id,
  label,
}: {
  entity: Entity;
  id: string;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function restore() {
    setBusy(true);
    try {
      const res = await restoreDeletedAction({ entity, id });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success(`Restored "${label}".`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={restore} disabled={busy}>
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RotateCcw className="h-3.5 w-3.5" />
      )}
      Restore
    </Button>
  );
}

/**
 * The exact delete time for a Recovery row's tooltip, in the VIEWER's zone
 * (CONFLICTS D13). The page is a server component, so formatting it there
 * printed the server's zone (UTC on Vercel): an evening delete in Los Angeles
 * read as the next morning. The tooltip is added once the page has hydrated;
 * the relative words ("3 days ago") come from the server unchanged.
 */
export function DeletedAtTooltip({ iso, children }: { iso: string; children: React.ReactNode }) {
  const hydrated = useHydrated();
  return <span title={hydrated ? formatDeletedAtExact(iso) : undefined}>{children}</span>;
}

/** The tooltip's words: the local date and time, seconds dropped. */
export function formatDeletedAtExact(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
