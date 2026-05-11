import { BookOpen, Search, X } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ProcedureCard } from '@/components/procedures/procedure-card';
import { requireOrgContext } from '@/lib/auth/session';
import { hasPermission } from '@stockpilot/core';
import { ProcedureCategoriesService } from '@/server/services/procedure-categories';
import { ProceduresService } from '@/server/services/procedures';
import { WarehousesService } from '@/server/services/warehouses';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 24;

interface SearchParams {
  q?: string;
  cat?: string;
  wh?: string;
  page?: string;
}

export default async function ProceduresListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = params.q?.trim() || '';
  const cat = params.cat?.trim() || '';
  const wh = params.wh?.trim() || '';
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const ctx = await requireOrgContext();
  const canCreate = hasPermission(ctx.role, 'categories:manage');

  const [procService, catService, whService] = await Promise.all([
    ProceduresService.forCurrentUser(),
    ProcedureCategoriesService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);

  const [{ rows, total }, categories, warehouses] = await Promise.all([
    procService.list({
      q: q || null,
      categoryId: cat || null,
      warehouseId: wh || null,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    catService.list(),
    whService.list(),
  ]);

  const hasFilters = q.length > 0 || cat.length > 0 || wh.length > 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function buildQS(overrides: Partial<SearchParams>): string {
    const sp = new URLSearchParams();
    const merged = { q, cat, wh, page: String(page), ...overrides };
    if (merged.q) sp.set('q', merged.q);
    if (merged.cat) sp.set('cat', merged.cat);
    if (merged.wh) sp.set('wh', merged.wh);
    if (merged.page && merged.page !== '1') sp.set('page', merged.page);
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Procedures</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cross-warehouse standard operating procedures, with video walkthroughs and
            discussion.
          </p>
        </div>
        {canCreate && (
          <Button asChild variant="gradient">
            <Link href="/dashboard/procedures/new">+ New procedure</Link>
          </Button>
        )}
      </div>

      <form action="/dashboard/procedures" method="get" className="mt-6 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search procedures…"
              className="pl-8"
            />
          </div>
          {cat && <input type="hidden" name="cat" value={cat} />}
          {wh && <input type="hidden" name="wh" value={wh} />}
          <Button type="submit" variant="outline">
            Search
          </Button>
          {hasFilters && (
            <Button asChild variant="ghost">
              <Link href="/dashboard/procedures">
                <X className="mr-1 h-3.5 w-3.5" /> Clear
              </Link>
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <label className="text-xs text-muted-foreground" htmlFor="wh-filter">
              Warehouse
            </label>
            <select
              id="wh-filter"
              name="wh"
              defaultValue={wh}
              className="rounded-md border bg-background px-2 py-1.5 text-xs"
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
          <div className="flex flex-wrap gap-1.5">
            <Link
              href={buildQS({ cat: '', page: '1' })}
              className="rounded-full"
              aria-label="All categories"
            >
              <Badge
                variant={cat ? 'outline' : 'default'}
                className="cursor-pointer"
              >
                All
              </Badge>
            </Link>
            {categories.map((c) => {
              const active = cat === c.id;
              return (
                <Link key={c.id} href={buildQS({ cat: c.id, page: '1' })}>
                  <Badge
                    variant={active ? 'default' : 'outline'}
                    className="cursor-pointer"
                    style={
                      active
                        ? {
                            backgroundColor: c.color ?? undefined,
                            borderColor: c.color ?? undefined,
                          }
                        : {
                            borderColor: `${c.color ?? '#475569'}55`,
                            color: c.color ?? undefined,
                          }
                    }
                  >
                    {c.name}
                  </Badge>
                </Link>
              );
            })}
          </div>
        )}
      </form>

      <div className="mt-6">
        {rows.length === 0 ? (
          hasFilters ? (
            <EmptyState
              icon={BookOpen}
              title="No matches"
              description="Try a broader search or clear the filters."
            />
          ) : (
            <EmptyState
              icon={BookOpen}
              title="No procedures yet"
              description="Start capturing how your warehouses get things done — write the steps and attach a quick video."
              cta={canCreate ? { label: 'Create first procedure', href: '/dashboard/procedures/new' } : undefined}
            />
          )
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {rows.map((row) => (
              <li key={row.id}>
                <ProcedureCard procedure={row} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {totalPages > 1 && (
        <nav
          aria-label="Pagination"
          className="mt-6 flex items-center justify-between text-sm"
        >
          <p className="text-muted-foreground">
            Page {page} of {totalPages} · {total} total
          </p>
          <div className="flex gap-2">
            {page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/dashboard/procedures${buildQS({ page: String(page - 1) })}`}>
                  Previous
                </Link>
              </Button>
            )}
            {page < totalPages && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/dashboard/procedures${buildQS({ page: String(page + 1) })}`}>
                  Next
                </Link>
              </Button>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
