'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { SettingsPanel } from '@/components/settings/settings-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useHydrated } from '@/lib/use-hydrated';
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

const STATUS_BADGE: Record<
  ConnectionStatus,
  { label: string; variant: 'success' | 'secondary' | 'destructive' | 'outline' }
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
  const hydrated = useHydrated();
  const [importing, startImport] = React.useTransition();
  const [importNote, setImportNote] = React.useState<string | null>(null);
  const [importWarehouseId, setImportWarehouseId] = React.useState(props.warehouses[0]?.id ?? '');

  const [poTxnDefinition, setPoTxnDefinition] = React.useState(
    props.settings.poTxnDefinition ?? '',
  );
  const [defaultItemId, setDefaultItemId] = React.useState(props.settings.defaultItemId ?? '');
  const [defaultVendorId, setDefaultVendorId] = React.useState(
    props.settings.defaultVendorId ?? '',
  );
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
              ? [
                  `First errors: ${s.errors
                    .slice(0, 3)
                    .map((e) => `${e.sku}: ${e.message}`)
                    .join(' | ')}`,
                ]
              : []),
          ].join(' '),
        );
      } else {
        toast.error(res.error.message);
      }
    });
  }

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder: string,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );

  return (
    <SettingsPanel
      title="Sage Intacct"
      description="Push purchase orders and return value entries to Sage Intacct, and import your Intacct item catalog (with on-hand quantities) into StockPilot."
      aside={
        badge ? (
          <Badge variant={badge.variant} dot>
            {badge.label}
          </Badge>
        ) : (
          !props.credentialsConfigured && (
            <Badge variant="outline" dot>
              Awaiting credentials
            </Badge>
          )
        )
      }
      flush={props.credentialsConfigured}
    >
      {!props.credentialsConfigured ? (
        <p className="text-muted-foreground text-[13px]">
          This connector is built and ready, but Sage Intacct API access requires a{' '}
          <span className="text-foreground font-medium">Web Services developer license</span>{' '}
          (sender ID) purchased through a Sage account manager. Once the OAuth app credentials are
          added to this deployment, the Connect button activates.
        </p>
      ) : (
        <>
          <KeyValueList>
            <KeyValueRow label="Intacct company">{props.externalAccountId ?? '—'}</KeyValueRow>
            <KeyValueRow label="Last connected">
              {formatDate(props.lastConnectedAt, hydrated)}
            </KeyValueRow>
            {props.lastError && (
              <KeyValueRow label="Last error" valueClassName="text-destructive">
                {props.lastError}
              </KeyValueRow>
            )}
          </KeyValueList>

          <div className="border-border space-y-3 border-t px-[18px] py-3.5">
            <div className="flex flex-wrap items-center gap-2">
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
                      <SelectTrigger className="w-44" aria-label="Import into warehouse">
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
              <p className="text-destructive text-[12.5px]">
                Create a warehouse before importing — items need one to belong to.
              </p>
            )}
            {importNote && <p className="text-muted-foreground text-[12.5px]">{importNote}</p>}
          </div>

          {isConnected && (
            <form
              onSubmit={handleSave}
              className="border-border space-y-3 border-t px-[18px] py-3.5"
            >
              <p className="text-muted-foreground text-[12.5px]">
                Document + GL configuration. Field values come from your Intacct company
                (transaction definition name, item/vendor ids, journal symbol, GL account ids).
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {field(
                  'intacct-txndef',
                  'PO transaction definition',
                  poTxnDefinition,
                  setPoTxnDefinition,
                  'Purchase Order',
                )}
                {field(
                  'intacct-item',
                  'Default (non-inventory) item id',
                  defaultItemId,
                  setDefaultItemId,
                  'Required for PO push',
                )}
                {field(
                  'intacct-vendor',
                  'Default vendor id',
                  defaultVendorId,
                  setDefaultVendorId,
                  'Fallback when no name match',
                )}
                {field(
                  'intacct-journal',
                  'GL journal symbol',
                  journalSymbol,
                  setJournalSymbol,
                  'GJ',
                )}
                {field(
                  'intacct-return',
                  'Return credit GL account',
                  returnCredit,
                  setReturnCredit,
                  'Credited on return.closed',
                )}
                {field(
                  'intacct-asset',
                  'Inventory asset GL account',
                  inventoryAsset,
                  setInventoryAsset,
                  'Debited to balance',
                )}
              </div>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save settings'}
              </Button>
            </form>
          )}
        </>
      )}
    </SettingsPanel>
  );
}
