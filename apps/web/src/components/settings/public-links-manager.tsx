'use client';

import { Check, Copy, CopyPlus, ExternalLink, Loader2, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

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
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
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
import {
  createPublicLinkAction,
  duplicatePublicLinkAction,
  setPublicLinkActiveAction,
} from '@/server/actions/public-links';
import type { PublicLinkRow } from '@/server/services/public-links';

/**
 * Links table for /dashboard/settings/public-requests: one row per shareable
 * /r/<token> link with copy / preview / enable-disable / edit actions and a
 * name-first create flow (the token is minted server-side by the service).
 */
export function PublicLinksManager({
  appUrl,
  links,
}: {
  appUrl: string;
  links: PublicLinkRow[];
}) {
  const router = useRouter();
  const base = appUrl.replace(/\/$/, '');

  const [error, setError] = React.useState<string | null>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const [togglingId, setTogglingId] = React.useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = React.useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = React.useState<PublicLinkRow | null>(null);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  async function copyUrl(link: PublicLinkRow) {
    try {
      await navigator.clipboard.writeText(`${base}/r/${link.token}`);
      setCopiedId(link.id);
      setTimeout(() => setCopiedId((cur) => (cur === link.id ? null : cur)), 1500);
    } catch {
      setError("Couldn't copy the link. Open the editor to copy it manually.");
    }
  }

  async function setActive(link: PublicLinkRow, active: boolean) {
    setTogglingId(link.id);
    setError(null);
    const res = await setPublicLinkActiveAction({ id: link.id, active });
    setTogglingId(null);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setConfirmDisable(null);
    router.refresh();
  }

  async function duplicateLink(link: PublicLinkRow) {
    setDuplicatingId(link.id);
    setError(null);
    const res = await duplicatePublicLinkAction({ id: link.id });
    setDuplicatingId(null);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    // The copy is created disabled — land the admin in its editor so they
    // review the duplicated catalog before enabling it.
    router.push(`/dashboard/settings/public-requests/${res.data.id}`);
  }

  async function createLink() {
    const name = createName.trim();
    if (!name) {
      setCreateError('Give the link a name — requesters never see it, your team does.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    const res = await createPublicLinkAction({ name });
    setCreating(false);
    if (!res.ok) {
      setCreateError(res.error.message);
      return;
    }
    setCreateOpen(false);
    setCreateName('');
    router.push(`/dashboard/settings/public-requests/${res.data.id}`);
  }

  return (
    <section data-tour="public-links" className="bg-card rounded-xl border">
      <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">Public request links</h2>
          <p className="text-muted-foreground mt-0.5 text-[11.5px]">
            Each link has its own catalog, availability window, and quantity
            limits. Share a link&apos;s URL with the audience it was made for.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New link
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-destructive px-4 pt-3 text-xs">
          {error}
        </p>
      ) : null}

      {links.length === 0 ? (
        <p className="text-muted-foreground p-6 text-center text-sm">
          No public links yet. Create one to share a curated catalog with
          external requesters.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="text-right">Items</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {links.map((link) => {
              const expired =
                link.expires_at != null && Date.parse(link.expires_at) <= Date.now();
              return (
                <TableRow key={link.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/dashboard/settings/public-requests/${link.id}`}
                      className="hover:underline"
                    >
                      {link.name}
                    </Link>
                    {link.purpose ? (
                      <p className="text-muted-foreground mt-0.5 max-w-[28ch] truncate text-xs font-normal">
                        {link.purpose}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {link.active ? (
                      expired ? (
                        <Badge variant="warning">Expired</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )
                    ) : (
                      <Badge variant="outline">Disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                    {link.expires_at ? (
                      <span className={expired ? 'text-destructive' : undefined}>
                        {new Date(link.expires_at).toLocaleDateString()}
                      </span>
                    ) : (
                      'Never'
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {link.entry_count}
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                    {new Date(link.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => copyUrl(link)}
                        title="Copy public URL"
                      >
                        {copiedId === link.id ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {copiedId === link.id ? 'Copied' : 'Copy URL'}
                      </Button>
                      <Button asChild type="button" variant="outline" size="sm">
                        <a
                          href={`${base}/r/${link.token}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open the live public page in a new tab"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          Preview
                        </a>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={togglingId === link.id}
                        onClick={() =>
                          link.active ? setConfirmDisable(link) : setActive(link, true)
                        }
                      >
                        {togglingId === link.id && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {link.active ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={duplicatingId === link.id}
                        onClick={() => void duplicateLink(link)}
                        title="Duplicate this link's settings and catalog as a new disabled link"
                      >
                        {duplicatingId === link.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CopyPlus className="h-3.5 w-3.5" />
                        )}
                        Duplicate
                      </Button>
                      <Button asChild type="button" variant="outline" size="sm">
                        <Link href={`/dashboard/settings/public-requests/${link.id}`}>
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <DestructiveConfirm
        open={confirmDisable !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDisable(null);
        }}
        title={`Disable “${confirmDisable?.name ?? ''}”?`}
        description="The public page for this link stops accepting visits and submissions immediately. The URL is kept — you can re-enable the link at any time."
        confirmLabel="Disable link"
        pending={togglingId === confirmDisable?.id}
        onConfirm={() => {
          if (confirmDisable) void setActive(confirmDisable, false);
        }}
      />

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            setCreateError(null);
            setCreateName('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New public request link</DialogTitle>
            <DialogDescription>
              A fresh link starts with an empty catalog and a unique URL. Name
              it after the audience it serves — you pick what it exposes next.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-link-name">Link name</Label>
            <Input
              id="new-link-name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              maxLength={160}
              placeholder="e.g. Spring book fair"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void createLink();
                }
              }}
            />
            {createError ? (
              <p role="alert" className="text-destructive text-xs">
                {createError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void createLink()} disabled={creating}>
              {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
