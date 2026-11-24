import Link from 'next/link';
import * as React from 'react';

import { DetailSection } from '@/components/patterns/detail-section';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  PASSKEY_SETTING_LABEL,
  type PlatformPasskeySetting,
} from '@/lib/platform/passkeys-console';
import {
  listOrganizationsForPasskeys,
  PASSKEY_ORGANIZATION_CHOICES_CAP,
  readPasskeyConsole,
} from '@/server/services/platform/passkey-switches';

import { OrganizationPasskeysTurnOn } from './organization-passkeys-turn-on';
import { PasskeySwitchControl } from './passkey-switch-control';
import { PlatformTable } from './platform-table';
import { ConsoleMoment, consoleZoneNote } from './zoned-time';

const HELP: Record<PlatformPasskeySetting, string> = {
  passkeys_on:
    'When off, nobody can add or use a passkey. Members whose only second step is a passkey must use a recovery code.',
  passkey_adds_on:
    'When off, nobody can add a passkey. Passkeys already added keep working while passkeys for everyone are on.',
};

function PlatformSwitchRow({ setting, on }: { setting: PlatformPasskeySetting; on: boolean }) {
  const labelId = React.useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0"
    >
      <div className="min-w-0 max-w-xl">
        <p id={labelId} className="text-foreground font-medium">
          {PASSKEY_SETTING_LABEL[setting]}
        </p>
        <p className="text-muted-foreground text-[12.5px]">{HELP[setting]}</p>
      </div>
      <PasskeySwitchControl target={{ kind: 'platform', setting }} on={on} />
    </div>
  );
}

/**
 * PASSKEYS in the platform console (part 2, plan 2.6 H and section 4): the
 * kill switch ("Passkeys for everyone"), "New passkeys" and Turn on for an
 * organization in the section's card, then the organizations that have
 * passkeys on in a console table straight on the page (never a card inside
 * the card, review L4). Everything starts OFF and only these controls turn
 * anything on; each press needs the typed word PASSKEYS and a fresh
 * authenticator code, and is recorded in the platform audit
 * (server/actions/platform/passkeys.ts).
 *
 * A server component that reads with the service client: the page that
 * renders it must have called requirePlatformAdmin() first. A read that
 * fails is said in words and offers no button, never shown as "Off".
 */
export async function PlatformPasskeysSection({
  timeZone = null,
}: {
  /** The viewer's chosen zone (lib/platform/viewer-time-zone), or null: UTC then. */
  timeZone?: string | null;
} = {}) {
  const [state, choices] = await Promise.all([
    readPasskeyConsole(),
    listOrganizationsForPasskeys(),
  ]);
  const onIds = new Set((state.organizations ?? []).map((o) => o.id));

  return (
    <div className="flex flex-col gap-4">
      <DetailSection title="Passkeys">
        <div className="space-y-6">
          {state.switches ? (
            <div className="divide-border divide-y">
              <PlatformSwitchRow setting="passkeys_on" on={state.switches.passkeysOn} />
              <PlatformSwitchRow setting="passkey_adds_on" on={state.switches.passkeyAddsOn} />
            </div>
          ) : (
            <p className="text-destructive text-[13px]">
              Could not read the passkey switches. Reload this page to try again.
            </p>
          )}

          {choices === null ? (
            <p className="text-destructive text-[13px]">
              Could not load the organizations. Reload this page to try again.
            </p>
          ) : (
            <OrganizationPasskeysTurnOn
              organizations={choices.organizations.filter((o) => !onIds.has(o.id))}
              capped={choices.capped}
              cap={PASSKEY_ORGANIZATION_CHOICES_CAP}
            />
          )}
        </div>
      </DetailSection>

      {/* Straight on the page, as every console table is: the table's card
          is never nested inside the section's card. */}
      <div className="flex flex-col gap-2">
        <h3 className="text-foreground text-[13px] font-medium">Organizations with passkeys on</h3>
        <p className="text-muted-foreground max-w-2xl text-[12.5px]">
          A member can add a passkey only when every organization they belong to has passkeys on.
          Turning one off stops new passkeys; existing ones keep working until removed.
        </p>
        {state.organizations === null ? (
          <p className="text-destructive text-[13px]">
            Could not read which organizations have passkeys on. Reload this page to try again.
          </p>
        ) : state.organizations.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">No organization has passkeys on.</p>
        ) : (
          <PlatformTable label="Organizations with passkeys on" minWidth={640}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Organization</TableHead>
                <TableHead title={consoleZoneNote(timeZone)}>Turned on</TableHead>
                <TableHead className="text-right">Members with passkeys</TableHead>
                <TableHead className="text-right">Passkeys</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.organizations.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>
                    <Link
                      href={`/platform/orgs/${o.id}`}
                      // Never prefetched: rendering an organization's page
                      // writes a viewed_org row to the audit trail.
                      prefetch={false}
                      className={
                        o.name
                          ? 'text-ink-2 hover:text-foreground'
                          : 'text-muted-foreground hover:text-foreground font-mono text-[12px]'
                      }
                    >
                      {o.name ?? o.id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                    <ConsoleMoment at={o.switchedOnAt} timeZone={timeZone} />
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {o.membersWithPasskeys === null
                      ? 'Unknown'
                      : o.membersWithPasskeys.toLocaleString('en-US')}
                  </TableCell>
                  <TableCell className="text-right">
                    <PasskeySwitchControl
                      target={{
                        kind: 'organization',
                        organizationId: o.id,
                        organizationName: o.name ?? o.id,
                      }}
                      on
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </PlatformTable>
        )}
      </div>
    </div>
  );
}
