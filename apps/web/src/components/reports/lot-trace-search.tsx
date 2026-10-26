'use client';

import * as React from 'react';

import { formatOrderNumber } from '@stockpilot/core';

import { DetailSection } from '@/components/patterns/detail-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { isControlFlow } from '@/lib/control-flow';
import { traceLotAction } from '@/server/actions/lot-trace';
import type { LotTraceResult } from '@/server/services/lots';

export function LotTraceSearch() {
  const [term, setTerm] = React.useState('');
  const [result, setResult] = React.useState<LotTraceResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  // Each result card's heading names its table's scroll region.
  const receivedId = React.useId();
  const pickedId = React.useId();

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    // The action answers every server-side failure with a result, but the
    // call itself can still reject (the network dropped, the deployment
    // changed under the tab). The button used to stay on "Searching…" and
    // disabled for good then; now it comes back and the reason is shown.
    try {
      const res = await traceLotAction(term);
      if (!res.ok) {
        setError(res.error.message);
        setResult(null);
        return;
      }
      setResult(res.data);
    } catch (caught) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(caught)) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={run} className="flex max-w-xl gap-2">
        {/* Named by its own words: the placeholder alone gave the field no
            accessible name once something was typed. */}
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Lot number (partial ok)"
          aria-label="Lot number (partial ok)"
        />
        <Button type="submit" disabled={loading} className="max-sm:h-11">
          {loading ? 'Searching…' : 'Trace'}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      )}
      {result && (
        <>
          <DetailSection
            headingId={receivedId}
            title={<>Received ({result.receipts.length})</>}
            flush
          >
            <Table scrollLabelledBy={receivedId} className="min-w-[560px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Receipt</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.receipts.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-[12.5px]">
                      {r.receiptNumber ?? '—'}
                    </TableCell>
                    <TableCell className="font-medium">{r.itemName}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {r.receivedAt.slice(0, 10)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {r.expirationDate ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.qty}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DetailSection>
          <DetailSection
            headingId={pickedId}
            title={<>Picked / shipped ({result.picks.length})</>}
            flush
          >
            <Table scrollLabelledBy={pickedId} className="min-w-[420px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Order</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.picks.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={3}
                      className="text-muted-foreground py-8 text-center text-[13px]"
                    >
                      No recorded picks.
                    </TableCell>
                  </TableRow>
                )}
                {result.picks.map((p, i) => (
                  <TableRow key={i}>
                    {/* The real SO- handle. Legacy orders carry no
                        order_number — those fall back to the id prefix. */}
                    <TableCell className="font-mono text-[12.5px]">
                      {formatOrderNumber(p.orderNumber) ??
                        (p.orderRequestId ? p.orderRequestId.slice(0, 8).toUpperCase() : '—')}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {p.pickedAt.slice(0, 10)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.qty}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DetailSection>
        </>
      )}
    </div>
  );
}
