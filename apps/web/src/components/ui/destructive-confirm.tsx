'use client';

import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Severity = 'standard' | 'critical';

interface BaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Red headline with the action verb (e.g. "Archive item?"). */
  title: string;
  /** Body copy explaining the consequence. */
  description: React.ReactNode;
  /** Label on the action button (e.g. "Archive", "Remove", "Cancel order"). */
  confirmLabel: string;
  /** Label on the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** When true, both buttons are disabled while the action is in flight. */
  pending?: boolean;
  /** Called when the user confirms. May be async — pair with `pending` to
   *  reflect in-flight state. The primitive does NOT close the dialog
   *  automatically; the caller decides (typically by calling
   *  `onOpenChange(false)` after a successful response). */
  onConfirm: () => void | Promise<void>;
  /**
   * Visual treatment of the confirm button + title. Defaults to
   * `destructive` (red) which matches the original use case. Pass
   * `primary` for inverse actions like Restore that reuse the same
   * primitive (binary toggle on archive/restore) without the red
   * destructive aesthetic.
   */
  tone?: 'destructive' | 'primary';
}

interface StandardProps extends BaseProps {
  severity?: 'standard';
  expectedConfirm?: never;
}

interface CriticalProps extends BaseProps {
  severity: 'critical';
  /** Case-sensitive string the user must type to enable the action. */
  expectedConfirm: string;
}

export type DestructiveConfirmProps = StandardProps | CriticalProps;

/**
 * Unified destructive-action confirmation dialog.
 *
 * Two flavours via `severity`:
 *   - "standard" — Cancel / destructive action. Cancel auto-focuses on open
 *     so a stray Enter never triggers destruction.
 *   - "critical" — adds a type-to-confirm input. The action stays disabled
 *     until the typed value matches `expectedConfirm` (case-sensitive). The
 *     input auto-focuses on open. Body text always includes "This cannot be
 *     undone."
 *
 * Built on the same Dialog primitives the rest of the app already uses,
 * so it inherits overlay, escape-to-close, focus trap, and animations.
 *
 * The caller owns dialog state. After a successful confirm, call
 * `onOpenChange(false)` to dismiss.
 */
export function DestructiveConfirm(props: DestructiveConfirmProps) {
  const {
    open,
    onOpenChange,
    title,
    description,
    confirmLabel,
    cancelLabel = 'Cancel',
    pending = false,
    onConfirm,
    tone = 'destructive',
  } = props;

  const severity: Severity = props.severity ?? 'standard';
  const expected = severity === 'critical' ? props.expectedConfirm : null;

  const [typed, setTyped] = React.useState('');
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Reset the typed input every time the dialog opens so a previous close
  // can't leak state into the next open.
  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
      setTyped('');
    }
  }, [open]);

  // Auto-focus: critical → input, standard → cancel. We use a microtask so
  // the focus runs after Radix's own initial focus management settles.
  React.useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      if (severity === 'critical') {
        inputRef.current?.focus();
      } else {
        cancelRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [open, severity]);

  const matches = expected == null ? true : typed === expected;
  const confirmDisabled = pending || !matches;

  async function handleConfirm() {
    if (confirmDisabled) return;
    await onConfirm();
  }

  function handleOpenChange(next: boolean) {
    // While pending, swallow programmatic close attempts (escape, overlay
    // click) so an in-flight action can't be orphaned by a half-closed UI.
    if (pending && !next) return;
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className={tone === 'destructive' ? 'text-destructive' : undefined}>
            {title}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <div>{description}</div>
              {severity === 'critical' && (
                <p className="font-medium text-destructive">This cannot be undone.</p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {severity === 'critical' && expected != null && (
          <div className="space-y-1.5">
            <Label htmlFor="destructive-confirm-input">
              Type{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                {expected}
              </code>{' '}
              to confirm
            </Label>
            <Input
              ref={inputRef}
              id="destructive-confirm-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={pending}
              aria-invalid={typed.length > 0 && !matches}
              className={cn(
                'font-mono',
                typed.length > 0 && !matches && 'border-destructive focus-visible:ring-destructive',
              )}
            />
          </div>
        )}

        <DialogFooter>
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === 'destructive' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={confirmDisabled}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
