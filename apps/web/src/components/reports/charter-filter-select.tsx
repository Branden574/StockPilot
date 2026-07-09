'use client';

import { useRouter, useSearchParams } from 'next/navigation';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Optional "by charter" filter for the inventory-valuation report (Model B,
 * task 8). Purely additive — the URL has no `charterId` param by default,
 * which is the whole-org total the report has always shown. Picking a
 * charter pushes `?charterId=<id>` (preserving any other query params) so
 * the server component re-renders scoped to that charter, and the CSV/PDF
 * export links (built by the parent) pick it up too.
 */
export function CharterFilterSelect({
  charters,
  current,
}: {
  charters: Array<{ id: string; name: string; code: string | null }>;
  current: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function onChange(value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === 'all') next.delete('charterId');
    else next.set('charterId', value);
    const qs = next.toString();
    router.push(qs ? `?${qs}` : '?', { scroll: false });
  }

  return (
    <Select value={current ?? 'all'} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-[220px]" aria-label="Filter by charter">
        <SelectValue placeholder="All charters" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All charters</SelectItem>
        {charters.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.code ? `${c.name} · ${c.code}` : c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
