'use client';

import * as React from 'react';
import type {
  FieldErrors,
  UseFormRegister,
  UseFormSetValue,
  UseFormWatch,
} from 'react-hook-form';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { sizeSystemEnum } from '@stockpilot/core';
import type {
  CreateItemInput,
  SizeSystem,
  SportsAttribute,
  SubcategoryTrackingProfile,
} from '@stockpilot/core';

/**
 * Group identity attributes (Task 11's PRODUCT-GROUP fields: brand, model,
 * team, season...). These deliberately do NOT go through react-hook-form:
 * `createProductGroupSchema.name` is required, and the moment RHF registers
 * ANY `productGroup.*` path the zodResolver validates the whole nested object
 * on every submit — failing on a missing `name` the user never had a field
 * for. Kept as plain state and merged into the submit payload by the parent
 * (item-form.tsx), the same pattern already used here for rack number/row,
 * crate color and author.
 */
export interface SportsGroupFieldValues {
  brand: string;
  model: string;
  styleNumber: string;
  colorway: string;
  team: string;
  league: string;
  season: string;
  homeAway: '' | 'home' | 'away' | 'alternate';
  /** Only used when the subcategory's group key carries a color slot (jerseys/uniforms). */
  color: string;
}

export const EMPTY_SPORTS_GROUP_FIELDS: SportsGroupFieldValues = {
  brand: '',
  model: '',
  styleNumber: '',
  colorway: '',
  team: '',
  league: '',
  season: '',
  homeAway: '',
  color: '',
};

/**
 * Subcategories whose GROUP key carries a `color` slot (buildGroupKey's
 * jerseys/uniforms branch in variant-keys.ts). Every other subcategory's
 * `color` attribute is a per-item VARIANT slot instead (buildVariantKey
 * accepts `color` unconditionally). Kept here as the single place that
 * decides which of the two `color` fields a given subcategory means, so the
 * mapping cannot drift from the key builders it mirrors.
 */
export const GROUP_LEVEL_COLOR_SUBCATEGORIES = new Set(['jerseys', 'uniforms']);

/**
 * Display copy only. The VOCABULARY comes from `sizeSystemEnum.options` below,
 * so this Record is exhaustive by type: adding a system to the shared zod enum
 * fails typecheck here until it is given a label, instead of silently shipping
 * a picker that is missing a value the schema accepts.
 */
const SIZE_SYSTEM_LABELS: Record<SizeSystem, string> = {
  US_MENS: "US Men's",
  US_WOMENS: "US Women's",
  US_YOUTH: 'US Youth',
  UK: 'UK',
  EU: 'EU',
  CM: 'CM',
  ALPHA: 'Alpha (S/M/L)',
  CUSTOM: 'Custom',
};

const SIZE_SYSTEM_OPTIONS = sizeSystemEnum.options.map((value) => ({
  value,
  label: SIZE_SYSTEM_LABELS[value],
}));

export interface SportsFieldsProps {
  profile: SubcategoryTrackingProfile;
  register: UseFormRegister<CreateItemInput>;
  watch: UseFormWatch<CreateItemInput>;
  setValue: UseFormSetValue<CreateItemInput>;
  errors: FieldErrors<CreateItemInput>;
  groupFields: SportsGroupFieldValues;
  onGroupFieldChange: <K extends keyof SportsGroupFieldValues>(
    key: K,
    value: SportsGroupFieldValues[K],
  ) => void;
}

function OptionalLabel({ children }: { children: React.ReactNode }) {
  return (
    <Label>
      {children}
      <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
    </Label>
  );
}

/**
 * Subcategory-driven fields for the Add Item form (Sports Task 11).
 *
 * BINDING: every input here is gated on `profile.supportedAttributes` — there
 * is no per-category `if (subcategory === 'shoes')` branching. A custom
 * subcategory (Task 12) that lists the same attributes gets the same fields
 * for free.
 *
 * There is no serial-number INPUT anywhere in this component, for any
 * subcategory or tracking mode. A serial is captured at RECEIVING time
 * (`post_receipt_v2` + `serial_registry`), never at item creation, so "hidden
 * for quantity-mode subcategories" holds for every mode by construction — the
 * jersey-number field below is the closest-looking input and is deliberately
 * never labelled "Serial Number" (requirement 4).
 */
export function SportsFields({
  profile,
  register,
  watch,
  setValue,
  errors,
  groupFields,
  onGroupFieldChange,
}: SportsFieldsProps) {
  const has = React.useCallback(
    (attr: SportsAttribute) => profile.supportedAttributes.includes(attr),
    [profile],
  );
  const colorIsGroupLevel = GROUP_LEVEL_COLOR_SUBCATEGORIES.has(profile.key);

  return (
    <div
      className="space-y-3 rounded-md border border-border bg-muted/20 p-3"
      data-testid="sports-fields"
    >
      <p className="text-xs font-medium text-muted-foreground">{profile.label} details</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {has('brand') && (
          <div className="space-y-1.5">
            <OptionalLabel>Brand</OptionalLabel>
            <Input
              placeholder="Nike"
              value={groupFields.brand}
              onChange={(e) => onGroupFieldChange('brand', e.target.value)}
            />
          </div>
        )}
        {has('model') && (
          <div className="space-y-1.5">
            <OptionalLabel>Model</OptionalLabel>
            <Input
              placeholder="Pegasus 41"
              value={groupFields.model}
              onChange={(e) => onGroupFieldChange('model', e.target.value)}
            />
          </div>
        )}
        {has('style_number') && (
          <div className="space-y-1.5">
            <OptionalLabel>Style number</OptionalLabel>
            <Input
              placeholder="e.g. DZ4494-001"
              value={groupFields.styleNumber}
              onChange={(e) => onGroupFieldChange('styleNumber', e.target.value)}
            />
          </div>
        )}
        {has('colorway') && (
          <div className="space-y-1.5">
            <OptionalLabel>Colorway</OptionalLabel>
            <Input
              placeholder="Black/White"
              value={groupFields.colorway}
              onChange={(e) => onGroupFieldChange('colorway', e.target.value)}
            />
          </div>
        )}
        {has('team') && (
          <div className="space-y-1.5">
            <OptionalLabel>Team</OptionalLabel>
            <Input
              placeholder="Wildcats"
              value={groupFields.team}
              onChange={(e) => onGroupFieldChange('team', e.target.value)}
            />
          </div>
        )}
        {has('league') && (
          <div className="space-y-1.5">
            <OptionalLabel>League</OptionalLabel>
            <Input
              placeholder="Varsity"
              value={groupFields.league}
              onChange={(e) => onGroupFieldChange('league', e.target.value)}
            />
          </div>
        )}
        {has('season') && (
          <div className="space-y-1.5">
            <OptionalLabel>Season</OptionalLabel>
            <Input
              placeholder="2026-27"
              value={groupFields.season}
              onChange={(e) => onGroupFieldChange('season', e.target.value)}
            />
          </div>
        )}
        {has('home_away') && (
          <div className="space-y-1.5">
            <OptionalLabel>Home / away</OptionalLabel>
            <Select
              value={groupFields.homeAway || '__none'}
              onValueChange={(v) =>
                onGroupFieldChange(
                  'homeAway',
                  v === '__none' ? '' : (v as SportsGroupFieldValues['homeAway']),
                )
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">—</SelectItem>
                <SelectItem value="home">Home</SelectItem>
                <SelectItem value="away">Away</SelectItem>
                <SelectItem value="alternate">Alternate</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {has('color') &&
          (colorIsGroupLevel ? (
            <div className="space-y-1.5">
              <OptionalLabel>Color</OptionalLabel>
              <Input
                placeholder="Navy"
                value={groupFields.color}
                onChange={(e) => onGroupFieldChange('color', e.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <OptionalLabel>Color</OptionalLabel>
              <Input placeholder="Navy" {...register('variantColor')} />
            </div>
          ))}
        {has('size') && (
          <div className="space-y-1.5">
            <OptionalLabel>Size</OptionalLabel>
            <Input placeholder="10.5" {...register('variantSize')} />
            {errors.variantSize?.message && (
              <p className="text-xs text-destructive">{String(errors.variantSize.message)}</p>
            )}
          </div>
        )}
        {has('size_system') && (
          <div className="space-y-1.5">
            <OptionalLabel>Size system</OptionalLabel>
            <Select
              value={watch('variantSizeSystem') ?? '__none'}
              onValueChange={(v) =>
                setValue('variantSizeSystem', v === '__none' ? null : (v as SizeSystem), {
                  shouldDirty: true,
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">—</SelectItem>
                {SIZE_SYSTEM_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.variantSizeSystem?.message && (
              <p className="text-xs text-destructive">
                {String(errors.variantSizeSystem.message)}
              </p>
            )}
          </div>
        )}
        {has('width') && (
          <div className="space-y-1.5">
            <OptionalLabel>Width</OptionalLabel>
            <Input placeholder="D" {...register('variantWidth')} />
          </div>
        )}
        {has('fit') && (
          <div className="space-y-1.5">
            <OptionalLabel>Fit</OptionalLabel>
            <Input placeholder="Regular" {...register('variantFit')} />
          </div>
        )}
        {has('jersey_number') && profile.supportsNumbers && (
          <div className="space-y-1.5">
            {/*
              NEVER labeled "Serial Number" (requirement 4): a jersey number
              repeats across sizes, teams and seasons and carries none of a
              serial's uniqueness guarantee. There is also no serial-number
              INPUT anywhere in Add Item, for any subcategory or tracking
              mode — serials are captured at receiving (post_receipt_v2 +
              serial_registry), never at item creation — so "hidden for
              quantity-mode subcategories" holds trivially for every mode.
            */}
            <OptionalLabel>Jersey number</OptionalLabel>
            <Input placeholder="e.g. 07" inputMode="numeric" {...register('jerseyNumber')} />
            <p className="text-muted-foreground text-[11px]">
              Numbers repeat across sizes and teams. Leading zeroes are kept.
            </p>
            {errors.jerseyNumber?.message && (
              <p className="text-xs text-destructive">{String(errors.jerseyNumber.message)}</p>
            )}
          </div>
        )}
        {has('player_name') && (
          <div className="space-y-1.5">
            <OptionalLabel>Player</OptionalLabel>
            <Input placeholder="e.g. Vega" {...register('playerName')} />
          </div>
        )}
      </div>
    </div>
  );
}
