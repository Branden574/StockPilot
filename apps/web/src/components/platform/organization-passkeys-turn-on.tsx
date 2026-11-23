'use client';

import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { PasskeySwitchControl } from './passkey-switch-control';

/** At most this many matches are listed at once. */
const SHOWN = 10;

/**
 * "Turn on for an organization" (plan section 4): find an organization by
 * name among those that do not have passkeys on, then its own switch
 * (PasskeySwitchControl: the typed word, a fresh step-up). Nothing is listed
 * before something is typed.
 */
export function OrganizationPasskeysTurnOn({
  organizations,
  capped,
  cap,
}: {
  /** The organizations that do not have passkeys on, by name. */
  organizations: ReadonlyArray<{ id: string; name: string }>;
  capped: boolean;
  /** How many were loaded, for the capped sentence. */
  cap: number;
}) {
  const [query, setQuery] = React.useState('');
  const inputId = React.useId();
  const labelId = React.useId();
  const term = query.trim().toLowerCase();
  const matches = term ? organizations.filter((o) => o.name.toLowerCase().includes(term)) : [];

  return (
    <div role="group" aria-labelledby={labelId} className="space-y-2">
      <h3 id={labelId} className="text-foreground text-[13px] font-medium">
        Turn on for an organization
      </h3>
      <div className="max-w-sm space-y-1.5">
        <Label htmlFor={inputId}>Find an organization</Label>
        <Input
          id={inputId}
          autoComplete="off"
          placeholder="Part of its name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {term && matches.length === 0 ? (
        <p className="text-muted-foreground text-[12.5px]">No organization matches.</p>
      ) : null}
      {matches.length > 0 ? (
        <ul className="divide-border divide-y">
          {matches.slice(0, SHOWN).map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="text-foreground">{o.name}</span>
              <PasskeySwitchControl
                target={{ kind: 'organization', organizationId: o.id, organizationName: o.name }}
                on={false}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {matches.length > SHOWN ? (
        <p className="text-muted-foreground text-[12px]">
          Showing {SHOWN} of {matches.length}. Type more of the name.
        </p>
      ) : null}
      {capped ? (
        <p className="text-muted-foreground text-[12px]">
          Only the first {cap} organizations by name are searched here.
        </p>
      ) : null}
    </div>
  );
}
