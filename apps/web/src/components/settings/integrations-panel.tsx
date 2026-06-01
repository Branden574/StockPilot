'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  beginConnectAction,
  connectEasyPostAction,
  disconnectAction,
  disconnectEasyPostAction,
  replaySyncAction,
  saveAccountMappingAction,
} from '@/server/actions/connections';

import { CONNECTOR_REGISTRY } from '@stockpilot/core';

type ConnectionStatus = 'pending' | 'active' | 'error' | 'disconnected';

interface SyncHealthRow {
  topic: string;
  status: 'pending' | 'success' | 'error' | 'dead';
  attempts: number;
  externalId: string | null;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
}

/**
 * A failed (dead-lettered or errored) sync row in the operator dead-letter view.
 * Carries the row `id` so the Replay button can re-queue it.
 */
export interface FailedSyncRow {
  id: string;
  topic: string;
  status: 'error' | 'dead';
  attempts: number;
  externalId: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * EasyPost (shipping) connection state. `null` means the EasyPost card is hidden
 * entirely — the shipping module is off for this org or the caller lacks
 * `shipping:manage`. When present, `status` is null until first connected.
 */
export interface EasyPostPanelProps {
  status: ConnectionStatus | null;
  /** 'test' | 'production', inferred from the key prefix. */
  mode: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
}

export interface QuickBooksPanelProps {
  /**
   * Whether to render the QuickBooks cards + recent-sync activity. False hides
   * them entirely — the integrations module is off for this org or the caller
   * lacks `integrations:manage` (e.g. a shipping-only org reaching this page to
   * manage EasyPost). Defaults to shown for back-compat.
   */
  showQuickBooks?: boolean;
  /** Null when no connection row exists yet (never connected). */
  status: ConnectionStatus | null;
  externalAccountId: string | null;
  lastConnectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  accountIds: { billExpense?: string; inventoryAsset?: string; valuationOffset?: string };
  health: SyncHealthRow[];
  /** EasyPost shipping connection; null hides the card. */
  easyPost?: EasyPostPanelProps | null;
  /**
   * Failed (dead-lettered/errored) connector exports for the operator
   * dead-letter view. `null` hides the panel entirely — the caller lacks a
   * manage permission for any enabled integration/shipping module. When present
   * (even empty), the panel renders so an operator sees "no failures" rather
   * than nothing.
   */
  failedSyncs?: FailedSyncRow[] | null;
}

const STATUS_BADGE: Record<
  ConnectionStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  active: { label: 'Connected', variant: 'default' },
  pending: { label: 'Connecting…', variant: 'secondary' },
  error: { label: 'Error', variant: 'destructive' },
  disconnected: { label: 'Disconnected', variant: 'outline' },
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function IntegrationsPanel(props: QuickBooksPanelProps) {
  const meta = CONNECTOR_REGISTRY.quickbooks;
  const showQuickBooks = props.showQuickBooks ?? true;
  const status = props.status;
  const isConnected = status === 'active';
  const badge = status ? STATUS_BADGE[status] : null;

  const [connecting, startConnect] = React.useTransition();
  const [disconnecting, startDisconnect] = React.useTransition();
  const [savingMapping, startSaveMapping] = React.useTransition();

  // Local form state for the account mapping (controlled inputs).
  const [billExpense, setBillExpense] = React.useState(props.accountIds.billExpense ?? '');
  const [inventoryAsset, setInventoryAsset] = React.useState(props.accountIds.inventoryAsset ?? '');
  const [valuationOffset, setValuationOffset] = React.useState(
    props.accountIds.valuationOffset ?? '',
  );

  function handleConnect() {
    startConnect(async () => {
      const res = await beginConnectAction({ provider: 'quickbooks' });
      if (res.ok) {
        // Hand off to Intuit's consent screen.
        window.location.assign(res.data.authorizeUrl);
      } else {
        toast.error(res.error.message);
      }
    });
  }

  function handleDisconnect() {
    startDisconnect(async () => {
      const res = await disconnectAction({ provider: 'quickbooks' });
      if (res.ok) {
        toast.success('QuickBooks disconnected.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  function handleSaveMapping(e: React.FormEvent) {
    e.preventDefault();
    startSaveMapping(async () => {
      const res = await saveAccountMappingAction({
        provider: 'quickbooks',
        billExpense,
        inventoryAsset,
        valuationOffset,
      });
      if (res.ok) {
        toast.success('Account mapping saved.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  return (
    <div className="space-y-6">
      {showQuickBooks && (
      <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                {meta.title}
                {badge && (
                  <Badge variant={badge.variant} className="text-[10px] px-1.5 py-0">
                    {badge.label}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                One-way export of posted receipts to QuickBooks Online as Bills, plus a monthly
                inventory-valuation journal entry. StockPilot never reads data back from QuickBooks.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">QuickBooks company</dt>
              <dd className="font-medium">{props.externalAccountId ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Last connected</dt>
              <dd className="font-medium">{formatDate(props.lastConnectedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Last synced</dt>
              <dd className="font-medium">{formatDate(props.lastSyncedAt)}</dd>
            </div>
            {props.lastError && (
              <div className="col-span-2">
                <dt className="text-muted-foreground text-xs">Last error</dt>
                <dd className="text-destructive font-medium">{props.lastError}</dd>
              </div>
            )}
          </dl>

          <div className="flex gap-2">
            {isConnected ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleConnect}
                  disabled={connecting || disconnecting}
                  className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {connecting ? 'Reconnecting…' : 'Reconnect'}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDisconnect}
                  disabled={disconnecting || connecting}
                  className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="gradient"
                onClick={handleConnect}
                disabled={connecting}
                className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {connecting ? 'Connecting…' : 'Connect QuickBooks'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">QuickBooks account mapping</CardTitle>
          <CardDescription>
            Paste the account ids from your QuickBooks Chart of Accounts. Receipts post as Bills
            against the expense account; the monthly valuation entry posts the delta between the
            inventory-asset and valuation-offset accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveMapping} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="qbo-bill-expense">Expense account ID</Label>
              <Input
                id="qbo-bill-expense"
                value={billExpense}
                onChange={(e) => setBillExpense(e.target.value)}
                placeholder="e.g. 54"
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qbo-inventory-asset">Inventory asset account ID</Label>
              <Input
                id="qbo-inventory-asset"
                value={inventoryAsset}
                onChange={(e) => setInventoryAsset(e.target.value)}
                placeholder="e.g. 81"
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qbo-valuation-offset">Valuation offset account ID</Label>
              <Input
                id="qbo-valuation-offset"
                value={valuationOffset}
                onChange={(e) => setValuationOffset(e.target.value)}
                placeholder="e.g. 90"
                inputMode="numeric"
              />
            </div>
            <Button
              type="submit"
              variant="default"
              disabled={savingMapping}
              className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {savingMapping ? 'Saving…' : 'Save mapping'}
            </Button>
          </form>
        </CardContent>
      </Card>
      </>
      )}

      {props.easyPost && <EasyPostCard {...props.easyPost} />}

      {props.failedSyncs != null && <DeadLetterCard rows={props.failedSyncs} />}

      {showQuickBooks && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent sync activity</CardTitle>
          <CardDescription>The most recent export attempts and their status.</CardDescription>
        </CardHeader>
        <CardContent>
          {props.health.length === 0 ? (
            <p className="text-muted-foreground text-sm">No sync activity yet.</p>
          ) : (
            <ul className="divide-border divide-y rounded-md border">
              {props.health.map((row, i) => (
                <li key={`${row.createdAt}-${i}`} className="flex items-center justify-between gap-4 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{row.topic}</span>
                      <SyncStatusBadge status={row.status} />
                    </div>
                    {row.lastError && (
                      <p className="text-destructive truncate text-xs">{row.lastError}</p>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {formatDate(row.completedAt ?? row.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}

function SyncStatusBadge({ status }: { status: SyncHealthRow['status'] }) {
  const map: Record<SyncHealthRow['status'], 'default' | 'secondary' | 'outline' | 'destructive'> = {
    success: 'default',
    pending: 'secondary',
    error: 'destructive',
    dead: 'destructive',
  };
  return (
    <Badge variant={map[status]} className="text-[10px] px-1.5 py-0 capitalize">
      {status}
    </Badge>
  );
}

/**
 * Operator dead-letter view: lists failed (error/dead) connector exports and
 * offers a per-row Replay button that re-queues the event for the drainer. Only
 * rendered when the caller can manage an enabled integration/shipping module
 * (gated server-side; the page passes `failedSyncs` only then). Replay is also
 * re-checked in the server action + RLS, so this UI is a convenience, not the
 * security boundary.
 */
function DeadLetterCard({ rows }: { rows: FailedSyncRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Failed exports (dead-letter)</CardTitle>
        <CardDescription>
          Exports that errored or hit the retry limit — usually a bad account id or an expired
          token. Fix the cause, then Replay to re-queue the export on the next sync.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No failed exports. Everything is in sync.</p>
        ) : (
          <ul className="divide-border divide-y rounded-md border">
            {rows.map((row) => (
              <DeadLetterRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DeadLetterRow({ row }: { row: FailedSyncRow }) {
  const [replaying, startReplay] = React.useTransition();
  const [replayed, setReplayed] = React.useState(false);

  function handleReplay() {
    startReplay(async () => {
      const res = await replaySyncAction({ id: row.id });
      if (res.ok) {
        setReplayed(true);
        toast.success('Export re-queued. It will retry on the next sync.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  return (
    <li className="flex items-center justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{row.topic}</span>
          <SyncStatusBadge status={replayed ? 'pending' : row.status} />
          <span className="text-muted-foreground text-xs">
            {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
          </span>
        </div>
        {row.externalId && (
          <p className="text-muted-foreground truncate text-xs">External id: {row.externalId}</p>
        )}
        {row.lastError && <p className="text-destructive truncate text-xs">{row.lastError}</p>}
        <p className="text-muted-foreground text-xs">{formatDate(row.updatedAt ?? row.createdAt)}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleReplay}
        disabled={replaying || replayed}
        className="shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {replayed ? 'Re-queued' : replaying ? 'Replaying…' : 'Replay'}
      </Button>
    </li>
  );
}

/**
 * EasyPost carrier-shipping card: paste an API key (+ optional webhook signing
 * secret) to connect. The key buys real postage, so secrets go straight to the
 * server action → Vault and are NEVER rendered back; the card only shows
 * connection status + mode. Disconnect destroys the Vault secret.
 */
function EasyPostCard(props: EasyPostPanelProps) {
  const status = props.status;
  const isConnected = status === 'active';
  const badge = status ? STATUS_BADGE[status] : null;

  const [connecting, startConnect] = React.useTransition();
  const [disconnecting, startDisconnect] = React.useTransition();
  const [apiKey, setApiKey] = React.useState('');
  const [webhookSecret, setWebhookSecret] = React.useState('');

  function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    startConnect(async () => {
      const res = await connectEasyPostAction({
        apiKey,
        webhookSecret: webhookSecret.trim() ? webhookSecret : undefined,
      });
      if (res.ok) {
        toast.success('EasyPost connected.');
        // Never keep the pasted secrets in client state past a successful save.
        setApiKey('');
        setWebhookSecret('');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  function handleDisconnect() {
    startDisconnect(async () => {
      const res = await disconnectEasyPostAction();
      if (res.ok) {
        toast.success('EasyPost disconnected.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {CONNECTOR_REGISTRY.easypost.title}
              {badge && (
                <Badge variant={badge.variant} className="text-[10px] px-1.5 py-0">
                  {badge.label}
                </Badge>
              )}
              {isConnected && props.mode && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">
                  {props.mode}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Buy carrier shipping labels and track delivery orders. StockPilot pushes label
              requests to EasyPost and receives tracking updates — it never changes inventory based
              on EasyPost data. Your API key is stored encrypted and never shown again.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground text-xs">Last connected</dt>
            <dd className="font-medium">{formatDate(props.lastConnectedAt)}</dd>
          </div>
          {props.lastError && (
            <div className="col-span-2">
              <dt className="text-muted-foreground text-xs">Last error</dt>
              <dd className="text-destructive font-medium">{props.lastError}</dd>
            </div>
          )}
        </dl>

        {isConnected ? (
          <Button
            type="button"
            variant="destructive"
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        ) : (
          <form onSubmit={handleConnect} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="easypost-api-key">EasyPost API key</Label>
              <Input
                id="easypost-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="EZAK… (production) or EZTK… (test)"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="easypost-webhook-secret">
                Webhook signing secret <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="easypost-webhook-secret"
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder="Used to verify tracking webhooks"
                autoComplete="off"
              />
            </div>
            <Button
              type="submit"
              variant="gradient"
              disabled={connecting || apiKey.trim().length === 0}
              className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {connecting ? 'Connecting…' : 'Connect EasyPost'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
