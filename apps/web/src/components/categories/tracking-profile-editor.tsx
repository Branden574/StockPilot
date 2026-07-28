'use client';

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

import {
  COUNTING_UNITS,
  SPORTS_ATTRIBUTES,
  TRACKING_MODES,
  TRACKING_MODE_LABELS,
  trackingProfileConsistencyError,
  trackingProfileSchema,
  type CountingUnit,
  type SportsAttribute,
  type SubcategoryTrackingProfile,
  type TrackingMode,
} from '@stockpilot/core';

/** Display copy only — the vocabulary itself comes from SPORTS_ATTRIBUTES, so
 *  this Record is exhaustive by type. */
const ATTRIBUTE_LABELS: Record<SportsAttribute, string> = {
  brand: 'Brand',
  model: 'Model',
  style_number: 'Style number',
  colorway: 'Colorway',
  size: 'Size',
  size_system: 'Size system',
  width: 'Width',
  fit: 'Fit',
  jersey_number: 'Number',
  player_name: 'Player name',
  team: 'Team',
  league: 'League',
  season: 'Season',
  home_away: 'Home / away',
  color: 'Color',
};

/** A brand-new, deliberately EMPTY draft. Every field starts unset (or, for a
 *  boolean, `false`) so `isTrackingProfileComplete` starts out false and the
 *  caller's Save button starts disabled — nothing here is a silent default the
 *  admin didn't choose. */
export const EMPTY_TRACKING_PROFILE_DRAFT: SubcategoryTrackingProfile = {
  key: '',
  label: '',
  defaultMode: 'QUANTITY',
  allowedModes: [],
  supportedAttributes: [],
  requiredAttributes: [],
  defaultCountingUnit: 'each',
  supportsNumbers: false,
  supportsSizes: false,
  supportsColors: false,
  individualTrackingAllowed: false,
};

/**
 * True only when the draft is a complete, internally-consistent profile — by
 * EXACTLY the rules the server applies, because both sides read the same two
 * shared definitions: `trackingProfileSchema` (the shape: every field present
 * and in-vocabulary, `allowedModes` non-empty, key/label within their bounds)
 * and `trackingProfileConsistencyError` (required ⊆ supported; defaultMode ∈
 * allowedModes). The hand-written field list this replaced silently skipped
 * `defaultCountingUnit`, the four booleans and both length caps, so a draft the
 * dialog called complete could still be refused by the server action's zod.
 *
 * The caller (CategoryDialog) keeps Save disabled until this is true; the
 * server re-validates regardless — this is a usability gate, never the
 * enforcement.
 */
export function isTrackingProfileComplete(p: SubcategoryTrackingProfile): boolean {
  // Key and label are trimmed here for the same reason the key input trims on
  // change: whitespace is not a value the admin meant to type.
  const parsed = trackingProfileSchema.safeParse({
    ...p,
    key: p.key.trim(),
    label: p.label.trim(),
  });
  return parsed.success && trackingProfileConsistencyError(parsed.data) === null;
}

export interface TrackingProfileEditorProps {
  value: SubcategoryTrackingProfile;
  onChange: (next: SubcategoryTrackingProfile) => void;
}

/**
 * The full CUSTOM Sports subcategory profile form (Task 12). Every field of
 * `SubcategoryTrackingProfile` is a control here — there is no
 * `if (subcategory === 'shoes')` branch anywhere, and nothing is inferred or
 * defaulted on the admin's behalf. `isTrackingProfileComplete` above is what
 * actually gates the parent's Save button; this component only renders and
 * edits the draft.
 */
export function TrackingProfileEditor({ value, onChange }: TrackingProfileEditorProps) {
  function set<K extends keyof SubcategoryTrackingProfile>(
    key: K,
    v: SubcategoryTrackingProfile[K],
  ) {
    onChange({ ...value, [key]: v });
  }

  function toggleMode(mode: TrackingMode) {
    const next = value.allowedModes.includes(mode)
      ? value.allowedModes.filter((m) => m !== mode)
      : [...value.allowedModes, mode];
    onChange({ ...value, allowedModes: next });
  }

  function toggleAttribute(listKey: 'supportedAttributes' | 'requiredAttributes', attr: SportsAttribute) {
    const list = value[listKey];
    const next = list.includes(attr) ? list.filter((a) => a !== attr) : [...list, attr];
    onChange({ ...value, [listKey]: next });
  }

  const defaultModeOptions = value.allowedModes.length > 0 ? value.allowedModes : TRACKING_MODES;

  return (
    <div
      className="space-y-4 rounded-md border border-border bg-muted/20 p-3"
      data-testid="tracking-profile-editor"
    >
      <p className="text-xs font-medium text-muted-foreground">
        Custom tracking profile — every field below is required.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="profile-key">Key</Label>
          <Input
            id="profile-key"
            placeholder="e.g. warmup_gear"
            value={value.key}
            onChange={(e) => set('key', e.target.value.trim().toLowerCase().replace(/\s+/g, '_'))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-label">Label</Label>
          <Input
            id="profile-label"
            placeholder="Warm-up gear"
            value={value.label}
            onChange={(e) => set('label', e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Allowed tracking modes</Label>
        <div className="flex flex-wrap gap-2">
          {TRACKING_MODES.map((m) => (
            <label
              key={m}
              className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs"
            >
              <input
                type="checkbox"
                checked={value.allowedModes.includes(m)}
                onChange={() => toggleMode(m)}
              />
              {TRACKING_MODE_LABELS[m]}
            </label>
          ))}
        </div>
        {value.allowedModes.length === 0 && (
          <p className="text-xs text-destructive">Pick at least one allowed mode.</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="profile-default-mode">Default tracking mode</Label>
        <Select value={value.defaultMode} onValueChange={(v) => set('defaultMode', v as TrackingMode)}>
          <SelectTrigger id="profile-default-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {defaultModeOptions.map((m) => (
              <SelectItem key={m} value={m}>
                {TRACKING_MODE_LABELS[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {value.allowedModes.length > 0 && !value.allowedModes.includes(value.defaultMode) && (
          <p className="text-xs text-destructive">
            The default mode must be one of the allowed modes above.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Supported attributes</Label>
          <div className="flex flex-wrap gap-2">
            {SPORTS_ATTRIBUTES.map((a) => (
              <label
                key={a}
                className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs"
              >
                <input
                  type="checkbox"
                  checked={value.supportedAttributes.includes(a)}
                  onChange={() => toggleAttribute('supportedAttributes', a)}
                />
                {ATTRIBUTE_LABELS[a]}
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Required attributes</Label>
          <div className="flex flex-wrap gap-2">
            {SPORTS_ATTRIBUTES.map((a) => {
              const supported = value.supportedAttributes.includes(a);
              return (
                <label
                  key={a}
                  className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs data-[disabled=true]:opacity-40"
                  data-disabled={!supported}
                >
                  <input
                    type="checkbox"
                    disabled={!supported}
                    checked={value.requiredAttributes.includes(a)}
                    onChange={() => toggleAttribute('requiredAttributes', a)}
                  />
                  {ATTRIBUTE_LABELS[a]}
                </label>
              );
            })}
          </div>
          <p className="text-muted-foreground text-[11px]">
            Only attributes checked as supported can be required.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="profile-counting-unit">Default counting unit</Label>
        <Select
          value={value.defaultCountingUnit}
          onValueChange={(v) => set('defaultCountingUnit', v as CountingUnit)}
        >
          <SelectTrigger id="profile-counting-unit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COUNTING_UNITS.map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            ['supportsNumbers', 'Numbers'],
            ['supportsSizes', 'Sizes'],
            ['supportsColors', 'Colors'],
            ['individualTrackingAllowed', 'Can be individually tagged'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-start gap-2 rounded-md border border-border p-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={value[key]}
              onChange={(e) => set(key, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}
