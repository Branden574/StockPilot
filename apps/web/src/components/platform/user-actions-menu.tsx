'use client';

import { MoreHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { useStepUp } from '@/components/auth/step-up-modal';
import { DisableAccountDialog } from '@/components/platform/disable-account-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  disableUserAccountAction,
  reenableUserAccountAction,
  sendUserPasswordResetAction,
} from '@/server/actions/platform/users';

import type { ActionResult, DisableReasonInput } from '@stockpilot/core';

/**
 * The row's status is stale, not the operator's permissions. A lost
 * compare-and-set (ACCOUNT_STATUS_CHANGED) and the two already-in-that-state
 * conflicts are the same staleness seen from either side, and the action layer
 * already types all three as `conflict`. Re-reading the page is the honest
 * response — and it is literally what ACCOUNT_STATUS_CHANGED's own sentence
 * instructs. None of them may ever be narrated as "not authorized": the actor's
 * allowlist membership was verified before the write, so sending a god admin
 * hunting a permissions problem that does not exist is the exact failure the
 * separate code was introduced to prevent.
 */
const STALE_STATUS_CODES = new Set([
  'ACCOUNT_STATUS_CHANGED',
  'ACCOUNT_ALREADY_DISABLED',
  'ACCOUNT_NOT_DISABLED',
]);

function isStaleStatus(res: ActionResult<unknown>): boolean {
  if (res.ok) return false;
  const code = res.error.details?.code;
  return typeof code === 'string' && STALE_STATUS_CODES.has(code);
}

/**
 * A half-applied change: the authoritative half landed, the rest did not. The
 * action layer composes one clause per missing layer (including `not_audited`,
 * which it refuses to launder into a success), so the message is passed through
 * verbatim rather than re-summarised here.
 */
function isPartial(res: ActionResult<unknown>): boolean {
  if (res.ok) return false;
  return Array.isArray(res.error.details?.partialReasons);
}

/**
 * Per-user actions on the platform console's org-detail Users tab. This is the
 * ONLY surface in the product that can disable an account: the org Team page
 * and the mobile admin screens are org-admin surfaces and deliberately get
 * nothing.
 *
 * BOTH status items are offered on EVERY row, whatever `disabledAt` says. They
 * are idempotent state setters — "make this account disabled", "make this
 * account active" — and the row's Disabled chip, not the menu, is what reports
 * the current state. Pressing either on an account already in that state is a
 * supported healing replay in the service, never an error.
 *
 * That is a fix, not a decoration. The items used to be derived from
 * `disabledAt` (`canDisable = !isDisabled`, `canReenable = isDisabled`), which
 * made every partial result's advertised retry unreachable the moment the page
 * was re-read. A partial disable tells the operator "press Disable again" and
 * leaves the row rendering as Disabled — so after any reload, navigation, or
 * handover to a colleague, the only item left was Re-enable, and healing meant
 * first restoring access to the very account under investigation. The mirror
 * case was worse: a re-enable returning ['ban_not_lifted'] clears the flag
 * while the GoTrue ban stands, so the row read Active, "Re-enable account" was
 * gone, and for a member with no email on file Disable was hidden too —
 * leaving a signed-out, banned, legitimate user with NO status action anywhere
 * in the product and no recovery short of direct GoTrue/SQL access. The
 * component cannot see a stray ban (nothing in the console can), so the only
 * honest posture is to keep both repairs reachable at all times.
 *
 * Disable is still hidden — rather than shown-and-refused — in two cases:
 *
 *   1. a protected (allowlisted) platform admin, so an operator never aims at a
 *      target the server will reject;
 *   2. a member with no email on file, because the email IS the type-to-confirm
 *      string and there is nothing to type.
 *
 * Both are courtesies, never controls. The server refuses a protected target
 * independently, on the VERIFIED auth email.
 *
 * Re-enable is hidden in NEITHER case, and that asymmetry is deliberate:
 *
 *   - case 2, because it has no type-to-confirm gate, and an emailless account
 *     that is locked out must still be recoverable;
 *   - case 1, because the server does not refuse it. Disable is refused for a
 *     protected admin; re-enable never is. You may always restore access, you
 *     may not remove a god admin's. Gating this item on `protectedAdmin` was a
 *     UI-invented restriction with a real victim: an account disabled BEFORE
 *     its address was added to STOCKPILOT_PLATFORM_ADMIN_EMAILS would have had
 *     no re-enable path through the console at all.
 */
export function UserActionsMenu({
  userId,
  email,
  disabledAt,
  protectedAdmin,
}: {
  userId: string;
  email: string | null;
  disabledAt: string | null;
  protectedAdmin: boolean;
}) {
  const router = useRouter();
  const { ensure, modal } = useStepUp();
  const [pending, start] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // NOT derived from `disabledAt` — see the note above. The only gates are the
  // ones the server itself applies (protected admin) or that the confirm dialog
  // physically needs (an email to type). Re-enable has neither, so it is
  // rendered unconditionally below.
  const canDisable = !protectedAdmin && email !== null && email.length > 0;
  // `disabledAt` no longer decides WHICH actions exist — only which one leads,
  // so a disabled row and an active row do not offer identical guidance.
  const isDisabled = disabledAt !== null;

  /** Runs an action, and on a stale step-up re-challenges TOTP and retries ONCE. */
  async function withStepUp<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
    const first = await run();
    if (first.ok || first.error.details?.reason !== 'aal2_required') return first;
    const ok = await ensure();
    if (!ok) return first;
    return run();
  }

  function onReset() {
    if (!window.confirm(`Email a password-reset link to ${email ?? 'this user'}?`)) return;
    start(async () => {
      const res = await sendUserPasswordResetAction({ targetUserId: userId });
      if (res.ok) toast.success(`Reset email sent to ${email ?? 'the user'}.`);
      else toast.error(res.error.message);
    });
  }

  /**
   * Failure handling shared by both status actions. The rule is deliberately
   * narrow: re-read the page ONLY when the row is stale, never on a partial.
   *
   * On a partial, the action layer's message ends in "press <Button> again".
   * Both status items are now mounted on every row, so a refresh can no longer
   * unmount the retry — but the row is still left alone and the dialog left
   * open, because re-rendering mid-incident would also discard the typed
   * confirmation and scroll the operator away from the row they are working.
   * The toast carries the whole truth either way.
   *
   * PARTIAL IS TESTED FIRST, and that ordering is load-bearing. The two
   * conditions are not mutually exclusive: a partial RE-ENABLE is returned with
   * code ACCOUNT_NOT_DISABLED, which is also a stale-status code. Testing
   * staleness first therefore sent every partial re-enable down the refresh
   * path and unmounted its own retry — the exact failure the comment above
   * describes, reached through the one code that belongs to both sets. A
   * partial is a statement about THIS write's completeness, a stale status is a
   * statement about the row being older than the operator thinks; when a result
   * carries both, the half-applied write is the more specific truth and the one
   * with an actionable next step.
   */
  function handleFailure(res: Extract<ActionResult<unknown>, { ok: false }>) {
    toast.error(res.error.message);
    if (isPartial(res)) return;
    setConfirmOpen(false);
    if (isStaleStatus(res)) router.refresh();
  }

  function onDisable(reason: DisableReasonInput) {
    start(async () => {
      const res = await withStepUp(() => disableUserAccountAction({ targetUserId: userId, reason }));
      if (!res.ok) {
        handleFailure(res);
        return;
      }
      setConfirmOpen(false);
      toast.success(
        res.data.sessionsRevoked > 0
          ? `Account disabled. ${res.data.sessionsRevoked} session${res.data.sessionsRevoked === 1 ? '' : 's'} revoked.`
          : 'Account disabled.',
      );
      router.refresh();
    });
  }

  function onReenable() {
    start(async () => {
      const res = await withStepUp(() => reenableUserAccountAction({ targetUserId: userId }));
      if (!res.ok) {
        handleFailure(res);
        return;
      }
      toast.success('Account re-enabled. The user can sign in again.');
      router.refresh();
    });
  }

  const disableItem = canDisable ? (
    <DropdownMenuItem
      className="text-destructive focus:text-destructive"
      onSelect={(e) => {
        // Keep the menu from closing before the dialog mounts, so focus
        // moves straight into the type-to-confirm field.
        e.preventDefault();
        setConfirmOpen(true);
      }}
    >
      Disable account...
    </DropdownMenuItem>
  ) : null;
  const reenableItem = <DropdownMenuItem onSelect={onReenable}>Re-enable account</DropdownMenuItem>;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" disabled={pending} aria-label="User actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onReset}>Send password reset...</DropdownMenuItem>
          {isDisabled ? (
            <>
              {reenableItem}
              {disableItem}
            </>
          ) : (
            <>
              {disableItem}
              {reenableItem}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Mounted only when the gate can actually be satisfied — an empty
          expected string must never reach the dialog. */}
      {canDisable && email !== null && (
        <DisableAccountDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          email={email}
          pending={pending}
          onConfirm={onDisable}
        />
      )}
      {modal}
    </>
  );
}
