'use client';

import { Loader2, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { createProcedureCommentAction } from '@/server/actions/procedures';

interface CommentComposerProps {
  procedureId: string;
  parentId?: string | null;
  placeholder?: string;
  onPosted?: () => void;
  /** Auto-focus on mount (used by the reply composer). */
  autoFocus?: boolean;
}

/**
 * Compact textarea + post-button used both for new top-level comments
 * and inline replies under an existing top-level comment. The parent
 * controls whether it's mounted (so the "Reply" toggle in
 * `CommentThread` swaps the visible composer).
 */
export function CommentComposer({
  procedureId,
  parentId = null,
  placeholder = 'Add a comment…',
  onPosted,
  autoFocus = false,
}: CommentComposerProps) {
  const router = useRouter();
  const [body, setBody] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const res = await createProcedureCommentAction({
        procedureId,
        body: trimmed,
        parentId,
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setBody('');
      router.refresh();
      onPosted?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={placeholder}
        rows={parentId ? 2 : 3}
        maxLength={5000}
        autoFocus={autoFocus}
      />
      <div className="flex items-center justify-end gap-2">
        {onPosted && (
          <Button type="button" variant="ghost" size="sm" onClick={onPosted}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy || body.trim().length === 0}>
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="mr-1 h-3.5 w-3.5" />
          )}
          Post
        </Button>
      </div>
    </form>
  );
}
