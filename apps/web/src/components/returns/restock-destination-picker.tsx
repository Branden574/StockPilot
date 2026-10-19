'use client';

import * as React from 'react';

import { choiceRowClass, eyebrowClass, nativeRadioClass } from '@/components/returns/returns-ui';
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
        <legend className={eyebrowClass}>
          {RETURNS_COPY.returnDisposition}
          <span className="sr-only"> for {itemLabel}</span>
        </legend>
        <div
          className="flex flex-wrap gap-2"
          role="radiogroup"
          aria-label={`${RETURNS_COPY.returnDisposition} for ${itemLabel}`}
        >
          {(['restock', 'scrap'] as const).map((d) => (
            <label
              key={d}
              className={cn(
                choiceRowClass({ checked: choice.disposition === d, disabled }),
                'inline-flex min-h-9 items-center gap-2.5 px-3 py-1.5',
              )}
            >
              <input
                type="radio"
                name={`${groupId}-disposition`}
                value={d}
                checked={choice.disposition === d}
                onChange={() =>
                  onChange(
                    choiceFromKey(d, d === 'restock' ? (selectedKey ?? keyForRestock(line)) : null),
                  )
                }
                className={nativeRadioClass}
              />
              {d === 'restock' ? RETURNS_COPY.restock : RETURNS_COPY.scrap}
            </label>
          ))}
        </div>
        {hint ? <p className="text-muted-foreground text-[12px]">{hint}</p> : null}
      </fieldset>

      {choice.disposition === 'restock' ? (
        <fieldset disabled={disabled} className="space-y-1.5">
          <legend className={eyebrowClass}>
            {RETURNS_COPY.returnedItemDestination}
            <span className="sr-only"> for {itemLabel}</span>
          </legend>
          <div
            className="space-y-1.5"
            role="radiogroup"
            aria-label={`${RETURNS_COPY.returnedItemDestination} for ${itemLabel}`}
          >
            {rows.map((row) => {
              const checked = selectedKey === row.key;
              const whyId = `${groupId}-${row.key}-why`;
              const showWhy =
                !row.enabled && row.disabledReason && row.disabledReason !== row.label;
              const helpId = `${groupId}-${row.key}-help`;
              return (
                <div
                  key={row.key}
                  className={cn(
                    choiceRowClass({ checked }),
                    'px-3 py-2',
                    row.enabled ? '' : 'bg-sunk hover:border-border cursor-not-allowed',
                  )}
                >
                  <label
                    className={cn(
                      'flex items-start gap-2.5',
                      row.enabled ? 'cursor-pointer' : 'text-muted-foreground cursor-not-allowed',
                    )}
                  >
                    <input
                      type="radio"
                      name={`${groupId}-destination`}
                      value={row.key}
                      checked={checked}
                      disabled={!row.enabled}
                      aria-describedby={
                        showWhy ? whyId : row.help && row.enabled ? helpId : undefined
                      }
                      onChange={() => onChange(choiceFromKey('restock', row.key))}
                      className={cn(nativeRadioClass, 'mt-0.5')}
                    />
                    <span className="min-w-0">{row.label}</span>
                  </label>
                  {row.help && row.enabled ? (
                    <p id={helpId} className="text-muted-foreground pl-[26px] text-[12px]">
                      {row.help}
                    </p>
                  ) : null}
                  {showWhy ? (
                    <p id={whyId} className="text-muted-foreground pl-[26px] text-[12px]">
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
