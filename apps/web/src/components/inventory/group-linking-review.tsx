'use client';

import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { SIZE_SYSTEMS, type CountingUnit } from '@stockpilot/core';

import { StatePanel } from '@/components/patterns/state-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { linkFamilyAction } from '@/server/actions/product-group-linking';

/**
 * The opt-in group-linking review screen.
 *
 * THE ONE RULE THIS COMPONENT ENFORCES IN THE UI: a link only ever leaves here
 * carrying item ids a person ticked, for a family a person opened, with a
 * reason a person typed. Every affordance that would let someone skip that
 * — a select-all across families, an "accept all suggestions" button, a
 * default-checked selection — is deliberately absent. Owner decision
 * 2026-07-27 refused a name-heuristic backfill; a bulk accept with heuristic
 * defaults is the same write with a nicer name on it.
 *
 * Members start UNSELECTED for the same reason. Ticking is the act of review.
 */

export interface ReviewMember {
  id: string;
  name: string;
  sku: string;
  parsedSize: string | null;
  quantity: number;
}

export interface ReviewSuggestion {
  styleKey: string;
  baseName: string;
  members: ReviewMember[];
  caveats: string[];
  confidence: 'medium' | 'low';
}

export interface ReviewExistingGroup {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
}

/** Per-member editable state. Seeded from the parse, owned by the reviewer. */
interface MemberDraft {
  selected: boolean;
  variantSize: string;
  variantSizeSystem: string;
  jerseyNumber: string;
}

const CONFIDENCE_COPY: Record<ReviewSuggestion['confidence'], string> = {
  medium: 'Suggestion · names line up',
  low: 'Suggestion · check this one carefully',
};

export function GroupLinkingReview({
  suggestions,
  existingGroups,
  groupsTruncated = false,
  subcategoryKeys,
}: {
  suggestions: ReviewSuggestion[];
  existingGroups: ReviewExistingGroup[];
  /**
   * True when the destination list is a PREFIX of the org's groups (the read
   * hit its cap). Disclosed on every card that offers the dropdown rather than
   * presenting a truncated list as the whole one — a cap nobody is told about
   * is the bug, not the cap.
   */
  groupsTruncated?: boolean;
  subcategoryKeys: string[];
}) {
  // Dismissals are LOCAL to this visit. Persisting them would need a table
  // and a migration, and a dismissal is cheap to repeat; a wrong permanent
  // one is not. Reloading brings the family back, which is the safe default.
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [linked, setLinked] = React.useState<ReadonlySet<string>>(() => new Set<string>());

  const visible = suggestions.filter(
    (s) => !dismissed.has(s.styleKey) && !linked.has(s.styleKey),
  );

  return (
    <div className="space-y-4">
      {visible.length === 0 ? (
        <StatePanel
          kind="empty"
          size="sm"
          headingLevel={null}
          title="Every suggestion on this page has been handled. Reload to look again."
        />
      ) : (
        visible.map((s) => (
          <FamilyCard
            key={s.styleKey}
            suggestion={s}
            existingGroups={existingGroups}
            groupsTruncated={groupsTruncated}
            subcategoryKeys={subcategoryKeys}
            onDismiss={() =>
              setDismissed((prev) => new Set(prev).add(s.styleKey))
            }
            onLinked={() => setLinked((prev) => new Set(prev).add(s.styleKey))}
          />
        ))
      )}
    </div>
  );
}

function FamilyCard({
  suggestion,
  existingGroups,
  groupsTruncated,
  subcategoryKeys,
  onDismiss,
  onLinked,
}: {
  suggestion: ReviewSuggestion;
  existingGroups: ReviewExistingGroup[];
  groupsTruncated: boolean;
  subcategoryKeys: string[];
  onDismiss: () => void;
  onLinked: () => void;
}) {
  const router = useRouter();
  const headingId = React.useId();
  const [pending, startTransition] = React.useTransition();
  const [reason, setReason] = React.useState('');
  const [destination, setDestination] = React.useState<'new' | string>('new');
  const [subcategoryKey, setSubcategoryKey] = React.useState(subcategoryKeys[0] ?? 'other_sports_equipment');
  const [countingUnit, setCountingUnit] = React.useState<CountingUnit>('each');
  const [groupName, setGroupName] = React.useState(suggestion.baseName);
  const [drafts, setDrafts] = React.useState<Record<string, MemberDraft>>(() =>
    Object.fromEntries(
      suggestion.members.map((m) => [
        m.id,
        {
          // NOT pre-selected. See the component header.
          selected: false,
          variantSize: m.parsedSize ?? '',
          variantSizeSystem: '',
          jerseyNumber: '',
        },
      ]),
    ),
  );

  const patch = (id: string, next: Partial<MemberDraft>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id]!, ...next } }));

  const selectedIds = suggestion.members.filter((m) => drafts[m.id]?.selected).map((m) => m.id);
  const canLink = selectedIds.length > 0 && reason.trim().length > 0 && !pending;

  function submit() {
    const members = suggestion.members
      .filter((m) => drafts[m.id]?.selected)
      .map((m) => {
        const d = drafts[m.id]!;
        return {
          itemId: m.id,
          variantSize: d.variantSize.trim() || null,
          // The reviewer's typed value IS the original text — the server
          // normalizes for matching and keeps this untouched.
          variantSizeOriginal: d.variantSize.trim() || null,
          variantSizeSystem: d.variantSizeSystem || null,
          jerseyNumber: d.jerseyNumber.trim() || null,
        };
      });

    startTransition(async () => {
      const res = await linkFamilyAction(
        destination === 'new'
          ? {
              group: {
                name: groupName.trim() || suggestion.baseName,
                subcategoryKey,
                defaultCountingUnit: countingUnit,
              },
              members,
              reason: reason.trim(),
            }
          : { groupId: destination, members, reason: reason.trim() },
      );
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success(
        `Linked ${res.data.linked} ${res.data.linked === 1 ? 'item' : 'items'} into one product.`,
      );
      onLinked();
      router.refresh();
    });
  }

  return (
    // One card per suggestion (the card language, DESIGN-SPEC 6.7), its
    // member table in the shared table look.
    <section
      aria-labelledby={headingId}
      className="border-border bg-card overflow-hidden rounded-lg border"
    >
      <div className="border-border flex flex-wrap items-start justify-between gap-3 border-b px-[18px] py-3.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={headingId} className="min-w-0 truncate text-[13.5px] font-medium leading-5">
              {suggestion.baseName}
            </h2>
            <Badge variant={suggestion.confidence === 'low' ? 'warning' : 'outline'}>
              {CONFIDENCE_COPY[suggestion.confidence]}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-0.5 text-[12px]">
            {suggestion.members.length} candidate items. Nothing here is linked yet.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss} disabled={pending}>
          Not a family
        </Button>
      </div>

      {suggestion.caveats.length > 0 ? (
        <ul className="border-border bg-warning-wash space-y-1 border-b px-[18px] py-2.5">
          {suggestion.caveats.map((c) => (
            <li key={c} className="text-foreground flex items-start gap-1.5 text-[12.5px]">
              <AlertTriangle aria-hidden className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{c}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-[13px]">
          <thead className="text-muted-foreground">
            <tr className="border-border border-b">
              <th className={cn(TH, 'w-10 pl-[18px] pr-2 text-left')}>
                <span className="sr-only">Include</span>
              </th>
              <th className={cn(TH, 'text-left')}>Item</th>
              <th className={cn(TH, 'text-left')}>SKU</th>
              <th className={cn(TH, 'text-left')}>Size</th>
              <th className={cn(TH, 'text-left')}>Size system</th>
              <th className={cn(TH, 'text-left')}>Number</th>
              <th className={cn(TH, 'pr-[18px] text-right')}>On hand</th>
            </tr>
          </thead>
          <tbody>
            {suggestion.members.map((m) => {
              const d = drafts[m.id]!;
              return (
                <tr
                  key={m.id}
                  className={cn(
                    'border-border border-b transition-colors last:border-0',
                    d.selected ? 'bg-success-wash' : 'hover:bg-muted/60',
                  )}
                >
                  <td className="py-2 pl-[18px] pr-2">
                    {/* The shared checkbox; members start unticked, and there
                        is no select-all (owner decision). */}
                    <Checkbox
                      checked={d.selected}
                      onCheckedChange={(next) => patch(m.id, { selected: next })}
                      label={`Include ${m.name} in this family`}
                    />
                  </td>
                  <td className="max-w-[220px] truncate px-3">{m.name}</td>
                  <td className="text-muted-foreground px-3 font-mono text-[12px]">{m.sku}</td>
                  <td className="px-3">
                    <Input
                      value={d.variantSize}
                      onChange={(e) => patch(m.id, { variantSize: e.target.value })}
                      aria-label={`Size for ${m.name}`}
                      className="h-7 w-24 text-[12.5px]"
                    />
                  </td>
                  <td className="px-3">
                    <select
                      value={d.variantSizeSystem}
                      onChange={(e) => patch(m.id, { variantSizeSystem: e.target.value })}
                      aria-label={`Size system for ${m.name}`}
                      className={cn(NATIVE_SELECT, 'h-7 px-1.5 text-[12.5px]')}
                    >
                      <option value="">Not set</option>
                      {SIZE_SYSTEMS.map((s) => (
                        <option key={s} value={s}>
                          {s.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3">
                    {/* NEVER labelled "Serial Number" — a jersey number repeats
                        across sizes and teams and is not identity
                        (requirements 4). */}
                    <Input
                      value={d.jerseyNumber}
                      onChange={(e) => patch(m.id, { jerseyNumber: e.target.value })}
                      inputMode="numeric"
                      placeholder="e.g. 07"
                      aria-label={`Jersey number for ${m.name}`}
                      className="h-7 w-20 text-[12.5px]"
                    />
                  </td>
                  <td className="pl-3 pr-[18px] text-right tabular-nums">{m.quantity}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="border-border bg-sunk space-y-3 border-t px-[18px] py-3.5">
        <div className="flex flex-wrap items-end gap-3">
          <label className={FIELD_LABEL}>
            Link into
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className={NATIVE_SELECT}
            >
              <option value="new">A new product group</option>
              {existingGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {[g.name, g.brand, g.model].filter(Boolean).join(' · ')}
                </option>
              ))}
            </select>
            {groupsTruncated ? (
              <span className="text-muted-foreground max-w-[320px] text-[12px]">
                Showing the first {existingGroups.length.toLocaleString()} groups. Rename or
                archive groups you no longer use, or link into a new group instead.
              </span>
            ) : null}
          </label>

          {destination === 'new' && (
            <>
              <label className={FIELD_LABEL}>
                Group name
                <Input
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  className="text-foreground w-56 max-w-full"
                />
              </label>
              <label className={FIELD_LABEL}>
                Subcategory
                <select
                  value={subcategoryKey}
                  onChange={(e) => setSubcategoryKey(e.target.value)}
                  className={NATIVE_SELECT}
                >
                  {subcategoryKeys.map((k) => (
                    <option key={k} value={k}>
                      {k.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label className={FIELD_LABEL}>
                Counted in
                <select
                  value={countingUnit}
                  onChange={(e) => setCountingUnit(e.target.value as CountingUnit)}
                  className={NATIVE_SELECT}
                >
                  <option value="each">each</option>
                  <option value="pair">pairs</option>
                  <option value="set">sets</option>
                  <option value="case">cases</option>
                  <option value="unit">units</option>
                </select>
              </label>
            </>
          )}
        </div>

        <label className={cn(FIELD_LABEL, 'flex')}>
          Why are these one product? (required — it is stored on the audit trail)
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Checked the rack: same style, three sizes"
            className="text-foreground"
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-[12.5px]">
            {selectedIds.length === 0
              ? 'Tick the items that really are one product.'
              : `${selectedIds.length} of ${suggestion.members.length} items selected.`}
          </p>
          {/* Committing the reviewed family: the ink primary. */}
          <Button type="button" onClick={submit} disabled={!canLink}>
            {pending ? 'Linking…' : `Link ${selectedIds.length || ''} selected`.trim()}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** A member-table header cell: 11 px uppercase in the quiet ink (DESIGN-SPEC 6.9). */
const TH = 'whitespace-nowrap px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.06em]';
/** A labelled control in the footer: the words above the field. */
const FIELD_LABEL = 'text-muted-foreground flex flex-col gap-1.5 text-[12.5px]';
/** A native select in the shared input look (44 px and 16 px text on a phone). */
const NATIVE_SELECT =
  'border-line-strong bg-card text-foreground focus-visible:ring-ring focus-visible:ring-offset-background h-8 max-w-full rounded-md border px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 max-sm:h-11 max-sm:text-base';
