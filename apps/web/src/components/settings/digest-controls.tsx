'use client';

import { Loader2, Mail } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  sendDigestPreviewAction,
  setDigestOptinAction,
} from '@/server/actions/digest';
import { cn } from '@/lib/utils';

interface DigestControlsProps {
  initialOptIn: boolean;
}

export function DigestControls({ initialOptIn }: DigestControlsProps) {
  const router = useRouter();
  const [optIn, setOptIn] = React.useState(initialOptIn);
  const [savingToggle, setSavingToggle] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);

  async function toggle(next: boolean) {
    setSavingToggle(true);
    setOptIn(next); // optimistic
    const res = await setDigestOptinAction(next);
    setSavingToggle(false);
    if (!res.ok) {
      setOptIn(!next); // revert
      toast.error(res.error.message);
      return;
    }
    toast.success(next ? 'Subscribed to weekly digest' : 'Unsubscribed from weekly digest');
    router.refresh();
  }

  async function preview() {
    setPreviewing(true);
    const res = await sendDigestPreviewAction();
    setPreviewing(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Preview sent to ${res.data.sentTo}`);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1">
          <div className="text-sm font-medium">Email me a weekly inventory digest</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Sent every Monday morning. Includes low / out of stock items, open
            purchase orders, and cycle counts in progress. We skip the email
            entirely on weeks where nothing needs your attention.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={optIn}
          aria-label="Toggle weekly digest"
          onClick={() => !savingToggle && toggle(!optIn)}
          disabled={savingToggle}
          className={cn(
            'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
            optIn ? 'bg-primary' : 'bg-muted',
            savingToggle && 'opacity-60',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'inline-block h-5 w-5 rounded-full bg-background shadow-sm transition-transform',
              optIn ? 'translate-x-[22px]' : 'translate-x-[2px]',
            )}
          />
        </button>
      </div>

      <div className="border-t border-border pt-4">
        <div className="text-sm font-medium">Preview the digest now</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Sends the latest digest content to your email immediately, regardless
          of opt-in state. Useful for verifying it lands in your inbox without
          waiting until Monday.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={preview}
          disabled={previewing}
          className="mt-3"
        >
          {previewing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Mail className="h-3.5 w-3.5" />
          )}
          {previewing ? 'Sending…' : 'Send preview now'}
        </Button>
      </div>
    </div>
  );
}
