'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { seedRecurringTemplateFromPoAction } from '@/server/actions/recurring-pos';

interface Props {
  poId: string;
}

/**
 * Appears on the PO detail page. Fetches the seed payload from the server
 * action, then navigates to /dashboard/purchase-orders/recurring with the
 * seed stored in sessionStorage so the panel opens pre-filled.
 */
export function MakeRecurringButton({ poId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function handle() {
    setBusy(true);
    const res = await seedRecurringTemplateFromPoAction(poId);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    // Persist seed in sessionStorage — the recurring page will pick it up on
    // mount (handled inside RecurringTemplatesSeedLoader).
    sessionStorage.setItem(
      'recurring-po-seed',
      JSON.stringify(res.data),
    );
    router.push('/dashboard/purchase-orders/recurring');
  }

  return (
    <Button variant="outline" size="sm" onClick={handle} disabled={busy}>
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <RefreshCw className="h-4 w-4" />
      )}
      Make recurring
    </Button>
  );
}
