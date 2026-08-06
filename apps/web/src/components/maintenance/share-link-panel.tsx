'use client';

import { Check, Copy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { revokeMaintenanceShareLinkAction } from '@/server/actions/maintenance-requests';

export interface MaintenanceShareLinkInfo {
  url: string;
  expiresAt: string;
}

interface Props {
  requestId: string;
  /** The request's current active share link, already resolved server-side
   *  (the page mints-or-returns it via MaintenanceShareLinksService.
   *  ensureActiveLink whenever the caller is eligible, the request has
   *  photos, and the org setting allows it) — `null` covers every reason
   *  there isn't one (no photos yet, the org disabled it, or this viewer
   *  can't mint one). This component never mints; it only displays,
   *  copies, and revokes. */
  link: MaintenanceShareLinkInfo | null;
}

/**
 * manage-only affordance — the caller never mounts this for a non-manager.
 *
 * The raw token is never rendered as visible/copyable page text: the URL is
 * copied straight from `link.url` into the clipboard via JS and never placed
 * into a text node, title, tooltip, or data attribute anywhere in this
 * component (fix-wave finding — the token appearing in page HTML is a real,
 * already-accepted exposure ONLY where the token functionally has to be,
 * e.g. inside the actual mailto/Outlook compose links elsewhere in this
 * feature; this panel deliberately does not add a second place it leaks).
 */
export function ShareLinkPanel({ requestId, link }: Props) {
  const router = useRouter();
  const [copied, setCopied] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);

  async function copyUrl() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy the link automatically. Try again.');
    }
  }

  async function revoke() {
    setRevoking(true);
    const res = await revokeMaintenanceShareLinkAction(requestId);
    setRevoking(false);
    setConfirmOpen(false);
    if ('error' in res) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Share link revoked.');
    router.refresh();
  }

  return (
    <section aria-label="Photo share link" className="space-y-2 rounded-xl border bg-card p-4 text-xs">
      <h2 className="text-muted-foreground text-[10.5px] uppercase tracking-[0.08em]">Photo share link</h2>

      {link ? (
        <>
          <p className="text-[11px] text-muted-foreground">
            Grants photo access to this request for about 180 days, without a StockPilot account. Revocable at
            any time.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void copyUrl()}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy URL'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
              Revoke
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Expires {new Date(link.expiresAt).toLocaleDateString()}.
          </p>
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          No active share link. One is created automatically once this request has photos and share links are
          enabled for this organization.
        </p>
      )}

      <DestructiveConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Revoke this share link?"
        description="The link stops granting photo access immediately. StockPilot may mint a new link automatically the next time this request needs one for an email."
        confirmLabel="Revoke link"
        pending={revoking}
        onConfirm={() => void revoke()}
      />
    </section>
  );
}
