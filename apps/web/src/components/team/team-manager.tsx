'use client';

import { Copy, Loader2, Mail, MoreHorizontal, Trash2, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { RoleBadge } from '@/components/team/role-badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
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
  revokeInviteAction,
  updateMemberRoleAction,
} from '@/server/actions/team';
import { formatRelative } from '@/lib/utils';

import { ROLES, type Role } from '@stockpilot/core';

interface Member {
  id: string;
  role: Role;
  invitedAt: string | null;
  acceptedAt: string | null;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
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
}

const ASSIGNABLE_ROLES: Role[] = ROLES.filter((r) => r !== 'owner');

export function TeamManager({ currentUserRole, members, pendingInvites }: TeamManagerProps) {
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
        <div className="overflow-hidden rounded-xl border bg-card">
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
                <MemberRow key={m.id} member={m} currentUserRole={currentUserRole} />
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
          <div className="overflow-hidden rounded-xl border bg-card">
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

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}

function MemberRow({ member, currentUserRole }: { member: Member; currentUserRole: Role }) {
  const router = useRouter();
  const initials = (member.fullName || member.email)
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');

  const canManage = (currentUserRole === 'owner' || currentUserRole === 'admin') && member.role !== 'owner';

  async function changeRole(role: Role) {
    const res = await updateMemberRoleAction({ memberId: member.id, role });
    if (!res.ok) toast.error(res.error.message);
    else {
      toast.success('Role updated');
      router.refresh();
    }
  }

  async function remove() {
    if (!confirm(`Remove ${member.fullName ?? member.email} from this workspace?`)) return;
    const res = await removeMemberAction(member.id);
    if (!res.ok) toast.error(res.error.message);
    else {
      toast.success('Member removed');
      router.refresh();
    }
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
        <RoleBadge role={member.role} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {member.acceptedAt ? 'Active' : 'Invited'}
      </TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">
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
              <DropdownMenuItem onClick={remove} className="text-destructive">
                <Trash2 className="mr-2 h-4 w-4" /> Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

function InviteRow({ invite }: { invite: PendingInvite }) {
  const router = useRouter();

  async function copyLink() {
    await navigator.clipboard.writeText(invite.acceptUrl);
    toast.success('Invite link copied');
  }

  async function revoke() {
    if (!confirm(`Revoke invite for ${invite.email}?`)) return;
    const res = await revokeInviteAction(invite.id);
    if (!res.ok) toast.error(res.error.message);
    else {
      toast.success('Invite revoked');
      router.refresh();
    }
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
      <TableCell className="text-xs text-muted-foreground">{formatRelative(invite.expiresAt)}</TableCell>
      <TableCell className="flex justify-end gap-1">
        <Button variant="outline" size="sm" onClick={copyLink}>
          <Copy className="h-3.5 w-3.5" /> Copy link
        </Button>
        <Button variant="ghost" size="icon" onClick={revoke}>
          <Trash2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<{ email: string; role: Role }>({
    defaultValues: { email: '', role: 'staff' },
  });

  React.useEffect(() => {
    if (!open) reset({ email: '', role: 'staff' });
  }, [open, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const res = await inviteMemberAction({ email: values.email, role: values.role });
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Invite sent to ${values.email}`, {
      description: 'Copy the link from the pending invites table if email isn\'t configured.',
    });
    onOpenChange(false);
    router.refresh();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            They'll get an email with a link to accept and join your workspace.
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
            {errors.email && <p className="text-xs text-destructive">Email is required</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={watch('role')} onValueChange={(v: string) => setValue('role', v as Role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
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
