'use client';

import { Check, Copy, Loader2, Mail, MoreHorizontal, Send, Trash2, Truck, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { CategoryAccessCard } from '@/components/team/category-access-card';
import { RoleBadge } from '@/components/team/role-badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  inviteMemberAction,
  removeMemberAction,
  resendInviteAction,
  revokeInviteAction,
  sendMemberPasswordResetAction,
  setMemberChartersAction,
  setMemberDriverAction,
  transferOwnershipAction,
  updateMemberRoleAction,
} from '@/server/actions/team';
import { formatRelative } from '@/lib/utils';

import { ROLES, ROLE_LABELS, type InviteableRole, type Role } from '@stockpilot/core';

interface Member {
  id: string;
  /** user_profile.id — distinct from organization_members.id. Needed for
   *  per-user grants like category access (which live on the user, not the
   *  membership row). */
  userId: string;
  role: Role;
  invitedAt: string | null;
  acceptedAt: string | null;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  /** The member's primary warehouse assignment (charters are warehouse-scoped).
   *  null when the member has no warehouse assignment (e.g. owner/admin) — the
   *  Charters edit affordance is hidden in that case. */
  warehouseId: string | null;
  /** charter_ids the member currently oversees at `warehouseId`. Empty = "all
   *  charters" at that warehouse. */
  charterIds: string[];
  /** Marked delivery driver — only these members populate the
   *  Assign-delivery picker on orders. */
  isDriver: boolean;
}

interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptUrl: string;
}

interface TeamManagerProps {
  currentUserRole: Role;
  members: Member[];
  pendingInvites: PendingInvite[];
  charters: Array<{ id: string; name: string }>;
  warehouses: Array<{ id: string; name: string }>;
  warehouseCharters: Array<{ warehouse_id: string; charter_id: string }>;
  /** All active categories in the org. Drives the viewer category-access
   *  picker on the member-row dropdown. */
  allCategories: Array<{ id: string; name: string }>;
  /** Map of user_id → granted category_ids for all viewers in the org.
   *  Empty list (or missing) = unrestricted. */
  grantsByUser: Record<string, string[]>;
  charterSingular: string;
  warehouseSingular: string;
}

const ASSIGNABLE_ROLES: Role[] = ROLES.filter((r) => r !== 'owner');

export function TeamManager({
  currentUserRole,
  members,
  pendingInvites,
  charters,
  warehouses,
  warehouseCharters,
  allCategories,
  grantsByUser,
  charterSingular,
  warehouseSingular,
}: TeamManagerProps) {
  const [inviteOpen, setInviteOpen] = React.useState(false);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-end">
        {(currentUserRole === 'owner' || currentUserRole === 'admin') && (
          <Button variant="gradient" onClick={() => setInviteOpen(true)}>
            <UserPlus className="h-4 w-4" /> Invite member
          </Button>
        )}
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Members ({members.length})</h2>
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Joined</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  currentUserRole={currentUserRole}
                  allCategories={allCategories}
                  initiallyGranted={grantsByUser[m.userId] ?? []}
                  charters={charters}
                  warehouseCharters={warehouseCharters}
                  charterSingular={charterSingular}
                  warehouseSingular={warehouseSingular}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {pendingInvites.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Pending invites ({pendingInvites.length})
          </h2>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingInvites.map((inv) => (
                  <InviteRow key={inv.id} invite={inv} />
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        charters={charters}
        warehouses={warehouses}
        warehouseCharters={warehouseCharters}
        charterSingular={charterSingular}
        warehouseSingular={warehouseSingular}
      />
    </div>
  );
}

function MemberRow({
  member,
  currentUserRole,
  allCategories,
  initiallyGranted,
  charters,
  warehouseCharters,
  charterSingular,
  warehouseSingular,
}: {
  member: Member;
  currentUserRole: Role;
  allCategories: Array<{ id: string; name: string }>;
  initiallyGranted: string[];
  charters: Array<{ id: string; name: string }>;
  warehouseCharters: Array<{ warehouse_id: string; charter_id: string }>;
  charterSingular: string;
  warehouseSingular: string;
}) {
  const router = useRouter();
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const [transferOpen, setTransferOpen] = React.useState(false);
  const [transferPassword, setTransferPassword] = React.useState('');
  const [transferAck, setTransferAck] = React.useState(false);
  const [transferBusy, setTransferBusy] = React.useState(false);
  const [categoryAccessOpen, setCategoryAccessOpen] = React.useState(false);
  const [chartersOpen, setChartersOpen] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [resetBusy, setResetBusy] = React.useState(false);
  const initials = (member.fullName || member.email)
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');

  const canManage = (currentUserRole === 'owner' || currentUserRole === 'admin') && member.role !== 'owner';
  // Only the owner can hand off the role, and only to an accepted (non-owner) member.
  const canTransferOwnership =
    currentUserRole === 'owner' && member.role !== 'owner' && member.acceptedAt !== null;
  // Charters are warehouse-scoped, so the per-member editor only applies to a
  // member who actually has a warehouse assignment (staff/viewer/manager). Hide
  // for owners/admins with no warehouse.
  const canManageCharters = canManage && member.warehouseId !== null;
  const displayName = member.fullName ?? member.email;

  async function changeRole(role: Role) {
    const res = await updateMemberRoleAction({ memberId: member.id, role });
    if (!res.ok) toast.error(res.error.message);
    else {
      toast.success('Role updated.');
      router.refresh();
    }
  }

  async function toggleDriver() {
    const next = !member.isDriver;
    const res = await setMemberDriverAction({ memberId: member.id, isDriver: next });
    if (!res.ok) toast.error(res.error.message);
    else {
      toast.success(
        next
          ? `${displayName} marked as a delivery driver.`
          : `${displayName} is no longer a delivery driver.`,
      );
      router.refresh();
    }
  }

  async function confirmRemove() {
    setRemoveBusy(true);
    const res = await removeMemberAction(member.id);
    setRemoveBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setRemoveOpen(false);
    toast.success(`"${displayName}" removed from the workspace.`);
    router.refresh();
  }

  async function confirmSendReset() {
    setResetBusy(true);
    const res = await sendMemberPasswordResetAction(member.userId);
    setResetBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setResetOpen(false);
    toast.success(`Reset link sent to ${member.email}.`);
  }

  async function confirmTransfer() {
    if (!transferPassword) {
      toast.error('Enter your password to confirm.');
      return;
    }
    if (!transferAck) {
      toast.error('Acknowledge the consequences before transferring.');
      return;
    }
    setTransferBusy(true);
    const res = await transferOwnershipAction({
      targetMemberId: member.id,
      password: transferPassword,
    });
    setTransferBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setTransferOpen(false);
    setTransferPassword('');
    setTransferAck(false);
    toast.success(
      `Ownership transferred to ${displayName}. You are now an admin in this workspace.`,
    );
    router.refresh();
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt={member.fullName ?? member.email} />}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-medium">{member.fullName ?? member.email}</p>
            <p className="truncate text-xs text-muted-foreground">{member.email}</p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <RoleBadge role={member.role} />
          {member.isDriver && (
            <span
              title="Delivery driver — appears in the Assign-delivery picker"
              className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
            >
              <Truck className="size-3" /> Driver
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {member.acceptedAt ? 'Active' : 'Invited'}
      </TableCell>
      <TableCell
        className="text-right text-xs text-muted-foreground"
        suppressHydrationWarning
      >
        {member.acceptedAt ? formatRelative(member.acceptedAt) : '—'}
      </TableCell>
      <TableCell>
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Change role</DropdownMenuLabel>
              {ASSIGNABLE_ROLES.map((r) => (
                <DropdownMenuItem
                  key={r}
                  disabled={member.role === r}
                  onClick={() => changeRole(r)}
                >
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {/* Only accepted members can be handed deliveries. */}
              {member.acceptedAt !== null && (
                <DropdownMenuItem onClick={() => void toggleDriver()}>
                  <Truck className="mr-2 h-4 w-4" />
                  {member.isDriver ? 'Remove delivery driver' : 'Mark as delivery driver'}
                </DropdownMenuItem>
              )}
              {canManageCharters && (
                <DropdownMenuItem onClick={() => setChartersOpen(true)}>
                  {charterSingular}s…
                </DropdownMenuItem>
              )}
              {member.role === 'viewer' && (
                <DropdownMenuItem onClick={() => setCategoryAccessOpen(true)}>
                  Category access…
                </DropdownMenuItem>
              )}
              {/* Only accepted members have an account to recover — pending
                  invitees get "Resend invite" in the invites table instead. */}
              {member.acceptedAt !== null && (
                <DropdownMenuItem onClick={() => setResetOpen(true)}>
                  Send password reset…
                </DropdownMenuItem>
              )}
              {canTransferOwnership && (
                <DropdownMenuItem onClick={() => setTransferOpen(true)}>
                  Transfer ownership…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => setRemoveOpen(true)}
                className="text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" /> Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DestructiveConfirm
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          title="Remove member?"
          description={`${displayName} will lose access to this workspace immediately. Their activity history stays on the record. You can re-invite them anytime.`}
          confirmLabel="Remove"
          pending={removeBusy}
          onConfirm={confirmRemove}
        />
        <DestructiveConfirm
          open={resetOpen}
          onOpenChange={setResetOpen}
          tone="primary"
          title="Send password reset?"
          description={`Email ${displayName} (${member.email}) a password-reset link? The link works once and expires in 1 hour.`}
          confirmLabel="Send reset link"
          pending={resetBusy}
          onConfirm={confirmSendReset}
        />
        {member.warehouseId && chartersOpen && (
          // Mounted only while open + freshly keyed so its state initializer
          // re-reads the member's current charters each time (incl. after a
          // save + router.refresh()).
          <MemberChartersDialog
            key={`${member.id}-charters`}
            open={chartersOpen}
            onOpenChange={setChartersOpen}
            userId={member.userId}
            warehouseId={member.warehouseId}
            displayName={displayName}
            currentCharterIds={member.charterIds}
            charters={charters}
            warehouseCharters={warehouseCharters}
            charterSingular={charterSingular}
            warehouseSingular={warehouseSingular}
          />
        )}
        <Dialog open={categoryAccessOpen} onOpenChange={setCategoryAccessOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Category access — {displayName}</DialogTitle>
              <DialogDescription>
                Restrict which inventory categories this viewer can see. New
                categories appear here automatically — re-open this dialog
                later to grant access to them.
              </DialogDescription>
            </DialogHeader>
            <CategoryAccessCard
              targetUserId={member.userId}
              targetUserName={displayName}
              allCategories={allCategories}
              initiallyGranted={initiallyGranted}
            />
          </DialogContent>
        </Dialog>
        <Dialog
          open={transferOpen}
          onOpenChange={(v) => {
            if (transferBusy) return;
            setTransferOpen(v);
            if (!v) {
              setTransferPassword('');
              setTransferAck(false);
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Transfer ownership to {displayName}?</DialogTitle>
              <DialogDescription>
                {displayName} will become the new owner of this workspace. You'll
                be demoted to <strong>admin</strong> and lose owner-only
                permissions (billing, ownership transfer, deleting the workspace).
                This action is reversible only if the new owner transfers it back.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="transfer-password">Confirm your password</Label>
                <Input
                  id="transfer-password"
                  type="password"
                  autoComplete="current-password"
                  value={transferPassword}
                  onChange={(e) => setTransferPassword(e.target.value)}
                  placeholder="Your account password"
                />
              </div>
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={transferAck}
                  onChange={(e) => setTransferAck(e.target.checked)}
                />
                <span>
                  I understand I will be demoted to admin and {displayName} will
                  control billing, role policy, and ownership of this workspace
                  going forward.
                </span>
              </label>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setTransferOpen(false)}
                disabled={transferBusy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={confirmTransfer}
                disabled={transferBusy || !transferPassword || !transferAck}
              >
                {transferBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'Transfer ownership'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </TableCell>
    </TableRow>
  );
}

function InviteRow({ invite }: { invite: PendingInvite }) {
  const router = useRouter();

  const [resending, setResending] = React.useState(false);
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  const [revokeBusy, setRevokeBusy] = React.useState(false);

  async function copyLink() {
    await navigator.clipboard.writeText(invite.acceptUrl);
    toast.success('Invite link copied to clipboard.');
  }

  async function resend() {
    setResending(true);
    const res = await resendInviteAction(invite.id);
    setResending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Invite resent to "${invite.email}".`, {
      description: 'Same link as before. Expiry refreshed to 7 days.',
    });
    router.refresh();
  }

  async function confirmRevoke() {
    setRevokeBusy(true);
    const res = await revokeInviteAction(invite.id);
    setRevokeBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setRevokeOpen(false);
    toast.success('Invite revoked.');
    router.refresh();
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{invite.email}</span>
        </div>
      </TableCell>
      <TableCell>
        <RoleBadge role={invite.role} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground" suppressHydrationWarning>{formatRelative(invite.expiresAt)}</TableCell>
      <TableCell className="flex justify-end gap-1">
        <Button variant="outline" size="sm" onClick={resend} disabled={resending}>
          {resending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          Resend
        </Button>
        <Button variant="outline" size="sm" onClick={copyLink}>
          <Copy className="h-3.5 w-3.5" /> Copy link
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setRevokeOpen(true)}>
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
        <DestructiveConfirm
          open={revokeOpen}
          onOpenChange={setRevokeOpen}
          title="Revoke invite?"
          description={`The pending invite for ${invite.email} will be cancelled. The accept link will stop working immediately. You can send a fresh invite anytime.`}
          confirmLabel="Revoke invite"
          pending={revokeBusy}
          onConfirm={confirmRevoke}
        />
      </TableCell>
    </TableRow>
  );
}

/**
 * A bordered, scrollable checkbox list of charters. Toggling a row adds/removes
 * its id from `selected`. Used both in the invite dialog and the per-member
 * "Charters" editor. Empty selection means "all charters at this warehouse" —
 * the caller renders that hint below.
 *
 * No shared checkbox primitive exists in the repo, so each row is an accessible
 * `<button role="checkbox" aria-checked>` styled like the tag-toggle in
 * inventory/bulk-actions.tsx.
 */
function CharterChecklist({
  charters,
  selected,
  onToggle,
  disabled,
  emptyHint,
}: {
  charters: Array<{ id: string; name: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
  /** Rendered (muted, dashed) when there are no charters to pick. */
  emptyHint?: React.ReactNode;
}) {
  if (charters.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-[11px] text-muted-foreground">
        {emptyHint}
      </div>
    );
  }
  return (
    <div
      className={
        disabled
          ? 'max-h-[180px] overflow-y-auto rounded-md border bg-muted/30 opacity-60'
          : 'max-h-[180px] overflow-y-auto rounded-md border'
      }
      aria-disabled={disabled}
    >
      {charters.map((c) => {
        const on = selected.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            role="checkbox"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onToggle(c.id)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <span
              aria-hidden
              className={
                on
                  ? 'flex h-4 w-4 shrink-0 items-center justify-center rounded border border-primary bg-primary text-primary-foreground'
                  : 'flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input bg-background'
              }
            >
              {on && <Check className="h-3 w-3" />}
            </span>
            <span className="truncate">{c.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Per-member charter editor. Reconciles which charters an existing member
 * oversees at their (primary) warehouse via setMemberChartersAction. Empty
 * selection = "all charters" at that warehouse.
 */
function MemberChartersDialog({
  open,
  onOpenChange,
  userId,
  warehouseId,
  displayName,
  currentCharterIds,
  charters,
  warehouseCharters,
  charterSingular,
  warehouseSingular,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  userId: string;
  warehouseId: string;
  displayName: string;
  currentCharterIds: string[];
  charters: Array<{ id: string; name: string }>;
  warehouseCharters: Array<{ warehouse_id: string; charter_id: string }>;
  charterSingular: string;
  warehouseSingular: string;
}) {
  const router = useRouter();

  // Charters this member's warehouse actually services.
  const chartersForWarehouse = React.useMemo(() => {
    const allowed = new Set(
      warehouseCharters
        .filter((wc) => wc.warehouse_id === warehouseId)
        .map((wc) => wc.charter_id),
    );
    return charters.filter((c) => allowed.has(c.id));
  }, [charters, warehouseCharters, warehouseId]);

  // Seed selection from the member's current charters (pruned to ones the
  // warehouse still services). The parent remounts this component with a fresh
  // `key` each time the dialog opens, so this initializer re-reads props after a
  // save + router.refresh() — no re-seed effect needed.
  const [selected, setSelected] = React.useState<string[]>(() => {
    const allowed = new Set(chartersForWarehouse.map((c) => c.id));
    return currentCharterIds.filter((id) => allowed.has(id));
  });
  const [busy, setBusy] = React.useState(false);

  const toggleCharter = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id],
    );
  };

  async function save() {
    setBusy(true);
    const res = await setMemberChartersAction({ userId, warehouseId, charterIds: selected });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`${charterSingular} access updated for ${displayName}.`);
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (busy ? null : onOpenChange(v))}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {charterSingular} access — {displayName}
          </DialogTitle>
          <DialogDescription>
            {`Choose which ${charterSingular.toLowerCase()}s this member oversees at their ${warehouseSingular.toLowerCase()}. Leave all unchecked to give them every ${charterSingular.toLowerCase()} this ${warehouseSingular.toLowerCase()} services.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <CharterChecklist
            charters={chartersForWarehouse}
            selected={selected}
            onToggle={toggleCharter}
            disabled={busy}
            emptyHint={`This ${warehouseSingular.toLowerCase()} has no ${charterSingular.toLowerCase()}s linked yet. Link some in Admin → ${warehouseSingular}s — this member already sees all stock at this ${warehouseSingular.toLowerCase()}.`}
          />
          <p className="text-[11px] text-muted-foreground">
            {selected.length > 0
              ? `Scoped to the selected ${charterSingular.toLowerCase()}${selected.length === 1 ? '' : 's'} at this ${warehouseSingular.toLowerCase()}.`
              : `No ${charterSingular.toLowerCase()} picked — they'll see every ${charterSingular.toLowerCase()} this ${warehouseSingular.toLowerCase()} services.`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="gradient" onClick={save} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface InviteFormValues {
  email: string;
  // Owner is never invitable — it can only be transferred from the
  // current owner via the dedicated ownership-transfer flow. Schema
  // mirrors `inviteMemberSchema.role` in @stockpilot/core.
  role: InviteableRole;
  charterIds: string[];
  warehouseId: string;
  message: string;
}

const NONE_VALUE = '__none';

function InviteDialog({
  open,
  onOpenChange,
  charters,
  warehouses,
  warehouseCharters,
  charterSingular,
  warehouseSingular,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  charters: Array<{ id: string; name: string }>;
  warehouses: Array<{ id: string; name: string }>;
  warehouseCharters: Array<{ warehouse_id: string; charter_id: string }>;
  charterSingular: string;
  warehouseSingular: string;
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<InviteFormValues>({
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: { email: '', role: 'staff', charterIds: [], warehouseId: '', message: '' },
  });

  const role = watch('role');
  const charterIds = watch('charterIds');
  const warehouseId = watch('warehouseId');
  const warehouseRequired = role === 'staff' || role === 'viewer';

  // ALL warehouses are always pickable — the (warehouse, charter) pair just
  // has to be valid (or charter must be empty = "all charters at this warehouse").
  // Filtering warehouses by charter previously hid warehouses that simply
  // hadn't been linked to a charter yet, which led to "where did my warehouse
  // go?" confusion.

  // Charters that the *currently selected* warehouse services. Drives the
  // charter dropdown below. If no warehouse picked yet, show all charters
  // (with a hint).
  const chartersForWarehouse = React.useMemo(() => {
    if (!warehouseId) return charters;
    const allowedCharterIds = new Set(
      warehouseCharters
        .filter((wc) => wc.warehouse_id === warehouseId)
        .map((wc) => wc.charter_id),
    );
    return charters.filter((c) => allowedCharterIds.has(c.id));
  }, [charters, warehouseCharters, warehouseId]);

  React.useEffect(() => {
    if (!open) reset({ email: '', role: 'staff', charterIds: [], warehouseId: '', message: '' });
  }, [open, reset]);

  // If the user changes warehouse, prune any selected charters that the new
  // warehouse doesn't service so an invalid pair never gets submitted.
  React.useEffect(() => {
    if (!warehouseId || charterIds.length === 0) return;
    const allowed = new Set(chartersForWarehouse.map((c) => c.id));
    const next = charterIds.filter((id) => allowed.has(id));
    if (next.length !== charterIds.length) setValue('charterIds', next);
  }, [warehouseId, charterIds, chartersForWarehouse, setValue]);

  const toggleCharter = (id: string) => {
    const next = charterIds.includes(id)
      ? charterIds.filter((c) => c !== id)
      : [...charterIds, id];
    setValue('charterIds', next);
  };

  const onSubmit = handleSubmit(async (values) => {
    if (warehouseRequired && !values.warehouseId) {
      toast.error(
        `Pick a ${warehouseSingular.toLowerCase()} for this role. The member will be locked to it.`,
      );
      return;
    }
    const res = await inviteMemberAction({
      email: values.email,
      role: values.role,
      charterIds: values.charterIds,
      warehouseId: values.warehouseId || null,
      message: values.message || undefined,
    });
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Invite sent to "${values.email}".`, {
      description: "Copy the link from the pending invites table if email isn't configured.",
    });
    onOpenChange(false);
    router.refresh();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            They&apos;ll get an email with a link to accept and join your workspace.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="teammate@company.com"
              {...register('email', { required: true })}
            />
            {errors.email && <p className="text-xs text-destructive">Email is required.</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select
                value={role}
                onValueChange={(v: string) => setValue('role', v as InviteableRole)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {ROLE_LABELS[role].description}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>
                {warehouseSingular}
                {!warehouseRequired && (
                  <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                )}
              </Label>
              <Select
                value={warehouseId || NONE_VALUE}
                onValueChange={(v: string) =>
                  setValue('warehouseId', v === NONE_VALUE ? '' : v)
                }
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      warehouseRequired
                        ? `Pick a ${warehouseSingular.toLowerCase()}`
                        : `No ${warehouseSingular.toLowerCase()}`
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {!warehouseRequired && (
                    <SelectItem value={NONE_VALUE}>
                      No specific {warehouseSingular.toLowerCase()}
                    </SelectItem>
                  )}
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>
              {charterSingular}s
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            {!warehouseId ? (
              <div className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-[11px] text-muted-foreground">
                {`Pick a ${warehouseSingular.toLowerCase()} above to see its ${charterSingular.toLowerCase()}s.`}
              </div>
            ) : (
              <CharterChecklist
                charters={chartersForWarehouse}
                selected={charterIds}
                onToggle={toggleCharter}
                emptyHint={`This ${warehouseSingular.toLowerCase()} has no ${charterSingular.toLowerCase()}s linked yet. Link some in Admin → ${warehouseSingular}s, or invite without a ${charterSingular.toLowerCase()} (they'll see all stock at this ${warehouseSingular.toLowerCase()}).`}
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              {!warehouseId
                ? `Pick a ${warehouseSingular.toLowerCase()} above to see its ${charterSingular.toLowerCase()}s.`
                : chartersForWarehouse.length === 0
                ? `Or invite without a ${charterSingular.toLowerCase()} (they'll see all stock at this ${warehouseSingular.toLowerCase()}).`
                : charterIds.length > 0
                ? `Scoped to the selected ${charterSingular.toLowerCase()}${charterIds.length === 1 ? '' : 's'} at this ${warehouseSingular.toLowerCase()}.`
                : `No ${charterSingular.toLowerCase()} picked — they'll see every ${charterSingular.toLowerCase()} this ${warehouseSingular.toLowerCase()} services.`}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-message">
              Message
              <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="invite-message"
              placeholder="Welcome to the team — see you Monday"
              {...register('message', { maxLength: 2000 })}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="gradient" disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
