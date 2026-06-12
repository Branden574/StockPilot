'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  beginConnectAction,
  disconnectAction,
  saveIntacctSettingsAction,
} from '@/server/actions/connections';
import { importFromIntacctAction } from '@/server/actions/intacct-import';

type ConnectionStatus = 'pending' | 'active' | 'error' | 'disconnected';

export interface SageIntacctCardProps {
  status: ConnectionStatus | null;
  externalAccountId: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  /** Whether SAGE_INTACCT_CLIENT_ID is set on this deployment. */
  credentialsConfigured: boolean;
  /** Active warehouses — imported items must land in one. */
  warehouses: { id: string; name: string }[];
  settings: {
    poTxnDefinition?: string;
    defaultItemId?: string;
    defaultVendorId?: string;
    journalSymbol?: string;
    returnCredit?: string;
    inventoryAsset?: string;
  };
}

const STATUS_BADGE: Record<ConnectionStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
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

/**
 * Sage Intacct connection card (Integrations panel). Three states:
 *  - awaiting credentials: the deployment has no SAGE_INTACCT_CLIENT_ID yet
 *    (the Web Services developer license / sender ID is an owner purchase via
 *    a Sage account manager) — explain, keep Connect disabled;
 *  - disconnected: Connect via OAuth;
 *  - connected: settings form (transaction definition, default item/vendor,
 *    journal + GL accounts), Import-items, Reconnect/Disconnect.
 */
export function SageIntacctCard(props: SageIntacctCardProps) {
  const status = props.status;
  const isConnected = status === 'active';
  const badge = status ? STATUS_BADGE[status] : null;

  const [connecting, startConnect] = React.useTransition();
  const [disconnecting, startDisconnect] = React.useTransition();
  const [saving, startSave] = React.useTransition();
  const [importing, startImport] = React.useTransition();
  const [importNote, setImportNote] = React.useState<string | null>(null);
  const [importWarehouseId, setImportWarehouseId] = React.useState(
    props.warehouses[0]?.id ?? '',
  );

  const [poTxnDefinition, setPoTxnDefinition] = React.useState(props.settings.poTxnDefinition ?? '');
  const [defaultItemId, setDefaultItemId] = React.useState(props.settings.defaultItemId ?? '');
  const [defaultVendorId, setDefaultVendorId] = React.useState(props.settings.defaultVendorId ?? '');
  const [journalSymbol, setJournalSymbol] = React.useState(props.settings.journalSymbol ?? '');
  const [returnCredit, setReturnCredit] = React.useState(props.settings.returnCredit ?? '');
  const [inventoryAsset, setInventoryAsset] = React.useState(props.settings.inventoryAsset ?? '');

  function handleConnect() {
    startConnect(async () => {
      const res = await beginConnectAction({ provider: 'sage_intacct' });
      if (res.ok) {
        window.location.assign(res.data.authorizeUrl);
      } else {
        toast.error(res.error.message);
      }
    });
  }

  function handleDisconnect() {
    startDisconnect(async () => {
      const res = await disconnectAction({ provider: 'sage_intacct' });
      if (res.ok) {
        toast.success('Sage Intacct disconnected.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    startSave(async () => {
      const res = await saveIntacctSettingsAction({
        poTxnDefinition,
        defaultItemId,
        defaultVendorId,
        journalSymbol,
        returnCredit,
        inventoryAsset,
      });
      if (res.ok) {
        toast.success('Sage Intacct settings saved.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  function handleImport() {
    startImport(async () => {
      setImportNote(null);
      const res = await importFromIntacctAction(
        importWarehouseId ? { warehouseId: importWarehouseId } : {},
      );
      if (res.ok) {
        const s = res.data;
        const parts = [
          `${s.created} created`,
          `${s.skippedExisting} already existed`,
          ...(s.failed ? [`${s.failed} failed`] : []),
        ];
        toast.success(`Intacct import: ${parts.join(' · ')}`);
        setImportNote(
          [
            `Scanned ${s.scanned} Intacct items — ${parts.join(', ')}.`,
            ...s.notes,
            ...(s.errors.length
              ? [`First errors: ${s.errors.slice(0, 3).map((e) => `${e.sku}: ${e.message}`).join(' | ')}`]
              : []),
          ].join(' '),
        );
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
              Sage Intacct
              {badge ? (
                <Badge variant={badge.variant} className="px-1.5 py-0 text-[10px]">
                  {badge.label}
                </Badge>
              ) : (
                !props.credentialsConfigured && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    Awaiting credentials
                  </Badge>
                )
              )}
            </CardTitle>
            <CardDescription>
              Push purchase orders and return value entries to Sage Intacct, and import your
              Intacct item catalog (with on-hand quantities) into StockPilot.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!props.credentialsConfigured ? (
          <p className="text-muted-foreground text-sm">
            This connector is built and ready, but Sage Intacct API access requires a{' '}
            <span className="text-foreground font-medium">Web Services developer license</span>{' '}
            (sender ID) purchased through a Sage account manager. Once the OAuth app credentials
            are added to this deployment, the Connect button activates.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">Intacct company</dt>
                <dd className="font-medium">{props.externalAccountId ?? '—'}</dd>
              </div>
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

            <div className="flex flex-wrap gap-2">
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
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleImport}
                    disabled={importing || props.warehouses.length === 0}
                  >
                    {importing ? 'Importing…' : 'Import items from Intacct'}
                  </Button>
                  {props.warehouses.length > 1 && (
                    <Select value={importWarehouseId} onValueChange={setImportWarehouseId}>
                      <SelectTrigger className="h-9 w-44" aria-label="Import into warehouse">
                        <SelectValue placeholder="Into warehouse…" />
                      </SelectTrigger>
                      <SelectContent>
                        {props.warehouses.map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </>
              ) : (
                <Button type="button" onClick={handleConnect} disabled={connecting}>
                  {connecting ? 'Redirecting…' : 'Connect Sage Intacct'}
                </Button>
              )}
            </div>

            {isConnected && props.warehouses.length === 0 && (
              <p className="text-destructive text-xs">
                Create a warehouse before importing — items need one to belong to.
              </p>
            )}
            {importNote && <p className="text-muted-foreground text-xs">{importNote}</p>}

            {isConnected && (
              <form onSubmit={handleSave} className="space-y-3 border-t pt-4">
                <p className="text-muted-foreground text-xs">
                  Document + GL configuration. Field values come from your Intacct company
                  (transaction definition name, item/vendor ids, journal symbol, GL account ids).
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="intacct-txndef" className="text-xs">PO transaction definition</Label>
                    <Input
                      id="intacct-txndef"
                      value={poTxnDefinition}
                      onChange={(e) => setPoTxnDefinition(e.target.value)}
                      placeholder="Purchase Order"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="intacct-item" className="text-xs">Default (non-inventory) item id</Label>
                    <Input
                      id="intacct-item"
                      value={defaultItemId}
                      onChange={(e) => setDefaultItemId(e.target.value)}
                      placeholder="Required for PO push"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="intacct-vendor" className="text-xs">Default vendor id</Label>
                    <Input
                      id="intacct-vendor"
                      value={defaultVendorId}
                      onChange={(e) => setDefaultVendorId(e.target.value)}
                      placeholder="Fallback when no name match"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="intacct-journal" className="text-xs">GL journal symbol</Label>
                    <Input
                      id="intacct-journal"
                      value={journalSymbol}
                      onChange={(e) => setJournalSymbol(e.target.value)}
                      placeholder="GJ"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="intacct-return" className="text-xs">Return credit GL account</Label>
                    <Input
                      id="intacct-return"
                      value={returnCredit}
                      onChange={(e) => setReturnCredit(e.target.value)}
                      placeholder="Credited on return.closed"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="intacct-asset" className="text-xs">Inventory asset GL account</Label>
                    <Input
                      id="intacct-asset"
                      value={inventoryAsset}
                      onChange={(e) => setInventoryAsset(e.target.value)}
                      placeholder="Debited to balance"
                    />
                  </div>
                </div>
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? 'Saving…' : 'Save settings'}
                </Button>
              </form>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
