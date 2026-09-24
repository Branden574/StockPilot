/**
 * The rack a NEW item's stock is about to land on, checked before Save.
 *
 * THE INCIDENT (2026-09-24). An operator added "Red Note Book" from the phone
 * meaning rack 17-B. The request the phone sent said "1-B". The server's
 * manual-create auto-place resolves-or-CREATES the typed rack, so it silently
 * minted a brand-new rack "1-B" in DC4 and moved all 130 units onto it. The
 * two creates before it that morning, also typed as 17-B, landed correctly.
 *
 * Every other place that can mint a rack already asks first (the 2026-07-23
 * guard, `describeNewRackPlacement`, on web put-away / transfer / bulk place
 * and the phone's Move stock sheet). The New Item screen did not. This module
 * is the pure half of closing that gap: given the label the server will
 * receive, the stock that will move, and the warehouse's existing racks, it
 * says whether Save may go straight through or must confirm, in the SAME words
 * the other guards use.
 *
 * The existence rule is the server's (LocationsService.findRackOrCrate): same
 * org + warehouse, kind 'rack', not deleted, compared through the one rack
 * canonicaliser. `describeNewRackPlacement` keys labels exactly that way.
 */

import { describeNewRackPlacement } from '@stockpilot/core';

export type CreateRackCheck =
  /** Nothing is created: no rack typed, or no stock would move. */
  | { kind: 'none' }
  /** The rack exists; Save proceeds with no question. */
  | { kind: 'existing'; label: string }
  /** The rack would be CREATED. Confirm, offering near-matches first. */
  | { kind: 'new'; label: string; title: string; message: string; suggestions: string[] }
  /** The racks could not be read, so "exists" is unknown. Confirm, never assume. */
  | { kind: 'unchecked'; label: string; title: string; message: string };

export function checkCreateRack(input: {
  /** Exactly what the create request carries as `binLocation`. */
  binLocation: string | null | undefined;
  /** Units the server would move onto the rack (it only places when > 0). */
  units: number;
  warehouseName: string | null | undefined;
  /** The warehouse's rack names, or null when they could not be read. */
  existingRacks: readonly string[] | null;
}): CreateRackCheck {
  const label = (input.binLocation ?? '').trim();
  // The server auto-places (and so creates a rack) only when a label was typed
  // AND there is stock to move: `isManualCreatePath && quantityOnHand > 0 &&
  // typedBinLabel` in InventoryService.create, the same for a size run.
  if (!label || !(input.units > 0)) return { kind: 'none' };

  const units = input.units === 1 ? '1 unit' : `${input.units} units`;
  const where = input.warehouseName?.trim() ? ` in ${input.warehouseName.trim()}` : '';

  // A failed read is NOT an empty warehouse. Treating it as one would call
  // every rack new (harmless nagging) — but treating it as "fine" would wave
  // the incident straight through. Ask.
  if (input.existingRacks === null) {
    return {
      kind: 'unchecked',
      label,
      title: `Put the stock on ${label}?`,
      message: `Could not check the racks${where} just now. If ${label} does not exist yet, saving creates it and moves ${units} into it.`,
    };
  }

  const decision = describeNewRackPlacement({
    label,
    warehouseName: input.warehouseName,
    quantity: input.units,
    existingLabels: input.existingRacks,
  });
  if (decision.exists) return { kind: 'existing', label: decision.matchedLabel ?? decision.label };
  return {
    kind: 'new',
    label: decision.label,
    title: decision.title,
    message: decision.message,
    suggestions: decision.suggestions,
  };
}

/**
 * The line under the rack boxes: where the stock is about to go, as the form
 * stands. Read-only guidance, so a failed or pending read degrades to saying
 * so — it never claims a rack exists that was not seen.
 */
export function rackDestinationHint(input: {
  binLocation: string | null | undefined;
  warehouseName: string | null | undefined;
  /** undefined = still loading; null = the read failed. */
  existingRacks: readonly string[] | null | undefined;
}): { text: string; tone: 'ok' | 'warn' | 'muted' } | null {
  const label = (input.binLocation ?? '').trim();
  if (!label) return null;
  const where = input.warehouseName?.trim() ? ` in ${input.warehouseName.trim()}` : '';
  if (input.existingRacks === undefined) {
    return { text: `Rack ${label}. Checking the racks${where}…`, tone: 'muted' };
  }
  if (input.existingRacks === null) {
    return { text: `Rack ${label}. Could not check the racks${where}.`, tone: 'warn' };
  }
  const decision = describeNewRackPlacement({
    label,
    warehouseName: input.warehouseName,
    quantity: 0,
    existingLabels: input.existingRacks,
  });
  if (decision.exists) {
    return { text: `Goes on rack ${decision.matchedLabel ?? decision.label}${where}.`, tone: 'ok' };
  }
  const hint =
    decision.suggestions.length > 0 ? ` Did you mean ${decision.suggestions.slice(0, 2).join(' or ')}?` : '';
  return { text: `${decision.label} is a new rack${where}.${hint}`, tone: 'warn' };
}
