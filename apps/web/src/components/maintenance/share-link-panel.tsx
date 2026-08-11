'use client';

import { Check, Copy, Link2, Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  issueMaintenanceShareLinkAction,
  revokeMaintenanceShareLinkAction,
} from '@/server/actions/maintenance-requests';

import { useMaintenanceShareLink } from './share-link-context';

export interface MaintenanceShareLinkStatus {
  expiresAt: string;
}

interface Props {
  requestId: string;
  /** Whether the request currently HAS an active share link (and when it
   *  expires), resolved server-side without any token material —
   *  MaintenanceShareLinksService.getActiveLinkStatus. Null covers every
   *  reason there isn't one (never generated, revoked, expired, org
   *  disabled). Since mig 0330 the URL itself is hashed at rest and NOT
   *  re-displayable: this panel only ever shows a URL it generated itself
   *  this session (show-once), and Generate/Regenerate is the only way to
   *  obtain one. */
  status: MaintenanceShareLinkStatus | null;
  /**
   * Fix wave Important 2: `issueLink` (maintenance-share-links.ts)
   * deliberately admits the OWNING REQUESTER (submit + owns the request),
   * not just a manage-holder — so the page mounts this panel for both
   * personas. But `revoke()` on that same service stays genuinely
   * manage-only. Passing `canRevoke={false}` hides the Revoke button AND
   * never mounts its confirm dialog at all, rather than showing a control
   * that would only ever come back 403 for a non-manager owner.
   */
  canRevoke: boolean;
}

/**
 * Mounted for a manage-holder (Generate/Regenerate + Revoke) OR the
 * request's owning requester (Generate/Regenerate only, `canRevoke=false`)
 * — never for anyone else. The caller (`[id]/page.tsx`) decides who ever
 * reaches this component at all.
 *
 * Show-once (mig 0330): the raw token is hashed at rest, so the URL is
 * displayable ONLY in the moment it is generated. Copy writes the URL from
 * client state straight into the clipboard via JS; the token is never
 * placed into a text node, title, tooltip, or data attribute anywhere in
 * this component (fix-wave finding — the token appearing in page HTML is a
 * real, already-accepted exposure ONLY where the token functionally has to
 * be, e.g. inside the actual mailto/Outlook compose links elsewhere in
 * this feature; this panel deliberately does not add a second place it
 * leaks).
 */
export function ShareLinkPanel({ requestId, status, canRevoke }: Props) {
  const router = useRouter();
  // Local state OWNS the freshly-generated URL (the panel must work even
  // without a provider); the context set below is a side-channel that lets
  // MaintenanceEmailAction fold the same URL into compose drafts when the
  // page mounts both under MaintenanceShareLinkProvider.
  const { setGeneratedUrl: publishGeneratedUrl } = useMaintenanceShareLink();
  const [generatedUrl, setGeneratedUrlState] = React.useState<string | null>(null);
  const setGeneratedUrl = React.useCallback(
    (url: string | null) => {
      setGeneratedUrlState(url);
      publishGeneratedUrl(url);
    },
    [publishGeneratedUrl],
  );
  const [generatedExpiresAt, setGeneratedExpiresAt] = React.useState<string | null>(null);
  const [generating, setGenerating] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);

  // A link exists if the server said so, or we just generated one.
  const hasActiveLink = generatedUrl !== null || status !== null;
  const expiresAt = generatedExpiresAt ?? status?.expiresAt ?? null;

  async function generate() {
    setGenerating(true);
    const res = await issueMaintenanceShareLinkAction(requestId);
    setGenerating(false);
    if ('error' in res) {
      toast.error(res.error.message);
      return;
    }
    setGeneratedUrl(res.url);
    setGeneratedExpiresAt(res.expiresAt);
    setCopied(false);
    router.refresh();
  }

  async function copyUrl() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
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
    // The revoked link may be the one we just generated — its URL is dead
    // now, so stop offering to copy it (and stop folding it into drafts).
    setGeneratedUrl(null);
    setGeneratedExpiresAt(null);
    toast.success('Share link revoked.');
    router.refresh();
  }

  return (
    <section aria-label="Photo share link" className="space-y-2 rounded-xl border bg-card p-4 text-xs">
      <h2 className="text-muted-foreground text-[10.5px] uppercase tracking-[0.08em]">Photo share link</h2>

      <p className="text-[11px] text-muted-foreground">
        Grants photo access to this request for about 180 days, without a StockPilot account. Revocable at
        any time.
      </p>

      {generatedUrl ? (
        <p className="text-[11px] font-medium">
          Link generated — copy it now. For security it is shown only this once; generating again replaces
          it.
        </p>
      ) : hasActiveLink ? (
        <p className="text-[11px] text-muted-foreground">
          An active share link exists. Its URL is not stored and cannot be shown again — generate a new
          link to get a copyable URL (the current one stops working).
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">No active share link.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {generatedUrl ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void copyUrl()}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy URL'}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" disabled={generating} onClick={() => void generate()}>
          {generating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : hasActiveLink ? (
            <RefreshCw className="h-3.5 w-3.5" />
          ) : (
            <Link2 className="h-3.5 w-3.5" />
          )}
          {hasActiveLink ? 'Generate new link' : 'Generate link'}
        </Button>
        {canRevoke && hasActiveLink ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
            Revoke
          </Button>
        ) : null}
      </div>

      {expiresAt ? (
        <p className="text-[11px] text-muted-foreground">
          Expires {new Date(expiresAt).toLocaleDateString()}.
        </p>
      ) : null}

      {canRevoke ? (
        <DestructiveConfirm
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Revoke this share link?"
          description="The link stops granting photo access immediately. Generate a new link whenever this request needs one again."
          confirmLabel="Revoke link"
          pending={revoking}
          onConfirm={() => void revoke()}
        />
      ) : null}
    </section>
  );
}
