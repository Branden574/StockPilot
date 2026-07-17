'use client';

import { Check, Loader2, Pencil, Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { editMovementNoteAction } from '@/server/actions/movements';

interface EditableMovementNoteProps {
  /** RAW stock_movements.id (uuid) — NOT the `m:`-prefixed activity id. */
  movementId: string;
  /** Current free-text note (stock_movements.notes). null when unset. */
  note: string | null;
  /**
   * Read-only "why" (stock_movements.reason) shown as the fallback display
   * text when there's no note. Only the `cell` variant uses it — the activity
   * feed renders `reason` itself, so it passes none. Never editable.
   */
  reason?: string | null;
  /**
   * When false the note is purely read-only (current behavior): no pencil, no
   * "Add note". The server action re-gates on `movements:edit_notes` regardless.
   */
  canEdit: boolean;
  /**
   * `cell` — a Movements-table cell (muted, with a reason fallback + em dash
   * when empty). `inline` — the item Activity feed meta line (quoted italic
   * note; only rendered for movement rows).
   */
  variant?: 'cell' | 'inline';
}

/**
 * The ONE client island for adding/editing a stock movement's note. Used in
 * three read-only-until-permitted surfaces: the global Movements table (both
 * the instant client table and the server-paged table) and the item-detail
 * Activity/Movements feed. Optimistic local update + toast + persistent inline
 * error (repo pattern #20 — a toast alone auto-dismisses and reads as
 * "nothing happened"). The append-only ledger only ever mutates `notes`.
 */
export function EditableMovementNote({
  movementId,
  note,
  reason = null,
  canEdit,
  variant = 'cell',
}: EditableMovementNoteProps) {
  const router = useRouter();
  const [value, setValue] = React.useState<string | null>(note);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const inline = variant === 'inline';

  function startEdit() {
    setDraft(value ?? '');
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft('');
    setError(null);
  }

  async function save() {
    const next = draft.trim();
    // No-op when unchanged (treat null and '' as equal) — just close.
    if (next === (value ?? '')) {
      cancelEdit();
      return;
    }
    setSaving(true);
    setError(null);
    const res = await editMovementNoteAction({ movementId, note: next });
    setSaving(false);
    if (!res.ok) {
      setError(res.error.message);
      toast.error(res.error.message);
      return;
    }
    setValue(res.data.note);
    setEditing(false);
    setDraft('');
    toast.success(res.data.note ? 'Note saved.' : 'Note cleared.');
    router.refresh();
  }

  if (editing) {
    return (
      <span className="inline-flex flex-col gap-1">
        <span className="inline-flex items-center gap-1">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              if (e.key === 'Escape') cancelEdit();
            }}
            className="h-7 w-48 text-xs"
            maxLength={2000}
            autoFocus
            placeholder="Add a note"
            aria-label="Movement note"
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0"
            onClick={() => void save()}
            disabled={saving}
            aria-label="Save note"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0"
            onClick={cancelEdit}
            disabled={saving}
            aria-label="Cancel edit"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </span>
        {error && (
          <span role="alert" className="text-destructive text-[11px]">
            {error}
          </span>
        )}
      </span>
    );
  }

  const displayText = value ?? (inline ? null : reason);

  // Read-only: exactly the prior rendering. Cell shows text or an em dash;
  // inline shows a quoted italic note only when one exists.
  if (!canEdit) {
    if (inline) {
      return value ? <span className="italic">&ldquo;{value}&rdquo;</span> : null;
    }
    return <span>{displayText ?? '—'}</span>;
  }

  // Editable, has a note (or, for cells, a reason fallback) → text + pencil.
  if (displayText) {
    return (
      <span className="group inline-flex items-center gap-1">
        {inline ? <span className="italic">&ldquo;{displayText}&rdquo;</span> : <span>{displayText}</span>}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-6 w-6 shrink-0 p-0 opacity-60 transition-opacity hover:opacity-100',
            'focus-visible:opacity-100',
          )}
          onClick={startEdit}
          aria-label="Edit note"
        >
          <Pencil className="text-muted-foreground h-3 w-3" />
        </Button>
      </span>
    );
  }

  // Editable, empty → subtle "Add note" affordance.
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground hover:text-foreground h-6 gap-1 px-1.5 text-xs font-normal"
      onClick={startEdit}
      aria-label="Add note"
    >
      <Plus className="h-3 w-3" /> Add note
    </Button>
  );
}
