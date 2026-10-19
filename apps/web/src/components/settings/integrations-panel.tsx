'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { SettingsPanel } from '@/components/settings/settings-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useHydrated } from '@/lib/use-hydrated';
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
  accountIds: {
    billExpense?: string;
    inventoryAsset?: string;
    valuationOffset?: string;
    returnCredit?: string;
  };
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
  { label: string; variant: 'success' | 'secondary' | 'outline' | 'destructive' }
> = {
  active: { label: 'Connected', variant: 'success' },
  pending: { label: 'Connecting…', variant: 'secondary' },
  error: { label: 'Error', variant: 'destructive' },
  disconnected: { label: 'Disconnected', variant: 'outline' },
};

/**
 * A date and time in the VIEWER's zone and locale. The server's zone (UTC on
 * Vercel) differs in every hour, so hydrating it threw React error #418; until
 * `hydrated` (useHydrated) a real date is a non-breaking space that holds the
 * line, and a missing one is a dash at once.
 */
function formatDate(iso: string | null, hydrated: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return hydrated ? d.toLocaleString() : '\u00a0';
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
  const hydrated = useHydrated();

  // Local form state for the account mapping (controlled inputs).
  const [billExpense, setBillExpense] = React.useState(props.accountIds.billExpense ?? '');
  const [inventoryAsset, setInventoryAsset] = React.useState(props.accountIds.inventoryAsset ?? '');
  const [valuationOffset, setValuationOffset] = React.useState(
    props.accountIds.valuationOffset ?? '',
  );
  const [returnCredit, setReturnCredit] = React.useState(props.accountIds.returnCredit ?? '');

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
        returnCredit,
      });
      if (res.ok) {
        toast.success('Account mapping saved.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  return (
    <>
      {showQuickBooks && (
        <>
          <SettingsPanel
            title={meta.title}
            description="One-way export of posted receipts to QuickBooks Online as Bills, plus a monthly inventory-valuation journal entry. StockPilot never reads data back from QuickBooks."
            aside={
              badge && (
                <Badge variant={badge.variant} dot>
                  {badge.label}
                </Badge>
              )
            }
            flush
          >
            <KeyValueList>
              <KeyValueRow label="QuickBooks company">{props.externalAccountId ?? '—'}</KeyValueRow>
              <KeyValueRow label="Last connected">
                {formatDate(props.lastConnectedAt, hydrated)}
              </KeyValueRow>
              <KeyValueRow label="Last synced">
                {formatDate(props.lastSyncedAt, hydrated)}
              </KeyValueRow>
              {props.lastError && (
                <KeyValueRow label="Last error" valueClassName="text-destructive">
                  {props.lastError}
                </KeyValueRow>
              )}
            </KeyValueList>

            <div className="border-border flex flex-wrap gap-2 border-t px-[18px] py-3.5">
              {isConnected ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleConnect}
                    disabled={connecting || disconnecting}
                  >
                    {connecting ? 'Reconnecting…' : 'Reconnect'}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={handleDisconnect}
                    disabled={disconnecting || connecting}
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
                >
                  {connecting ? 'Connecting…' : 'Connect QuickBooks'}
                </Button>
              )}
            </div>
          </SettingsPanel>

          <SettingsPanel
            title="QuickBooks account mapping"
            description="Paste the account ids from your QuickBooks Chart of Accounts. Receipts post as Bills against the expense account; the monthly valuation entry posts the delta between the inventory-asset and valuation-offset accounts."
          >
            <form onSubmit={handleSaveMapping} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
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
                <div className="space-y-1.5">
                  <Label htmlFor="qbo-return-credit">Return credit account ID</Label>
                  <Input
                    id="qbo-return-credit"
                    value={returnCredit}
                    onChange={(e) => setReturnCredit(e.target.value)}
                    placeholder="e.g. 47"
                    inputMode="numeric"
                  />
                  <p className="text-muted-foreground text-[12px]">
                    Closed returns post a balanced journal entry crediting this account (the
                    offsetting debit uses the inventory-asset account).
                  </p>
                </div>
              </div>
              <Button type="submit" variant="default" disabled={savingMapping}>
                {savingMapping ? 'Saving…' : 'Save mapping'}
              </Button>
            </form>
          </SettingsPanel>
        </>
      )}

      {props.easyPost && <EasyPostCard {...props.easyPost} />}

      {props.failedSyncs != null && <DeadLetterCard rows={props.failedSyncs} />}

      {showQuickBooks && (
        <SettingsPanel
          title="Recent sync activity"
          description="The most recent export attempts and their status."
          flush
        >
          {props.health.length === 0 ? (
            <p className="text-muted-foreground px-[18px] py-4 text-[13px]">
              No sync activity yet.
            </p>
          ) : (
            <ul className="divide-border divide-y">
              {props.health.map((row, i) => (
                <li
                  key={`${row.createdAt}-${i}`}
                  className="flex items-center justify-between gap-4 px-[18px] py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12.5px]">{row.topic}</span>
                      <SyncStatusBadge status={row.status} />
                    </div>
                    {row.lastError && (
                      <p className="text-destructive truncate text-[12px]">{row.lastError}</p>
                    )}
                  </div>
                  <span className="text-muted-foreground shrink-0 text-[12px]">
                    {formatDate(row.completedAt ?? row.createdAt, hydrated)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SettingsPanel>
      )}
    </>
  );
}

function SyncStatusBadge({ status }: { status: SyncHealthRow['status'] }) {
  const map: Record<SyncHealthRow['status'], 'success' | 'secondary' | 'outline' | 'destructive'> =
    {
      success: 'success',
      pending: 'secondary',
      error: 'destructive',
      dead: 'destructive',
    };
  return (
    <Badge variant={map[status]} dot className="capitalize">
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
    <SettingsPanel
      title="Failed exports (dead-letter)"
      description="Exports that errored or hit the retry limit — usually a bad account id or an expired token. Fix the cause, then Replay to re-queue the export on the next sync."
      flush
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-[18px] py-4 text-[13px]">
          No failed exports. Everything is in sync.
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {rows.map((row) => (
            <DeadLetterRow key={row.id} row={row} />
          ))}
        </ul>
      )}
    </SettingsPanel>
  );
}

function DeadLetterRow({ row }: { row: FailedSyncRow }) {
  const [replaying, startReplay] = React.useTransition();
  const [replayed, setReplayed] = React.useState(false);
  const hydrated = useHydrated();

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
    <li className="flex items-center justify-between gap-4 px-[18px] py-2.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12.5px]">{row.topic}</span>
          <SyncStatusBadge status={replayed ? 'pending' : row.status} />
          <span className="text-muted-foreground text-[12px]">
            {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
          </span>
        </div>
        {row.externalId && (
          <p className="text-muted-foreground truncate text-[12px]">
            External id: {row.externalId}
          </p>
        )}
        {row.lastError && <p className="text-destructive truncate text-[12px]">{row.lastError}</p>}
        <p className="text-muted-foreground text-[12px]">
          {formatDate(row.updatedAt ?? row.createdAt, hydrated)}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleReplay}
        disabled={replaying || replayed}
        className="shrink-0"
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
  const hydrated = useHydrated();
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
    <SettingsPanel
      title={CONNECTOR_REGISTRY.easypost.title}
      description="Buy carrier shipping labels and track delivery orders. StockPilot pushes label requests to EasyPost and receives tracking updates — it never changes inventory based on EasyPost data. Your API key is stored encrypted and never shown again."
      aside={
        badge || (isConnected && props.mode) ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {badge && (
              <Badge variant={badge.variant} dot>
                {badge.label}
              </Badge>
            )}
            {isConnected && props.mode && (
              <Badge variant="outline" className="capitalize">
                {props.mode}
              </Badge>
            )}
          </div>
        ) : null
      }
      flush
    >
      <KeyValueList>
        <KeyValueRow label="Last connected">
          {formatDate(props.lastConnectedAt, hydrated)}
        </KeyValueRow>
        {props.lastError && (
          <KeyValueRow label="Last error" valueClassName="text-destructive">
            {props.lastError}
          </KeyValueRow>
        )}
      </KeyValueList>

      <div className="border-border border-t px-[18px] py-3.5">
        {isConnected ? (
          <Button
            type="button"
            variant="destructive"
            onClick={handleDisconnect}
            disabled={disconnecting}
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        ) : (
          <form onSubmit={handleConnect} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
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
            </div>
            <Button
              type="submit"
              variant="gradient"
              disabled={connecting || apiKey.trim().length === 0}
            >
              {connecting ? 'Connecting…' : 'Connect EasyPost'}
            </Button>
          </form>
        )}
      </div>
    </SettingsPanel>
  );
}
