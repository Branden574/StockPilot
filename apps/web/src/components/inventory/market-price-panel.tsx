'use client';

import { Star } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection } from '@/components/patterns/detail-section';
import { Button } from '@/components/ui/button';
import { fetchItemPriceAction } from '@/server/actions/price-tracking';
import type { PriceObservationRow } from '@/server/services/price-tracking';

/**
 * Market price on the item page (Phase 6): the latest Google Books list and
 * retail price for the book's ISBN beside this organization's own retail price
 * and cost, with Refresh. Drawn as the redesign's titled section (DESIGN-SPEC
 * 6.7); every word and figure is unchanged.
 */
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
    <DetailSection
      title="Market price · Google Books"
      aside={
        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? 'Fetching…' : 'Refresh'}
        </Button>
      }
    >
      {!obs ? (
        <p className="text-muted-foreground text-[13.5px]">
          No market data yet. Click Refresh to look it up by ISBN.
        </p>
      ) : (
        <div className="flex gap-4">
          {obs.thumbnail_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={obs.thumbnail_url}
              alt=""
              className="border-border h-20 w-auto shrink-0 rounded-sm border bg-white"
            />
          )}
          <dl className="grid flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[13.5px] leading-[20.25px]">
            <dt className="text-muted-foreground">List price</dt>
            <dd className="tabular-nums">{money(obs.list_price, obs.currency)}</dd>
            <dt className="text-muted-foreground">Retail price</dt>
            <dd className="tabular-nums">{money(obs.retail_price, obs.currency)}</dd>
            <dt className="text-muted-foreground">Your retail</dt>
            <dd className="tabular-nums">{money(ourRetail, 'USD')}</dd>
            <dt className="text-muted-foreground">Your cost</dt>
            <dd className="tabular-nums">{money(ourCost, 'USD')}</dd>
            {obs.average_rating != null && (
              <>
                <dt className="text-muted-foreground">Rating</dt>
                {/* The star is drawn as an icon, not a character (no emoji or
                    symbol glyphs in the redesigned copy); the label names it. */}
                <dd className="inline-flex items-center gap-1 tabular-nums">
                  {obs.average_rating}
                  <Star className="size-3.5 fill-current" aria-hidden />
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
      {obs?.info_link && (
        <a
          href={obs.info_link}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:text-foreground mt-3 inline-block text-[12.5px] transition-colors"
        >
          View on Google Books →
        </a>
      )}
      {obs?.observed_at && (
        <p className="text-muted-foreground mt-2 text-[12px]">
          Observed {obs.observed_at.slice(0, 10)}
        </p>
      )}
    </DetailSection>
  );
}
