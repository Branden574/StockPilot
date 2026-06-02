'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { traceLotAction } from '@/server/actions/lot-trace';
import type { LotTraceResult } from '@/server/services/lots';

export function LotTraceSearch() {
  const [term, setTerm] = React.useState('');
  const [result, setResult] = React.useState<LotTraceResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await traceLotAction(term);
    setLoading(false);
    if (!res.ok) {
      setError(res.error.message);
      setResult(null);
      return;
    }
    setResult(res.data);
  }

  return (
    <div>
      <form onSubmit={run} className="flex gap-2">
        <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Lot number (partial ok)" />
        <Button type="submit" disabled={loading}>{loading ? 'Searching…' : 'Trace'}</Button>
      </form>
      {error && <p className="text-destructive mt-2 text-sm">{error}</p>}
      {result && (
        <div className="mt-4 space-y-4">
          <section>
            <h2 className="text-sm font-medium">Received ({result.receipts.length})</h2>
            <div className="mt-2 overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">Receipt</th>
                    <th className="px-3 py-2 text-left">Item</th>
                    <th className="px-3 py-2 text-left">Received</th>
                    <th className="px-3 py-2 text-left">Expiry</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {result.receipts.map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2 font-mono">{r.receiptNumber ?? '—'}</td>
                      <td className="px-3 py-2">{r.itemName}</td>
                      <td className="px-3 py-2">{r.receivedAt.slice(0, 10)}</td>
                      <td className="px-3 py-2">{r.expirationDate ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{r.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <h2 className="text-sm font-medium">Picked / shipped ({result.picks.length})</h2>
            <div className="mt-2 overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">Order</th>
                    <th className="px-3 py-2 text-left">When</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {result.picks.length === 0 && (
                    <tr><td colSpan={3} className="text-muted-foreground px-3 py-4 text-center">No recorded picks.</td></tr>
                  )}
                  {result.picks.map((p, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2 font-mono">{p.orderRequestId ? p.orderRequestId.slice(0, 8).toUpperCase() : '—'}</td>
                      <td className="px-3 py-2">{p.pickedAt.slice(0, 10)}</td>
                      <td className="px-3 py-2 text-right">{p.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
