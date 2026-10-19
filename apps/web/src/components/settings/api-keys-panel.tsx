'use client';

import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { SettingsPanel } from '@/components/settings/settings-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useHydrated } from '@/lib/use-hydrated';
import { createApiKeyAction, revokeApiKeyAction } from '@/server/actions/api-keys';

// Read scopes that have live endpoints. (inventory:write exists in the scope
// enum but has no endpoint yet, so it's not offered.)
const SCOPES: ReadonlyArray<readonly [string, string]> = [
  ['inventory:read', 'Read inventory'],
  ['orders:read', 'Read orders'],
  ['purchase_orders:read', 'Read purchase orders'],
  ['webhooks:manage', 'Manage automation webhooks (Zapier / Make / n8n)'],
];

export interface PanelApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function ApiKeysPanel({ apiKeys }: { apiKeys: PanelApiKey[] }) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set(['inventory:read']));
  const [busy, setBusy] = React.useState(false);
  const [newKey, setNewKey] = React.useState<string | null>(null);
  // "last used" is a day in the viewer's zone; the server's zone (UTC) would
  // print the next day for an evening call (React error #418). Printed once
  // hydrated.
  const hydrated = useHydrated();

  const toggle = (s: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  async function create() {
    if (!name.trim() || selected.size === 0) {
      toast.error('Name the key and pick at least one scope.');
      return;
    }
    setBusy(true);
    const res = await createApiKeyAction({ name: name.trim(), scopes: [...selected] });
    setBusy(false);
    if (!res.ok) return toast.error(res.error.message);
    setNewKey(res.data.key);
    setName('');
    setSelected(new Set(['inventory:read']));
    setAdding(false);
    router.refresh();
  }

  async function revoke(id: string) {
    if (!window.confirm('Revoke this key? Any integration using it will immediately stop working.'))
      return;
    const res = await revokeApiKeyAction(id);
    if (!res.ok) return toast.error(res.error.message);
    toast.success('Key revoked.');
    router.refresh();
  }

  return (
    <SettingsPanel
      title={
        <span className="flex items-center gap-2">
          <KeyRound aria-hidden className="text-muted-foreground h-4 w-4" />
          API keys
        </span>
      }
      description={
        <>
          Let other software read your StockPilot data over the public API. Send the key as
          <code className="bg-sunk mx-1 rounded px-1 py-0.5 font-mono text-[11.5px]">
            Authorization: Bearer sk_live_…
          </code>
          to <code className="font-mono text-[11.5px]">/api/public/v1/…</code>.
        </>
      }
      aside={
        !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            New key
          </Button>
        )
      }
      bodyClassName="space-y-4"
    >
      {newKey && (
        <div className="bg-sunk rounded-lg border p-3">
          <p className="text-[13px] font-medium">
            Your new API key — copy it now, it won&apos;t be shown again
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bg-card min-w-0 flex-1 overflow-x-auto rounded-md border px-2 py-1.5 font-mono text-[12px]">
              {newKey}
            </code>
            <Button
              size="icon"
              variant="outline"
              aria-label="Copy API key"
              onClick={() => {
                void navigator.clipboard?.writeText(newKey);
                toast.success('Copied');
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNewKey(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {adding && (
        <div className="space-y-4 rounded-lg border p-4">
          <div className="space-y-1.5">
            <Label htmlFor="ak-name">Key name</Label>
            <Input
              id="ak-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Zapier, internal dashboard"
              maxLength={80}
            />
          </div>
          <div role="group" aria-labelledby="ak-scopes-label">
            <Label id="ak-scopes-label">Scopes</Label>
            <div className="mt-1.5 flex flex-col items-start gap-2">
              {SCOPES.map(([value, label]) => (
                <Checkbox
                  key={value}
                  checked={selected.has(value)}
                  onCheckedChange={() => toggle(value)}
                  className="flex-wrap text-[13px]"
                >
                  {label}{' '}
                  <code className="text-muted-foreground font-mono text-[11.5px]">{value}</code>
                </Checkbox>
              ))}
            </div>
          </div>
          {/* 8 px apart: the small buttons' 44 px touch areas (coarse
              pointers) must not overlap. */}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={create} disabled={busy}>
              {busy ? 'Creating…' : 'Create key'}
            </Button>
          </div>
        </div>
      )}

      {apiKeys.length === 0 && !adding ? (
        <p className="text-muted-foreground text-[13px]">No API keys yet.</p>
      ) : apiKeys.length > 0 ? (
        <ul className="divide-border divide-y rounded-lg border">
          {apiKeys.map((k) => (
            <li
              key={k.id}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{k.name}</span>
                  {k.revokedAt ? (
                    <Badge variant="destructive" dot>
                      Revoked
                    </Badge>
                  ) : (
                    <Badge variant="success" dot>
                      Active
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground mt-1 font-mono text-[12px] [overflow-wrap:anywhere]">
                  {k.keyPrefix}…··· · {k.scopes.join(', ')}
                  {k.lastUsedAt
                    ? hydrated
                      ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                      : null
                    : ' · never used'}
                </div>
              </div>
              {!k.revokedAt && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => void revoke(k.id)}
                  title="Revoke"
                  aria-label={`Revoke ${k.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsPanel>
  );
}
