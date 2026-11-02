'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { isControlFlow } from '@/lib/control-flow';
import { requestFailedMessage } from '@/lib/request-failure';
import { refreshBookPricesAction } from '@/server/actions/price-tracking';

export function RefreshBookPricesButton() {
  const [loading, setLoading] = React.useState(false);
  async function run() {
    setLoading(true);
    let res: Awaited<ReturnType<typeof refreshBookPricesAction>>;
    try {
      res = await refreshBookPricesAction();
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      toast.error(requestFailedMessage(e, 'refresh the book prices'));
      return;
    } finally {
      setLoading(false);
    }
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      `Prices refreshed — ${res.data.written} updated, ${res.data.skipped} skipped of ${res.data.scanned}.`,
    );
  }
  return (
    // A secondary header action: the page header's 32 px outline button.
    <Button type="button" variant="outline" onClick={run} disabled={loading}>
      {loading ? 'Refreshing…' : 'Refresh book prices'}
    </Button>
  );
}
