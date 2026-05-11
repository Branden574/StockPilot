'use client';

import { Film } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

interface PlayerVideo {
  id: string;
  title: string | null;
  signed_url: string | null;
  mime_type: string | null;
}

interface VideoPlayerProps {
  videos: PlayerVideo[];
}

/**
 * Multi-clip video player. When the procedure has more than one video,
 * we render a horizontal strip of tabs above the player and swap the
 * `<video>` src on click. Single-video case skips the tab strip
 * entirely so the layout stays clean.
 */
export function VideoPlayer({ videos }: VideoPlayerProps) {
  const [activeIdx, setActiveIdx] = React.useState(0);
  if (videos.length === 0) return null;
  const active = videos[Math.min(activeIdx, videos.length - 1)]!;
  return (
    <div className="space-y-3">
      {videos.length > 1 && (
        <div
          role="tablist"
          aria-label="Procedure videos"
          className="flex flex-wrap gap-1.5 overflow-x-auto"
        >
          {videos.map((v, i) => {
            const selected = i === activeIdx;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveIdx(i)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  selected
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card hover:bg-muted',
                )}
              >
                <Film className="h-3 w-3" aria-hidden />
                <span className="max-w-[200px] truncate">
                  {v.title ?? `Video ${i + 1}`}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border bg-black">
        {active.signed_url ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            key={active.id}
            src={active.signed_url}
            controls
            preload="metadata"
            playsInline
            className="aspect-video w-full bg-black"
          />
        ) : (
          <div className="grid aspect-video place-items-center text-sm text-muted-foreground">
            Video unavailable.
          </div>
        )}
      </div>
      {active.title && (
        <p className="text-sm font-medium text-muted-foreground">{active.title}</p>
      )}
    </div>
  );
}
