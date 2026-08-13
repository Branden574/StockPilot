'use client';

import { CRATE_COLORS, formatCrateColorLabel, getCrateColor } from '@stockpilot/core';
import type { BookStorageInfo } from '@stockpilot/core';
import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * The shared crate controls for the two put-away dialogs.
 *
 * ONE rule runs through all of them: A COLOR IS NEVER THE ONLY SIGNAL. Every
 * swatch is decorative (aria-hidden) and always sits beside the color's NAME,
 * because "the blue crate" is unreadable to a color-blind picker and invisible
 * to a screen reader. The swatch is an accelerator for people who can use it,
 * never the information itself.
 */

/** Decorative color chip. Always render the color's NAME next to it. */
export function CrateSwatch({ color, className }: { color: string | null; className?: string }) {
  const known = getCrateColor(color?.trim().toLowerCase() ?? null);
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-3 shrink-0 rounded-full border border-border',
        !known && 'bg-muted',
        className,
      )}
      style={known ? { backgroundColor: known.hex } : undefined}
    />
  );
}

/** Swatch + name, the only way a crate color is ever shown. */
export function CrateColorTag({ color }: { color: string | null }) {
  const label = formatCrateColorLabel(color);
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <CrateSwatch color={color} />
      <span>{label}</span>
    </span>
  );
}

/** The sentinel a Select needs for "no value" — Radix forbids an empty value. */
export const NO_CRATE_COLOR = '__none__';

/**
 * Crate color picker over the CRATE_COLORS registry.
 *
 * A registry Select rather than a free-text box: production's stored colors
 * are already exactly these ten slugs, and typing "navy" would mint a color no
 * swatch, filter or label sheet can render. "No color" stays available on
 * purpose — a crate is identified by its NUMBER, and staff routinely number a
 * crate before they know which colored bin it ends up in.
 */
export function CrateColorSelect({
  value,
  onChange,
  id,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <Select value={value || NO_CRATE_COLOR} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label="Crate color">
        <SelectValue placeholder="No color" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_CRATE_COLOR}>No color</SelectItem>
        {CRATE_COLORS.map((c) => (
          <SelectItem key={c.slug} value={c.slug}>
            <span className="inline-flex items-center gap-2">
              <CrateSwatch color={c.slug} />
              {c.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export type NewDestinationKind = 'rack' | 'crate';

/**
 * Rack-or-crate as an EXPLICIT choice — of the KIND OF ROW being created, and
 * nothing more.
 *
 * It used to be implicit: typing a crate color turned the new location into a
 * crate and leaving it blank made a rack, which meant the single most
 * consequential field on the form (it decides `locations.kind`, and 0270's
 * dedupe index is kind-scoped) was never actually asked about.
 *
 * ═══ IT IS NOT "RACK OR CRATE, PICK ONE PLACE" ═══
 *
 * A CRATE SITS ON A RACK. The crate branch therefore also offers "On rack" +
 * "Row": both facts are true at once, and a picker needs both to find a book
 * (go to rack 38-B, find crate 13 on it). Reading this toggle as mutually
 * exclusive PLACES — and hiding the rack fields on the crate branch — is what
 * made a positioned crate unexpressible and produced books recorded in a crate
 * with an empty RACK column.
 */
export function DestinationKindToggle({
  value,
  onChange,
  disabled,
}: {
  value: NewDestinationKind;
  onChange: (next: NewDestinationKind) => void;
  disabled?: boolean;
}) {
  const options: Array<{ value: NewDestinationKind; label: string }> = [
    { value: 'rack', label: 'Rack' },
    { value: 'crate', label: 'Crate' },
  ];
  return (
    <div className="space-y-1.5">
      <Label id="new-destination-kind-label">New location type</Label>
      <div
        role="radiogroup"
        aria-labelledby="new-destination-kind-label"
        className="inline-flex rounded-md border p-0.5"
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'rounded-[5px] px-3 py-1 text-sm font-medium transition-colors',
              value === opt.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * "Current storage" — where this BOOK is recorded today, straight off the
 * row's summary. Read-only by design: the summary is not authoritative (the
 * holdings are), so it is context for the decision, never an input to it.
 */
export function CurrentStorageSummary({ storage }: { storage: BookStorageInfo }) {
  const nothing = !storage.rackLabel && !storage.crateLabel && !storage.crateColor;
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2">
      <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        Current storage
      </p>
      {nothing ? (
        <p className="mt-1 text-sm">Not assigned</p>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {storage.rackLabel && (
            <span>
              <span className="text-muted-foreground">Rack </span>
              <span className="font-medium">{storage.rackLabel}</span>
            </span>
          )}
          {(storage.crateNumber || storage.crateColor) && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-muted-foreground">Crate</span>
              <CrateColorTag color={storage.crateColor} />
              {storage.crateNumber && <span className="font-medium">{storage.crateNumber}</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The crate an EXISTING destination already is, derived from the location row
 * the server sent (migration 0188's `crate_color` / `crate_number` columns).
 *
 * Shown so the operator can SEE the metadata that will be recorded without
 * retyping it — re-typing was how the item summary and the location row came
 * to disagree about the same crate in the first place.
 */
export function DestinationCrateNote({
  crateColor,
  crateNumber,
}: {
  crateColor: string | null;
  crateNumber: string | null;
}) {
  if (!crateColor && !crateNumber) return null;
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
      <span>This crate is</span>
      <CrateColorTag color={crateColor} />
      {crateNumber && <span className="text-foreground font-medium">{crateNumber}</span>}
      <span>— it will be recorded on the book.</span>
    </p>
  );
}

/** Crate number field. FREE TEXT: production holds 0, 1..16, "Bin", "Blue Shelf". */
export function CrateNumberInput({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  id?: string;
}) {
  return (
    <Input
      id={id}
      placeholder="e.g. 42"
      value={value}
      maxLength={64}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * WHERE THE CRATE SITS — the rack number and row of a crate destination.
 *
 * Optional, and it must stay optional: production holds a crate on no rack at
 * all (blue "Blue Shelf", 5 books), and demanding a position would force
 * operators to invent one.
 *
 * When it IS given it becomes part of the crate's IDENTITY, not decoration:
 * "gray BIN" names five physically distinct bins in this warehouse (43-B, 43-C,
 * 42-B, 42-C, 41-C), so the position is what tells them apart — in the created
 * `locations.name`, in migration 0270's dedupe key, and on the book's own rack
 * summary. One component for all three dialogs so no surface can offer half of
 * it.
 */
export function CrateRackPositionFields({
  idPrefix,
  rackNumber,
  rackRow,
  onRackNumberChange,
  onRackRowChange,
}: {
  idPrefix: string;
  rackNumber: string;
  rackRow: string;
  onRackNumberChange: (next: string) => void;
  onRackRowChange: (next: string) => void;
}) {
  return (
    <>
      <p className="text-muted-foreground text-xs">
        A crate sits on a rack. Say which one and the book is recorded in both — crate 13 on rack
        38-B. Leave it blank for a crate that is not on a rack.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-crate-rack-number`}>On rack (optional)</Label>
          <Input
            id={`${idPrefix}-crate-rack-number`}
            placeholder="e.g. 38"
            value={rackNumber}
            maxLength={64}
            onChange={(e) => onRackNumberChange(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-crate-rack-row`}>Row (optional)</Label>
          <Input
            id={`${idPrefix}-crate-rack-row`}
            placeholder="e.g. B"
            value={rackRow}
            maxLength={64}
            onChange={(e) => onRackRowChange(e.target.value)}
          />
        </div>
      </div>
    </>
  );
}
