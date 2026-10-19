'use client';

import * as React from 'react';

import { ProcedureFallbackBand } from './procedure-fallback-band';

/**
 * The procedures-grid thumbnail. Two modes:
 *   - kind="poster": a small JPEG captured at upload — a plain <img>, the
 *     cheap path (~30 KB instead of range-fetching the full video file).
 *   - kind="video" (legacy rows without a poster): the muted
 *     <video preload="metadata"> first-frame trick.
 * Either way, an expired signed URL or decode failure falls back to the same
 * flat band the no-video card uses — never a silent gray tile.
 *
 * It fills its frame: the card's media box is `relative` with a 16:9 ratio.
 */
export function ProcedureVideoThumb({
  src,
  kind,
  fallbackColor,
}: {
  src: string;
  kind: 'poster' | 'video';
  fallbackColor: string;
}) {
  const [failed, setFailed] = React.useState(false);
  // A server-rendered poster can fail before hydration attaches onError (an
  // expired signed URL), and React never hears about it. When the element is
  // attached, a finished request with no pixels means exactly that: set the
  // same source again so the browser retries and reports to the handler now
  // listening (the shared photo pattern does the same).
  const retryMissedError = React.useCallback((img: HTMLImageElement | null) => {
    const current = img?.getAttribute('src');
    if (img && current && img.complete && img.naturalWidth === 0) img.src = current;
  }, []);
  if (failed) {
    return <ProcedureFallbackBand color={fallbackColor} />;
  }
  if (kind === 'poster') {
    return (
      // Signed URL to a private bucket object — plain img, not next/image.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        ref={retryMissedError}
        onError={() => setFailed(true)}
        className="absolute inset-0 h-full w-full object-cover"
      />
    );
  }
  return (
    <video
      src={src}
      preload="metadata"
      playsInline
      muted
      onError={() => setFailed(true)}
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}
