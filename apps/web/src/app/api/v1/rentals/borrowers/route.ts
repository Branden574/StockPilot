import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { RentalsService } from '@/server/services/rentals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The team members a rental can be checked out to, for the phone's New rental
 * borrower search: the Bearer twin of what the web New rental page hands its
 * BorrowerPicker. Both come from RentalsService.listBorrowerMembers, one query.
 *
 * WHO MAY CALL IT AND WHAT IT SHOWS. rentals:create (and the Rentals module),
 * the web page's own gate. The rows are read with the CALLER's client, so
 * user_profiles RLS decides which members, and which emails, come back: any
 * accepted member may already read a co-member's profile (0003
 * user_profiles_select_orgmates), and this adds no reach beyond that. No
 * service-role read, and nothing but id, name and email in the answer.
 *
 * The existing Bearer roster (/api/v1/maintenance-requests/members) is not
 * reused: it is gated on maintenance_requests:manage, which a rental operator
 * need not hold, and it returns no email, which a rental needs.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  try {
    const members = await new RentalsService(ctx).listBorrowerMembers();
    return NextResponse.json({ members });
  } catch (e) {
    if (e instanceof ServiceError && e.code !== 'internal_error') {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    // Never the error's own text (S13): the detail goes to the reporter.
    void reportError(
      e instanceof ServiceError ? new Error(e.internalDetail ?? e.message) : e,
      { tag: 'api.v1.rentals.borrowers', organizationId: ctx.organizationId },
    );
    return NextResponse.json(
      { error: 'internal_error', message: 'Could not load team members. Please try again.' },
      { status: 500 },
    );
  }
}
