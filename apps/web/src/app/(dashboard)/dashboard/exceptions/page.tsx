import { AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ExceptionsService } from '@/server/services/exceptions';
import { ServiceError } from '@/server/services/context';

import { countExceptions, groupExceptions, type WarehouseException } from '@stockpilot/core';

export const metadata = { title: 'Exceptions · StockPilot' };

/**
 * THE EXCEPTION CENTER.
 *
 * Built first, ahead of the warehouse work queue, because the operation was
 * measured before either was built: one order in flight, nothing sitting in a
 * non-terminal status, staging cleared inside two days. There is no backlog for
 * a queue to manage.
 *
 * What there was, on the same day and found only by hand-written SQL: 49 units
 * unplaced for 55 days, two items whose printed label names a rack holding none
 * of their stock, and 22 units on a rack number the floor does not have — which
 * sat visible in the database for four weeks before anybody noticed.
 *
 * None of that had been assigned to someone and forgotten. It was simply wrong,
 * and nothing surfaced it. This page is the thing that surfaces it.
 */
export default async function ExceptionsPage() {
  let svc: ExceptionsService;
  try {
    svc = await ExceptionsService.forCurrentUser();
  } catch (e) {
    if (e instanceof ServiceError && (e.code === 'forbidden' || e.code === 'not_found')) notFound();
    throw e;
  }

  let result;
  try {
    result = await svc.list();
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'forbidden') notFound();
    throw e;
  }

  const groups = groupExceptions(result.exceptions);
  const { total, critical } = countExceptions(result.exceptions);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Exceptions</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Conditions that are wrong and that nothing else tells you about. This is a live read —
          fix the cause and the row disappears on its own.
        </p>
      </header>

      {total === 0 ? (
        /* The empty state a reader should WANT to see, and deliberately distinct
           from "no results match your filters" — there are no filters here. */
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CheckCircle2 className="text-success size-7" aria-hidden />
            <p className="text-base font-medium">Nothing needs attention</p>
            <p className="text-muted-foreground max-w-md text-sm">
              No archived locations holding stock, nothing over-promised, nothing stranded in
              Staging or Unplaced, and every rack label agrees with where the stock actually is.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <Badge variant={critical > 0 ? 'destructive' : 'secondary'} className="gap-1">
              {critical > 0 && <AlertTriangle className="size-3" aria-hidden />}
              {total} open
            </Badge>
            {critical > 0 && (
              <span className="text-muted-foreground text-xs">{critical} need attention now</span>
            )}
          </div>

          <div className="space-y-4">
            {groups.map((g) => (
              <Card key={g.meta.rule}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">{g.meta.label}</CardTitle>
                    {/* Severity carries an icon and a word, never colour alone —
                        these screens get read on cheap handsets in bad light. */}
                    <Badge
                      variant={g.meta.severity === 'critical' ? 'destructive' : 'secondary'}
                      className="gap-1"
                    >
                      {g.meta.severity === 'critical' && (
                        <AlertTriangle className="size-3" aria-hidden />
                      )}
                      {g.meta.severity === 'critical' ? 'Critical' : 'Warning'}
                    </Badge>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {g.items.length}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-sm">{g.meta.action}</p>
                  {result.truncatedRules.includes(g.meta.rule) && (
                    /* NEVER a silent cap. A truncated list that looks complete is
                       a lie the reader has no way to detect. */
                    <p className="text-warning mt-1 text-xs">
                      Showing the first {g.items.length}. There are more — this rule is the finding.
                    </p>
                  )}
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="divide-border divide-y">
                    {g.items.map((e) => (
                      <ExceptionRow key={e.key} e={e} />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ExceptionRow({ e }: { e: WarehouseException }) {
  const body = (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{e.title}</p>
        <p className="text-muted-foreground truncate text-xs">{e.detail}</p>
      </div>
      {e.href && <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />}
    </div>
  );
  return (
    <li>
      {e.href ? (
        <Link
          href={e.href}
          className="hover:bg-muted/50 focus-visible:ring-ring block rounded-sm px-1 focus-visible:ring-2 focus-visible:outline-none"
        >
          {body}
        </Link>
      ) : (
        <div className="px-1">{body}</div>
      )}
    </li>
  );
}
