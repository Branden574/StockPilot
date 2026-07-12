'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  setItemPublicVisibilityAction,
  type ItemPublicVisibility,
} from '@/server/actions/item-visibility';

export const PUBLIC_VISIBILITY_LABELS: Record<ItemPublicVisibility, string> = {
  internal_only: 'Internal only',
  public: 'Public',
  hidden: 'Hidden',
};

/**
 * Item-detail "Public visibility" control (P3 of the public-catalog plan).
 * Rendered only for viewers with public_links:manage — the server action
 * re-asserts the permission, this is just the UI surface gate.
 *
 * The helper copy mirrors the SQL predicate in migration 0261
 * (public_link_eligible_items): 'hidden' is ANDed above BOTH eligibility
 * branches (it beats explicit link entries too); 'public' only matters for
 * the shared-pool branch, which additionally requires the item's category to
 * be public and a link with include_public_pool.
 */
export function PublicVisibilityControl({
  itemId,
  value,
  categoryIsInternalOnly,
}: {
  itemId: string;
  value: ItemPublicVisibility;
  /** True when the item's category has public_visibility='internal_only' —
      drives the inherited/override warning on 'public' items. */
  categoryIsInternalOnly: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = React.useState<ItemPublicVisibility>(value);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onChange(next: string) {
    const visibility = next as ItemPublicVisibility;
    if (visibility === current || busy) return;
    const previous = current;
    setBusy(true);
    setError(null);
    setCurrent(visibility);
    const res = await setItemPublicVisibilityAction({ itemId, visibility });
    setBusy(false);
    if (!res.ok) {
      setCurrent(previous);
      setError(res.error.message);
      return;
    }
    toast.success(`Public visibility set to ${PUBLIC_VISIBILITY_LABELS[visibility]}.`);
    router.refresh();
  }

  return (
    <div className="w-full space-y-1.5">
      <div className="flex items-center gap-2">
        <Select value={current} onValueChange={onChange} disabled={busy}>
          <SelectTrigger className="h-8 w-[180px] text-sm" aria-label="Public visibility">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="internal_only">Internal only</SelectItem>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="hidden">Hidden</SelectItem>
          </SelectContent>
        </Select>
        {busy && <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
      {current === 'public' && categoryIsInternalOnly && (
        <p className="text-warning flex items-start gap-1.5 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This item is Public, but its category is internal-only, so it stays out of the
            shared public pool. It can still appear on links where it&apos;s individually
            selected.
          </span>
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        &lsquo;Hidden&rsquo; beats everything — the item never appears publicly, even when
        hand-picked on a link. &lsquo;Public&rsquo; still requires the item&apos;s category to
        be public and a link that includes the public pool. Per-link curation lives in
        Settings → Public request links.
      </p>
    </div>
  );
}
