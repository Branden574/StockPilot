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

import type { CustomFieldDefinition } from '@stockpilot/core';

/**
 * Generic renderer for an org's ACTIVE item custom field definitions.
 *
 * It reads the current `custom_fields` object and renders one input per
 * definition, writing back into a COPY of that object under each definition's
 * `fieldKey`. It NEVER touches reserved/hardcoded keys (book_rack_number,
 * rack_number, size, author, ...) — those are owned by the item form's
 * purpose-built inputs, and a definition can never claim a reserved key (the
 * settings editor + action reject them). So this sits ALONGSIDE the existing
 * rack/author handling without clobbering it.
 *
 * The form owns the source of truth; this component is controlled. On every
 * edit it emits the full next `custom_fields` object so the parent can fold it
 * into its react-hook-form `customFields` value at submit time.
 */
export function CustomFieldsInputs({
  definitions,
  values,
  onChange,
  disabled,
}: {
  definitions: CustomFieldDefinition[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const active = React.useMemo(
    () =>
      definitions
        .filter((d) => !d.archived)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)),
    [definitions],
  );

  if (active.length === 0) return null;

  function set(key: string, value: unknown) {
    const next = { ...values };
    // Empty string / undefined clears the key so we don't persist blanks.
    if (value === undefined || value === '' || value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  }

  return (
    <div className="space-y-4">
      {active.map((def) => {
        const current = values[def.fieldKey];
        const inputId = `cf-${def.fieldKey}`;

        if (def.fieldType === 'checkbox') {
          return (
            <label key={def.id} className="flex items-center gap-2 text-sm">
              <input
                id={inputId}
                type="checkbox"
                className="h-4 w-4"
                disabled={disabled}
                checked={current === true}
                onChange={(e) => set(def.fieldKey, e.target.checked ? true : undefined)}
              />
              {def.label}
              {def.required && <span className="text-destructive">*</span>}
            </label>
          );
        }

        return (
          <div key={def.id} className="space-y-1.5">
            <Label htmlFor={inputId}>
              {def.label}
              {def.required && <span className="text-destructive ml-0.5">*</span>}
            </Label>
            {def.fieldType === 'select' ? (
              <Select
                value={typeof current === 'string' ? current : ''}
                disabled={disabled}
                onValueChange={(v) => set(def.fieldKey, v || undefined)}
              >
                <SelectTrigger id={inputId}>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {(def.options ?? []).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={inputId}
                type={def.fieldType === 'number' ? 'number' : def.fieldType === 'date' ? 'date' : 'text'}
                disabled={disabled}
                value={
                  current === undefined || current === null ? '' : String(current)
                }
                onChange={(e) => set(def.fieldKey, e.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
