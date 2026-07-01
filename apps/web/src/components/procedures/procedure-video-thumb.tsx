'use client';

import { BookOpen } from 'lucide-react';
import * as React from 'react';

/**
 * The procedures-grid thumbnail. Two modes:
 *   - kind="poster": a small JPEG captured at upload — a plain <img>, the
 *     cheap path (~30 KB instead of range-fetching the full video file).
 *   - kind="video" (legacy rows without a poster): the muted
 *     <video preload="metadata"> first-frame trick.
 * Either way, an expired signed URL or decode failure falls back to the same
 * category-colored band the no-video card uses — never a silent gray tile.
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
  if (failed) {
    return (
      <div
        className="flex h-full w-full items-center justify-center"
        style={{
          backgroundImage: `linear-gradient(135deg, ${fallbackColor}, ${fallbackColor}cc)`,
        }}
      >
        <BookOpen className="h-10 w-10 opacity-80" aria-hidden />
      </div>
    );
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
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
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
      className="h-full w-full object-cover"
    />
  );
}
