'use client';

import { Loader2, Mail } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  sendDigestPreviewAction,
  setDigestPrefsAction,
} from '@/server/actions/digest';
import { cn } from '@/lib/utils';

interface SectionFlags {
  lowStock: boolean;
  openPos: boolean;
  cycleCounts: boolean;
}

interface DigestControlsProps {
  initialOptIn: boolean;
  initialSections: SectionFlags;
}

const SECTION_DEFS: Array<{
  key: keyof SectionFlags;
  label: string;
  hint: string;
}> = [
  {
    key: 'lowStock',
    label: 'Low / out of stock',
    hint: 'Items at or below reorder point, grouped by warehouse.',
  },
  {
    key: 'openPos',
    label: 'Open purchase orders',
    hint: 'Ordered, expected, or partially received POs. Overdue ones are flagged.',
  },
  {
    key: 'cycleCounts',
    label: 'Cycle counts in progress',
    hint: 'Open count sessions with progress %.',
  },
];

export function DigestControls({ initialOptIn, initialSections }: DigestControlsProps) {
  const router = useRouter();
  const [optIn, setOptIn] = React.useState(initialOptIn);
  const [sections, setSections] = React.useState<SectionFlags>(initialSections);
  const [savingToggle, setSavingToggle] = React.useState(false);
  const [savingSection, setSavingSection] = React.useState<keyof SectionFlags | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  const noSectionsOn =
    !sections.lowStock && !sections.openPos && !sections.cycleCounts;

  async function toggleMaster(next: boolean) {
    setSavingToggle(true);
    setOptIn(next); // optimistic
    const res = await setDigestPrefsAction({ optIn: next });
    setSavingToggle(false);
    if (!res.ok) {
      setOptIn(!next); // revert
      toast.error(res.error.message);
      return;
    }
    toast.success(next ? 'Subscribed to the weekly digest.' : 'Unsubscribed from the weekly digest.');
    router.refresh();
  }

  async function toggleSection(key: keyof SectionFlags, next: boolean) {
    setSavingSection(key);
    setSections((prev) => ({ ...prev, [key]: next })); // optimistic
    const res = await setDigestPrefsAction({ [key]: next });
    setSavingSection(null);
    if (!res.ok) {
      setSections((prev) => ({ ...prev, [key]: !next })); // revert
      toast.error(res.error.message);
      return;
    }
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
    toast.success(`Digest preview sent to "${res.data.sentTo}".`);
  }

  return (
    <div className="space-y-6">
      {/* Master toggle */}
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1">
          <div className="text-sm font-medium">Email me a weekly inventory digest</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Sent every Monday morning. We skip the email entirely on weeks
            where every section you've opted into is empty.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={optIn}
          aria-label="Toggle weekly digest"
          onClick={() => !savingToggle && toggleMaster(!optIn)}
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

      {/* Per-section sub-toggles, visible only when master is on */}
      {optIn && (
        <div className="border-l-2 border-border pl-4 space-y-3">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Sections to include
          </div>
          {SECTION_DEFS.map(({ key, label, hint }) => {
            const checked = sections[key];
            const busy = savingSection === key;
            return (
              <label
                key={key}
                className={cn(
                  'flex items-start gap-3 cursor-pointer',
                  busy && 'opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => !busy && toggleSection(key, e.target.checked)}
                  disabled={busy}
                  className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground">{hint}</div>
                </div>
              </label>
            );
          })}
          {noSectionsOn && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              All sections off — you won't receive any digest emails until
              you turn at least one back on.
            </p>
          )}
        </div>
      )}

      {/* Preview button */}
      <div className="border-t border-border pt-4">
        <div className="text-sm font-medium">Preview the digest now</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Sends the latest digest content to your email immediately, honoring
          your section choices. Bypasses the empty-skip rule, so you'll get
          the email even when nothing's flagged (renders an "all clear"
          panel).
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
