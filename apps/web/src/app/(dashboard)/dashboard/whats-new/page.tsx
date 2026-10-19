import type { Metadata } from 'next';
import { Gift } from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { Badge } from '@/components/ui/badge';
import { LocalDate } from '@/components/ui/local-date';
import { MarkAllReadButton } from '@/components/updates/release-history-actions';
import { utcDateLabel } from '@/lib/utc-date-label';
import { withContext } from '@/server/services/context';
import { listReleasesFor } from '@/server/services/releases';

export const metadata: Metadata = { title: 'What’s new' };
export const dynamic = 'force-dynamic';

/**
 * Release history: the permanent home of What's New, for after the notice is
 * gone. Newest first, in the registry's own order. Filtered ON THE SERVER to
 * what this reader can reach, so nobody is shown copy about a feature that would
 * bounce them (the Help page used to list the raw registry to every role).
 *
 * Opening this page marks NOTHING as read. A list of titles is not the releases.
 */
export default async function WhatsNewHistoryPage() {
  const ctx = await withContext();
  const list = await listReleasesFor(ctx);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            <Gift className="text-accent size-5 shrink-0" aria-hidden strokeWidth={1.75} /> What’s
            new
          </span>
        }
        subline="Every StockPilot release, what changed, and what it means for your work."
        actions={
          list.stateAvailable ? <MarkAllReadButton unreadCount={list.unreadCount} /> : undefined
        }
      />

      {!list.stateAvailable ? (
        <p
          role="status"
          className="border-border bg-sunk text-muted-foreground rounded-lg border px-3.5 py-2.5 text-[12.5px] leading-[18.75px]"
        >
          We could not load which releases you have read, so none are marked unread right now.
        </p>
      ) : null}

      {list.releases.length === 0 ? (
        <StatePanel
          kind="empty"
          icon={Gift}
          size="sm"
          title="There are no release notes for you yet."
        />
      ) : (
        <ol className="border-border bg-card overflow-hidden rounded-lg border">
          {list.releases.map((r) => (
            <li key={r.id} className="border-border border-b last:border-b-0">
              <Link
                href={`/dashboard/whats-new/${r.id}`}
                className="hover:bg-muted focus-visible:ring-ring block px-[18px] py-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
              >
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  {!r.state.read ? (
                    <Badge variant="success" dot>
                      Unread
                    </Badge>
                  ) : null}
                  {r.status === 'withdrawn' ? <Badge variant="outline">Withdrawn</Badge> : null}
                  <span className="text-muted-foreground text-[12px] leading-[18px]">
                    {r.version ? `${r.version} · ` : ''}
                    <LocalDate iso={r.publishedAt} fallback={utcDateLabel(r.publishedAt)} />
                  </span>
                </div>
                <h2 className="text-foreground mt-1.5 text-[15px] font-medium leading-[22px] tracking-[-0.005em]">
                  {r.title}
                </h2>
                <p className="text-muted-foreground mt-1 line-clamp-3 text-[13px] leading-[19.5px]">
                  {r.summary}
                </p>
                <p className="text-accent mt-2 text-[12.5px] font-medium">
                  {r.status === 'withdrawn'
                    ? 'See why →'
                    : `Read ${r.entryCount} ${r.entryCount === 1 ? 'change' : 'changes'} →`}
                </p>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
