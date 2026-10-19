import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { LocalDate } from '@/components/ui/local-date';
import { ReleaseEntryCard } from '@/components/updates/release-entry-card';
import { MarkReleaseRead } from '@/components/updates/release-history-actions';
import { utcDateLabel } from '@/lib/utc-date-label';
import { withContext } from '@/server/services/context';
import { getReleaseFor } from '@/server/services/releases';

export const dynamic = 'force-dynamic';

const LABEL = 'text-muted-foreground text-[11px] font-medium uppercase leading-4 tracking-[0.08em]';

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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        back={
          <PageHeaderBackLink href="/dashboard/whats-new">
            <ArrowLeft className="size-3.5" aria-hidden /> Release history
          </PageHeaderBackLink>
        }
        title={release.title}
        subline={
          <span className="text-[12.5px]">
            {release.version ? `${release.version} · ` : ''}
            <LocalDate iso={release.publishedAt} fallback={utcDateLabel(release.publishedAt)} />
          </span>
        }
      />

      <MarkReleaseRead releaseId={release.id} alreadyRead={release.state.read || withdrawn} />

      {withdrawn ? (
        <div className="border-border bg-card rounded-lg border px-[18px] py-4">
          <p className={LABEL}>This release was withdrawn</p>
          <p className="mt-1.5 text-[13.5px] leading-relaxed">
            {release.withdrawnNote ?? 'These changes are not available at the moment.'}
          </p>
        </div>
      ) : (
        <>
          <section
            aria-labelledby="release-highlights"
            className="border-border bg-card rounded-lg border px-[18px] py-4"
          >
            <h2 id="release-highlights" className={LABEL}>
              Highlights
            </h2>
            <p className="mt-1.5 text-[13.5px] leading-relaxed">{release.summary}</p>
          </section>
          <section aria-label="Changes in this release" className="space-y-3">
            {release.entries.map((entry) => (
              <ReleaseEntryCard key={entry.id} entry={entry} />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
