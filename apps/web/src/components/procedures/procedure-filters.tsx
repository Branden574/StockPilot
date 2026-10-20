import { Search, X } from 'lucide-react';
import Link from 'next/link';

import { FilterChipLink } from '@/components/patterns/chip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import {
  PROCEDURES_PATH,
  procedureListClearHref,
  procedureListHref,
  type ProcedureListState,
} from './list-query';

interface CategoryOption {
  id: string;
  name: string;
  color: string | null;
}

interface WarehouseOption {
  id: string;
  name: string;
}

/**
 * The Procedures list's filter row (DESIGN-SPEC 6.3, 6.4, 6.6): a GET form
 * with the search field, Search and Clear, the Warehouse select (applied on
 * Search, as before: no auto-submit), and the category chips under it.
 *
 * The form sends each parameter once. `wh` comes from the select only: the
 * hidden `wh` field it used to carry beside the select sent the warehouse
 * twice, which broke the page (CONFLICTS D21). `cat` and `view` ride along as
 * hidden fields, because no control in the form holds them.
 *
 * Category chips are links that keep q / wh / view and go back to page 1;
 * each keeps its words and shows the category's colour as a dot.
 */
export function ProcedureFilters({
  state,
  categories,
  warehouses,
}: {
  state: ProcedureListState;
  categories: CategoryOption[];
  warehouses: WarehouseOption[];
}) {
  const hasFilters = state.q.length > 0 || state.cat.length > 0 || state.wh.length > 0;
  return (
    <form action={PROCEDURES_PATH} method="get" className="flex flex-col gap-3">
      {/* The filter row (FilterBar's look: wrapping, 8 px gaps). Written out
          here so the search field can take the full row on a phone. */}
      <div data-slot="filter-bar" className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-[280px]">
          <Search
            className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            name="q"
            defaultValue={state.q}
            placeholder="Search procedures…"
            className="pl-8"
          />
        </div>
        {state.cat && <input type="hidden" name="cat" value={state.cat} />}
        {state.archived && <input type="hidden" name="view" value="archived" />}
        <Button type="submit" variant="outline" className="max-sm:h-11">
          Search
        </Button>
        {hasFilters && (
          <Button asChild variant="ghost" className="text-muted-foreground max-sm:h-11">
            <Link href={procedureListClearHref(state)}>
              <X className="mr-1 h-3.5 w-3.5" /> Clear
            </Link>
          </Button>
        )}
        <div className="flex min-w-0 max-w-full items-center gap-2 sm:ml-auto">
          <label className="text-muted-foreground shrink-0 text-[12.5px]" htmlFor="wh-filter">
            Warehouse
          </label>
          <select
            id="wh-filter"
            name="wh"
            defaultValue={state.wh}
            className="bg-card text-foreground focus-visible:ring-ring focus-visible:ring-offset-background border-line-strong h-8 min-w-0 max-w-full rounded-md border px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-offset-2 max-sm:h-11 max-sm:text-base"
          >
            <option value="">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {categories.length > 0 && (
        <div data-slot="procedure-category-chips" className="flex flex-wrap gap-2">
          <FilterChipLink
            href={procedureListHref(state, { cat: '', page: 1 })}
            active={!state.cat}
            aria-label="All categories"
          >
            All
          </FilterChipLink>
          {categories.map((c) => (
            <FilterChipLink
              key={c.id}
              href={procedureListHref(state, { cat: c.id, page: 1 })}
              active={state.cat === c.id}
            >
              <span
                aria-hidden
                data-slot="category-dot"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: c.color ?? '#475569' }}
              />
              {c.name}
            </FilterChipLink>
          ))}
        </div>
      )}
    </form>
  );
}
