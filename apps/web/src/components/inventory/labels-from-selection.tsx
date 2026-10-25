'use client';

import * as React from 'react';

import { StatePanel } from '@/components/patterns/state-panel';
import { Button } from '@/components/ui/button';
import { isControlFlow } from '@/lib/control-flow';
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
      } catch (e) {
        // A redirect (the session ended): the router is already navigating.
        if (isControlFlow(e)) return;
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
        <StatePanel
          kind="empty"
          size="sm"
          headingLevel={null}
          className="print:hidden"
          title={
            <>
              Go back to the inventory list, select the items again and click &quot;Print
              labels&quot;.
            </>
          }
        />
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
        <StatePanel
          kind="failed"
          size="sm"
          live="assertive"
          headingLevel={null}
          className="print:hidden"
          title={<span className="text-destructive">{state.message}</span>}
          action={
            <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          }
        />
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
