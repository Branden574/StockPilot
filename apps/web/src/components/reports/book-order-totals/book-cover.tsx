'use client';

import { BookOpen } from 'lucide-react';
import Image from 'next/image';
import * as React from 'react';

import { ImageHoverPreview } from '@/components/ui/image-hover-preview';
import { cn } from '@/lib/utils';

import { BOOK_COVER_PLACEHOLDER, BOOK_COVER_UNAVAILABLE, bookCoverAlt } from '@stockpilot/core';

/**
 * A book's cover in the report table, 40 x 56, the whole cover shown
 * (object-contain), never cropped.
 *
 * The page resolves covers AFTER the numbers: it hands each row a promise
 * that never rejects and resolves to the cover URL, no cover, or a cover
 * that could not be loaded. Each cell reads it with React.use() inside its
 * own Suspense boundary, so rows, totals and the pager paint first and
 * covers arrive as they resolve. A slow, missing or broken cover shows the
 * neutral placeholder ("No cover", or "Cover could not be loaded" when a
 * cover exists but failed) and never touches a number.
 *
 * The URL is one the server already authorized (a caller-RLS read of the
 * book before any image was signed) and trusted (this project's signed
 * item-images URL or an allowlisted cover host). The larger preview on
 * hover reuses that same URL; it never asks /api/items/[id]/image-master.
 */
/** What a row's cover resolved to: a URL, or none (failed: the cover could
 *  not be loaded, as distinct from a book with no cover). */
export interface BookCoverSource {
  url: string | null;
  failed: boolean;
}

export function BookCover({ cover, title }: { cover: Promise<BookCoverSource>; title: string }) {
  return (
    <React.Suspense fallback={<CoverBox loading />}>
      <ResolvedCover cover={cover} title={title} />
    </React.Suspense>
  );
}

function ResolvedCover({ cover, title }: { cover: Promise<BookCoverSource>; title: string }) {
  const { url: src, failed: lookupFailed } = React.use(cover);
  const [failed, setFailed] = React.useState(false);
  if (!src || failed) return <CoverBox failed={failed || lookupFailed} />;
  const alt = bookCoverAlt(title);
  return (
    <ImageHoverPreview src={src} alt={alt} title={title}>
      <span className="border-border bg-muted/40 relative block h-14 w-10 overflow-hidden rounded-[3px] border">
        <Image
          src={src}
          alt={alt}
          width={40}
          height={56}
          sizes="40px"
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      </span>
    </ImageHoverPreview>
  );
}

/** The neutral box: while loading it is silent; for a book with no cover it
 *  says "No cover" to assistive technology, and for a cover that could not
 *  be loaded "Cover could not be loaded". */
export function CoverBox({
  loading = false,
  failed = false,
}: {
  loading?: boolean;
  failed?: boolean;
}) {
  return (
    <span
      className={cn(
        'border-border bg-muted/50 text-muted-foreground flex h-14 w-10 items-center justify-center rounded-[3px] border',
        loading && 'animate-pulse',
      )}
      aria-hidden={loading ? true : undefined}
      data-cover-state={loading ? 'loading' : failed ? 'failed' : 'none'}
    >
      <BookOpen aria-hidden className="h-4 w-4" strokeWidth={1.5} />
      {loading ? null : (
        <span className="sr-only">{failed ? BOOK_COVER_UNAVAILABLE : BOOK_COVER_PLACEHOLDER}</span>
      )}
    </span>
  );
}
