import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalDate } from '@/components/ui/local-date';
import { ReleaseEntryCard } from '@/components/updates/release-entry-card';
import { MarkReleaseRead } from '@/components/updates/release-history-actions';
import { utcDateLabel } from '@/lib/utc-date-label';
import { withContext } from '@/server/services/context';
import { getReleaseFor } from '@/server/services/releases';

export const dynamic = 'force-dynamic';

const LABEL = 'text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--ed-ink-3)]';

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const release = await getReleaseFor(await withContext(), slug);
  // The same title for "no such release" and "not for you": a tab title must
  // not confirm what the page itself refuses to.
  return { title: release ? `${release.title} · What’s new` : 'What’s new' };
}

/**
 * One release, by its own stable URL: a complete page that works from a bookmark
 * or a shared link, with browser back and forward, and no drawer involved.
 *
 * notFound() covers a release that does not exist, a draft, and one that is not
 * addressed to this reader, identically.
 */
export default async function WhatsNewReleasePage({ params }: Params) {
  const { slug } = await params;
  const release = await getReleaseFor(await withContext(), slug);
  if (!release) notFound();

  const withdrawn = release.status === 'withdrawn';

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link
        href="/dashboard/whats-new"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[13px]"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Release history
      </Link>

      <h1 className="mt-3 font-display text-[28px] font-medium leading-tight tracking-[-0.02em]">
        {release.title}
      </h1>
      <p className="mt-2 text-[12.5px] text-[var(--ed-ink-3)]">
        {release.version ? `${release.version} · ` : ''}
        <LocalDate iso={release.publishedAt} fallback={utcDateLabel(release.publishedAt)} />
      </p>

      <MarkReleaseRead releaseId={release.id} alreadyRead={release.state.read || withdrawn} />

      {withdrawn ? (
        <div className="mt-6 rounded-xl border p-4">
          <p className={LABEL}>This release was withdrawn</p>
          <p className="mt-1.5 text-sm leading-relaxed">
            {release.withdrawnNote ?? 'These changes are not available at the moment.'}
          </p>
        </div>
      ) : (
        <>
          <section aria-labelledby="release-highlights" className="mt-6">
            <h2 id="release-highlights" className={LABEL}>
              Highlights
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed">{release.summary}</p>
          </section>
          <section aria-label="Changes in this release" className="mt-6 space-y-3">
            {release.entries.map((entry) => (
              <ReleaseEntryCard key={entry.id} entry={entry} />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
