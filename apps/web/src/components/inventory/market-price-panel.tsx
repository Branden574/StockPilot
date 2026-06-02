'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { fetchItemPriceAction } from '@/server/actions/price-tracking';
import type { PriceObservationRow } from '@/server/services/price-tracking';

export function MarketPricePanel({
  itemId,
  initial,
  ourRetail,
  ourCost,
}: {
  itemId: string;
  initial: PriceObservationRow | null;
  ourRetail: number | null;
  ourCost: number | null;
}) {
  const [obs, setObs] = React.useState<PriceObservationRow | null>(initial);
  const [loading, setLoading] = React.useState(false);

  async function refresh() {
    setLoading(true);
    const res = await fetchItemPriceAction(itemId);
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setObs(res.data);
    toast.success(res.data ? 'Market price updated.' : 'No market data found for this ISBN.');
  }

  const money = (n: number | null, ccy: string | null) =>
    n == null ? '—' : `${ccy === 'USD' || !ccy ? '$' : ccy + ' '}${n.toFixed(2)}`;

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">Market price · Google Books</h3>
        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? 'Fetching…' : 'Refresh'}
        </Button>
      </div>
      {!obs ? (
        <p className="text-muted-foreground text-sm">No market data yet. Click Refresh to look it up by ISBN.</p>
      ) : (
        <div className="flex gap-4">
          {obs.thumbnail_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={obs.thumbnail_url} alt="" className="h-20 w-auto rounded border" />
          )}
          <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">List price</dt>
            <dd>{money(obs.list_price, obs.currency)}</dd>
            <dt className="text-muted-foreground">Retail price</dt>
            <dd>{money(obs.retail_price, obs.currency)}</dd>
            <dt className="text-muted-foreground">Your retail</dt>
            <dd>{money(ourRetail, 'USD')}</dd>
            <dt className="text-muted-foreground">Your cost</dt>
            <dd>{money(ourCost, 'USD')}</dd>
            {obs.average_rating != null && (
              <>
                <dt className="text-muted-foreground">Rating</dt>
                <dd>{obs.average_rating} ★</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {obs?.info_link && (
        <a href={obs.info_link} target="_blank" rel="noreferrer" className="text-primary mt-2 inline-block text-xs hover:underline">
          View on Google Books →
        </a>
      )}
      {obs?.observed_at && (
        <p className="text-muted-foreground mt-2 text-[11px]">Observed {obs.observed_at.slice(0, 10)}</p>
      )}
    </div>
  );
}
