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
import type { DestinationFields } from '@/lib/locations/placement-destination';
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

/**
 * ═══ THE FOUR FIELDS, ALWAYS VISIBLE — the BOOK put-away's primary "To" input ═══
 *
 * Rack number | Row, then Crate color | Crate number, in one bordered group.
 * Shared by the staging put-away, the bulk put-away and the transfer dialog so
 * the four boxes look and behave identically on every surface.
 *
 * WHY NOT A TOGGLE. These fields used to sit behind "+ New rack / crate" plus a
 * Rack|Crate radio, and the toggle was the thing that hid the crate: for a
 * label-only crate (most of this warehouse) the crate the dialog had just said
 * the book was in was not in the dropdown, and the operator's only visible move
 * was the bare rack — which clears the crate (Maus I, 2026-08-17). Now the kind
 * is decided by the planner from what is filled in: any crate box → a crate ON
 * the typed rack; crate blank → the bare rack. Both facts are on screen at
 * once because a crate SITS ON a rack — the picker needs both.
 *
 * `unknownCrateColor`: a recorded colour the registry Select cannot show. The
 * raw text is said beside the box so the operator can pick the nearest colour
 * or leave it blank on purpose (blank changes the pair, so the gate will ask).
 * `problem`: the planner's own refusal for a half-filled form, in its words.
 */
export function BookDestinationFields({
  idPrefix,
  fields,
  onChange,
  unknownCrateColor,
  problem,
  disabled,
}: {
  idPrefix: string;
  fields: DestinationFields;
  onChange: (next: DestinationFields) => void;
  unknownCrateColor?: string | null;
  problem?: string | null;
  disabled?: boolean;
}) {
  const set = (key: keyof DestinationFields) => (value: string) =>
    onChange({ ...fields, [key]: value });
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">Place into</p>
        <p className="text-muted-foreground text-xs">
          The rack and, if it sits in one, the crate on that rack. Leave the crate blank to place
          on the bare rack — the book’s crate label is then cleared, and you will be asked first.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-rack-number`}>Rack number</Label>
          <Input
            id={`${idPrefix}-rack-number`}
            placeholder="e.g. 38"
            value={fields.rackNumber}
            maxLength={64}
            disabled={disabled}
            onChange={(e) => set('rackNumber')(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-rack-row`}>Row</Label>
          <Input
            id={`${idPrefix}-rack-row`}
            placeholder="e.g. B"
            value={fields.rackRow}
            maxLength={64}
            disabled={disabled}
            onChange={(e) => set('rackRow')(e.target.value)}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-crate-color`}>Crate color</Label>
          <CrateColorSelect
            id={`${idPrefix}-crate-color`}
            value={fields.crateColor}
            disabled={disabled}
            onChange={(v) => set('crateColor')(v === NO_CRATE_COLOR ? '' : v)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-crate-number`}>Crate number</Label>
          <CrateNumberInput
            id={`${idPrefix}-crate-number`}
            value={fields.crateNumber}
            onChange={set('crateNumber')}
          />
        </div>
      </div>
      {unknownCrateColor && (
        <p className="text-muted-foreground text-xs">
          This book’s recorded crate color, “{unknownCrateColor}”, is not one of the crate
          colors, so it could not be filled in. Pick the nearest one, or leave it blank to record
          no color.
        </p>
      )}
      {/* The planner's refusal, said where the fields are. Without it a
          half-filled form would just have a dead Place button and no
          explanation — and the version of this dialog that had neither offered
          to create a crate it could not name. */}
      {problem && <p className="text-destructive text-xs">{problem}</p>}
    </div>
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

