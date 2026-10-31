import { ArrowLeft, Pencil } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ArchiveButton } from '@/components/procedures/archive-button';
import { DetailSection } from '@/components/patterns/detail-section';
import { Button } from '@/components/ui/button';
import { CommentComposer } from '@/components/procedures/comment-composer';
import { CommentThread, type CommentView } from '@/components/procedures/comment-thread';
import { MarkdownBody } from '@/components/procedures/markdown-body';
import { ProcedureCategoryPill } from '@/components/procedures/procedure-fallback-band';
import { VideoPlayer } from '@/components/procedures/video-player';
import { can, isAdminRole, resolveOrgTimezone } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { reportError } from '@/lib/error-reporter';
import { formatRelative } from '@/lib/utils';
import { ProceduresService } from '@/server/services/procedures';
import { ServiceError } from '@/server/services/context';

export const dynamic = 'force-dynamic';

export default async function ProcedureDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  const canEdit = can(ctx, 'categories:manage');
  const canModerate = isAdminRole(ctx.role);
  // The discussion's times are the organization's. The request-cached org row
  // the layout already read, so nothing new is fetched; a failed read is the
  // documented default zone, never a failed page.
  const timezoneRead = getOrgRowForRequest(ctx.organizationId)
    .then((org) => resolveOrgTimezone(org?.timezone))
    .catch((e: unknown) => {
      void reportError(e, { tag: 'procedures.detail.org_timezone_failed', level: 'warning' });
      return resolveOrgTimezone(null);
    });

  const svc = await ProceduresService.forCurrentUser();
  let procedure;
  try {
    procedure = await svc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }
  const timeZone = await timezoneRead;

  const liveCommentCount = countLiveComments(procedure.comments);

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 pb-16 sm:px-8">
      {/* The sticky header (CONFLICTS area 20): an opaque bar on the page
          surface, no blur, that stays at the top of the scrolling page with
          Back, the title and Edit / Archive. The title column asks for 18rem
          (basis-72) so on a phone the actions wrap under it instead of
          squeezing it (detail-title guard). */}
      <div
        data-slot="procedure-sticky-header"
        className="border-border bg-card sticky top-0 z-20 -mx-4 mb-6 border-b px-4 py-3 sm:-mx-8 sm:px-8"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground -ml-2.5">
            <Link href="/dashboard/procedures">
              <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to procedures
            </Link>
          </Button>
          {/* "truncate" leads the h1's classes: the detail-title guard finds
              this title column by it (prettier would sort it in). */}
          <div className="min-w-0 flex-1 basis-72">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="truncate text-foreground min-w-0 max-w-full font-display text-[20px] font-medium leading-[1.3] tracking-[-0.02em] sm:text-[22px]">
                {procedure.title}
              </h1>
              {procedure.category_name && (
                <ProcedureCategoryPill
                  name={procedure.category_name}
                  color={procedure.category_color}
                />
              )}
            </div>
          </div>
          {canEdit && (
            <div className="flex items-center gap-2">
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

      <div className="flex max-w-[880px] flex-col gap-6">
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-[13px]">
            Authored by{' '}
            <span className="text-foreground">{procedure.created_by_name ?? 'Unknown'}</span>
            {procedure.authoring_warehouse_name
              ? ` at ${procedure.authoring_warehouse_name}`
              : ''}{' '}
            · {formatRelative(procedure.created_at)}
          </p>

          {procedure.description && (
            <p className="text-ink-2 text-[15px] leading-6">{procedure.description}</p>
          )}
        </div>

        {procedure.videos.length > 0 && (
          <section>
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

        <section>
          <MarkdownBody body={procedure.body ?? ''} />
        </section>

        <DetailSection
          title={`Discussion (${liveCommentCount})`}
          className="mt-4 max-w-[680px]"
          bodyClassName="flex flex-col gap-6"
        >
          <CommentComposer procedureId={procedure.id} />
          <CommentThread
            procedureId={procedure.id}
            comments={procedure.comments.map(toView)}
            canModerate={canModerate}
            timeZone={timeZone}
          />
        </DetailSection>
      </div>
    </div>
  );
}

function toView(
  c: import('@/server/services/procedure-comments').ProcedureCommentNode,
): CommentView {
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
