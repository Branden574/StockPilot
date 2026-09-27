import { notFound } from 'next/navigation';

import {
  LocationBackLink,
  LocationVerificationUnavailable,
  LocationVerificationView,
} from '@/components/locations/location-verification';
import { isNextControlFlowError, reportError } from '@/lib/error-reporter';
import { canOpenCountPage } from '@/lib/verification/count-page-access';
import { ServiceError, withContext, type ServiceContext } from '@/server/services/context';
import { VerificationService, type LocationVerification } from '@/server/services/verification';

import { uuidSchema, verificationRefusalOf, type VerificationRefusal } from '@stockpilot/core';

export const metadata = { title: 'Location' };

/**
 * ONE LOCATION (F1-3): its name, kind and warehouse, the open exceptions
 * recorded here, and every item held here with when it was last physically
 * counted, 50 to a page with totals across all of them. Linked from the
 * Locations list and from an exception's location.
 *
 * The facts are VerificationService.location, the same answer the phone gets
 * from GET /api/v1/locations/[id]/verification: holdings read in full under
 * the reader's RLS (fetchAllRows), summaries in 500-id batches, items the
 * reader cannot open counted rather than listed, and "not in your warehouses"
 * rather than an empty location when the reader's warehouses do not cover it.
 *
 * WHO. items:read (with the MFA step-up), like the Exception Center. Without
 * it, for a location that does not exist in this organization, or for a
 * malformed link, the page says "Couldn't load verification" and why, in the
 * phone's words (core verificationRefusalCopy: not found and not visible are
 * the same answer, so existence is not leaked). Any other failure is reported
 * and says "Couldn't load verification", never an empty page. A manager who
 * can start counts also gets "Recount items here".
 *
 * `?page=` is 1-based; anything else reads as page 1, and a page past the end
 * shows the last page (the service clamps it).
 */
function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw !== undefined && /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : 1;
}

export default async function LocationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ page?: string | string[] }>;
}) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) {
    // The phone refuses a malformed id before any read, with these words.
    return <Refused refusal="invalid_id" />;
  }
  const page = parsePage((await searchParams)?.page);

  let ctx: ServiceContext;
  try {
    ctx = await withContext();
  } catch (e) {
    if (e instanceof ServiceError && (e.code === 'forbidden' || e.code === 'not_found')) notFound();
    throw e;
  }

  let data: LocationVerification | null;
  try {
    data = await new VerificationService(ctx).location(id, { page });
  } catch (e) {
    if (isNextControlFlowError(e)) throw e;
    // A refusal the service authored is an answer, not a failure: said, not
    // reported.
    const refusal =
      e instanceof ServiceError ? verificationRefusalOf(e.code, e.details?.reason) : null;
    if (refusal) return <Refused refusal={refusal} />;
    void reportError(e, { tag: 'locations.verification_page', organizationId: ctx.organizationId });
    data = null;
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <LocationBackLink archived={data?.location.archived ?? false} />
      {data === null ? (
        <LocationVerificationUnavailable />
      ) : (
        <LocationVerificationView data={data} canOpenCounts={canOpenCountPage(ctx)} />
      )}
    </div>
  );
}

function Refused({ refusal }: { refusal: VerificationRefusal }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <LocationBackLink />
      <LocationVerificationUnavailable refusal={refusal} />
    </div>
  );
}
