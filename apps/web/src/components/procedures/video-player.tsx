'use client';

import { Film } from 'lucide-react';
import * as React from 'react';

import { SegmentedTabs } from '@/components/patterns/segmented-tabs';

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
 * a segmented strip of clip tabs sits above the player (a "Procedure
 * videos" tablist, one `role="tab"` per clip, as before) and swaps the
 * `<video>` src on click. Single-video case skips the strip entirely so the
 * layout stays clean. The stage stays black in both themes.
 */
export function VideoPlayer({ videos }: VideoPlayerProps) {
  const [activeIdx, setActiveIdx] = React.useState(0);
  // Video ids whose <video> errored (expired signed URL, network failure,
  // unplayable codec). Without this a failure is a black box with dead
  // controls — indistinguishable from "still loading".
  const [erroredIds, setErroredIds] = React.useState<Set<string>>(new Set());
  if (videos.length === 0) return null;
  const active = videos[Math.min(activeIdx, videos.length - 1)]!;
  return (
    <div className="flex flex-col gap-3">
      {videos.length > 1 && (
        <SegmentedTabs
          aria-label="Procedure videos"
          activeId={active.id}
          onSelect={(id) =>
            setActiveIdx(
              Math.max(
                0,
                videos.findIndex((v) => v.id === id),
              ),
            )
          }
          items={videos.map((v, i) => ({
            id: v.id,
            icon: <Film aria-hidden className="h-3.5 w-3.5" />,
            label: (
              <span className="block max-w-[200px] truncate">{v.title ?? `Video ${i + 1}`}</span>
            ),
          }))}
        />
      )}
      <div className="border-border overflow-hidden rounded-lg border bg-black">
        {active.signed_url && !erroredIds.has(active.id) ? (
          <video
            key={active.id}
            src={active.signed_url}
            controls
            preload="metadata"
            playsInline
            onError={() => setErroredIds((prev) => new Set(prev).add(active.id))}
            className="aspect-video w-full bg-black"
          />
        ) : (
          <div
            role="status"
            className="bg-sunk text-muted-foreground grid aspect-video place-items-center px-4 text-center text-[13.5px]"
          >
            {active.signed_url
              ? 'This video failed to load — its link may have expired. Refresh the page to try again.'
              : 'Video unavailable.'}
          </div>
        )}
      </div>
      {active.title && (
        <p className="text-muted-foreground text-[13px] font-medium">{active.title}</p>
      )}
    </div>
  );
}
