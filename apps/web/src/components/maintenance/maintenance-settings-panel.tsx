'use client';

import { Loader2, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { updateMaintenanceSettingsAction } from '@/server/actions/maintenance-settings';

import { L4L_MAINTENANCE_EMAIL } from '@stockpilot/core';

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
 * links there. Recipients (L4L_MAINTENANCE_EMAIL) are rendered read-only —
 * there is no input for them anywhere in this component, on purpose.
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
  const [audience, setAudience] = React.useState<Record<string, MaintenanceNotifyMode>>(
    initialNotifyAudience,
  );
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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Categories</CardTitle>
          <CardDescription>
            Shown on the maintenance request form. Falls back to the default list when none are
            configured.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <li
                key={c}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-sm"
              >
                {c}
                <button
                  type="button"
                  onClick={() => removeCategory(c)}
                  aria-label={`Remove ${c}`}
                  disabled={busy}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-50"
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
            <Button type="button" variant="outline" size="sm" onClick={addCategory} disabled={busy}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Photo links in email</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={includeShareLinksInEmail}
              onChange={(e) => setIncludeShareLinksInEmail(e.target.checked)}
              disabled={busy}
              aria-label="Include a secure photo link in the generated email"
            />
            Include a secure photo link in the generated email
          </label>
          <p className="text-muted-foreground text-xs">
            When off, the email lists the photo count but carries no link.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notification audience</CardTitle>
          <CardDescription>
            Choose which accounts are notified when a maintenance request is saved.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other members in this organization yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-sm">{m.name}</span>
                  <Select
                    value={audience[m.userId] ?? 'none'}
                    onValueChange={(v) =>
                      setAudience((prev) => ({ ...prev, [m.userId]: v as MaintenanceNotifyMode }))
                    }
                    disabled={busy}
                  >
                    <SelectTrigger className="w-44" aria-label={`Notification audience for ${m.name}`}>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Access</CardTitle>
          <CardDescription>
            Granting access to individual accounts happens on the Roles &amp; permissions page —
            not here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/dashboard/settings/roles"
            className="text-sm font-medium text-[hsl(var(--accent))] hover:underline"
          >
            Manage who can view or manage all requests
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recipients</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            <span className="text-muted-foreground">To: </span>
            {L4L_MAINTENANCE_EMAIL.to}
          </p>
          <p>
            <span className="text-muted-foreground">CC: </span>
            {L4L_MAINTENANCE_EMAIL.cc}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Recipients are fixed in this release. Contact support to change them.
          </p>
        </CardContent>
      </Card>

      <Button onClick={() => void save()} disabled={busy}>
        {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
        Save settings
      </Button>
    </div>
  );
}
