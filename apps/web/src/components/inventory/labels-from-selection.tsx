'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { LABELS_MAX_ITEMS, readLabelsSelection } from '@/lib/inventory/labels-selection';
import { loadLabelItemsAction, type LabelItem } from '@/server/actions/labels';

import { LabelsHeader, labelsSummary } from './labels-header';
import { LabelSheet, type LabelFormat, type Template } from './label-sheet';

type State =
  | { kind: 'loading'; selected: number }
  | { kind: 'missing' }
  | { kind: 'error'; message: string; selected: number }
  | { kind: 'ready'; items: LabelItem[]; selected: number };

/**
 * The labels page for a selection handed over by the Items bulk bar
 * (?selection=<key>; see lib/inventory/labels-selection.ts).
 *
 * Reads the ids this tab stored, asks the server for the label rows in a POST
 * body (loadLabelItemsAction, the same read the ?items= page does), and renders
 * the same sheet. A failed read is an error with a retry, never "No items
 * selected": that message sent people back to pick items they had picked.
 */
export function LabelsFromSelection({
  selectionKey,
  copies,
  template,
  format,
}: {
  selectionKey: string;
  copies: number;
  template: Template;
  format: LabelFormat;
}) {
  const [state, setState] = React.useState<State>({ kind: 'loading', selected: 0 });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      const ids = readLabelsSelection(selectionKey);
      if (!ids || ids.length === 0) {
        if (!cancelled) setState({ kind: 'missing' });
        return;
      }
      if (!cancelled) setState({ kind: 'loading', selected: ids.length });
      try {
        const res = await loadLabelItemsAction({ ids: ids.slice(0, LABELS_MAX_ITEMS) });
        if (cancelled) return;
        setState(
          res.ok
            ? { kind: 'ready', items: res.data, selected: ids.length }
            : { kind: 'error', message: res.error.message, selected: ids.length },
        );
      } catch {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: 'Could not load the selected items. Check your connection and try again.',
            selected: ids.length,
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectionKey, attempt]);

  if (state.kind === 'missing') {
    return (
      <>
        <LabelsHeader summary="This label selection is not available in this browser tab any more." />
        <div className="border-border bg-card rounded-md border p-8 text-center print:hidden">
          <p className="text-muted-foreground text-sm">
            Go back to the inventory list, select the items again and click &quot;Print
            labels&quot;.
          </p>
        </div>
      </>
    );
  }

  if (state.kind === 'loading') {
    return (
      <LabelsHeader
        summary={
          state.selected > 0
            ? `Loading ${Math.min(state.selected, LABELS_MAX_ITEMS)} selected item${state.selected === 1 ? '' : 's'}…`
            : 'Loading the selected items…'
        }
        selectedCount={state.selected}
      />
    );
  }

  if (state.kind === 'error') {
    return (
      <>
        <LabelsHeader
          summary="The selected items could not be loaded."
          selectedCount={state.selected}
        />
        <div
          className="border-border bg-card rounded-md border p-8 text-center print:hidden"
          role="alert"
        >
          <p className="text-destructive text-sm">{state.message}</p>
          <Button className="mt-4" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <LabelsHeader
        summary={labelsSummary(state.items.length, copies)}
        selectedCount={state.selected}
      />
      <LabelSheet items={state.items} copies={copies} template={template} format={format} />
    </>
  );
}
