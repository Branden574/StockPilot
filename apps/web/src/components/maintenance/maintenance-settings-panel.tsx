'use client';

import { Loader2, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { touchTargetClass } from '@/components/patterns/touch-target';
import { SettingsPanel } from '@/components/settings/settings-panel';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { updateMaintenanceSettingsAction } from '@/server/actions/maintenance-settings';

export type MaintenanceNotifyMode = 'all' | 'urgent_only' | 'none';

export interface MaintenanceSettingsMember {
  userId: string;
  name: string;
}

interface Props {
  initialCategories: string[];
  initialIncludeShareLinksInEmail: boolean;
  initialNotifyAudience: Record<string, MaintenanceNotifyMode>;
  /** Accepted org members — the rows of the notification-audience map.
   *  Individual read_all/manage GRANTS are never made here; that flows
   *  entirely through /dashboard/settings/roles (see the Access card below). */
  members: MaintenanceSettingsMember[];
}

const NOTIFY_OPTIONS: Array<{ value: MaintenanceNotifyMode; label: string }> = [
  { value: 'all', label: 'All new requests' },
  { value: 'urgent_only', label: 'Urgent only' },
  { value: 'none', label: 'None' },
];

/**
 * Owner-only maintenance-request settings (master brief §5/§6/§26): the
 * server action (`updateMaintenanceSettingsAction`) re-gates on
 * `maintenance_requests:configure` — this component never assumes the page's
 * own gate is the only line of defense. Deliberately does NOT build a
 * permissions UI: granting read_all/manage to an individual (Andrew's real
 * grant path) happens entirely on /dashboard/settings/roles's existing
 * per-user-exceptions matrix (role-permission-matrix.tsx); this panel only
 * links there. Recipients are configured per org on
 * /dashboard/settings/email-routing (per-org email routing, migration 0337) —
 * the Recipients card here only links across, and there is no recipient
 * input anywhere in this component, on purpose.
 */
export function MaintenanceSettingsPanel({
  initialCategories,
  initialIncludeShareLinksInEmail,
  initialNotifyAudience,
  members,
}: Props) {
  const router = useRouter();
  const [categories, setCategories] = React.useState<string[]>(initialCategories);
  const [newCategory, setNewCategory] = React.useState('');
  const [includeShareLinksInEmail, setIncludeShareLinksInEmail] = React.useState(
    initialIncludeShareLinksInEmail,
  );
  const [audience, setAudience] =
    React.useState<Record<string, MaintenanceNotifyMode>>(initialNotifyAudience);
  const [busy, setBusy] = React.useState(false);

  function addCategory() {
    const trimmed = newCategory.trim();
    if (!trimmed) return;
    if (categories.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      toast.error('That category already exists.');
      return;
    }
    setCategories((prev) => [...prev, trimmed]);
    setNewCategory('');
  }

  function removeCategory(name: string) {
    if (categories.length <= 1) {
      toast.error('Keep at least one category.');
      return;
    }
    setCategories((prev) => prev.filter((c) => c !== name));
  }

  async function save() {
    setBusy(true);
    const res = await updateMaintenanceSettingsAction({
      categories,
      includeShareLinksInEmail,
      notifyAudience: audience,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Maintenance settings saved.');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsPanel
        title="Categories"
        description="Shown on the maintenance request form. Falls back to the default list when none are configured."
        bodyClassName="space-y-3"
      >
        {/* 12 px apart: each remove button's 44 px touch area (coarse
            pointers) must not reach the next chip's. */}
        <ul className="flex flex-wrap gap-3">
          {categories.map((c) => (
            <li
              key={c}
              className="bg-sunk inline-flex h-7 items-center gap-1 rounded-full border border-[var(--ed-line-strong)] pl-2.5 pr-1 text-[12.5px]"
            >
              {c}
              <button
                type="button"
                onClick={() => removeCategory(c)}
                aria-label={`Remove ${c}`}
                disabled={busy}
                className={cn(
                  'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-grid size-5 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50',
                  touchTargetClass,
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex max-w-sm items-center gap-2">
          <Input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="Add a category"
            maxLength={80}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCategory();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addCategory} disabled={busy}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </SettingsPanel>

      <SettingsPanel title="Photo links in email" bodyClassName="space-y-1.5">
        <Checkbox
          checked={includeShareLinksInEmail}
          onCheckedChange={setIncludeShareLinksInEmail}
          disabled={busy}
          label="Include a secure photo link in the generated email"
          className="text-[13.5px] font-medium"
        >
          Include a secure photo link in the generated email
        </Checkbox>
        <p className="text-muted-foreground pl-7 text-[12.5px]">
          When off, the email lists the photo count but carries no link.
        </p>
      </SettingsPanel>

      <SettingsPanel
        title="Notification audience"
        description="Choose which accounts are notified when a maintenance request is saved."
        flush
      >
        {members.length === 0 ? (
          <p className="text-muted-foreground px-[18px] py-4 text-[13px]">
            No other members in this organization yet.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {members.map((m) => (
              <li
                key={m.userId}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-[18px] py-2.5"
              >
                <span className="min-w-0 text-[13.5px] [overflow-wrap:anywhere]">{m.name}</span>
                <Select
                  value={audience[m.userId] ?? 'none'}
                  onValueChange={(v) =>
                    setAudience((prev) => ({ ...prev, [m.userId]: v as MaintenanceNotifyMode }))
                  }
                  disabled={busy}
                >
                  <SelectTrigger
                    className="w-44"
                    aria-label={`Notification audience for ${m.name}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {NOTIFY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        )}
      </SettingsPanel>

      <SettingsPanel
        title="Access"
        description={
          <>
            Granting access to individual accounts happens on the Roles &amp; permissions page — not
            here.
          </>
        }
      >
        <Link
          href="/dashboard/settings/roles"
          className="text-accent hover:text-foreground text-[13px] font-medium transition-colors hover:underline"
        >
          Manage who can view or manage all requests
        </Link>
      </SettingsPanel>

      <SettingsPanel
        title="Recipients"
        description="Where maintenance-request emails are addressed is configured per organization on the Email routing page."
      >
        {/* This card used to print one tenant's compiled mailboxes to every
            org's admins with "Recipients are fixed in this release. Contact
            support to change them." — per-org email routing (migration
            0337) IS that support path, so the fixed display is gone. */}
        <Link
          href="/dashboard/settings/email-routing"
          className="text-accent hover:text-foreground text-[13px] font-medium transition-colors hover:underline"
        >
          Configure email routing
        </Link>
      </SettingsPanel>

      <div>
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          Save settings
        </Button>
      </div>
    </div>
  );
}
