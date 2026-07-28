'use client';

import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { SIZE_SYSTEMS, type CountingUnit } from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
        <p className="text-[13px] text-[var(--ed-ink-3)]">
          Every suggestion on this page has been handled. Reload to look again.
        </p>
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
    <section className="border-border rounded-lg border">
      <header className="border-border flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[14px] font-medium">{suggestion.baseName}</h2>
            <span
              className={
                suggestion.confidence === 'low'
                  ? 'shrink-0 rounded-full border border-amber-500/40 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400'
                  : 'border-border shrink-0 rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--ed-ink-3)]'
              }
            >
              {CONFIDENCE_COPY[suggestion.confidence]}
            </span>
          </div>
          <p className="text-[11.5px] text-[var(--ed-ink-4)]">
            {suggestion.members.length} candidate items. Nothing here is linked yet.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss} disabled={pending}>
          Not a family
        </Button>
      </header>

      <ul className="border-border space-y-1 border-b px-4 py-2.5">
        {suggestion.caveats.map((c) => (
          <li key={c} className="flex items-start gap-1.5 text-[11.5px] text-[var(--ed-ink-3)]">
            <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
            <span>{c}</span>
          </li>
        ))}
      </ul>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-[12px]">
          <thead className="text-[var(--ed-ink-4)]">
            <tr className="border-border border-b">
              <th className="w-8 py-1.5 pl-4 pr-2 text-left font-medium">
                <span className="sr-only">Include</span>
              </th>
              <th className="px-2 text-left font-medium">Item</th>
              <th className="px-2 text-left font-medium">SKU</th>
              <th className="px-2 text-left font-medium">Size</th>
              <th className="px-2 text-left font-medium">Size system</th>
              <th className="px-2 text-left font-medium">Number</th>
              <th className="px-2 pr-4 text-right font-medium">On hand</th>
            </tr>
          </thead>
          <tbody>
            {suggestion.members.map((m) => {
              const d = drafts[m.id]!;
              return (
                <tr key={m.id} className="border-border border-b last:border-0">
                  <td className="py-1.5 pl-4 pr-2">
                    <input
                      type="checkbox"
                      checked={d.selected}
                      onChange={(e) => patch(m.id, { selected: e.target.checked })}
                      aria-label={`Include ${m.name} in this family`}
                      className="h-3.5 w-3.5"
                    />
                  </td>
                  <td className="max-w-[220px] truncate px-2">{m.name}</td>
                  <td className="px-2 font-mono text-[11px] text-[var(--ed-ink-3)]">{m.sku}</td>
                  <td className="px-2">
                    <Input
                      value={d.variantSize}
                      onChange={(e) => patch(m.id, { variantSize: e.target.value })}
                      aria-label={`Size for ${m.name}`}
                      className="h-7 w-24 text-[12px]"
                    />
                  </td>
                  <td className="px-2">
                    <select
                      value={d.variantSizeSystem}
                      onChange={(e) => patch(m.id, { variantSizeSystem: e.target.value })}
                      aria-label={`Size system for ${m.name}`}
                      className="border-border bg-background h-7 rounded-md border px-1.5 text-[12px]"
                    >
                      <option value="">Not set</option>
                      {SIZE_SYSTEMS.map((s) => (
                        <option key={s} value={s}>
                          {s.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2">
                    {/* NEVER labelled "Serial Number" — a jersey number repeats
                        across sizes and teams and is not identity
                        (requirements 4). */}
                    <Input
                      value={d.jerseyNumber}
                      onChange={(e) => patch(m.id, { jerseyNumber: e.target.value })}
                      inputMode="numeric"
                      placeholder="e.g. 07"
                      aria-label={`Jersey number for ${m.name}`}
                      className="h-7 w-20 text-[12px]"
                    />
                  </td>
                  <td className="px-2 pr-4 text-right tabular-nums">{m.quantity}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="border-border space-y-3 border-t px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11.5px] text-[var(--ed-ink-3)]">
            Link into
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className="border-border bg-background h-8 rounded-md border px-2 text-[12px]"
            >
              <option value="new">A new product group</option>
              {existingGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {[g.name, g.brand, g.model].filter(Boolean).join(' · ')}
                </option>
              ))}
            </select>
            {groupsTruncated ? (
              <span className="text-[10.5px] text-[var(--ed-ink-4)]">
                Showing the first {existingGroups.length.toLocaleString()} groups. Rename or
                archive groups you no longer use, or link into a new group instead.
              </span>
            ) : null}
          </label>

          {destination === 'new' && (
            <>
              <label className="flex flex-col gap-1 text-[11.5px] text-[var(--ed-ink-3)]">
                Group name
                <Input
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  className="h-8 w-56 text-[12px]"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11.5px] text-[var(--ed-ink-3)]">
                Subcategory
                <select
                  value={subcategoryKey}
                  onChange={(e) => setSubcategoryKey(e.target.value)}
                  className="border-border bg-background h-8 rounded-md border px-2 text-[12px]"
                >
                  {subcategoryKeys.map((k) => (
                    <option key={k} value={k}>
                      {k.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11.5px] text-[var(--ed-ink-3)]">
                Counted in
                <select
                  value={countingUnit}
                  onChange={(e) => setCountingUnit(e.target.value as CountingUnit)}
                  className="border-border bg-background h-8 rounded-md border px-2 text-[12px]"
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

        <label className="block text-[11.5px] text-[var(--ed-ink-3)]">
          Why are these one product? (required — it is stored on the audit trail)
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Checked the rack: same style, three sizes"
            className="mt-1 h-8 text-[12px]"
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11.5px] text-[var(--ed-ink-4)]">
            {selectedIds.length === 0
              ? 'Tick the items that really are one product.'
              : `${selectedIds.length} of ${suggestion.members.length} items selected.`}
          </p>
          <Button type="button" size="sm" onClick={submit} disabled={!canLink}>
            {pending ? 'Linking…' : `Link ${selectedIds.length || ''} selected`.trim()}
          </Button>
        </div>
      </footer>
    </section>
  );
}
