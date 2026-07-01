'use client';

import { BookOpen } from 'lucide-react';
import * as React from 'react';

/**
 * The procedures-grid video "thumbnail" (a muted <video preload="metadata">
 * showing its first frame). An expired signed URL or unplayable codec used to
 * leave a silent gray tile with a misleading video-count badge — on error we
 * fall back to the same category-colored band the no-video card uses.
 */
export function ProcedureVideoThumb({
  src,
  fallbackColor,
}: {
  src: string;
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
