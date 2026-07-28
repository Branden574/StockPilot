'use client';

import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import {
  AMBIGUOUS_COLUMN_MEANINGS,
  AMBIGUOUS_COLUMN_MEANING_LABELS,
  lineNeedsMappingConfirmation,
  type AmbiguousColumnMeaning,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { confirmPoImportMappingsAction } from '@/server/actions/po-imports';

import type { PoImportLineRow } from '@/server/services/po-imports';

/**
 * The AI mapping confirmation step.
 *
 * Requirements: "Never silently guess: show candidate mappings + confidence,
 * require confirmation, preserve source values, block import until required
 * mappings resolved."
 *
 * A bare "Number" column is the canonical case — it could be a jersey number,
 * a quantity, a serial, a style number, or a PO line number. The extractor is
 * instructed to LOWER its mapping confidence rather than guess, and every line
 * it flagged lands here with its source value shown beside the choice.
 *
 * Nothing is pre-selected. There is no "accept all" and no default meaning:
 * the whole point of the step is that a human states what the column is.
 */
/**
 * Re-exported from core rather than reimplemented: this component and
 * `approve()` must agree exactly on which lines are flagged, or the screen
 * shows a block with no control (or hides one the server will refuse).
 */
export const needsMappingConfirmation = lineNeedsMappingConfirmation;

interface Props {
  poImportId: string;
  /** Every line of the import; the flagged ones are picked out here. */
  lines: PoImportLineRow[];
  /** False once the import is approved or canceled — then this is read-only. */
  editable: boolean;
  onConfirmed: () => void;
}

export function MappingConfirmation({ poImportId, lines, editable, onConfirmed }: Props) {
  const flagged = React.useMemo(() => lines.filter(needsMappingConfirmation), [lines]);
  const [choices, setChoices] = React.useState<Record<string, AmbiguousColumnMeaning>>({});
  const [busy, setBusy] = React.useState(false);

  if (flagged.length === 0) return null;

  const allAnswered = flagged.every((l) => choices[l.id] != null);

  async function submit() {
    setBusy(true);
    const r = await confirmPoImportMappingsAction({
      poImportId,
      decisions: Object.fromEntries(flagged.map((l) => [l.id, choices[l.id]!])),
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success(
      `Confirmed ${r.data.confirmed} column mapping${r.data.confirmed === 1 ? '' : 's'}.`,
    );
    onConfirmed();
  }

  return (
    <section className="border-warning/40 bg-warning/5 space-y-3 rounded-xl border p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">
            Confirm what {flagged.length} ambiguous column
            {flagged.length === 1 ? '' : 's'} mean
            {flagged.length === 1 ? 's' : ''}
          </h2>
          <p className="text-muted-foreground text-xs">
            A column headed something like &ldquo;Number&rdquo; could be a jersey number, a
            quantity, a serial, a style number or a PO line number. Rather than guess, the
            extractor flagged these lines. The value it read is shown beside each one and is
            kept exactly as printed; approval stays blocked until every row here is answered.
          </p>
        </div>
      </div>

      <div className="divide-border border-border bg-card divide-y rounded-md border">
        {flagged.map((l) => {
          const pct = Math.round((l.mapping_confidence ?? 0) * 100);
          return (
            <div
              key={l.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-xs"
            >
              <span className="font-mono">Line {l.line_number}</span>
              <span className="text-muted-foreground max-w-[260px] truncate">
                {l.description ?? '—'}
              </span>
              <span
                className="border-warning/40 bg-warning/10 text-warning rounded-full border px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide"
                title="How confident the extractor was that it put this value in the right field"
              >
                {pct}% mapping confidence
              </span>
              <span className="text-muted-foreground">
                value read:{' '}
                <span className="text-foreground font-mono">{l.jersey_number ?? '—'}</span>
              </span>
              <div className="ml-auto min-w-[200px]">
                <Select
                  value={choices[l.id] ?? ''}
                  onValueChange={(v) =>
                    setChoices((m) => ({ ...m, [l.id]: v as AmbiguousColumnMeaning }))
                  }
                  disabled={busy || !editable}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="What is this value?" />
                  </SelectTrigger>
                  <SelectContent>
                    {AMBIGUOUS_COLUMN_MEANINGS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {AMBIGUOUS_COLUMN_MEANING_LABELS[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          );
        })}
      </div>

      {editable && (
        <div className="flex items-center justify-end gap-2">
          {!allAnswered && (
            <span className="text-muted-foreground text-[11px]">
              Answer every row to continue.
            </span>
          )}
          <Button size="sm" onClick={submit} disabled={busy || !allAnswered}>
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Confirm mappings
          </Button>
        </div>
      )}
    </section>
  );
}
