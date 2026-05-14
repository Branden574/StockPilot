'use client';

import { CheckCircle2, PlayCircle, Square } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { backfillItemEmbeddingsAction } from '@/server/actions/embeddings';

interface PanelProps {
  initialRemaining: number;
  initialTotal: number;
}

const BATCH_SIZE = 50;

/**
 * Loops backfillItemEmbeddingsAction until `remaining` hits 0 or the
 * user clicks Stop. Each call does 50 items at ~50ms apart, so a
 * 1,000-item backfill is roughly 1 minute end-to-end.
 *
 * State machine: idle → running → done | stopped. The button label
 * + icon reflects the state; the in-progress run can be safely
 * stopped between batches (the running batch finishes, then the
 * loop exits).
 */
export function EmbeddingsBackfillPanel({
  initialRemaining,
  initialTotal,
}: PanelProps) {
  const [remaining, setRemaining] = React.useState(initialRemaining);
  const [total, setTotal] = React.useState(initialTotal);
  const [embeddedThisSession, setEmbeddedThisSession] = React.useState(0);
  const [failedThisSession, setFailedThisSession] = React.useState(0);
  const [state, setState] = React.useState<'idle' | 'running' | 'done' | 'stopped'>(
    initialRemaining === 0 ? 'done' : 'idle',
  );
  const stopRef = React.useRef(false);

  const done = total > 0 ? total - remaining : 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;

  async function start() {
    stopRef.current = false;
    setState('running');
    setEmbeddedThisSession(0);
    setFailedThisSession(0);

    let safety = 0;
    while (!stopRef.current && safety < 500) {
      safety += 1;
      const res = await backfillItemEmbeddingsAction({ limit: BATCH_SIZE });
      if (!res.ok) {
        toast.error(res.error.message);
        setState('stopped');
        return;
      }
      setEmbeddedThisSession((s) => s + res.data.embedded);
      setFailedThisSession((s) => s + res.data.failed);
      setRemaining(res.data.remaining);
      // total can drift if items are created/archived during the run —
      // recompute it so the bar tracks reality.
      setTotal((t) => Math.max(t, res.data.remaining + done + res.data.embedded));
      if (res.data.remaining === 0 || res.data.embedded === 0) {
        setState(res.data.remaining === 0 ? 'done' : 'stopped');
        if (res.data.remaining === 0) {
          toast.success('Backfill complete.');
        } else if (res.data.embedded === 0) {
          // No new rows embedded this batch — either everything's done
          // or the embedder failed on all rows. Surface the latter.
          toast.warning(
            `Stopped: ${res.data.failed} item(s) failed to embed in the last batch.`,
          );
        }
        return;
      }
    }
    if (stopRef.current) setState('stopped');
  }

  function stop() {
    stopRef.current = true;
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 flex items-center justify-between text-[12px] text-muted-foreground">
          <span>
            {done.toLocaleString()} of {total.toLocaleString()} items embedded
          </span>
          <span>{pct}%</span>
        </div>
        <div
          className="bg-muted relative h-2 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="absolute inset-y-0 left-0 bg-foreground transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {state === 'running' ? (
          <Button onClick={stop} variant="outline" size="sm">
            <Square className="h-3.5 w-3.5" /> Stop after current batch
          </Button>
        ) : (
          <Button
            onClick={start}
            variant={state === 'done' ? 'outline' : 'gradient'}
            size="sm"
            disabled={total === 0}
          >
            {state === 'done' ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" /> Re-run backfill
              </>
            ) : (
              <>
                <PlayCircle className="h-3.5 w-3.5" /> Start backfill
              </>
            )}
          </Button>
        )}
        {(embeddedThisSession > 0 || failedThisSession > 0) && (
          <span className="text-muted-foreground text-[11.5px]">
            This session: {embeddedThisSession} embedded
            {failedThisSession > 0 && `, ${failedThisSession} failed`}
          </span>
        )}
      </div>

      <p className="text-muted-foreground text-[11.5px]">
        Each batch processes {BATCH_SIZE} items with light pacing to stay under
        Gemini&apos;s burst limit. You can navigate away while it runs — embedding
        happens server-side, but progress only updates while this page is open.
        Items you create or edit going forward embed automatically; the
        backfill only covers existing rows.
      </p>
    </div>
  );
}
