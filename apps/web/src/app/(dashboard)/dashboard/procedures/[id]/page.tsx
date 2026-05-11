import { ArrowLeft, Pencil } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ArchiveButton } from '@/components/procedures/archive-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CommentComposer } from '@/components/procedures/comment-composer';
import { CommentThread, type CommentView } from '@/components/procedures/comment-thread';
import { MarkdownBody } from '@/components/procedures/markdown-body';
import { VideoPlayer } from '@/components/procedures/video-player';
import { hasPermission, isAdminRole } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { formatRelative } from '@/lib/utils';
import { ProceduresService } from '@/server/services/procedures';
import { ServiceError } from '@/server/services/context';

export const dynamic = 'force-dynamic';

export default async function ProcedureDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  const canEdit = hasPermission(ctx.role, 'categories:manage');
  const canModerate = isAdminRole(ctx.role);

  const svc = await ProceduresService.forCurrentUser();
  let procedure;
  try {
    procedure = await svc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const liveCommentCount = countLiveComments(procedure.comments);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="sticky top-14 z-20 -mx-4 mb-6 border-b bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/procedures">
              <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to procedures
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">
                {procedure.title}
              </h1>
              {procedure.category_name && (
                <Badge
                  variant="outline"
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
          </div>
          {canEdit && (
            <div className="flex items-center gap-1">
              <Button asChild variant="outline" size="sm">
                <Link href={`/dashboard/procedures/${procedure.id}/edit`}>
                  <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                </Link>
              </Button>
              <ArchiveButton procedureId={procedure.id} />
            </div>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Authored by{' '}
        <span className="text-foreground">{procedure.created_by_name ?? 'Unknown'}</span>
        {procedure.authoring_warehouse_name
          ? ` at ${procedure.authoring_warehouse_name}`
          : ''}{' '}
        · {formatRelative(procedure.created_at)}
      </p>

      {procedure.description && (
        <p className="mt-3 text-base text-muted-foreground">{procedure.description}</p>
      )}

      {procedure.videos.length > 0 && (
        <section className="mt-6">
          <VideoPlayer
            videos={procedure.videos.map((v) => ({
              id: v.id,
              title: v.title,
              signed_url: v.signed_url,
              mime_type: v.mime_type,
            }))}
          />
        </section>
      )}

      <section className="mt-8">
        <MarkdownBody body={procedure.body ?? ''} />
      </section>

      <section className="mt-12 max-w-[680px]">
        <h2 className="text-lg font-semibold tracking-tight">
          Discussion ({liveCommentCount})
        </h2>
        <div className="mt-4">
          <CommentComposer procedureId={procedure.id} />
        </div>
        <div className="mt-6">
          <CommentThread
            procedureId={procedure.id}
            comments={procedure.comments.map(toView)}
            canModerate={canModerate}
          />
        </div>
      </section>
    </div>
  );
}

function toView(c: import('@/server/services/procedure-comments').ProcedureCommentNode): CommentView {
  return {
    id: c.id,
    procedure_id: c.procedure_id,
    body: c.body,
    author: c.author,
    is_own: c.is_own,
    parent_id: c.parent_id,
    created_at: c.created_at,
    edited_at: c.edited_at,
    deleted_at: c.deleted_at,
    replies: c.replies.map(toView),
  };
}

function countLiveComments(
  comments: import('@/server/services/procedure-comments').ProcedureCommentNode[],
): number {
  let n = 0;
  for (const c of comments) {
    if (!c.deleted_at) n += 1;
    n += countLiveComments(c.replies);
  }
  return n;
}
