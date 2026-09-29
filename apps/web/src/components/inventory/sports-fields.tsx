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

import {
  GROUP_KEY_COLOR_SUBCATEGORIES,
  SIZE_SYSTEM_LABELS,
  isAttributeRequired,
  sizeSystemEnum,
} from '@stockpilot/core';
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
 * Subcategories whose GROUP key carries a `color` slot. Re-exported from
 * `@stockpilot/core`, where it lives beside the `buildGroupKey` branch it
 * describes — the Expo Add Item screen collects the same field and has to
 * reach the same answer, so the set cannot be owned by a web component.
 */
export const GROUP_LEVEL_COLOR_SUBCATEGORIES = GROUP_KEY_COLOR_SUBCATEGORIES;

// Display names live in @stockpilot/core (SIZE_SYSTEM_LABELS, exhaustive by
// type) so the phone's picker offers the same words; the VOCABULARY comes from
// `sizeSystemEnum.options`.
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
  /**
   * An example size that fits this category (core `sizePlaceholder`): a letter
   * on an apparel scale, 10.5 only for shoes. The field used to say "10.5" for
   * every subcategory, which is not even a size on the Jerseys letter scale.
   */
  sizeExample?: string;
  /** The form offers size chips for this category (a size RUN can be picked). */
  sizeRunAvailable?: boolean;
  /** Sizes are picked in the chips above, so the single Size box is not used. */
  sizeRunPicked?: boolean;
}

/**
 * A field label that says "(optional)" only when the subcategory does not
 * require the attribute. The requirement is read from the resolved profile —
 * the same `requiredAttributes` the server enforces — so a label can never
 * call a field optional that Save then refuses without (2026-09-29).
 */
function FieldLabel({
  htmlFor,
  required,
  children,
}: {
  htmlFor: string;
  required: boolean;
  children: React.ReactNode;
}) {
  return (
    <Label htmlFor={htmlFor}>
      {children}
      {!required && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
    </Label>
  );
}

function FieldError({ id, message }: { id: string; message: unknown }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-destructive">
      {String(message)}
    </p>
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
  sizeExample = 'M',
  sizeRunAvailable = false,
  sizeRunPicked = false,
}: SportsFieldsProps) {
  const has = React.useCallback(
    (attr: SportsAttribute) => profile.supportedAttributes.includes(attr),
    [profile],
  );
  const required = React.useCallback(
    (attr: SportsAttribute) => isAttributeRequired(profile, attr),
    [profile],
  );
  const colorIsGroupLevel = GROUP_LEVEL_COLOR_SUBCATEGORIES.has(profile.key);
  const uid = React.useId();
  const idFor = (name: string) => `${uid}-${name}`;

  return (
    <div
      className="space-y-3 rounded-md border border-border bg-muted/20 p-3"
      data-testid="sports-fields"
    >
      <p className="text-xs font-medium text-muted-foreground">{profile.label} details</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {has('brand') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('brand')} required={required('brand')}>
              Brand
            </FieldLabel>
            <Input
              id={idFor('brand')}
              placeholder="Nike"
              value={groupFields.brand}
              onChange={(e) => onGroupFieldChange('brand', e.target.value)}
            />
          </div>
        )}
        {has('model') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('model')} required={required('model')}>
              Model
            </FieldLabel>
            <Input
              id={idFor('model')}
              placeholder="Pegasus 41"
              value={groupFields.model}
              onChange={(e) => onGroupFieldChange('model', e.target.value)}
            />
          </div>
        )}
        {has('style_number') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('style-number')} required={required('style_number')}>
              Style number
            </FieldLabel>
            <Input
              id={idFor('style-number')}
              placeholder="e.g. DZ4494-001"
              value={groupFields.styleNumber}
              onChange={(e) => onGroupFieldChange('styleNumber', e.target.value)}
            />
          </div>
        )}
        {has('colorway') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('colorway')} required={required('colorway')}>
              Colorway
            </FieldLabel>
            <Input
              id={idFor('colorway')}
              placeholder="Black/White"
              value={groupFields.colorway}
              onChange={(e) => onGroupFieldChange('colorway', e.target.value)}
            />
          </div>
        )}
        {has('team') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('team')} required={required('team')}>
              Team
            </FieldLabel>
            <Input
              id={idFor('team')}
              placeholder="Wildcats"
              value={groupFields.team}
              onChange={(e) => onGroupFieldChange('team', e.target.value)}
            />
          </div>
        )}
        {has('league') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('league')} required={required('league')}>
              League
            </FieldLabel>
            <Input
              id={idFor('league')}
              placeholder="Varsity"
              value={groupFields.league}
              onChange={(e) => onGroupFieldChange('league', e.target.value)}
            />
          </div>
        )}
        {has('season') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('season')} required={required('season')}>
              Season
            </FieldLabel>
            <Input
              id={idFor('season')}
              placeholder="2026-27"
              value={groupFields.season}
              onChange={(e) => onGroupFieldChange('season', e.target.value)}
            />
          </div>
        )}
        {has('home_away') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('home-away')} required={required('home_away')}>
              Home / away
            </FieldLabel>
            <Select
              value={groupFields.homeAway || '__none'}
              onValueChange={(v) =>
                onGroupFieldChange(
                  'homeAway',
                  v === '__none' ? '' : (v as SportsGroupFieldValues['homeAway']),
                )
              }
            >
              <SelectTrigger id={idFor('home-away')}>
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
              <FieldLabel htmlFor={idFor('color')} required={required('color')}>
                Color
              </FieldLabel>
              <Input
                id={idFor('color')}
                placeholder="Navy"
                value={groupFields.color}
                onChange={(e) => onGroupFieldChange('color', e.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <FieldLabel htmlFor={idFor('color')} required={required('color')}>
                Color
              </FieldLabel>
              <Input id={idFor('color')} placeholder="Navy" {...register('variantColor')} />
            </div>
          ))}
        {has('size') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('size')} required={required('size')}>
              Size
            </FieldLabel>
            <Input
              id={idFor('size')}
              placeholder={`e.g. ${sizeExample}`}
              aria-invalid={errors.variantSize ? true : undefined}
              aria-describedby={
                [
                  errors.variantSize ? idFor('size-error') : null,
                  sizeRunAvailable ? idFor('size-note') : null,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              {...register('variantSize')}
            />
            {sizeRunAvailable && (
              // The single box and the chips above are two ways to answer the
              // same question, and a picked run ignores the box entirely (the
              // sized save sends variants[], never variantSize) — say which.
              <p id={idFor('size-note')} className="text-muted-foreground text-[11px]">
                {sizeRunPicked
                  ? 'Sizes are picked above, so this box is not used: one item is added per size.'
                  : 'Or pick sizes above to add one item per size.'}
              </p>
            )}
            <FieldError id={idFor('size-error')} message={errors.variantSize?.message} />
          </div>
        )}
        {has('size_system') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('size-system')} required={required('size_system')}>
              Size system
            </FieldLabel>
            <Select
              value={watch('variantSizeSystem') ?? '__none'}
              onValueChange={(v) =>
                setValue('variantSizeSystem', v === '__none' ? null : (v as SizeSystem), {
                  shouldDirty: true,
                  // Re-run the check so a "pick a size system" error clears the
                  // moment one is picked, like a typed field does.
                  shouldValidate: true,
                })
              }
            >
              <SelectTrigger
                id={idFor('size-system')}
                aria-invalid={errors.variantSizeSystem ? true : undefined}
                aria-describedby={errors.variantSizeSystem ? idFor('size-system-error') : undefined}
              >
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
            <FieldError
              id={idFor('size-system-error')}
              message={errors.variantSizeSystem?.message}
            />
          </div>
        )}
        {has('width') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('width')} required={required('width')}>
              Width
            </FieldLabel>
            <Input id={idFor('width')} placeholder="D" {...register('variantWidth')} />
          </div>
        )}
        {has('fit') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('fit')} required={required('fit')}>
              Fit
            </FieldLabel>
            <Input id={idFor('fit')} placeholder="Regular" {...register('variantFit')} />
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
            <FieldLabel htmlFor={idFor('jersey-number')} required={required('jersey_number')}>
              Jersey number
            </FieldLabel>
            <Input
              id={idFor('jersey-number')}
              placeholder="e.g. 07"
              inputMode="numeric"
              aria-invalid={errors.jerseyNumber ? true : undefined}
              aria-describedby={errors.jerseyNumber ? idFor('jersey-number-error') : undefined}
              {...register('jerseyNumber')}
            />
            <p className="text-muted-foreground text-[11px]">
              Numbers repeat across sizes and teams. Leading zeroes are kept.
            </p>
            <FieldError id={idFor('jersey-number-error')} message={errors.jerseyNumber?.message} />
          </div>
        )}
        {has('player_name') && (
          <div className="space-y-1.5">
            <FieldLabel htmlFor={idFor('player')} required={required('player_name')}>
              Player
            </FieldLabel>
            <Input id={idFor('player')} placeholder="e.g. Vega" {...register('playerName')} />
          </div>
        )}
      </div>
    </div>
  );
}
