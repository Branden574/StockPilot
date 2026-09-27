import { AlertTriangle, ClipboardCheck } from 'lucide-react';
import Link from 'next/link';

import {
  formatCycleCountNumber,
  VERIFICATION_UNAVAILABLE_COPY,
  verificationIssueChipCopy,
  verificationRefusalCopy,
  verificationRefusalOf,
  verificationSummaryCopy,
  type VerificationRefusal,
} from '@stockpilot/core';

import { exceptionTime } from '@/components/exceptions/occurrence-display';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { isNextControlFlowError, reportError } from '@/lib/error-reporter';
import { canOpenCountPage } from '@/lib/verification/count-page-access';
import { ServiceError, withContext } from '@/server/services/context';
import { VerificationService, type ItemVerification } from '@/server/services/verification';

/**
 * "LAST PHYSICAL COUNT" FOR ONE ITEM (F1-3), on the item page and on an
 * exception's page.
 *
 * What the item's latest physical count found, who counted and posted it,
 * what it covered, how many recorded stock movements came after it, the book
 * now, an open count holding the item, and the item's open exceptions. Every
 * word comes from core verificationSummaryCopy, the same words the phone
 * shows, so the item never reads two ways. Nothing here says "verified" or
 * shows a percentage: a count is what was recorded at a moment, not a
 * guarantee about the shelf now.
 *
 * OFF THE CRITICAL PATH. The pages render this under <Suspense> with
 * ItemVerificationCardSkeleton as the fallback, so the page never waits for
 * item_verification_summaries: the card makes its own read and streams in
 * when it answers (item-detail.parallel-reads.test.tsx pins it).
 *
 * A FAILED READ SAYS SO. Any failure other than a refusal is reported and
 * renders "Couldn't load verification" (role="alert"), never "No physical
 * count on record.": an error must not read as a fact. A REFUSAL (not found,
 * not permitted, the MFA step-up, a bad id) is not reported and says why,
 * under the same headline, in the phone card's words (core
 * verificationRefusalCopy), so the two platforms show the same card.
 */

export interface ItemVerificationCardProps {
  itemId: string;
  /** Where "N recorded stock movements since" links: the item's Movements tab. */
  movementsHref: string;
  /** An exception's page leaves its own exception out of the chips. */
  excludeIssueId?: string | null;
}

export async function ItemVerificationCard({
  itemId,
  movementsHref,
  excludeIssueId = null,
}: ItemVerificationCardProps) {
  let data: ItemVerification | null;
  let refusal: VerificationRefusal | null = null;
  let canOpenCounts = false;
  let organizationId: string | undefined;
  try {
    const ctx = await withContext();
    organizationId = ctx.organizationId;
    canOpenCounts = canOpenCountPage(ctx);
    data = await new VerificationService(ctx).item(itemId);
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    data = null;
    // A refusal is an answer (said, not reported); anything else is a read
    // that failed.
    refusal = e instanceof ServiceError ? verificationRefusalOf(e.code, e.details?.reason) : null;
    if (!refusal) void reportError(e, { tag: 'inventory.item_verification', organizationId });
  }
  return (
    <ItemVerificationCardView
      data={data}
      refusal={refusal}
      canOpenCounts={canOpenCounts}
      movementsHref={movementsHref}
      excludeIssueId={excludeIssueId}
    />
  );
}

function CardShell({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardCheck className="h-4 w-4" aria-hidden /> Physical count
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">{children}</CardContent>
    </Card>
  );
}

/** The card's fallback while the summary streams in. */
export function ItemVerificationCardSkeleton() {
  return (
    <CardShell testId="item-verification-card-loading">
      <div aria-busy="true" className="space-y-2">
        <span className="sr-only">Loading the last physical count</span>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </CardShell>
  );
}

/** The card from an answer (null: the read failed, or was refused when
 *  `refusal` says why). Exported for tests. */
export function ItemVerificationCardView({
  data,
  refusal = null,
  canOpenCounts,
  movementsHref,
  excludeIssueId = null,
}: {
  data: ItemVerification | null;
  refusal?: VerificationRefusal | null;
  canOpenCounts: boolean;
  movementsHref: string;
  excludeIssueId?: string | null;
}) {
  if (data === null) {
    return (
      <CardShell testId="item-verification-card">
        <div
          role="alert"
          className="border-warning/40 bg-warning/5 flex items-start gap-2 rounded-md border px-3 py-2"
        >
          <AlertTriangle className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
          {refusal ? (
            <div className="space-y-1">
              <p className="font-medium">{VERIFICATION_UNAVAILABLE_COPY}</p>
              <p data-testid="verification-refusal">{verificationRefusalCopy(refusal, 'item')}</p>
            </div>
          ) : (
            <p>{VERIFICATION_UNAVAILABLE_COPY}. Reload the page to try again.</p>
          )}
        </div>
      </CardShell>
    );
  }

  // "Count this item" is not offered here: the item page carries the same
  // button in its header (same gate), and an exception's page offers Recount
  // only where a count can settle the exception (F1 does not recount holding
  // rules).
  const copy = verificationSummaryCopy(data.summary, { timeZone: data.timeZone });
  const countHref = (id: string) => `/dashboard/cycle-counts/${id}`;
  const issues = data.openIssues.filter((i) => i.id !== excludeIssueId);
  // The count's reference ("CC-000031") never breaks at its hyphen on a
  // narrow screen: the headline's last part is kept on one line.
  const ref = formatCycleCountNumber(data.summary.lastCount?.countNumber ?? null);
  const headline =
    ref && copy.headline.endsWith(ref) ? (
      <>
        {copy.headline.slice(0, -ref.length)}
        <span className="whitespace-nowrap">{ref}</span>
      </>
    ) : (
      copy.headline
    );

  return (
    <CardShell testId="item-verification-card">
      <p className="font-medium" data-testid="verification-headline">
        {copy.countId && canOpenCounts ? (
          <Link href={countHref(copy.countId)} className="hover:underline">
            {headline}
          </Link>
        ) : (
          headline
        )}
      </p>
      {copy.result ? <p data-testid="verification-result">{copy.result}</p> : null}
      {copy.scope ? <p className="text-muted-foreground">{copy.scope}</p> : null}
      {copy.who || copy.capture || copy.aiAssisted ? (
        <div className="text-muted-foreground space-y-0.5 text-xs">
          {copy.who ? <p>{copy.who}</p> : null}
          {copy.capture ? <p>{copy.capture}</p> : null}
          {copy.aiAssisted ? <p>{copy.aiAssisted}</p> : null}
        </div>
      ) : null}
      {copy.movementsSince ? (
        <p data-testid="verification-movements">
          {data.summary.movementsSince !== null ? (
            <Link href={movementsHref} className="hover:underline">
              {copy.movementsSince}
            </Link>
          ) : (
            <span className="text-muted-foreground">{copy.movementsSince}</span>
          )}
        </p>
      ) : null}
      {copy.outsideLedger ? (
        <p className="text-warning" data-testid="verification-outside-ledger">
          {copy.outsideLedger}
        </p>
      ) : null}
      {copy.onRecordNow ? <p className="tabular-nums">{copy.onRecordNow}</p> : null}
      {copy.beingCounted ? (
        <p data-testid="verification-being-counted">
          {canOpenCounts ? (
            <Link href={countHref(copy.beingCounted.cycleCountId)} className="hover:underline">
              {copy.beingCounted.text}
            </Link>
          ) : (
            copy.beingCounted.text
          )}
        </p>
      ) : null}
      {copy.notCountable ? (
        <p className="text-muted-foreground" data-testid="verification-not-countable">
          {copy.notCountable}
        </p>
      ) : null}

      {issues.length > 0 ? (
        <div className="space-y-1 pt-1" data-testid="verification-issues">
          <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
            {excludeIssueId ? 'Other open exceptions' : 'Open exceptions'}
          </p>
          <VerificationIssueChips issues={issues} />
          {data.openIssuesTruncated ? (
            <p className="text-muted-foreground text-xs">
              More open exceptions exist than are shown here.
            </p>
          ) : null}
          {data.checkedAt ? (
            <p className="text-muted-foreground text-xs">
              Checked at {exceptionTime(data.checkedAt, data.timeZone)}.
            </p>
          ) : null}
        </div>
      ) : null}
    </CardShell>
  );
}

/** Open exceptions as chips, each linking to its page. Shared with the
 *  location page. */
export function VerificationIssueChips({
  issues,
}: {
  issues: ReadonlyArray<{ id: string; number: number | null; rule: string }>;
}) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {issues.map((i) => (
        <li key={i.id} data-testid="verification-issue-chip">
          <Link
            href={`/dashboard/exceptions/${i.id}`}
            className="border-border hover:bg-muted inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium"
          >
            {verificationIssueChipCopy(i)}
          </Link>
        </li>
      ))}
    </ul>
  );
}
