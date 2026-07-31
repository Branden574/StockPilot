'use client';

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

import {
  DISABLE_REASON_CATEGORIES,
  DISABLE_REASON_CATEGORY_LABELS,
  disableReasonSchema,
  type DisableReasonCategory,
  type DisableReasonInput,
} from '@stockpilot/core';

/**
 * Critical-severity confirm for a platform-wide account disable.
 *
 * Composes the same two safety devices the shared DestructiveConfirm uses —
 * type-to-confirm plus destructive tone — and adds the mandatory reason the
 * primitive has no slot for (it accepts no children). The typed string is the
 * target's EMAIL, so the operator has to look at who they are about to lock
 * out.
 *
 * The blast radius is stated explicitly: the platform console shows users
 * inside one org, but this action is not org-scoped, and an operator must not
 * discover that afterwards.
 *
 * `email` is REQUIRED to be non-empty for the gate to arm. That is not
 * defensive noise: PlatformOrgMember.email is `string | null`, so a caller
 * reaching for `email ?? ''` would hand this an empty string — and an empty
 * `typed` equals an empty `email` on the FIRST render, which would arm the
 * destructive button with zero keystrokes and print "This disables  across
 * every organization". The caller also hides the menu item in that case; this
 * check is the half that cannot be forgotten at a call site.
 */
export function DisableAccountDialog({
  open,
  onOpenChange,
  email,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
  pending: boolean;
  onConfirm: (reason: DisableReasonInput) => void | Promise<void>;
}) {
  const [category, setCategory] = React.useState<DisableReasonCategory>('security_investigation');
  const [notes, setNotes] = React.useState('');
  const [typed, setTyped] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) {
      // Reset on CLOSE so a cancelled disable can't leak a half-typed
      // confirmation or a stale reason into the next account's dialog.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on close
      setCategory('security_investigation');
      setNotes('');
      setTyped('');
    }
  }, [open]);

  // Land the caret in the confirm field, matching DestructiveConfirm's critical
  // severity. The timeout lets Radix's own initial focus management settle first.
  React.useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const parsed = disableReasonSchema.safeParse({
    category,
    notes: notes.trim().length > 0 ? notes : undefined,
  });
  const reasonError = parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Reason required');
  const canConfirm = parsed.success && email.length > 0 && typed === email && !pending;

  function handleOpenChange(next: boolean) {
    // While pending, swallow programmatic close attempts (escape, overlay click)
    // so an in-flight disable can't be orphaned by a half-closed UI.
    if (pending && !next) return;
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-destructive">Disable this account?</DialogTitle>
          <DialogDescription>
            This disables {email} across every organization, not just this one. They are signed out
            of every device immediately and cannot sign in again until an administrator re-enables
            the account. No data is deleted and no work is reassigned.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="disable-reason-category">Reason</Label>
            <select
              id="disable-reason-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as DisableReasonCategory)}
              className="border-border bg-background w-full rounded-md border px-3 py-2 text-sm"
            >
              {DISABLE_REASON_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {DISABLE_REASON_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="disable-reason-notes">
              Notes{category === 'other' ? ' (required)' : ' (optional)'}
            </Label>
            <textarea
              id="disable-reason-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              className="border-border bg-background w-full rounded-md border px-3 py-2 text-sm"
            />
            {reasonError && <p className="text-destructive text-xs">{reasonError}</p>}
            <p className="text-muted-foreground text-xs">
              Recorded in the platform audit trail. Never shown to the user.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="disable-confirm">
              Type <span className="font-mono">{email}</span> to confirm
            </Label>
            <Input
              id="disable-confirm"
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canConfirm}
            onClick={() => {
              if (!canConfirm || !parsed.success) return;
              void onConfirm(parsed.data);
            }}
          >
            {pending ? 'Disabling...' : 'Disable account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
