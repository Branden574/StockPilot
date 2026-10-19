import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';

/**
 * The report MFA step-up state (matrix W-RP-00): what a report page shows in
 * place of its data when the organization's MFA policy refuses the read, so
 * the person sees what to do instead of an error page.
 *
 * Only the look lives here. The decision (which variant, where the link goes)
 * and the words stay in the locked `lib/reports/report-page-gate.tsx`
 * (`REPORT_MFA_ENROLL` / `REPORT_MFA_VERIFY`), which renders this card; the
 * gate test pins the alert text, the link name and its URL.
 *
 * The card sits on the caution wash with a caution hairline (DESIGN-SPEC 2.2
 * washes), inside the page's gutters like the module-off state beside it, and
 * stays `role="alert"` so it is announced when the page opens. The way out is
 * the ink button: it commits the work in front of the person (verify, or set
 * up two-step verification).
 */
export function ReportMfaCard({
  message,
  href,
  actionLabel,
}: {
  message: string;
  href: string;
  actionLabel: string;
}) {
  return (
    <div data-slot="report-mfa-state" className="w-full px-4 py-16 sm:px-8 sm:py-24">
      <div
        role="alert"
        className="border-warning/40 bg-warning-wash mx-auto flex max-w-2xl items-start gap-3 rounded-lg border p-[18px]"
      >
        <ShieldAlert
          aria-hidden
          className="text-warning mt-px h-5 w-5 shrink-0"
          strokeWidth={1.75}
        />
        <div className="min-w-0 space-y-3">
          <p className="text-foreground text-[13.5px] leading-[20.25px]">{message}</p>
          <Button asChild size="sm">
            <Link href={href}>{actionLabel}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
