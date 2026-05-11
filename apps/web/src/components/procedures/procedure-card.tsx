import { BookOpen, MessageSquare, Video } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatRelative } from '@/lib/utils';
import type { ProcedureListRow } from '@/server/actions/procedures';

interface ProcedureCardProps {
  procedure: ProcedureListRow;
}

/**
 * Grid tile for one procedure on the list page. Renders the first
 * video as a 16:9 thumbnail (via the signed URL `<video preload="metadata">`
 * trick that browsers use to show the first frame). When the procedure
 * has no video, we fall back to a category-colored band with a
 * BookOpen icon so the grid stays visually consistent.
 */
export function ProcedureCard({ procedure }: ProcedureCardProps) {
  const fallbackBg = procedure.category_color ?? '#475569';
  return (
    <Link
      href={`/dashboard/procedures/${procedure.id}`}
      className="group focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-xl"
    >
      <Card className="h-full overflow-hidden transition-shadow group-hover:shadow-md">
        <div
          className="relative flex aspect-video items-center justify-center overflow-hidden bg-muted text-white"
          style={
            procedure.thumbnail_url
              ? undefined
              : { backgroundImage: `linear-gradient(135deg, ${fallbackBg}, ${fallbackBg}cc)` }
          }
        >
          {procedure.thumbnail_url ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              src={procedure.thumbnail_url}
              preload="metadata"
              playsInline
              muted
              className="h-full w-full object-cover"
            />
          ) : (
            <BookOpen className="h-10 w-10 opacity-80" aria-hidden />
          )}
          {procedure.video_count > 0 && (
            <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">
              <Video className="h-3 w-3" aria-hidden /> {procedure.video_count}
            </span>
          )}
        </div>
        <CardContent className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {procedure.category_name && (
              <Badge
                variant="outline"
                className="border-transparent text-xs"
                style={{
                  backgroundColor: `${procedure.category_color ?? '#475569'}1a`,
                  color: procedure.category_color ?? undefined,
                  borderColor: `${procedure.category_color ?? '#475569'}55`,
                }}
              >
                {procedure.category_name}
              </Badge>
            )}
          </div>
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
            {procedure.title}
          </h3>
          <p className="text-xs text-muted-foreground">
            By {procedure.created_by_name ?? 'Unknown'}
            {procedure.authoring_warehouse_name
              ? ` at ${procedure.authoring_warehouse_name}`
              : ''}{' '}
            · {formatRelative(procedure.created_at)}
          </p>
          {procedure.comment_count > 0 && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" aria-hidden /> {procedure.comment_count}{' '}
              {procedure.comment_count === 1 ? 'comment' : 'comments'}
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
