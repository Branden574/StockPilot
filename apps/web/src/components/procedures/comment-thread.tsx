'use client';

import { Loader2, MessageSquareReply, Pencil, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Textarea } from '@/components/ui/textarea';
import { formatRelative } from '@/lib/utils';
import {
  deleteProcedureCommentAction,
  updateProcedureCommentAction,
} from '@/server/actions/procedures';

import { CommentComposer } from './comment-composer';

export interface CommentAuthorView {
  id: string | null;
  full_name: string | null;
  avatar_url: string | null;
}

export interface CommentView {
  id: string;
  procedure_id: string;
  body: string;
  author: CommentAuthorView;
  is_own: boolean;
  parent_id: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  replies: CommentView[];
}

interface CommentThreadProps {
  procedureId: string;
  comments: CommentView[];
  /** True when the current viewer is an admin or owner (can moderate). */
  canModerate: boolean;
}

function initials(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '');
}

function CommentRow({
  procedureId,
  comment,
  canModerate,
  allowReply,
}: {
  procedureId: string;
  comment: CommentView;
  canModerate: boolean;
  allowReply: boolean;
}) {
  const router = useRouter();
  const [replyOpen, setReplyOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editBody, setEditBody] = React.useState(comment.body);
  const [busy, setBusy] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const isDeleted = comment.deleted_at !== null;
  const canEdit = (comment.is_own || canModerate) && !isDeleted;

  async function saveEdit() {
    const trimmed = editBody.trim();
    if (!trimmed) {
      toast.error('Comment cannot be empty.');
      return;
    }
    setBusy(true);
    try {
      const res = await updateProcedureCommentAction(comment.id, { body: trimmed });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setDeleteBusy(true);
    try {
      const res = await deleteProcedureCommentAction(comment.id);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      router.refresh();
    } finally {
      setDeleteBusy(false);
      setDeleteOpen(false);
    }
  }

  return (
    <div className="flex gap-3">
      <Avatar className="h-8 w-8 flex-none">
        {comment.author.avatar_url ? (
          <AvatarImage src={comment.author.avatar_url} alt="" />
        ) : null}
        <AvatarFallback>{initials(comment.author.full_name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p className="text-sm font-medium">
            {comment.author.full_name ?? 'Unknown user'}
          </p>
          <time
            dateTime={comment.created_at}
            className="text-xs text-muted-foreground tabular-nums"
            title={new Date(comment.created_at).toLocaleString()}
            // clock drifts between SSR + hydration; tolerate it instead
            // of unmounting the comment thread with React error #418.
            suppressHydrationWarning
          >
            {formatRelative(comment.created_at)}
          </time>
          {comment.edited_at && !isDeleted && (
            <span className="text-xs text-muted-foreground">(edited)</span>
          )}
        </div>
        {isDeleted ? (
          <p className="text-sm italic text-muted-foreground">(deleted)</p>
        ) : editing ? (
          <div className="space-y-2">
            <Textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              rows={3}
              maxLength={5000}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setEditBody(comment.body);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={saveEdit} disabled={busy}>
                {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{comment.body}</p>
        )}
        {!editing && !isDeleted && (
          <div className="flex flex-wrap items-center gap-1">
            {allowReply && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setReplyOpen((o) => !o)}
              >
                <MessageSquareReply className="mr-1 h-3 w-3" /> Reply
              </Button>
            )}
            {canEdit && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setEditing(true)}
              >
                <Pencil className="mr-1 h-3 w-3" /> Edit
              </Button>
            )}
            {canEdit && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-1 h-3 w-3" /> Delete
              </Button>
            )}
          </div>
        )}
        {replyOpen && (
          <div className="pt-2">
            <CommentComposer
              procedureId={procedureId}
              parentId={comment.id}
              placeholder={`Reply to ${comment.author.full_name ?? 'this comment'}…`}
              onPosted={() => setReplyOpen(false)}
              autoFocus
            />
          </div>
        )}
        {comment.replies.length > 0 && (
          <ul className="mt-3 space-y-4 border-l border-border pl-4">
            {comment.replies.map((r) => (
              <li key={r.id}>
                <CommentRow
                  procedureId={procedureId}
                  comment={r}
                  canModerate={canModerate}
                  allowReply={false}
                />
              </li>
            ))}
          </ul>
        )}
        <DestructiveConfirm
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete this comment?"
          description="The comment is hidden from the thread. Replies stay so the discussion still reads correctly."
          confirmLabel="Delete"
          pending={deleteBusy}
          onConfirm={confirmDelete}
        />
      </div>
    </div>
  );
}

export function CommentThread({ procedureId, comments, canModerate }: CommentThreadProps) {
  if (comments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No comments yet. Start the discussion.
      </p>
    );
  }
  return (
    <ul className="space-y-6">
      {comments.map((c) => (
        <li key={c.id}>
          <CommentRow
            procedureId={procedureId}
            comment={c}
            canModerate={canModerate}
            allowReply
          />
        </li>
      ))}
    </ul>
  );
}
