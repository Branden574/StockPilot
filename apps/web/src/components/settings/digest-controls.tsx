'use client';

import { Loader2, Mail, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { sendDigestPreviewAction, setDigestPrefsAction } from '@/server/actions/digest';

interface SectionFlags {
  lowStock: boolean;
  openPos: boolean;
  cycleCounts: boolean;
}

interface DigestControlsProps {
  initialOptIn: boolean;
  initialSections: SectionFlags;
  /** When the digest is sent, in the organization's zone, as its email
   *  footer says it: "Mondays at 7:00 AM PDT" (digestScheduleLabel, worked
   *  out by the page on the server). */
  scheduleLabel: string;
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

export function DigestControls({
  initialOptIn,
  initialSections,
  scheduleLabel,
}: DigestControlsProps) {
  const router = useRouter();
  const [optIn, setOptIn] = React.useState(initialOptIn);
  const [sections, setSections] = React.useState<SectionFlags>(initialSections);
  const [savingToggle, setSavingToggle] = React.useState(false);
  const [savingSection, setSavingSection] = React.useState<keyof SectionFlags | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  const noSectionsOn = !sections.lowStock && !sections.openPos && !sections.cycleCounts;

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
    toast.success(
      next ? 'Subscribed to the weekly digest.' : 'Unsubscribed from the weekly digest.',
    );
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
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">Email me a weekly inventory digest</div>
          <p className="text-muted-foreground mt-1 text-[12.5px]">
            Sent {scheduleLabel}, in your workspace's time zone. It covers only the warehouses,
            items and purchase orders you can see in StockPilot. We skip the email entirely on weeks
            where every section you've opted into is empty.
          </p>
        </div>
        <Switch
          checked={optIn}
          label="Toggle weekly digest"
          pending={savingToggle}
          onCheckedChange={(next) => void toggleMaster(next)}
          className="mt-0.5"
        />
      </div>

      {/* Per-section sub-toggles, visible only when master is on */}
      {optIn && (
        <div className="border-border space-y-3 border-l-2 pl-4">
          <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
            Sections to include
          </div>
          {SECTION_DEFS.map(({ key, label, hint }) => {
            const checked = sections[key];
            const busy = savingSection === key;
            return (
              <Checkbox
                key={key}
                checked={checked}
                aria-busy={busy || undefined}
                disabled={busy}
                onCheckedChange={(next) => {
                  if (!busy) void toggleSection(key, next);
                }}
                className="flex w-full items-start gap-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">{label}</span>
                  <span className="text-muted-foreground block text-[12.5px] font-normal">
                    {hint}
                  </span>
                </span>
              </Checkbox>
            );
          })}
          {noSectionsOn && (
            <p className="text-warning flex items-start gap-1.5 text-[12.5px]">
              <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                All sections off — you won't receive any digest emails until you turn at least one
                back on.
              </span>
            </p>
          )}
        </div>
      )}

      {/* Preview button */}
      <div className="border-border border-t pt-4">
        <div className="text-[13.5px] font-medium">Preview the digest now</div>
        <p className="text-muted-foreground mt-1 text-[12.5px]">
          Sends the latest digest content to your email immediately, honoring your section choices.
          Bypasses the empty-skip rule, so you'll get the email even when nothing's flagged (renders
          an "all clear" panel).
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
