'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { setWarehouseFilterAction } from '@/server/actions/warehouse-filter';

/**
 * "Search all warehouses" — clears the warehouse-filter cookie and refreshes.
 *
 * The filter cannot be cleared with a link: it lives in a cookie that a server
 * action sets (it is a per-browser view preference, not URL state). Same call
 * the sidebar picker makes, so the two cannot behave differently.
 */
export function ClearWarehouseFilterButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  return (
    <Button
      variant="gradient"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await setWarehouseFilterAction(null);
          if (!res.ok) {
            toast.error("Couldn't clear the warehouse filter. Try again.");
            return;
          }
          router.refresh();
        })
      }
    >
      {pending ? 'Clearing…' : label}
    </Button>
  );
}
