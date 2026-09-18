import type { Metadata } from 'next';
import { Gift } from 'lucide-react';
import Link from 'next/link';

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
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Gift className="text-primary size-5" aria-hidden /> What’s new
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Every StockPilot release, what changed, and what it means for your work.
          </p>
        </div>
        {list.stateAvailable ? <MarkAllReadButton unreadCount={list.unreadCount} /> : null}
      </div>

      {!list.stateAvailable ? (
        <p
          role="status"
          className="mt-6 rounded-lg border px-3 py-2 text-[12.5px] text-[var(--ed-ink-3)]"
        >
          We could not load which releases you have read, so none are marked unread right now.
        </p>
      ) : null}

      {list.releases.length === 0 ? (
        <p className="text-muted-foreground mt-10 text-sm">
          There are no release notes for you yet.
        </p>
      ) : (
        <ol className="mt-8 space-y-3">
          {list.releases.map((r) => (
            <li key={r.id}>
              <Link
                href={`/dashboard/whats-new/${r.id}`}
                className="bg-card hover:bg-muted/40 focus-visible:ring-ring block rounded-xl border p-4 transition-colors focus-visible:outline-none focus-visible:ring-2"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {!r.state.read ? (
                    <span className="border-primary/40 text-primary inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium">
                      <span aria-hidden className="bg-primary size-1.5 rounded-full" /> Unread
                    </span>
                  ) : null}
                  {r.status === 'withdrawn' ? (
                    <span className="border-border rounded-full border px-2 py-0.5 text-[11px] font-medium text-[var(--ed-ink-3)]">
                      Withdrawn
                    </span>
                  ) : null}
                  <span className="text-[12px] text-[var(--ed-ink-3)]">
                    {r.version ? `${r.version} · ` : ''}
                    <LocalDate iso={r.publishedAt} fallback={utcDateLabel(r.publishedAt)} />
                  </span>
                </div>
                <h2 className="mt-2 text-base font-semibold tracking-tight">{r.title}</h2>
                <p className="text-muted-foreground mt-1 line-clamp-3 text-sm leading-relaxed">
                  {r.summary}
                </p>
                <p className="text-primary mt-2 text-[13px] font-medium">
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
