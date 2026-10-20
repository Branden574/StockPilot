'use client';

import { ArrowDown, ArrowUp, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  archiveCustomFieldAction,
  createCustomFieldAction,
  updateCustomFieldAction,
} from '@/server/actions/custom-fields';

import {
  CUSTOM_FIELD_TYPES,
  isSnakeCaseKey,
  type CustomFieldDefinition,
  type CustomFieldOption,
  type CustomFieldType,
} from '@stockpilot/core';

const TYPE_LABELS: Record<CustomFieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Dropdown (select)',
  checkbox: 'Checkbox',
};

interface DraftState {
  /** Present only when editing an existing definition. */
  id?: string;
  fieldKey: string;
  label: string;
  fieldType: CustomFieldType;
  options: CustomFieldOption[];
  required: boolean;
}

function emptyDraft(): DraftState {
  return { fieldKey: '', label: '', fieldType: 'text', options: [], required: false };
}

function draftFromDefinition(def: CustomFieldDefinition): DraftState {
  return {
    id: def.id,
    fieldKey: def.fieldKey,
    label: def.label,
    fieldType: def.fieldType,
    options: def.options ?? [],
    required: def.required,
  };
}

export function CustomFieldsEditor({
  initialDefinitions,
}: {
  initialDefinitions: CustomFieldDefinition[];
}) {
  const [definitions, setDefinitions] = React.useState<CustomFieldDefinition[]>(initialDefinitions);
  const [draft, setDraft] = React.useState<DraftState | null>(null);
  const [pending, setPending] = React.useState(false);

  const active = definitions
    .filter((d) => !d.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
  const archived = definitions.filter((d) => d.archived);

  function applyResult(
    result: Awaited<ReturnType<typeof createCustomFieldAction>>,
  ): CustomFieldDefinition | null {
    if (!result.ok) {
      toast.error(result.error.message);
      return null;
    }
    const def = result.data.definition;
    setDefinitions((prev) => {
      const next = prev.filter((d) => d.id !== def.id);
      next.push(def);
      return next;
    });
    return def;
  }

  async function save() {
    if (!draft) return;
    if (!draft.label.trim()) {
      toast.error('Label is required.');
      return;
    }
    if (!draft.id && !isSnakeCaseKey(draft.fieldKey)) {
      toast.error('Field key must be snake_case (e.g. "warranty_months").');
      return;
    }
    if (draft.fieldType === 'select' && draft.options.length === 0) {
      toast.error('Add at least one option for a dropdown field.');
      return;
    }

    setPending(true);
    try {
      const options = draft.fieldType === 'select' ? draft.options : null;
      const result = draft.id
        ? await updateCustomFieldAction({
            id: draft.id,
            label: draft.label.trim(),
            fieldType: draft.fieldType,
            options,
            required: draft.required,
          })
        : await createCustomFieldAction({
            fieldKey: draft.fieldKey.trim(),
            label: draft.label.trim(),
            fieldType: draft.fieldType,
            options,
            required: draft.required,
            sortOrder: active.length,
          });
      const def = applyResult(result);
      if (def) {
        toast.success(draft.id ? 'Field updated.' : 'Field added.');
        setDraft(null);
      }
    } finally {
      setPending(false);
    }
  }

  async function setArchived(def: CustomFieldDefinition, archivedNext: boolean) {
    setPending(true);
    try {
      const result = await archiveCustomFieldAction({ id: def.id, archived: archivedNext });
      const updated = applyResult(result);
      if (updated) toast.success(archivedNext ? 'Field archived.' : 'Field restored.');
    } finally {
      setPending(false);
    }
  }

  async function reorder(def: CustomFieldDefinition, direction: -1 | 1) {
    const idx = active.findIndex((d) => d.id === def.id);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= active.length) return;
    const a = active[idx];
    const b = active[swapIdx];
    if (!a || !b) return;
    setPending(true);
    try {
      // Swap the two sort orders. Use index-based order to keep values stable.
      const [r1, r2] = await Promise.all([
        updateCustomFieldAction({ id: a.id, sortOrder: swapIdx }),
        updateCustomFieldAction({ id: b.id, sortOrder: idx }),
      ]);
      applyResult(r1);
      applyResult(r2);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Active definitions */}
      <section className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13.5px] font-medium">Item fields</h2>
          {!draft && (
            <Button size="sm" variant="outline" onClick={() => setDraft(emptyDraft())}>
              <Plus aria-hidden className="h-4 w-4" /> Add field
            </Button>
          )}
        </div>

        {active.length === 0 && !draft && (
          <p className="text-muted-foreground bg-card rounded-lg border px-[18px] py-6 text-center text-[13.5px]">
            No custom fields yet. Add one to capture extra item data (warranty, voltage, color,
            etc.).
          </p>
        )}

        {active.length > 0 && (
          <ul className="bg-card divide-border divide-y rounded-lg border">
            {active.map((def, idx) => (
              <li key={def.id} className="flex min-h-[60px] items-center gap-3 px-[18px] py-2.5">
                {/* Reorder: each button names its field (it said only "Move up"). */}
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={pending || idx === 0}
                    onClick={() => reorder(def, -1)}
                    aria-label={`Move ${def.label} up`}
                  >
                    <ArrowUp aria-hidden className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={pending || idx === active.length - 1}
                    onClick={() => reorder(def, 1)}
                    aria-label={`Move ${def.label} down`}
                  >
                    <ArrowDown aria-hidden className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium">{def.label}</span>
                    <Badge variant="secondary">{TYPE_LABELS[def.fieldType]}</Badge>
                    {def.required && <Badge variant="outline">Required</Badge>}
                  </div>
                  <code className="text-muted-foreground font-mono text-[12px]">
                    {def.fieldKey}
                  </code>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setDraft(draftFromDefinition(def))}
                    aria-label={`Edit ${def.label}`}
                  >
                    <Pencil aria-hidden className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setArchived(def, true)}
                    aria-label="Archive field"
                    title={`Archive ${def.label}`}
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Draft editor */}
      {draft && (
        <section className="bg-card space-y-4 rounded-lg border p-[18px]">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13.5px] font-medium">{draft.id ? 'Edit field' : 'New field'}</h3>
            <Button size="icon" variant="ghost" onClick={() => setDraft(null)} aria-label="Cancel">
              <X aria-hidden className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cf-label">Label</Label>
              <Input
                id="cf-label"
                value={draft.label}
                maxLength={60}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="Warranty (months)"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cf-key">Field key</Label>
              <Input
                id="cf-key"
                value={draft.fieldKey}
                maxLength={64}
                disabled={!!draft.id}
                onChange={(e) => setDraft({ ...draft, fieldKey: e.target.value })}
                placeholder="warranty_months"
              />
              <p className="text-muted-foreground text-[12px]">
                snake_case.{' '}
                {draft.id ? 'Cannot be changed after creation.' : 'Stored on each item.'}
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cf-type">Type</Label>
              <Select
                value={draft.fieldType}
                onValueChange={(v) => setDraft({ ...draft, fieldType: v as CustomFieldType })}
              >
                <SelectTrigger id="cf-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_FIELD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end pb-1.5">
              <Checkbox
                checked={draft.required}
                onCheckedChange={(next) => setDraft({ ...draft, required: next })}
              >
                Required
              </Checkbox>
            </div>
          </div>

          {draft.fieldType === 'select' && (
            <OptionsEditor
              options={draft.options}
              onChange={(options) => setDraft({ ...draft, options })}
            />
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={pending}>
              {draft.id ? 'Save changes' : 'Add field'}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </section>
      )}

      {/* Archived definitions */}
      {archived.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="text-muted-foreground text-[13.5px] font-medium">Archived</h2>
          <ul className="bg-card divide-border divide-y rounded-lg border">
            {archived.map((def) => (
              <li key={def.id} className="flex min-h-[52px] items-center gap-3 px-[18px] py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="truncate text-[13.5px]">{def.label}</span>
                  <code className="text-muted-foreground ml-2 font-mono text-[12px]">
                    {def.fieldKey}
                  </code>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setArchived(def, false)}
                >
                  <RotateCcw aria-hidden className="h-4 w-4" /> Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: CustomFieldOption[];
  onChange: (next: CustomFieldOption[]) => void;
}) {
  const [label, setLabel] = React.useState('');

  function add() {
    const trimmed = label.trim();
    if (!trimmed) return;
    // value defaults to a slugified, lowercase label; keep it stable + unique.
    const value = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!value || options.some((o) => o.value === value)) {
      setLabel('');
      return;
    }
    onChange([...options, { value, label: trimmed }]);
    setLabel('');
  }

  return (
    <div className="space-y-2">
      <Label>Options</Label>
      <ul className="space-y-1">
        {options.map((o, i) => (
          <li key={o.value} className="flex items-center gap-2">
            <Badge variant="secondary">{o.value}</Badge>
            <span className="text-[13px]">{o.label}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onChange(options.filter((_, j) => j !== i))}
              aria-label="Remove option"
              title={`Remove ${o.label}`}
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          value={label}
          maxLength={60}
          placeholder="Add an option"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" variant="outline" onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}
