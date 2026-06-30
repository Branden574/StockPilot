'use client';

import { ExternalLink, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { setZendeskSubdomainAction } from '@/server/actions/zendesk';

/**
 * "Open your Zendesk" launchpad — the no-API / SSO path for managed Zendesk
 * accounts that can't issue API credentials. We can't embed the agent UI inline
 * (Zendesk sends `X-Frame-Options: SAMEORIGIN`), so this opens the real Zendesk
 * in a new tab where the user is already signed in via SSO. Admins set the
 * org's subdomain here (no token required).
 */
export function ZendeskQuickAccess({
  subdomain,
  canManage,
}: {
  subdomain: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState(subdomain ?? '');
  const [saving, setSaving] = React.useState(false);

  const agentUrl = subdomain ? `https://${subdomain}.zendesk.com/agent` : null;

  async function save() {
    const next = value.trim();
    if (!next || saving) return;
    setSaving(true);
    const res = await setZendeskSubdomainAction({ subdomain: next });
    setSaving(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Zendesk subdomain saved.');
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {agentUrl ? (
        <a
          href={agentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium"
        >
          Open my Zendesk
          <ExternalLink className="h-4 w-4" />
        </a>
      ) : (
        <p className="text-muted-foreground text-sm">
          No Zendesk subdomain set yet{canManage ? ' — add it below.' : '. Ask an admin to set it.'}
        </p>
      )}

      {canManage ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="text-muted-foreground text-xs">Your Zendesk subdomain</span>
            <span className="mt-1 flex items-center">
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="learn4life"
                className="border-border bg-background w-44 rounded-l-md border px-3 py-2 text-sm outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save();
                }}
              />
              <span className="border-border bg-muted text-muted-foreground rounded-r-md border border-l-0 px-2 py-2 text-sm">
                .zendesk.com
              </span>
            </span>
          </label>
          <Button onClick={() => void save()} disabled={saving || !value.trim()} size="sm">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </Button>
        </div>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Opens your real Zendesk in a new tab — you stay signed in with your normal
        Zendesk login (SSO). No API key or admin setup needed.
      </p>
    </div>
  );
}
