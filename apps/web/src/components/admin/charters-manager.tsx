'use client';

import {
  Building2,
  History,
  Loader2,
  MapPin,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { STICKY_ACTIONS } from '@/components/admin/sticky-actions';
import { PageHeader } from '@/components/patterns/page-header';
import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  archiveCharterAction,
  createCharterAction,
  restoreCharterAction,
  updateCharterAction,
} from '@/server/actions/charters';

interface CharterAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

interface CharterRow {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  notes: string | null;
  status: 'active' | 'inactive' | 'archived';
  address: CharterAddress | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  warehouse_count: number;
  user_count: number;
}

interface FormValues {
  name: string;
  code: string;
  description: string;
  notes: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

/** True when none of the address fields carry a value. Used to surface the
 *  "needed for shipping labels" hint on the charter row. */
function isAddressEmpty(address: CharterAddress | null): boolean {
  if (!address) return true;
  return !(
    address.line1 ||
    address.line2 ||
    address.city ||
    address.region ||
    address.postalCode ||
    address.country
  );
}

/** Flattens the jsonb address into displayable lines, dropping blanks so we
 *  never render "null". Mirrors the warehouse detail renderer. */
function formatAddressLines(address: CharterAddress | null): string[] {
  if (!address) return [];
  const cityLine = [address.city, address.region].filter(Boolean).join(', ');
  const cityZip = [cityLine, address.postalCode].filter(Boolean).join(' ').trim();
  return [address.line1, address.line2, cityZip, address.country].filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );
}

export function ChartersManager({
  initial,
  termSingular,
  view = 'active',
  eyebrow,
  title,
  subline,
}: {
  initial: CharterRow[];
  termSingular: string;
  view?: 'active' | 'archived';
  /** The page header's words, resolved by the page (terminology included). */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subline?: React.ReactNode;
}) {
  const isArchivedView = view === 'archived';
  const [editing, setEditing] = React.useState<CharterRow | null>(null);
  const [open, setOpen] = React.useState(false);

  return (
    <>
      {/* The header lives here because "New" and each row's Edit share one
          dialog. The Active / Archived toggle is the header's view control
          (DESIGN-SPEC 6.21); "New" is the page-level create, so it is the
          accent primary, hidden in the archived view as before. */}
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        titleId="charters-title"
        subline={subline}
        actions={<ArchiveViewToggle view={view} />}
        primaryAction={
          !isArchivedView ? (
            <Button
              variant="gradient"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> New {termSingular.toLowerCase()}
            </Button>
          ) : null
        }
      />

      {initial.length === 0 ? (
        isArchivedView ? (
          <EmptyState
            icon={History}
            title={`No archived ${termSingular.toLowerCase()}s`}
            description={`${termSingular}s you archive show up here so you can restore them later.`}
          />
        ) : (
          <EmptyState
            icon={Building2}
            title={`No ${termSingular.toLowerCase()}s yet`}
            description={`Create your first ${termSingular.toLowerCase()} to start grouping warehouses and routing orders. Use the New ${termSingular.toLowerCase()} button above to add one.`}
          />
        )
      ) : (
        // The table scrolls sideways inside its card on a narrow screen, so
        // the Actions column is always reachable and never pushed off the page.
        <div className="border-border bg-card overflow-hidden rounded-lg border">
          <Table scrollLabelledBy="charters-title" className="min-w-[760px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead className="text-right">Warehouses</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead>Shipping address</TableHead>
                {/* Below md the Actions column stays pinned to the card's right edge
                    while the other columns scroll under it, so Edit and Archive
                    are always on screen. */}
                <TableHead className={cn('w-32 text-right', STICKY_ACTIONS)}>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initial.map((row) => (
                <CharterTableRow
                  key={row.id}
                  row={row}
                  isArchivedView={isArchivedView}
                  onEdit={() => {
                    setEditing(row);
                    setOpen(true);
                  }}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CharterDialog
        open={open}
        onOpenChange={setOpen}
        editing={editing}
        termSingular={termSingular}
      />
    </>
  );
}

function CharterTableRow({
  row,
  isArchivedView,
  onEdit,
}: {
  row: CharterRow;
  isArchivedView: boolean;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [archiveBusy, setArchiveBusy] = React.useState(false);
  const [restoreOpen, setRestoreOpen] = React.useState(false);
  const [restoreBusy, setRestoreBusy] = React.useState(false);
  // Why the last try was refused, shown inside the confirm: a toast alone
  // sits behind the open dialog. Cleared on open and on each try.
  const [confirmError, setConfirmError] = React.useState<string | null>(null);

  async function confirmArchive() {
    setArchiveBusy(true);
    setConfirmError(null);
    const res = await archiveCharterAction(row.id);
    setArchiveBusy(false);
    if (!res.ok) {
      setConfirmError(res.error.message);
      toast.error(res.error.message);
      return;
    }
    setArchiveOpen(false);
    toast.success(`"${row.name}" archived.`);
    router.refresh();
  }

  async function confirmRestore() {
    setRestoreBusy(true);
    setConfirmError(null);
    const res = await restoreCharterAction(row.id);
    setRestoreBusy(false);
    if (!res.ok) {
      setConfirmError(res.error.message);
      toast.error(res.error.message);
      return;
    }
    setRestoreOpen(false);
    toast.success(`"${row.name}" restored.`);
    router.refresh();
  }

  return (
    <TableRow>
      <TableCell className="text-foreground font-medium">{row.name}</TableCell>
      <TableCell className="text-muted-foreground font-mono text-[12.5px]">
        {row.code ?? '—'}
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">{row.warehouse_count}</TableCell>
      <TableCell className="text-right font-mono tabular-nums">{row.user_count}</TableCell>
      <TableCell className="text-ink-2 w-[280px] max-w-[280px] text-[13px]">
        {isAddressEmpty(row.address) ? (
          <Badge variant="warning" className="gap-1">
            <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
            Needed for shipping labels
          </Badge>
        ) : (
          // Wrap long mailing addresses inside the bounded cell instead of
          // truncating with nowrap — nowrap expands the auto-layout column and
          // shoves the Actions/Edit buttons off-screen (owner caught this).
          <span className="flex min-w-0 items-start gap-1.5">
            <MapPin className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">
              {formatAddressLines(row.address).join(', ')}
            </span>
          </span>
        )}
      </TableCell>
      <TableCell className={cn('whitespace-nowrap', STICKY_ACTIONS)}>
        {/* The buttons sit in their own flex box: a flex table cell stops
            being a table cell (its row border and alignment break). */}
        <div className="flex items-center justify-end gap-2">
          {isArchivedView ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setConfirmError(null);
                  setRestoreOpen(true);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Restore
              </Button>
              <DestructiveConfirm
                open={restoreOpen}
                onOpenChange={setRestoreOpen}
                title={`Restore "${row.name}"?`}
                description="This brings the charter back into the active list."
                confirmLabel="Restore"
                tone="primary"
                pending={restoreBusy}
                error={confirmError}
                onConfirm={confirmRestore}
              />
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onEdit}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setConfirmError(null);
                  setArchiveOpen(true);
                }}
                aria-label="Archive"
              >
                <Trash2 className="text-muted-foreground h-4 w-4" />
              </Button>
              <DestructiveConfirm
                open={archiveOpen}
                onOpenChange={setArchiveOpen}
                title={`Archive "${row.name}"?`}
                description={
                  <>
                    Existing warehouses keep working. You can restore this from the{' '}
                    <strong>Archived view</strong> later.
                  </>
                }
                confirmLabel="Archive"
                pending={archiveBusy}
                error={confirmError}
                onConfirm={confirmArchive}
              />
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function CharterDialog({
  open,
  onOpenChange,
  editing,
  termSingular,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: CharterRow | null;
  termSingular: string;
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<FormValues>({
    mode: 'onBlur',
    reValidateMode: 'onChange',
    defaultValues: {
      name: '',
      code: '',
      description: '',
      notes: '',
      addressLine1: '',
      addressLine2: '',
      city: '',
      region: '',
      postalCode: '',
      country: '',
      contactName: '',
      contactEmail: '',
      contactPhone: '',
    },
  });

  React.useEffect(() => {
    if (open) {
      reset({
        name: editing?.name ?? '',
        code: editing?.code ?? '',
        description: editing?.description ?? '',
        notes: editing?.notes ?? '',
        addressLine1: editing?.address?.line1 ?? '',
        addressLine2: editing?.address?.line2 ?? '',
        city: editing?.address?.city ?? '',
        region: editing?.address?.region ?? '',
        postalCode: editing?.address?.postalCode ?? '',
        country: editing?.address?.country ?? '',
        contactName: editing?.contact_name ?? '',
        contactEmail: editing?.contact_email ?? '',
        contactPhone: editing?.contact_phone ?? '',
      });
    }
  }, [open, editing, reset]);

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      name: values.name,
      code: values.code || undefined,
      description: values.description || undefined,
      notes: values.notes || undefined,
      status: 'active' as const,
      address: {
        line1: values.addressLine1 || undefined,
        line2: values.addressLine2 || undefined,
        city: values.city || undefined,
        region: values.region || undefined,
        postalCode: values.postalCode || undefined,
        country: values.country || undefined,
      },
      contactName: values.contactName || undefined,
      contactEmail: values.contactEmail || undefined,
      contactPhone: values.contactPhone || undefined,
    };
    const res = editing
      ? await updateCharterAction(editing.id, payload)
      : await createCharterAction(payload);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(editing ? `${termSingular} updated.` : `${termSingular} created.`);
    onOpenChange(false);
    router.refresh();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${termSingular.toLowerCase()}` : `New ${termSingular.toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>
            {termSingular}s group warehouses by region, division, or business unit.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="charter-name">Name</Label>
            <Input
              id="charter-name"
              placeholder={`${termSingular} A`}
              {...register('name', { required: true, maxLength: 120 })}
            />
            {errors.name && <p className="text-destructive text-[12px]">Name is required.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="charter-code">
              Code
              <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
            </Label>
            <Input id="charter-code" placeholder="A" {...register('code', { maxLength: 32 })} />
            <p className="text-muted-foreground text-xs">
              Short identifier used in reports and exports.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="charter-description">
              Description
              <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
            </Label>
            <Textarea
              id="charter-description"
              rows={2}
              placeholder="What this charter covers"
              {...register('description', { maxLength: 2000 })}
            />
          </div>
          <div className="border-border bg-sunk space-y-2 rounded-lg border p-3">
            <div>
              <Label>
                Shipping address
                <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
              </Label>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Destination for delivery orders. Required before you can buy a shipping label for
                this {termSingular.toLowerCase()}.
              </p>
            </div>
            <div className="space-y-2">
              <Input
                placeholder="Address line 1"
                aria-label="Address line 1"
                {...register('addressLine1', { maxLength: 200 })}
              />
              <Input
                placeholder="Address line 2"
                aria-label="Address line 2"
                {...register('addressLine2', { maxLength: 200 })}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="City"
                  aria-label="City"
                  {...register('city', { maxLength: 120 })}
                />
                <Input
                  placeholder="State / region"
                  aria-label="State or region"
                  {...register('region', { maxLength: 120 })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Postal code"
                  aria-label="Postal code"
                  {...register('postalCode', { maxLength: 32 })}
                />
                <Input
                  placeholder="Country"
                  aria-label="Country"
                  {...register('country', { maxLength: 120 })}
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>
              Contact
              <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
            </Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Input
                placeholder="Name"
                aria-label="Contact name"
                {...register('contactName', { maxLength: 120 })}
              />
              <Input
                placeholder="Email"
                type="email"
                aria-label="Contact email"
                {...register('contactEmail', {
                  maxLength: 254,
                  pattern: { value: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, message: 'Invalid email' },
                })}
              />
              <Input
                placeholder="Phone"
                aria-label="Contact phone"
                {...register('contactPhone', { maxLength: 40 })}
              />
            </div>
            {errors.contactEmail && (
              <p className="text-destructive text-[12px]">Enter a valid email address.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="charter-notes">
              Internal notes
              <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
            </Label>
            <Textarea id="charter-notes" rows={2} {...register('notes', { maxLength: 2000 })} />
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
            {/* The button keeps its words beside the spinner while it saves. */}
            <Button
              type="submit"
              variant="gradient"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {editing ? 'Save changes' : `Create ${termSingular.toLowerCase()}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
