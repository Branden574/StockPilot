'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { connectZendeskAction, disconnectZendeskAction } from '@/server/actions/zendesk';

interface Props {
  status: string | null;
  subdomain: string | null;
}

/**
 * Zendesk connect card: paste a subdomain + agent email + API token to connect.
 * The token buys read/write access to the helpdesk, so it goes straight to the
 * server action → Vault and is NEVER rendered back; the card only shows the
 * connected subdomain once active. Disconnect destroys the Vault secret.
 */
export function ZendeskConnectCard({ status, subdomain }: Props) {
  const connected = status === 'active';

  const [connecting, startConnect] = React.useTransition();
  const [disconnecting, startDisconnect] = React.useTransition();
  const [subdomainInput, setSubdomainInput] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [apiToken, setApiToken] = React.useState('');

  function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    startConnect(async () => {
      const res = await connectZendeskAction({
        subdomain: subdomainInput,
        email,
        apiToken,
      });
      if (res.ok) {
        toast.success('Zendesk connected.');
        // Never keep the pasted token in client state past a successful save.
        setSubdomainInput('');
        setEmail('');
        setApiToken('');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  function handleDisconnect() {
    startDisconnect(async () => {
      const res = await disconnectZendeskAction();
      if (res.ok) {
        toast.success('Zendesk disconnected.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  if (connected) {
    return (
      <div className="rounded-lg border p-4">
        <p className="text-sm font-medium">
          Connected{subdomain ? ` to ${subdomain}.zendesk.com` : ''}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={disconnecting}
          onClick={handleDisconnect}
        >
          {disconnecting ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleConnect} className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1.5">
        <Label htmlFor="zd-subdomain">Zendesk subdomain</Label>
        <Input
          id="zd-subdomain"
          name="subdomain"
          value={subdomainInput}
          onChange={(e) => setSubdomainInput(e.target.value)}
          placeholder="acme (from acme.zendesk.com)"
          autoComplete="off"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="zd-email">Agent email</Label>
        <Input
          id="zd-email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="off"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="zd-token">API token</Label>
        <Input
          id="zd-token"
          name="apiToken"
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder="Zendesk API token"
          autoComplete="off"
          required
        />
      </div>
      <Button
        type="submit"
        variant="gradient"
        size="sm"
        disabled={connecting || subdomainInput.trim().length === 0 || apiToken.trim().length === 0}
      >
        {connecting ? 'Connecting…' : 'Connect Zendesk'}
      </Button>
    </form>
  );
}
