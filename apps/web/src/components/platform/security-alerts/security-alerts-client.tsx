'use client';

import * as React from 'react';

import { StatePanel } from '@/components/patterns/state-panel';
import { PlatformTable } from '@/components/platform/platform-table';
import { SecurityResponseButton } from '@/components/platform/security-response/security-response-button';
import { SecurityResponseHost } from '@/components/platform/security-response/security-response-host';
import {
  ConsoleMoment,
  consoleZoneNote,
  SECURITY_PAGES_CLOCK,
  ZonedWords,
} from '@/components/platform/zoned-time';
import { Button } from '@/components/ui/button';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { isControlFlow } from '@/lib/control-flow';
import { formatMomentInZone } from '@/lib/platform/dates';
import { formatExactUtc } from '@/lib/platform/last-active';
import { readPlatformSecurityAlertsAction } from '@/server/actions/platform/security-alerts';

import {
  ALERT_LIST_DEFAULT,
  SECURITY_ALERTS_FAILED,
  SECURITY_ALERTS_WORDS as W,
  securityAlertCardId,
  securityAlertChangeLabel,
  securityAlertChangeValueWords,
  securityAlertClassLabel,
  securityAlertCountsWords,
  securityAlertEventsFromMs,
  securityAlertPhaseLabel,
  securityAlertRuleLabel,
  securityAlertSendingLines,
  securityAlertsHeartbeatSay,
  securityAlertThresholdRows,
  securityAlertWhat,
  type SecurityAlertChangeView,
  type SecurityAlertRow,
  type SecurityAlertsResult,
  type SecurityAlertsView,
} from '@stockpilot/core';

/**
 * THE SECURITY ALERTS, as the console shows them (part 5, stage 4a: RECORD
 * ONLY). The first read comes from the section on the server; "Check again"
 * asks the Server Action, which asks the console's own rule first.
 *
 * WHAT IT SAYS, AND WHAT IT DOES NOT. Nothing is sent in this release: the
 * banner says so first, always. Each alert shows the disposition the
 * database recorded, in plain words, and what it would have done with a
 * channel on only as far as the record can say (the push budget, counted
 * with every switch off); the daily email caps and the choice to hold an
 * alert are not worked out while the switches are off, so the page says that
 * and invents neither. No line says anything was sent.
 *
 * Every time is in the viewer's chosen zone (their organization's Timezone
 * setting), else UTC, the same on the server and in the browser, with its
 * exact UTC in the title and for screen readers. The only organization name
 * is the one the list returns for an aimed alert.
 */

export interface SecurityAlertsClientProps {
  initial: SecurityAlertsResult;
  timeZone: string | null;
}

/** A time on this page in words, in the viewer's zone. */
const at = (iso: string, timeZone: string | null) =>
  formatMomentInZone(iso, timeZone ?? 'UTC', SECURITY_PAGES_CLOCK);

export function SecurityAlertsClient({ initial, timeZone }: SecurityAlertsClientProps) {
  const [result, setResult] = React.useState<SecurityAlertsResult>(initial);
  const [pending, startTransition] = React.useTransition();
  const checkAgain = () =>
    startTransition(async () => {
      try {
        setResult(await readPlatformSecurityAlertsAction({}));
      } catch (e) {
        // The router is already navigating (a redirect): stop quietly.
        if (isControlFlow(e)) return;
        setResult(SECURITY_ALERTS_FAILED);
      }
    });
  const again = (
    <Button
      type="button"
      variant="outline"
      className="max-sm:h-11"
      onClick={checkAgain}
      disabled={pending}
      aria-busy={pending || undefined}
    >
      {pending ? W.checking : W.checkAgain}
    </Button>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6" data-slot="security-alerts">
      <div
        role="note"
        data-slot="security-alerts-record-only"
        className="border-warning/40 bg-warning-wash rounded-lg border px-4 py-3"
      >
        <p className="text-foreground text-[14px] font-semibold">{W.recordOnlyBanner}</p>
        <p className="text-ink-2 mt-1 text-[13px]">{W.recordOnlyNote}</p>
        {result.ok && !result.view.state.recordOnly ? (
          <p className="text-ink-2 mt-1 text-[13px]">{W.channelOnNote}</p>
        ) : null}
      </div>

      {result.ok ? (
        <AlertsView view={result.view} timeZone={timeZone} again={again} />
      ) : result.reason === 'refused' ? (
        <StatePanel kind="forbidden" title={W.refused} live="polite" />
      ) : (
        <StatePanel kind="failed" title={W.couldNotCheck} live="polite" action={again} />
      )}
    </div>
  );
}

function AlertsView({
  view,
  timeZone,
  again,
}: {
  view: SecurityAlertsView;
  timeZone: string | null;
  again: React.ReactNode;
}) {
  const readAt = Date.parse(view.generatedAt);
  const zoneNote = consoleZoneNote(timeZone, readAt);
  return (
    <>
      <JobSection view={view} timeZone={timeZone} again={again} />
      <AlertsSection view={view} timeZone={timeZone} zoneNote={zoneNote} />
      <ThresholdsSection view={view} />
      <ChangesSection
        heading={W.latestChangesHeading}
        label="Who set each value in force"
        changes={view.latestChanges}
        truncated={false}
        timeZone={timeZone}
        zoneNote={zoneNote}
        empty={W.noChanges}
      />
      <ChangesSection
        heading={W.changesHeading}
        label="Change history"
        changes={view.changes}
        truncated={view.changesTruncated}
        timeZone={timeZone}
        zoneNote={zoneNote}
        empty={W.noChanges}
      />
    </>
  );
}

/* ─────────────────────────────── the job ─────────────────────────────── */

function JobSection({
  view,
  timeZone,
  again,
}: {
  view: SecurityAlertsView;
  timeZone: string | null;
  again: React.ReactNode;
}) {
  const say = securityAlertsHeartbeatSay(view.state.heartbeat, Date.parse(view.generatedAt));
  const t = view.state.thresholds;
  const b = view.state.baseline;
  const lines: Array<{ key: string; at: string | null; text: string; warning: boolean }> = [];
  if (say.lastChecked.kind === 'never') {
    lines.push({ key: 'never', at: null, text: W.notRunYet, warning: true });
  } else if (say.lastChecked.kind === 'never_ok') {
    lines.push({ key: 'never_ok', at: null, text: W.noGoodCheckYet, warning: true });
  } else {
    const when = say.lastChecked.at;
    lines.push({ key: 'last', at: when, text: W.lastChecked(at(when, timeZone)), warning: false });
  }
  if (say.running) {
    lines.push({
      key: 'running',
      at: say.running,
      text: W.running(at(say.running, timeZone)),
      warning: false,
    });
  }
  if (say.lastFailed) {
    lines.push({
      key: 'failed',
      at: say.lastFailed,
      text: W.lastFailed(at(say.lastFailed, timeZone)),
      warning: true,
    });
  }
  if (say.partial) lines.push({ key: 'partial', at: null, text: W.partial, warning: true });
  if (say.missed) {
    lines.push({
      key: 'missed',
      at: say.missed,
      text: W.missed(at(say.missed, timeZone)),
      warning: true,
    });
  }
  if (say.failures !== null) {
    lines.push({ key: 'failures', at: null, text: W.failures(say.failures), warning: true });
    if (say.failureReportedAt) {
      lines.push({
        key: 'reported',
        at: say.failureReportedAt,
        text: W.failureReported(at(say.failureReportedAt, timeZone)),
        warning: false,
      });
    }
  }

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-foreground text-[15px] font-semibold">{W.heartbeatHeading}</h2>
        {again}
      </div>
      <ul className="flex flex-col gap-1.5 text-[13.5px]" data-slot="security-alerts-heartbeat">
        {lines.map((line) => (
          <li
            key={line.key}
            data-warning={line.warning || undefined}
            className={line.warning ? 'text-warning font-medium' : 'text-ink-2'}
          >
            {line.warning ? <span className="sr-only">Warning: </span> : null}
            <ZonedWords at={line.at} text={line.text} />
          </li>
        ))}
      </ul>
      <ul className="text-muted-foreground flex flex-col gap-1.5 text-[13px]">
        <li>
          {b.eventHigh === null || b.sourceHigh === null || b.computedAt === null ? (
            W.spikeNoBaseline
          ) : (
            <ZonedWords
              at={b.computedAt}
              text={W.spikeBaseline(
                at(b.computedAt, timeZone),
                b.eventHigh,
                b.sourceHigh,
                t.spike_learning_days,
              )}
            />
          )}
          {b.shortened ? ` ${W.spikeShortened}` : null}
        </li>
        <li>{W.budget(view.budget, t)}</li>
        {view.state.plannedCheckUntil ? (
          <li>
            <ZonedWords
              at={view.state.plannedCheckUntil}
              text={W.plannedCheck(at(view.state.plannedCheckUntil, timeZone))}
            />
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/* ─────────────────────────────── the alerts ─────────────────────────────── */

function AlertsSection({
  view,
  timeZone,
  zoneNote,
}: {
  view: SecurityAlertsView;
  timeZone: string | null;
  zoneNote: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div>
        <h2 className="text-foreground text-[15px] font-semibold">{W.alertsHeading}</h2>
        <p className="text-muted-foreground text-[12.5px]">{zoneNote}</p>
      </div>
      {/* The how-to-respond panel's host: one for the list. */}
      <SecurityResponseHost>
        <PlatformTable label="Latest alerts" minWidth={1100}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead title={zoneNote}>{W.columns.when}</TableHead>
              <TableHead>{W.columns.alert}</TableHead>
              <TableHead>{W.columns.phase}</TableHead>
              <TableHead>{W.columns.counts}</TableHead>
              <TableHead>{W.columns.would}</TableHead>
              <TableHead>
                <span className="sr-only">{W.columns.respond}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.alerts.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <StatePanel
                    kind="empty"
                    surface="plain"
                    headingLevel={null}
                    icon={null}
                    title={W.noAlerts}
                  />
                </TableCell>
              </TableRow>
            ) : (
              view.alerts.map((alert, i) => (
                <AlertRow
                  key={`${alert.rule}|${alert.subject}|${alert.eventKey}|${alert.phase}|${i}`}
                  alert={alert}
                  timeZone={timeZone}
                />
              ))
            )}
          </TableBody>
        </PlatformTable>
      </SecurityResponseHost>
      {view.alertsTruncated ? (
        <p className="text-muted-foreground text-[12.5px]">
          {W.alertsTruncated(ALERT_LIST_DEFAULT)}
        </p>
      ) : null}
    </section>
  );
}

function AlertRow({ alert, timeZone }: { alert: SecurityAlertRow; timeZone: string | null }) {
  const what = securityAlertWhat(alert);
  const from = securityAlertEventsFromMs(alert);
  const fromIso = from === null ? null : new Date(from).toISOString();
  const cardId = securityAlertCardId(alert);
  const organization =
    alert.rule === 'aimed_guessing' ? (alert.organizationName ?? alert.subject) : null;
  return (
    <TableRow data-rule={alert.rule} data-disposition={alert.disposition}>
      <TableCell className="text-muted-foreground whitespace-nowrap align-top text-[12.5px]">
        <ConsoleMoment at={alert.claimedAt} timeZone={timeZone} />
        {fromIso ? (
          <span className="block text-[12px]">
            Events from <ConsoleMoment at={fromIso} timeZone={timeZone} />
          </span>
        ) : null}
      </TableCell>
      <TableCell className="align-top">
        <span className="text-foreground">{what}</span>
        <span className="text-muted-foreground block text-[12px]">
          {securityAlertRuleLabel(alert.rule)} · {securityAlertClassLabel(alert.class)}
        </span>
        {organization ? (
          <span
            className={
              alert.organizationName
                ? 'text-ink-2 block text-[12px]'
                : 'text-muted-foreground block font-mono text-[12px]'
            }
          >
            {organization}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="whitespace-nowrap align-top">
        {securityAlertPhaseLabel(alert)}
        {alert.stateEndedAt && alert.phase !== 'ended' ? (
          <span className="text-muted-foreground block text-[12px]">
            Ended <ConsoleMoment at={alert.stateEndedAt} timeZone={timeZone} />
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-ink-2 align-top text-[12.5px]">
        {securityAlertCountsWords(alert.counts)}
      </TableCell>
      <TableCell className="align-top">
        <ul className="flex flex-col gap-1 text-[12.5px]">
          {securityAlertSendingLines(alert).map((line, i) => (
            <li key={i} className={i === 0 ? 'text-foreground' : 'text-ink-2'}>
              {line}
            </li>
          ))}
        </ul>
      </TableCell>
      <TableCell className="whitespace-nowrap align-top">
        {cardId !== null ? (
          <SecurityResponseButton
            oneLine
            request={{
              cardId,
              what,
              // What this row shows already, and nothing else.
              context: {
                kind: securityAlertRuleLabel(alert.rule),
                place: null,
                time: at(alert.claimedAt, timeZone),
                timeUtc: formatExactUtc(alert.claimedAt),
                organization,
              },
              organizationId: alert.rule === 'aimed_guessing' ? alert.subject : null,
            }}
          />
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/* ─────────────────────────────── thresholds ─────────────────────────────── */

function ThresholdsSection({ view }: { view: SecurityAlertsView }) {
  const rows = securityAlertThresholdRows(view.state.thresholds);
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div>
        <h2 className="text-foreground text-[15px] font-semibold">{W.thresholdsHeading}</h2>
        <p className="text-muted-foreground text-[12.5px]">{W.thresholdsNote}</p>
      </div>
      <PlatformTable label="Thresholds" minWidth={640}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{W.columns.setting}</TableHead>
            <TableHead className="text-right">{W.columns.value}</TableHead>
            <TableHead className="text-right">{W.columns.defaultValue}</TableHead>
            <TableHead>
              <span className="sr-only">Notes</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.name}
              data-threshold={row.name}
              data-differs={row.differs || undefined}
            >
              <TableCell>{row.label}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {row.value.toLocaleString('en-US')}
              </TableCell>
              <TableCell className="text-muted-foreground text-right font-mono tabular-nums">
                {row.defaultValue.toLocaleString('en-US')}
              </TableCell>
              <TableCell className="text-[12.5px]">
                {row.differs ? <span className="text-ink-2 block">Not its default.</span> : null}
                {row.warning ? (
                  <span className="text-warning block font-medium">
                    <span className="sr-only">Warning: </span>
                    {row.warning}
                  </span>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </PlatformTable>
    </section>
  );
}

/* ─────────────────────────────── changes ─────────────────────────────── */

function ChangesSection({
  heading,
  label,
  changes,
  truncated,
  timeZone,
  zoneNote,
  empty,
}: {
  heading: string;
  label: string;
  changes: SecurityAlertChangeView[];
  truncated: boolean;
  timeZone: string | null;
  zoneNote: string;
  empty: string;
}) {
  const value = (c: SecurityAlertChangeView, v: SecurityAlertChangeView['oldValue']) =>
    securityAlertChangeValueWords(c.name, v, (iso) => at(iso, timeZone));
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="text-foreground text-[15px] font-semibold">{heading}</h2>
      <PlatformTable label={label} minWidth={760}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead title={zoneNote}>{W.columns.when}</TableHead>
            <TableHead>{W.columns.setting}</TableHead>
            <TableHead>{W.columns.from}</TableHead>
            <TableHead>{W.columns.to}</TableHead>
            <TableHead>{W.columns.who}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {changes.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={5} className="p-0">
                <StatePanel
                  kind="empty"
                  surface="plain"
                  headingLevel={null}
                  icon={null}
                  title={empty}
                />
              </TableCell>
            </TableRow>
          ) : (
            changes.map((c, i) => (
              <TableRow key={`${c.changedAt}|${c.name}|${i}`}>
                <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                  <ConsoleMoment at={c.changedAt} timeZone={timeZone} />
                </TableCell>
                <TableCell>{securityAlertChangeLabel(c.name)}</TableCell>
                <TableCell className="text-muted-foreground">{value(c, c.oldValue)}</TableCell>
                <TableCell>{value(c, c.newValue)}</TableCell>
                <TableCell className="text-ink-2">{c.actorEmail ?? 'A platform admin'}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </PlatformTable>
      {truncated ? (
        <p className="text-muted-foreground text-[12.5px]">
          {W.changesTruncated(ALERT_LIST_DEFAULT)}
        </p>
      ) : null}
    </section>
  );
}
