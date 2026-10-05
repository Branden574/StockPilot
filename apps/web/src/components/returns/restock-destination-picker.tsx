'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

import {
  choiceFromKey,
  choiceKey,
  damagedHint,
  RETURNS_COPY,
  restockOptionRows,
  type RestockChoice,
  type RestockOptionsLine,
} from '@stockpilot/core';

/**
 * The returned item's disposition and destination for ONE line (returns
 * RX-1, plan 3.5 and section 6). Two radio groups:
 *
 *   RETURN DISPOSITION         Restock | Scrap
 *   RETURNED ITEM DESTINATION  (restock only; hidden for scrap, brief 10)
 *     Return to original rack: 31-C            (C1, preselected when valid)
 *     Return to original racks: 31-C ×1 · …    (C2)
 *     Return to one of the original racks: 34-A  up to N   (C3)
 *     Original rack unavailable. …             (C4, shown disabled)
 *     Leave in Staging                         (always one tap away)
 *
 * A rack that failed revalidation is shown disabled with its reason ("(archived)").
 * The rows come from core's restock-view, built from the server's
 * provenance answer; this component never decides that a rack is valid.
 * The reason "Damaged" adds "Inspect before choosing." and never selects
 * scrap by itself (brief 38).
 */
export function RestockDestinationPicker({
  line,
  choice,
  onChange,
  disabled = false,
  reasonCode,
  itemLabel,
}: {
  line: RestockOptionsLine;
  choice: RestockChoice;
  onChange: (next: RestockChoice) => void;
  disabled?: boolean;
  reasonCode?: string | null;
  itemLabel: string;
}) {
  const groupId = React.useId();
  const rows = restockOptionRows(line);
  const selectedKey = choiceKey(choice);
  const hint = damagedHint(reasonCode);

  return (
    <div className="space-y-3">
      <fieldset disabled={disabled} className="space-y-1.5">
        <legend className="text-muted-foreground font-mono text-[10.5px] uppercase tracking-[0.12em]">
          {RETURNS_COPY.returnDisposition}
          <span className="sr-only"> for {itemLabel}</span>
        </legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`${RETURNS_COPY.returnDisposition} for ${itemLabel}`}>
          {(['restock', 'scrap'] as const).map((d) => (
            <label
              key={d}
              className={cn(
                'inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
                choice.disposition === d ? 'border-foreground bg-muted' : 'border-border',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="radio"
                name={`${groupId}-disposition`}
                value={d}
                checked={choice.disposition === d}
                onChange={() => onChange(choiceFromKey(d, d === 'restock' ? (selectedKey ?? keyForRestock(line)) : null))}
                className="h-3.5 w-3.5"
              />
              {d === 'restock' ? RETURNS_COPY.restock : RETURNS_COPY.scrap}
            </label>
          ))}
        </div>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </fieldset>

      {choice.disposition === 'restock' ? (
        <fieldset disabled={disabled} className="space-y-1.5">
          <legend className="text-muted-foreground font-mono text-[10.5px] uppercase tracking-[0.12em]">
            {RETURNS_COPY.returnedItemDestination}
            <span className="sr-only"> for {itemLabel}</span>
          </legend>
          <div className="space-y-1.5" role="radiogroup" aria-label={`${RETURNS_COPY.returnedItemDestination} for ${itemLabel}`}>
            {rows.map((row) => {
              const checked = selectedKey === row.key;
              const whyId = `${groupId}-${row.key}-why`;
              const showWhy = !row.enabled && row.disabledReason && row.disabledReason !== row.label;
              const helpId = `${groupId}-${row.key}-help`;
              return (
                <div
                  key={row.key}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm',
                    checked ? 'border-foreground bg-muted' : 'border-border',
                    row.enabled ? '' : 'opacity-70',
                  )}
                >
                  <label className={cn('flex items-start gap-2', row.enabled ? 'cursor-pointer' : 'cursor-not-allowed')}>
                    <input
                      type="radio"
                      name={`${groupId}-destination`}
                      value={row.key}
                      checked={checked}
                      disabled={!row.enabled}
                      aria-describedby={showWhy ? whyId : row.help && row.enabled ? helpId : undefined}
                      onChange={() => onChange(choiceFromKey('restock', row.key))}
                      className="mt-0.5 h-3.5 w-3.5"
                    />
                    <span className="min-w-0">{row.label}</span>
                  </label>
                  {row.help && row.enabled ? (
                    <p id={helpId} className="text-muted-foreground pl-5 text-xs">
                      {row.help}
                    </p>
                  ) : null}
                  {showWhy ? (
                    <p id={whyId} className="text-muted-foreground pl-5 text-xs">
                      {row.disabledReason}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

/** The key a restock starts from when switching back from scrap. */
function keyForRestock(line: RestockOptionsLine): string {
  return line.preselect === 'original' && line.offerOriginal ? 'original' : 'staging';
}
