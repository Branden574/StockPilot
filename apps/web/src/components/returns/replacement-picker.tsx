'use client';

import { Loader2, Search } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import {
  exchangeCandidateRows,
  returnLineLabel,
  RETURNS_COPY,
  type ActionResult,
  type ExchangeCandidateRow,
  type ExchangeCandidatesAnswer,
} from '@stockpilot/core';

/**
 * The replacement picker (returns RX-2): the returned item's other sizes
 * first, in size order (the items' own variant sizes, never a name guess),
 * then a name or SKU search over items orderable in the order's warehouse,
 * each with its free stock for the quantity asked ("Available: 14" or
 * "Short: 0 available, 1 needed."). The search is the database's
 * (return_exchange_candidates, under the viewer's item scope); a short item
 * stays choosable (the approval then refuses with the numbers, or goes on
 * backorder when asked to).
 */
export function ReplacementPicker({
  load,
  needed,
  selectedItemId,
  onSelect,
  disabled = false,
  label,
}: {
  /** One candidates read: '' answers the siblings only. */
  load: (q: string) => Promise<ActionResult<ExchangeCandidatesAnswer>>;
  needed: number;
  selectedItemId: string | null;
  onSelect: (row: ExchangeCandidateRow, label: string) => void;
  disabled?: boolean;
  /** The returned line the picker is for ("New Hire Shirt, M"). */
  label: string;
}) {
  const groupId = React.useId();
  const [q, setQ] = React.useState('');
  const [answer, setAnswer] = React.useState<ExchangeCandidatesAnswer | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const loadRef = React.useRef(load);
  React.useEffect(() => {
    loadRef.current = load;
  }, [load]);

  React.useEffect(() => {
    let live = true;
    const term = q.trim();
    const run = async () => {
      setLoading(true);
      const res = await loadRef.current(term.length >= 2 ? term : '');
      if (!live) return;
      setLoading(false);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      setError(null);
      setAnswer(res.data);
    };
    const t = setTimeout(() => void run(), term.length >= 2 ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const rows = answer ? exchangeCandidateRows(answer, needed) : { siblings: [], matches: [] };
  const term = q.trim();

  const renderRow = (row: ExchangeCandidateRow) => {
    const rowLabel = returnLineLabel(row.name, row.variantSize);
    const checked = selectedItemId === row.itemId;
    return (
      <label
        key={row.itemId}
        className={cn(
          'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm',
          checked ? 'border-foreground bg-muted' : 'border-border',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <input
          type="radio"
          name={`${groupId}-replacement`}
          value={row.itemId}
          checked={checked}
          disabled={disabled}
          onChange={() => onSelect(row, rowLabel)}
          className="mt-0.5 h-3.5 w-3.5"
        />
        {/* Review fix P3: the whole name, wrapped, never cut (its size is in
            it); below sm the availability goes under the name. */}
        <span data-replacement-row className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <span className="min-w-0">
            <span className="block break-words font-medium">{rowLabel}</span>
            <span className="text-muted-foreground block text-xs">{row.sku ?? ''}</span>
          </span>
          <span className="flex flex-col items-start gap-1 sm:shrink-0 sm:items-end sm:text-right">
            <span className={cn('text-xs tabular-nums', row.short ? 'text-destructive' : 'text-muted-foreground')}>
              {row.availability}
            </span>
            {row.isReturnedItem ? <Badge variant="outline">{RETURNS_COPY.replacementSameAsReturned}</Badge> : null}
          </span>
        </span>
      </label>
    );
  };

  return (
    <div className="space-y-3" aria-busy={loading}>
      <fieldset disabled={disabled} className="space-y-1.5">
        <legend className="text-muted-foreground font-mono text-[10.5px] uppercase tracking-[0.12em]">
          {RETURNS_COPY.replacementSiblings}
          <span className="sr-only"> for {label}</span>
        </legend>
        <div role="radiogroup" aria-label={`${RETURNS_COPY.replacementSiblings} for ${label}`} className="space-y-1.5">
          {rows.siblings.map(renderRow)}
          {!loading && rows.siblings.length === 0 ? (
            <p className="text-muted-foreground text-xs">{RETURNS_COPY.replacementNoMatches}</p>
          ) : null}
        </div>
      </fieldset>

      <fieldset disabled={disabled} className="space-y-1.5">
        <legend className="text-muted-foreground font-mono text-[10.5px] uppercase tracking-[0.12em]">
          {RETURNS_COPY.replacementOtherItems}
        </legend>
        <div className="relative">
          <Search className="text-muted-foreground absolute left-2.5 top-2.5 h-3.5 w-3.5" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={RETURNS_COPY.replacementSearchPlaceholder}
            aria-label={`${RETURNS_COPY.replacementSearchPlaceholder} for ${label}`}
            maxLength={80}
            className="pl-8"
          />
        </div>
        {term.length > 0 && term.length < 2 ? (
          <p className="text-muted-foreground text-xs">{RETURNS_COPY.replacementSearchHint}</p>
        ) : null}
        {term.length >= 2 ? (
          <div role="radiogroup" aria-label={`${RETURNS_COPY.replacementOtherItems} for ${label}`} className="space-y-1.5">
            {rows.matches.map(renderRow)}
            {!loading && rows.matches.length === 0 ? (
              <p className="text-muted-foreground text-xs">{RETURNS_COPY.replacementNoMatches}</p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      {loading ? (
        <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading
        </p>
      ) : null}
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
