'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { setOrderItemsAccessAction } from '@/server/actions/platform/permission-exceptions';

import {
  ORDER_ITEMS_ACCESS_ROLE_DEFAULT_COPY,
  ORDER_ITEMS_ACCESS_STATE_LABELS,
  PERMISSION_EXCEPTION_STATES,
  ROLE_DEFINITIONS,
  orderCatalogAccessAfterSavingCopy,
  orderCatalogAccessChipCopy,
  orderCatalogAccessExplanations,
  orderCatalogAccessPreview,
  type PermissionExceptionState,
  type Role,
} from '@stockpilot/core';

/**
 * Everything the dialog needs about one member, read by the Users tab in its
 * one batched read (orgs.ts getOrgMembersOrderItemsAccess). Plain data: it
 * crosses from the server page to this client component.
 */
export interface OrderItemsAccessTarget {
  organizationId: string;
  userId: string;
  /** Their name, else their email. */
  name: string;
  role: Role;
  disabled: boolean;
  /** StockPilot's exception as the page read it: what Save compares against. */
  exception: PermissionExceptionState;
  ordersModuleEnabled: boolean;
  canRequestOrders: boolean;
}

/** A stale step-up the operator then dismissed: nothing was sent. */
const STEP_UP_CANCELLED_COPY =
  'Confirm with your authenticator to save this change. Nothing was saved.';

const STATE_SET: ReadonlySet<string> = new Set(PERMISSION_EXCEPTION_STATES);

function isState(v: unknown): v is PermissionExceptionState {
  return typeof v === 'string' && STATE_SET.has(v);
}

/**
 * God Admin's Order items access control for one member
 * (orders:manage_catalog_visibility, migration 0413): Follow role default,
 * Allow or Deny, with the effect shown before saving. Opened from the row's
 * actions on the console Users tab (design 8.4).
 *
 * The preview and every explanation come from core (orderCatalogAccessPreview
 * and its copy), the function the Users tab column uses too, so the dialog and
 * the column cannot disagree about what a choice does. Prerequisites (an
 * enabled account, the Orders module, warehouse and category access) are
 * explained, never granted.
 *
 * Save sends the chosen state WITH the state this dialog showed
 * (compare-and-set). Outcomes:
 *   - saved: a toast, the dialog closes and the page is re-read;
 *   - a stale step-up (details.reason aal2_required): the authenticator prompt,
 *     then ONE retry;
 *   - a lost compare-and-set (permission_exception_changed): the stale-state
 *     sentence, the dialog moves to the state it is now and the page is
 *     re-read; never "not authorized" (the STALE_STATUS_CODES rule of
 *     user-actions-menu.tsx), and the operator's choice is kept so they can
 *     decide again against the fresh state;
 *   - the member left (member_not_found): the dialog closes and the page is
 *     re-read, because there is no row left to change;
 *   - busy, invalid or a failure: the sentence in place, the dialog stays.
 * Nothing closes or resends it while a save is out.
 */
export function OrderItemsAccessDialog({
  open,
  onOpenChange,
  target,
  ensureStepUp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: OrderItemsAccessTarget;
  /** The row menu's useStepUp().ensure: one authenticator prompt per row. */
  ensureStepUp: () => Promise<boolean>;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  /** The operator's pick; null until they pick, so the dialog opens on the current state. */
  const [choice, setChoice] = React.useState<PermissionExceptionState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  /**
   * What a lost compare-and-set said the state is now, tied to the page value
   * it superseded: once the re-read page brings a different value, the page
   * wins again without an effect.
   */
  const [conflict, setConflict] = React.useState<{
    basis: PermissionExceptionState;
    current: PermissionExceptionState;
  } | null>(null);

  React.useEffect(() => {
    if (!open) {
      // Reset on CLOSE, so the next opening starts from the row as it is.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on close
      setChoice(null);
      setError(null);
      setConflict(null);
    }
  }, [open]);

  const current =
    conflict && conflict.basis === target.exception ? conflict.current : target.exception;
  const selected = choice ?? current;

  const previewOf = (exception: PermissionExceptionState, role: Role = target.role) =>
    orderCatalogAccessPreview({
      role,
      exception,
      disabled: target.disabled,
      ordersModuleEnabled: target.ordersModuleEnabled,
      canRequestOrders: target.canRequestOrders,
    });
  const currentPreview = previewOf(current);
  const preview = previewOf(selected);
  const explanations = orderCatalogAccessExplanations(preview, {
    role: target.role,
    exception: selected,
  });
  const roleName = ROLE_DEFINITIONS[target.role].name;
  const canSave = selected !== current && !pending;

  function handleOpenChange(next: boolean) {
    // While a save is out, swallow Escape and the overlay click so the answer
    // always lands in an open dialog.
    if (pending && !next) return;
    onOpenChange(next);
  }

  function onSave() {
    if (!canSave) return;
    const state = selected;
    const expectedState = current;
    const basis = target.exception;
    setError(null);
    start(async () => {
      const send = () =>
        setOrderItemsAccessAction({
          organizationId: target.organizationId,
          targetUserId: target.userId,
          state,
          expectedState,
        });
      let res = await send();
      if (!res.ok && res.error.details?.reason === 'aal2_required') {
        if (!(await ensureStepUp())) {
          setError(STEP_UP_CANCELLED_COPY);
          return;
        }
        res = await send();
      }

      if (res.ok) {
        const saved = previewOf(res.data.after, res.data.targetRole);
        toast.success(
          `Order items access saved: ${orderCatalogAccessChipCopy(saved.effective)} for ${target.name}.`,
        );
        onOpenChange(false);
        router.refresh();
        return;
      }

      const reason = res.error.details?.reason;
      if (reason === 'permission_exception_changed') {
        const now = res.error.details?.current;
        if (isState(now)) setConflict({ basis, current: now });
        setError(res.error.message);
        router.refresh();
        return;
      }
      if (reason === 'member_not_found') {
        toast.error(res.error.message);
        onOpenChange(false);
        router.refresh();
        return;
      }
      setError(res.error.message);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Order items access</DialogTitle>
          <DialogDescription>
            Whether this member can use Manage order items: choosing which items and books appear in
            Place an Order. Their role does not change.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground text-[13.5px] font-medium">{target.name}</span>
              <span className="text-ink-2 text-[12.5px]">{roleName}</span>
              {target.disabled ? <Badge variant="destructive">Disabled</Badge> : null}
            </div>
            <p className="text-muted-foreground text-[12.5px]">
              {ORDER_ITEMS_ACCESS_ROLE_DEFAULT_COPY}
            </p>
            <p className="text-[12.5px]" data-testid="order-items-access-now">
              Now: {ORDER_ITEMS_ACCESS_STATE_LABELS[current]}.{' '}
              {orderCatalogAccessChipCopy(currentPreview.effective)}.
            </p>
          </div>

          <RadioGroup
            aria-label={`Order items access for ${target.name}`}
            value={selected}
            onValueChange={(v) => {
              if (isState(v)) setChoice(v);
            }}
            disabled={pending}
            variant="card"
          >
            {PERMISSION_EXCEPTION_STATES.map((state) => (
              <RadioGroupItem
                key={state}
                value={state}
                label={ORDER_ITEMS_ACCESS_STATE_LABELS[state]}
                description={
                  state === 'default'
                    ? `${roleName} default: ${orderCatalogAccessChipCopy(previewOf('default').roleDefault)}.`
                    : state === 'allow'
                      ? 'Allowed, whatever their role.'
                      : 'Not allowed, whatever their role.'
                }
              />
            ))}
          </RadioGroup>

          <div className="bg-sunk border-border space-y-2 rounded-md border p-3">
            <p
              className="text-foreground text-[13px] font-medium"
              aria-live="polite"
              data-testid="order-items-access-after"
            >
              {orderCatalogAccessAfterSavingCopy(preview)}
            </p>
            {explanations.length > 0 ? (
              <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-[12.5px]">
                {explanations.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="text-destructive text-[12.5px]">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!canSave}>
            {pending ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
