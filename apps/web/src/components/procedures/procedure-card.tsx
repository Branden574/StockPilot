import { MessageSquare, Video } from 'lucide-react';
import Link from 'next/link';

import { ProcedureVideoThumb } from '@/components/procedures/procedure-video-thumb';
import { formatRelative } from '@/lib/utils';
import type { ProcedureListRow } from '@/server/services/procedures';

import {
  ProcedureCategoryPill,
  ProcedureFallbackBand,
  procedureCategoryColor,
} from './procedure-fallback-band';

interface ProcedureCardProps {
  procedure: ProcedureListRow;
}

/**
 * Grid tile for one procedure on the list page, in the photo-first card
 * language (DESIGN-SPEC 6.15): a hairline card on the page surface whose
 * border strengthens on hover, the media on top and a 12 px body.
 *
 * The media is the procedure's 16:9 thumbnail: the poster JPEG captured at
 * upload, or for older rows the first video's first frame (see
 * ProcedureVideoThumb). With no video it is the flat fallback band, with the
 * category colour as a stripe. The video count sits top-right on an opaque
 * chip.
 *
 * The whole card is one link to the detail page, as before.
 */
export function ProcedureCard({ procedure }: ProcedureCardProps) {
  const color = procedureCategoryColor(procedure.category_color);
  return (
    <Link
      href={`/dashboard/procedures/${procedure.id}`}
      data-slot="procedure-card"
      className="border-border bg-background focus-visible:ring-ring focus-visible:ring-offset-background hover:border-ink-4 flex h-full min-w-0 flex-col overflow-hidden rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
    >
      <div
        data-slot="procedure-card-media"
        className="border-border bg-sunk relative aspect-video w-full shrink-0 overflow-hidden border-b"
      >
        {procedure.thumbnail_url ? (
          <ProcedureVideoThumb
            src={procedure.thumbnail_url}
            kind={procedure.thumbnail_kind === 'poster' ? 'poster' : 'video'}
            fallbackColor={color}
          />
        ) : (
          <ProcedureFallbackBand color={color} />
        )}
        {procedure.video_count > 0 && (
          <span className="border-border bg-card text-foreground absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium tabular-nums leading-[18px]">
            <Video className="h-3 w-3" aria-hidden /> {procedure.video_count}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        {procedure.category_name && (
          <div className="flex min-w-0">
            <ProcedureCategoryPill name={procedure.category_name} color={color} />
          </div>
        )}
        <h3 className="text-foreground line-clamp-2 text-[13.5px] font-medium leading-[1.35] [overflow-wrap:anywhere]">
          {procedure.title}
        </h3>
        <p className="text-muted-foreground text-[12px] leading-[18px]">
          By {procedure.created_by_name ?? 'Unknown'}
          {procedure.authoring_warehouse_name
            ? ` at ${procedure.authoring_warehouse_name}`
            : ''} · {formatRelative(procedure.created_at)}
        </p>
        {procedure.comment_count > 0 && (
          <p className="text-muted-foreground mt-auto flex items-center gap-1 text-[12px] leading-[18px]">
            <MessageSquare className="h-3 w-3" aria-hidden /> {procedure.comment_count}{' '}
            {procedure.comment_count === 1 ? 'comment' : 'comments'}
          </p>
        )}
      </div>
    </Link>
  );
}
