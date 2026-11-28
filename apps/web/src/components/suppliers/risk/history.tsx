import Link from 'next/link';
import type { ReactNode } from 'react';

import { VENDOR_RISK_ITEM_STATUS_WORDS, vendorRiskQuestion } from '@stockpilot/core';

import {
  supplierRiskDay,
  supplierRiskEventWords,
  supplierRiskResultWords,
} from '@/lib/supplier-risk/words';
import type {
  SupplierRiskEvent,
  SupplierRiskEventItemState,
  SupplierRiskEventsPage,
  SupplierRiskRead,
} from '@/server/services/supplier-risk';

import { SupplierRiskTime } from './when';

function statusWords(status: string | null): string {
  if (!status) return 'none';
  return (VENDOR_RISK_ITEM_STATUS_WORDS as Record<string, string>)[status] ?? status;
}

function Owner({ name, deleted }: { name: string | null; deleted: boolean }) {
  if (!name) return <>no owner</>;
  return (
    <>
      <bdi>{name}</bdi>
      {deleted ? ' (account deleted)' : null}
    </>
  );
}

/** What changed on an item, field by field, only where before and after differ. */
function ItemChanges({
  before,
  after,
}: {
  before: SupplierRiskEventItemState | null;
  after: SupplierRiskEventItemState | null;
}) {
  if (!after) return null;
  const b = before ?? { status: null, ownerName: null, ownerDeleted: false, dueOn: null };
  const lines: ReactNode[] = [];
  if (b.status !== after.status) {
    lines.push(
      <li key="status">
        {before
          ? `Status changed from ${statusWords(b.status)} to ${statusWords(after.status)}.`
          : `Status: ${statusWords(after.status)}.`}
      </li>,
    );
  }
  if (b.ownerName !== after.ownerName || b.ownerDeleted !== after.ownerDeleted) {
    lines.push(
      <li key="owner">
        {before ? (
          <>
            Owner changed from <Owner name={b.ownerName} deleted={b.ownerDeleted} /> to{' '}
            <Owner name={after.ownerName} deleted={after.ownerDeleted} />.
          </>
        ) : (
          <>
            Owner: <Owner name={after.ownerName} deleted={after.ownerDeleted} />.
          </>
        )}
      </li>,
    );
  }
  if (b.dueOn !== after.dueOn) {
    const day = (d: string | null) => (d ? supplierRiskDay(d) : 'none');
    lines.push(
      <li key="due">
        {before
          ? `Due changed from ${day(b.dueOn)} to ${day(after.dueOn)}.`
          : `Due: ${day(after.dueOn)}.`}
      </li>,
    );
  }
  return lines.length > 0 ? <ul className="list-disc space-y-0.5 pl-5">{lines}</ul> : null;
}

function EventRow({ e, timeZone }: { e: SupplierRiskEvent; timeZone: string }) {
  const question = e.questionKey
    ? (vendorRiskQuestion(e.questionKey)?.text ?? e.questionKey)
    : null;
  const { computedResult, result, reason, version } = e.detail;
  return (
    <li className="space-y-1 py-3" data-event={e.event}>
      <p className="text-foreground text-[13.5px] font-medium">
        {supplierRiskEventWords(e.event)}
        {version !== null ? (
          <span className="text-muted-foreground font-normal"> · Version {version}</span>
        ) : null}
      </p>
      <p className="text-muted-foreground text-[12px]">
        <SupplierRiskTime at={e.at} timeZone={timeZone} clock />
        {e.actorName ? (
          <>
            {' by '}
            <bdi>{e.actorName}</bdi>
            {e.actorAccountDeleted ? ' (account since deleted)' : null}
          </>
        ) : null}
      </p>
      <div className="text-ink-2 space-y-1 text-[13px] leading-5">
        {question ? <p>{question}</p> : null}
        {computedResult && result && computedResult !== result ? (
          <p>
            The rules gave {supplierRiskResultWords(computedResult)}; the result is{' '}
            {supplierRiskResultWords(result)}.
          </p>
        ) : result ? (
          <p>Result: {supplierRiskResultWords(result)}.</p>
        ) : null}
        <ItemChanges before={e.detail.before} after={e.detail.after} />
        {reason ? (
          <p>
            Reason:{' '}
            <span className="whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">
              {reason}
            </span>
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * THE HISTORY of a supplier's reviews, newest first: the database's own
 * record of each privileged write (a draft discarded, a review finished, a
 * result set by an admin, an item changed with its before and after, a risk
 * accepted with its reason), for owners and admins only. It is never the
 * shared audit log, which managers read. Every value is text: names in
 * <bdi>, a reason exactly as written, an event this page does not know by the
 * database's own word. Times are in the organization's zone, with the exact
 * UTC instant beside them. A history that could not be read says so.
 */
export function SupplierRiskHistory({
  read,
  timeZone,
  olderHref,
  newestHref,
}: {
  read: SupplierRiskRead<SupplierRiskEventsPage>;
  timeZone: string;
  /** The next page's address, or null when this is the last. */
  olderHref: string | null;
  /** The first page's address when this is a later one; else null. */
  newestHref: string | null;
}) {
  if (read.state !== 'ok') {
    return (
      <p role="status" className="text-ink-2 text-[13px]" data-slot="supplier-risk-history">
        The history could not be checked just now. This is not the same as no history: reload the
        page to try again.
      </p>
    );
  }
  const { events } = read.value;
  return (
    <div data-slot="supplier-risk-history">
      {events.length === 0 ? (
        <p className="text-ink-2 text-[13px]">
          {newestHref ? 'No older changes.' : 'No change recorded yet.'}
        </p>
      ) : (
        <ol className="divide-border divide-y">
          {events.map((e) => (
            <EventRow key={e.id} e={e} timeZone={timeZone} />
          ))}
        </ol>
      )}
      {olderHref || newestHref ? (
        <p className="flex flex-wrap gap-4 pt-2 text-[13px]">
          {newestHref ? (
            <Link href={newestHref} className="text-accent underline-offset-4 hover:underline">
              Newest changes
            </Link>
          ) : null}
          {olderHref ? (
            <Link href={olderHref} className="text-accent underline-offset-4 hover:underline">
              Older changes
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
