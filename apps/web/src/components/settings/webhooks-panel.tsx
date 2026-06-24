'use client';

import { Check, Copy, Plus, Send, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  createIntegrationEndpointAction,
  deleteIntegrationEndpointAction,
  setIntegrationEndpointEnabledAction,
  testIntegrationEndpointAction,
} from '@/server/actions/integration-endpoints';

// Only events wired at their emit sites are offered, so nobody subscribes to an
// event that never fires. The full order/PO/return lifecycle + the security
// feed are all dispatched today.
const EVENTS: ReadonlyArray<readonly [string, string]> = [
  // Orders lifecycle
  ['order.created', 'New order'],
  ['order.approved', 'Order approved'],
  ['order.denied', 'Order denied'],
  ['order.status_changed', 'Order status changed'],
  ['order.in_transit', 'Order in transit'],
  ['order.completed', 'Order completed'],
  ['order.cancelled', 'Order cancelled'],
  // Purchase orders lifecycle
  ['po.created', 'New purchase order'],
  ['po.updated', 'Purchase order updated'],
  ['po.received', 'PO received'],
  ['po.cancelled', 'PO cancelled'],
  // Returns lifecycle
  ['return.created', 'Return started'],
  ['return.approved', 'Return approved'],
  ['return.denied', 'Return denied'],
  ['return.closed', 'Return closed'],
  // Inventory
  ['stock.low', 'Low stock'],
  ['cycle_count.completed', 'Cycle count complete'],
  // Security feed — point these at a #security Slack channel for live
  // monitoring of forensic-relevant account/credential events.
  ['security.new_device_login', 'Security: new device sign-in'],
  ['security.mfa_unenrolled', 'Security: MFA disabled'],
  ['security.mfa_policy_changed', 'Security: MFA policy changed'],
  ['security.api_key_created', 'Security: API key created'],
  ['security.api_key_revoked', 'Security: API key revoked'],
  ['security.member_role_changed', 'Security: member role changed'],
  ['security.export_rate_limited', 'Security: export rate limit tripped'],
];

type EndpointType = 'webhook' | 'slack' | 'teams';

export interface PanelEndpoint {
  id: string;
  type: EndpointType;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  description: string | null;
  lastDeliveryAt: string | null;
  lastStatus: string | null;
  hasSecret: boolean;
}

const TYPE_LABEL: Record<EndpointType, string> = {
  webhook: 'Webhook',
  slack: 'Slack',
  teams: 'Teams',
};

export function WebhooksPanel({ endpoints }: { endpoints: PanelEndpoint[] }) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [type, setType] = React.useState<EndpointType>('slack');
  const [url, setUrl] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set(['order.created']));
  const [busy, setBusy] = React.useState(false);
  const [newSecret, setNewSecret] = React.useState<string | null>(null);

  const toggleEvent = (e: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });

  async function add() {
    if (!url.trim() || selected.size === 0) {
      toast.error('Add a URL and pick at least one event.');
      return;
    }
    setBusy(true);
    const res = await createIntegrationEndpointAction({
      type,
      url: url.trim(),
      eventTypes: [...selected],
      description: description.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Endpoint added.');
    if (res.data.secret) setNewSecret(res.data.secret);
    setUrl('');
    setDescription('');
    setSelected(new Set(['order.created']));
    setAdding(false);
    router.refresh();
  }

  async function test(id: string) {
    const res = await testIntegrationEndpointAction(id);
    if (!res.ok) return toast.error(res.error.message);
    if (res.data.ok) toast.success('Test delivered — check the destination.');
    else toast.error(`Test failed: ${res.data.error ?? `HTTP ${res.data.status}`}`);
  }

  async function toggleEnabled(ep: PanelEndpoint) {
    const res = await setIntegrationEndpointEnabledAction(ep.id, !ep.enabled);
    if (!res.ok) return toast.error(res.error.message);
    router.refresh();
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this endpoint? Events will stop being delivered to it.')) return;
    const res = await deleteIntegrationEndpointAction(id);
    if (!res.ok) return toast.error(res.error.message);
    toast.success('Endpoint deleted.');
    router.refresh();
  }

  return (
    <section className="border-border bg-card mt-8 rounded-xl border p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Webhooks &amp; alerts</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Get notified in Slack or Microsoft Teams, or send signed webhooks to your own
            systems, when things happen in StockPilot.
          </p>
        </div>
        {!adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add endpoint
          </Button>
        )}
      </div>

      {/* Secret shown once after creating a webhook */}
      {newSecret && (
        <div className="border-border bg-muted/40 mt-4 rounded-lg border p-3">
          <p className="text-sm font-medium">Signing secret — copy it now, it won&apos;t be shown again</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bg-background flex-1 overflow-x-auto rounded border px-2 py-1.5 font-mono text-xs">
              {newSecret}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(newSecret);
                toast.success('Copied');
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNewSecret(null)}>
              <Check className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            We sign each webhook <code>X-StockPilot-Signature: t=&lt;ts&gt;,v1=&lt;hmac&gt;</code> —
            HMAC-SHA256 of <code>&lt;ts&gt;.&lt;body&gt;</code> with this secret.
          </p>
        </div>
      )}

      {/* Add form */}
      {adding && (
        <div className="border-border mt-4 space-y-4 rounded-lg border p-4">
          <div>
            <Label>Destination</Label>
            <div className="mt-1 flex gap-2">
              {(['slack', 'teams', 'webhook'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={
                    'rounded-full border px-3 py-1 text-sm transition-colors ' +
                    (type === t
                      ? 'border-primary bg-foreground text-background'
                      : 'border-border text-muted-foreground hover:bg-muted')
                  }
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label htmlFor="wh-url">
              {type === 'slack'
                ? 'Slack incoming webhook URL'
                : type === 'teams'
                  ? 'Teams incoming webhook URL'
                  : 'Webhook URL (https)'}
            </Label>
            <Input
              id="wh-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <Label>Send these events</Label>
            <div className="mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {EVENTS.map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(value)}
                    onChange={() => toggleEvent(value)}
                    className="h-4 w-4"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div>
            <Label htmlFor="wh-desc">Label (optional)</Label>
            <Input
              id="wh-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. #ops-alerts"
              maxLength={200}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={add} disabled={busy}>
              {busy ? 'Adding…' : 'Add endpoint'}
            </Button>
          </div>
        </div>
      )}

      {/* List */}
      <div className="mt-4 space-y-2">
        {endpoints.length === 0 && !adding ? (
          <p className="text-muted-foreground text-sm">No endpoints yet.</p>
        ) : (
          endpoints.map((ep) => (
            <div
              key={ep.id}
              className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant={ep.enabled ? 'success' : 'outline'}>{TYPE_LABEL[ep.type]}</Badge>
                  <span className="text-muted-foreground truncate font-mono text-xs">{ep.url}</span>
                </div>
                <div className="text-muted-foreground mt-1 text-xs">
                  {ep.eventTypes.length} event{ep.eventTypes.length === 1 ? '' : 's'}
                  {ep.description ? ` · ${ep.description}` : ''}
                  {ep.lastStatus ? ` · last: ${ep.lastStatus}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => void test(ep.id)} title="Send test">
                  <Send className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void toggleEnabled(ep)}>
                  {ep.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void remove(ep.id)}
                  title="Delete"
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
