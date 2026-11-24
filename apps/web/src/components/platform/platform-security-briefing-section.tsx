import Link from 'next/link';
import * as React from 'react';

import { DetailSection, DetailSectionLink } from '@/components/patterns/detail-section';
import { Badge } from '@/components/ui/badge';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { recordPlatformAudit } from '@/server/services/platform/audit';
import {
  findBriefingOrganization,
  readOrganizationSecurityBriefing,
  readPlatformSecurityBriefing,
  type OrganizationSecurityBriefing,
} from '@/server/services/platform/security-briefing';

import {
  briefingRoleLabel,
  briefingSeverityLabel,
  type BriefingFixedBy,
  type BriefingItem,
  type BriefingSeverity,
  type PlatformSecurityBriefing,
} from '@stockpilot/core';

import { PlatformTable } from './platform-table';
import { ConsoleMoment, consoleZoneNote } from './zoned-time';

const COULD_NOT_CHECK = 'Could not check';

/**
 * The Organization column of the all-organizations table keeps a width of its
 * own. In the Liquid Glass appearance the headers of a console table do not
 * wrap, so the eleven columns beside it take what they need and this one was
 * left with the width of its header: a name of three words stood on three
 * lines, and a long one ran down the page. Long names still wrap inside it,
 * and a long unbroken word (or an id shown in place of a name) breaks.
 */
const ORGANIZATION_COLUMN = 'min-w-[14rem]';
const ORGANIZATION_CELL = 'min-w-[14rem] [overflow-wrap:anywhere]';

const SEVERITY_TONE: Record<BriefingSeverity, 'destructive' | 'warning' | 'secondary'> = {
  high: 'destructive',
  medium: 'warning',
  low: 'secondary',
};

const FIXED_BY: Record<BriefingFixedBy, string> = {
  you: "The organization's admins",
  stockpilot: 'StockPilot',
};

const num = (n: number): string => n.toLocaleString('en-US');

/** A count, or the words for a number that could not be read. Never a zero in its place. */
function CountCell({ value }: { value: number | null }) {
  return value === null ? (
    <TableCell className="text-muted-foreground text-right">{COULD_NOT_CHECK}</TableCell>
  ) : (
    <TableCell className="text-right font-mono tabular-nums">{num(value)}</TableCell>
  );
}

/** The items as cards' worth of words: severity, headline, then the three labelled lines. */
function BriefingItems({ items }: { items: BriefingItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="divide-border divide-y">
      {items.map((item) => (
        <li key={item.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={SEVERITY_TONE[item.severity]}>
              {briefingSeverityLabel(item.severity)}
            </Badge>
            <p className="text-foreground font-medium">{item.headline}</p>
          </div>
          <dl className="mt-1.5 max-w-3xl space-y-0.5 text-[13px]">
            {(
              [
                ['What we see', item.whatWeSee],
                ['Why it matters', item.whyItMatters],
                ['What to do', item.whatToDo],
                ['Who can fix it', FIXED_BY[item.fixedBy]],
              ] as const
            ).map(([label, text]) => (
              <div key={label}>
                <dt className="text-muted-foreground inline">{label}: </dt>
                <dd className="inline">{text}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

/** "In good shape" and "Could not check" (grey), each only when it has lines. */
function ShapeLines({ goodShape, unchecked }: { goodShape: string[]; unchecked: string[] }) {
  if (goodShape.length === 0 && unchecked.length === 0) return null;
  return (
    <div className="space-y-3 text-[13px]">
      {goodShape.length > 0 ? (
        <div>
          <p className="text-foreground font-medium">In good shape</p>
          <ul className="list-disc pl-5">
            {goodShape.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {unchecked.length > 0 ? (
        <div className="text-muted-foreground">
          <p className="font-medium">{COULD_NOT_CHECK}</p>
          <ul className="list-disc pl-5">
            {unchecked.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ALL ORGANIZATIONS: counts only. No person's name and no email is read for
 * this part or shown in it (the functions behind it return none).
 */
function AllOrganizations({ briefing }: { briefing: PlatformSecurityBriefing }) {
  return (
    <>
      <DetailSection title="This week across all organizations">
        <div className="space-y-4">
          <div>
            <p className="text-foreground font-medium">{briefing.bottomLine}</p>
            {briefing.totalsLine ? (
              <p className="text-muted-foreground text-[12.5px]">{briefing.totalsLine}</p>
            ) : null}
            {briefing.noOrganizationLine ? (
              <p className="text-muted-foreground text-[12.5px]">{briefing.noOrganizationLine}</p>
            ) : null}
          </div>
          <BriefingItems items={briefing.items} />
          <ShapeLines goodShape={briefing.goodShape} unchecked={briefing.unchecked} />
        </div>
      </DetailSection>

      {/* Straight on the page, as every console table is. */}
      <div className="flex flex-col gap-2">
        <h3 className="text-foreground text-[13px] font-medium">
          Organizations with something to report
        </h3>
        {!briefing.organizationsChecked ? (
          <p className="text-muted-foreground text-[13px]">
            Could not check this week&apos;s summary.
          </p>
        ) : briefing.organizations.length === 0 ? (
          briefing.organizationsAllChecked ? (
            <p className="text-muted-foreground text-[13px]">
              No organization has anything to report this week.
            </p>
          ) : (
            // Never "nothing to report" when a part was not read: say which.
            <p className="text-muted-foreground text-[13px]">
              Nothing to list from what could be checked.
              {briefing.organizationsUnchecked.map((line) => (
                <React.Fragment key={line}> {line}</React.Fragment>
              ))}
            </p>
          )
        ) : (
          // 1200, not wider: in Classic the headers wrap, and the card is
          // about 1250 wide on a 1360 screen, so the last column is in view
          // without scrolling sideways there.
          <PlatformTable label="Security briefing by organization" minWidth={1200}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={ORGANIZATION_COLUMN}>Organization</TableHead>
                <TableHead>Attention</TableHead>
                <TableHead className="text-right">Blocked this week</TableHead>
                <TableHead className="text-right">Blocked last week</TableHead>
                <TableHead className="text-right">Flagged this week</TableHead>
                <TableHead className="text-right">Admins without a second step</TableHead>
                <TableHead className="text-right">Members without a second step</TableHead>
                <TableHead className="text-right">Sign-ins reported</TableHead>
                <TableHead className="text-right">Admins added</TableHead>
                <TableHead className="text-right">Admins removed or changed role</TableHead>
                <TableHead className="text-right">Ownership moves</TableHead>
                <TableHead className="text-right">Policy changes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {briefing.organizations.map((o) => (
                <TableRow key={o.organizationId}>
                  <TableCell className={ORGANIZATION_CELL}>
                    <Link
                      href={`/platform/security?org=${o.organizationId}`}
                      // Never prefetched: rendering one organization's
                      // briefing writes a viewed_org row to the audit trail.
                      prefetch={false}
                      className={
                        o.name
                          ? 'text-ink-2 hover:text-foreground'
                          : 'text-muted-foreground hover:text-foreground font-mono text-[12px]'
                      }
                    >
                      {o.name ?? o.organizationId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {o.attention ? (
                      <Badge variant={SEVERITY_TONE[o.attention]}>
                        {briefingSeverityLabel(o.attention)}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <CountCell value={o.blockedThisWeek} />
                  <CountCell value={o.blockedLastWeek} />
                  <CountCell value={o.flaggedThisWeek} />
                  <CountCell value={o.adminsWithoutSecondStep} />
                  <CountCell value={o.membersWithoutSecondStep} />
                  <CountCell value={o.signInsReported} />
                  <CountCell value={o.adminsAdded} />
                  <CountCell value={o.adminsRemoved} />
                  <CountCell value={o.ownershipMoves} />
                  <CountCell value={o.policyChanges} />
                </TableRow>
              ))}
            </TableBody>
          </PlatformTable>
        )}
        {briefing.organizationsNotListed > 0 ? (
          <p className="text-muted-foreground text-[12.5px]">
            {num(briefing.organizationsNotListed)} more{' '}
            {briefing.organizationsNotListed === 1 ? 'organization has' : 'organizations have'}{' '}
            something to report and {briefing.organizationsNotListed === 1 ? 'is' : 'are'} not
            listed.
          </p>
        ) : null}
        {briefing.organizationsWithNothingToReport !== null &&
        briefing.organizationsWithNothingToReport > 0 ? (
          <p className="text-muted-foreground text-[12.5px]">
            {num(briefing.organizationsWithNothingToReport)}{' '}
            {briefing.organizationsWithNothingToReport === 1
              ? 'organization has'
              : 'organizations have'}{' '}
            nothing to report.
          </p>
        ) : null}
        {briefing.organizationsTruncated ? (
          <p className="text-muted-foreground text-[12.5px]">
            There are more organizations than one read returns. The ones past that are not counted
            here.
          </p>
        ) : null}
      </div>
    </>
  );
}

/** What the one-organization part found before, or instead of, its read. */
type OrganizationPart =
  | { state: 'unknown' }
  | { state: 'failed' }
  | { state: 'not_recorded'; name: string }
  | { state: 'read'; id: string; name: string; briefing: OrganizationSecurityBriefing };

/**
 * ONE ORGANIZATION (?org=<uuid>, already checked to be a uuid by the page).
 * In this order, and each step only after the one before it:
 *   1. the id names an organization (one row);
 *   2. the viewed_org row is written to the platform audit trail;
 *   3. the detail is read.
 * An id that names no organization writes no row and reads nothing. A row
 * that could not be written reads nothing: this part names members and their
 * sign-in state across a tenant boundary, so it is never shown unrecorded.
 */
async function readOrganizationPart(
  organizationId: string,
  actor: { userId: string; email: string },
): Promise<OrganizationPart> {
  const organization = await findBriefingOrganization(organizationId);
  if (!organization.found) return { state: organization.failed ? 'failed' : 'unknown' };

  // `detail` is free-form, so the view rides there with the existing action
  // word (as the Users tab's does): no new word, no change to the table's check.
  const recorded = await recordPlatformAudit({
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: 'viewed_org',
    targetOrganizationId: organization.id,
    detail: { name: organization.name, tab: 'security' },
  });
  if (!recorded) return { state: 'not_recorded', name: organization.name };

  return {
    state: 'read',
    id: organization.id,
    name: organization.name,
    briefing: await readOrganizationSecurityBriefing(organization.id),
  };
}

function OneOrganization({ part, timeZone }: { part: OrganizationPart; timeZone: string | null }) {
  if (part.state === 'unknown') {
    return <p className="text-muted-foreground text-[13px]">No organization has that id.</p>;
  }
  if (part.state === 'failed') {
    return (
      <p className="text-destructive text-[13px]">
        Could not check that organization. Reload this page to try again.
      </p>
    );
  }
  if (part.state === 'not_recorded') {
    return (
      <p className="text-destructive text-[13px]">
        This view of {part.name} could not be recorded, so its briefing is not shown. Reload this
        page to try again.
      </p>
    );
  }

  const { briefing, detail } = part.briefing;
  return (
    <>
      <DetailSection
        title={`Security briefing: ${part.name}`}
        aside={
          <DetailSectionLink
            href={`/platform/orgs/${part.id}`}
            // Never prefetched: rendering an organization's page writes a
            // viewed_org row to the audit trail.
            prefetch={false}
          >
            Open this organization
          </DetailSectionLink>
        }
      >
        <div className="space-y-4">
          <p className="text-foreground font-medium">{briefing.bottomLine}</p>
          <BriefingItems items={briefing.items} />
          <ShapeLines goodShape={briefing.goodShape} unchecked={briefing.unchecked} />
        </div>
      </DetailSection>

      <div className="flex flex-col gap-2">
        <h3 className="text-foreground text-[13px] font-medium">
          Blocked and flagged activity, this week and last
        </h3>
        {briefing.categories === null ? (
          <p className="text-muted-foreground text-[13px]">{COULD_NOT_CHECK}.</p>
        ) : briefing.categories.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            Nothing was blocked or flagged in the two weeks.
          </p>
        ) : (
          <PlatformTable label={`Blocked and flagged activity: ${part.name}`} minWidth={720}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Blocked this week</TableHead>
                <TableHead className="text-right">Blocked last week</TableHead>
                <TableHead>Change</TableHead>
                <TableHead className="text-right">Flagged this week</TableHead>
                <TableHead className="text-right">Flagged last week</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {briefing.categories.map((c) => (
                <TableRow key={c.category}>
                  <TableCell>{c.label}</TableCell>
                  <CountCell value={c.blockedThisWeek} />
                  <CountCell value={c.blockedLastWeek} />
                  <TableCell className="text-muted-foreground">{c.blockedChange}</TableCell>
                  <CountCell value={c.flaggedThisWeek} />
                  <CountCell value={c.flaggedLastWeek} />
                </TableRow>
              ))}
            </TableBody>
          </PlatformTable>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-foreground text-[13px] font-medium">People</h3>
        {briefing.idleSignIns ? (
          <p className="text-muted-foreground max-w-2xl text-[12.5px]">
            {briefing.idleSignIns} For information only.
          </p>
        ) : null}
        {detail === null ? (
          <p className="text-muted-foreground text-[13px]">{COULD_NOT_CHECK}.</p>
        ) : detail.people.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            Every member has a second step, and no sign-in has gone unused for{' '}
            {num(detail.idleAfterDays)} days.
          </p>
        ) : (
          <PlatformTable label={`People: ${part.name}`} minWidth={760}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>What</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.people.map((p) => (
                <TableRow key={p.userId}>
                  <TableCell>
                    {p.fullName ?? <span className="text-muted-foreground">No name</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.email}</TableCell>
                  <TableCell>{briefingRoleLabel(p.role)}</TableCell>
                  <TableCell>
                    {p.notes.map((note) => (
                      <span key={note} className="block">
                        {note}
                      </span>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </PlatformTable>
        )}
        {detail?.peopleTruncated ? (
          <p className="text-muted-foreground text-[12.5px]">
            And more: only the first {num(detail.people.length)} are listed.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-foreground text-[13px] font-medium">
          Admin and sign-in policy changes, last 30 days
        </h3>
        {detail === null ? (
          <p className="text-muted-foreground text-[13px]">{COULD_NOT_CHECK}.</p>
        ) : detail.changes.length === 0 ? (
          // "None in the last 30 days" only when every row of the 30 days was read.
          detail.changesTruncated ? null : (
            <p className="text-muted-foreground text-[13px]">
              No admin or sign-in policy change in the last 30 days.
            </p>
          )
        ) : (
          <PlatformTable label={`Admin and sign-in policy changes: ${part.name}`} minWidth={640}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead title={consoleZoneNote(timeZone)}>When</TableHead>
                <TableHead>What</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.changes.map((c, i) => (
                <TableRow key={`${c.at}-${i}`}>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                    <ConsoleMoment at={c.at} timeZone={timeZone} />
                  </TableCell>
                  <TableCell>{c.text}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </PlatformTable>
        )}
        {detail?.changesTruncated ? (
          <p className="text-muted-foreground text-[12.5px]">
            {detail.changes.length === 0
              ? `This list is made from the newest ${num(detail.changesRowsRead)} audit entries, and none of them is an admin or sign-in policy change.`
              : `This list is made from the newest ${num(detail.changesRowsRead)} audit entries.`}{' '}
            Older ones in the 30 days are not listed. This week&apos;s numbers above count every
            entry.
          </p>
        ) : null}
      </div>
    </>
  );
}

/**
 * THE SECURITY BRIEFING in the platform console: what happened this week
 * across every organization (counts only), and, with ?org=<uuid>, one
 * organization's briefing below it.
 *
 * A server component that reads with the service client: the page that
 * renders it must have called requirePlatformAdmin() first, and renders it
 * inside <Suspense>, after the Passkeys section, so a slow or failed
 * briefing never delays the passkey switches. A part that could not be read
 * is said in words, never shown as a zero.
 */
export async function PlatformSecurityBriefingSection({
  organizationId,
  actor,
  timeZone = null,
}: {
  /** The ?org= value, already checked to be a uuid; null without one. */
  organizationId: string | null;
  /** The platform admin the gate answered: who a view is recorded for. */
  actor: { userId: string; email: string };
  /** The viewer's chosen zone (lib/platform/viewer-time-zone), or null: UTC then. */
  timeZone?: string | null;
}) {
  const [platform, organization] = await Promise.all([
    readPlatformSecurityBriefing(),
    organizationId === null ? null : readOrganizationPart(organizationId, actor),
  ]);

  return (
    <section aria-label="Security briefing" className="flex flex-col gap-4">
      <AllOrganizations briefing={platform} />
      {organization ? <OneOrganization part={organization} timeZone={timeZone} /> : null}
    </section>
  );
}
