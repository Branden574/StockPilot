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
        <Button asChild>
          <a href={agentUrl} target="_blank" rel="noopener noreferrer">
            Open my Zendesk
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      ) : (
        <p className="text-muted-foreground text-[13.5px]">
          No Zendesk subdomain set yet{canManage ? ' — add it below.' : '. Ask an admin to set it.'}
        </p>
      )}

      {canManage ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[13px]">
            <span className="text-muted-foreground text-[12.5px]">Your Zendesk subdomain</span>
            {/* One field with its fixed suffix, edged with the control border
                the shared Input draws (the plain hairline nearly vanished on
                the dark card). The input itself draws no outline, so the whole
                field shows the focus ring (it had no visible focus at all
                before). */}
            <span className="border-line-strong bg-card focus-within:ring-ring focus-within:ring-offset-background mt-1.5 flex items-stretch overflow-hidden rounded-md border focus-within:ring-2 focus-within:ring-offset-2">
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="yourcompany"
                className="placeholder:text-muted-foreground h-[30px] w-44 min-w-0 bg-transparent px-2.5 text-[13px] outline-none max-sm:h-[42px] max-sm:text-base"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save();
                }}
              />
              <span className="border-border bg-sunk text-muted-foreground flex items-center border-l px-2.5 text-[13px] max-sm:text-base">
                .zendesk.com
              </span>
            </span>
          </label>
          <Button
            variant="outline"
            onClick={() => void save()}
            disabled={saving || !value.trim() || value.trim() === (subdomain ?? '')}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
          </Button>
        </div>
      ) : null}

      <p className="text-muted-foreground text-[12.5px]">
        Opens your real Zendesk in a new tab — you stay signed in with your normal
        Zendesk login (SSO). No API key or admin setup needed.
      </p>
    </div>
  );
}
