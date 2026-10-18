'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

import { MissingPhoto } from './missing-photo';

/**
 * A record photo that fills its frame: `cover` for row thumbnails, `contain`
 * (uncropped) for grid card media. It swaps to the missing-photo hatch when
 * there is no source and when the image fails (a signed URL that expired, a
 * deleted file), so a broken-image glyph never shows. A new `src` gets a
 * fresh attempt.
 *
 * The caller passes the small rendition it already has (the ~200 px thumb),
 * never the master; nothing here fetches.
 */
export interface PatternPhotoProps {
  src: string | null | undefined;
  alt: string;
  fit?: 'cover' | 'contain';
  className?: string;
}

export function PatternPhoto({ src, alt, fit = 'cover', className }: PatternPhotoProps) {
  // Remember WHICH source failed, so a new source is tried again without an
  // effect resetting state.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  // A server-rendered image can fail before hydration attaches onError, and
  // React never hears about it, so the broken image would stay. When the
  // element is attached, a finished request with no pixels means exactly that:
  // set the same source again, which makes the browser retry and report the
  // outcome to the handler now listening. (A loaded image has pixels and is
  // left alone; one still loading reports to the handler by itself.)
  const retryMissedError = React.useCallback((img: HTMLImageElement | null) => {
    const current = img?.getAttribute('src');
    if (img && current && img.complete && img.naturalWidth === 0) img.src = current;
  }, []);
  if (!src || failedSrc === src) {
    return <MissingPhoto className={cn('absolute inset-0', className)} />;
  }
  return (
    // Pre-sized thumbnails are served as they are: the image optimizer's cache
    // is per deployment, so routing ~200 px thumbs through it cost the first
    // viewer after every deploy a cold transform per photo (inventory table,
    // owner report 2026-07-06).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      ref={retryMissedError}
      onError={() => setFailedSrc(src)}
      className={cn(
        'absolute inset-0 h-full w-full',
        fit === 'contain' ? 'object-contain' : 'object-cover',
        className,
      )}
    />
  );
}
