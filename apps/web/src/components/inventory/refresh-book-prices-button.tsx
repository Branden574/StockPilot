'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { refreshBookPricesAction } from '@/server/actions/price-tracking';

export function RefreshBookPricesButton() {
  const [loading, setLoading] = React.useState(false);
  async function run() {
    setLoading(true);
    const res = await refreshBookPricesAction();
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Prices refreshed — ${res.data.written} updated, ${res.data.skipped} skipped of ${res.data.scanned}.`);
  }
  return (
    <Button type="button" variant="outline" size="sm" onClick={run} disabled={loading}>
      {loading ? 'Refreshing…' : 'Refresh book prices'}
    </Button>
  );
}
