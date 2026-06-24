'use client';

import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    <section className="border-border bg-card mt-8 rounded-xl border p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <KeyRound className="h-4 w-4" />
            API keys
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Let other software read your StockPilot data over the public API. Send the key as
            <code className="bg-muted/60 mx-1 rounded px-1 py-0.5 text-xs">
              Authorization: Bearer sk_live_…
            </code>
            to <code className="text-xs">/api/public/v1/…</code>.
          </p>
        </div>
        {!adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            New key
          </Button>
        )}
      </div>

      {newKey && (
        <div className="border-border bg-muted/40 mt-4 rounded-lg border p-3">
          <p className="text-sm font-medium">Your new API key — copy it now, it won&apos;t be shown again</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bg-background flex-1 overflow-x-auto rounded border px-2 py-1.5 font-mono text-xs">
              {newKey}
            </code>
            <Button
              size="sm"
              variant="outline"
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
        <div className="border-border mt-4 space-y-4 rounded-lg border p-4">
          <div>
            <Label htmlFor="ak-name">Key name</Label>
            <Input
              id="ak-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Zapier, internal dashboard"
              maxLength={80}
            />
          </div>
          <div>
            <Label>Scopes</Label>
            <div className="mt-1 space-y-1.5">
              {SCOPES.map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(value)}
                    onChange={() => toggle(value)}
                    className="h-4 w-4"
                  />
                  {label} <code className="text-muted-foreground text-xs">{value}</code>
                </label>
              ))}
            </div>
          </div>
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

      <div className="mt-4 space-y-2">
        {apiKeys.length === 0 && !adding ? (
          <p className="text-muted-foreground text-sm">No API keys yet.</p>
        ) : (
          apiKeys.map((k) => (
            <div
              key={k.id}
              className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{k.name}</span>
                  {k.revokedAt ? (
                    <Badge variant="destructive">Revoked</Badge>
                  ) : (
                    <Badge variant="success">Active</Badge>
                  )}
                </div>
                <div className="text-muted-foreground mt-1 font-mono text-xs">
                  {k.keyPrefix}…··· · {k.scopes.join(', ')}
                  {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : ' · never used'}
                </div>
              </div>
              {!k.revokedAt && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => void revoke(k.id)}
                  title="Revoke"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
