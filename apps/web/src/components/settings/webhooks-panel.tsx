'use client';

import { Check, Copy, Plus, Send, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { FilterChip } from '@/components/patterns/chip';
import { SettingsPanel } from '@/components/settings/settings-nav';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  ['return.received', 'Return received'],
  ['return.cancelled', 'Return cancelled'],
  ['return.exchange_approved', 'Exchange approved'],
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
    <SettingsPanel
      title={<>Webhooks &amp; alerts</>}
      description="Get notified in Slack or Microsoft Teams, or send signed webhooks to your own systems, when things happen in StockPilot."
      aside={
        !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            Add endpoint
          </Button>
        )
      }
      bodyClassName="space-y-4"
    >
      {/* Secret shown once after creating a webhook */}
      {newSecret && (
        <div className="bg-sunk rounded-lg border p-3">
          <p className="text-[13px] font-medium">
            Signing secret — copy it now, it won&apos;t be shown again
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bg-card min-w-0 flex-1 overflow-x-auto rounded-md border px-2 py-1.5 font-mono text-[12px]">
              {newSecret}
            </code>
            <Button
              size="icon"
              variant="outline"
              aria-label="Copy signing secret"
              onClick={() => {
                void navigator.clipboard?.writeText(newSecret);
                toast.success('Copied');
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Done, hide the signing secret"
              onClick={() => setNewSecret(null)}
            >
              <Check className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-muted-foreground mt-2 text-[12px]">
            We sign each webhook <code>X-StockPilot-Signature: t=&lt;ts&gt;,v1=&lt;hmac&gt;</code> —
            HMAC-SHA256 of <code>&lt;ts&gt;.&lt;body&gt;</code> with this secret.
          </p>
        </div>
      )}

      {/* Add form */}
      {adding && (
        <div className="space-y-4 rounded-lg border p-4">
          <div role="group" aria-labelledby="wh-destination-label">
            <Label id="wh-destination-label">Destination</Label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {(['slack', 'teams', 'webhook'] as const).map((t) => (
                <FilterChip key={t} pressed={type === t} onClick={() => setType(t)}>
                  {TYPE_LABEL[t]}
                </FilterChip>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
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
          <div role="group" aria-labelledby="wh-events-label">
            <Label id="wh-events-label">Send these events</Label>
            <div className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              {EVENTS.map(([value, label]) => (
                <Checkbox
                  key={value}
                  checked={selected.has(value)}
                  onCheckedChange={() => toggleEvent(value)}
                  className="text-[13px]"
                >
                  {label}
                </Checkbox>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
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
      {endpoints.length === 0 && !adding ? (
        <p className="text-muted-foreground text-[13px]">No endpoints yet.</p>
      ) : endpoints.length > 0 ? (
        <ul className="divide-border divide-y rounded-lg border">
          {endpoints.map((ep) => (
            <li
              key={ep.id}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant={ep.enabled ? 'success' : 'outline'} dot>
                    {TYPE_LABEL[ep.type]}
                  </Badge>
                  <span className="text-muted-foreground truncate font-mono text-[12px]">
                    {ep.url}
                  </span>
                </div>
                <div className="text-muted-foreground mt-1 text-[12px]">
                  {ep.eventTypes.length} event{ep.eventTypes.length === 1 ? '' : 's'}
                  {ep.description ? ` · ${ep.description}` : ''}
                  {ep.lastStatus ? ` · last: ${ep.lastStatus}` : ''}
                </div>
              </div>
              {/* 8 px apart: the small buttons' 44 px touch areas (coarse
                  pointers) must not overlap. */}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void test(ep.id)}
                  title="Send test"
                  aria-label={`Send test to ${endpointName(ep)}`}
                >
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
                  aria-label={`Delete ${endpointName(ep)}`}
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsPanel>
  );
}

/** An endpoint's accessible name for its icon buttons (CONFLICTS D17): the
 *  destination and, when set, its label, so each row's buttons say which
 *  endpoint they act on. The full URL is left out (a Slack or Teams URL holds
 *  a credential). */
function endpointName(ep: PanelEndpoint): string {
  return ep.description
    ? `${TYPE_LABEL[ep.type]} endpoint ${ep.description}`
    : `${TYPE_LABEL[ep.type]} endpoint`;
}
