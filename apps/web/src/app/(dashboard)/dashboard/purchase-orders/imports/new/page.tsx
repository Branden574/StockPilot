import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { PoScanForm } from '@/components/po-imports/po-scan-form';
import { PoUploadForm } from '@/components/po-imports/po-upload-form';
import { checkModuleAccess } from '@/lib/modules/module-gate';

/** The page area (DESIGN-SPEC 4 and 5.3), the same box the imports list draws. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** Both upload cards at a reading width. */
const FORM_WIDTH = 'w-full max-w-[880px]';

export default async function NewPoImportPage() {
  // The imports list's own module gate. With PO imports switched off every
  // upload and scan action refuses on the server, so the page says the module
  // is off (the list's words and Enable link) instead of offering two forms
  // that cannot work. The module set is the request-cached read the dashboard
  // layout already made, so this adds no query.
  const moduleAccess = await checkModuleAccess('po_imports');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="po_imports" canManage={moduleAccess.canManage} />;
  }

  return (
    <div className={PAGE}>
      <PageHeader
        back={
          <PageHeaderBackLink href="/dashboard/purchase-orders/imports">
            ← Back to imports
          </PageHeaderBackLink>
        }
        title="New PO import"
        subline="Two ways to bring a PO in: scan a photo or PDF for AI extraction, or upload a CSV / structured PDF for the deterministic parser."
        className={FORM_WIDTH}
      />

      {/* The two ways in, one card each (DESIGN-SPEC 6.7), with the card's
          own explanation under its title. */}
      <div className={`${FORM_WIDTH} flex flex-col gap-4`}>
        <UploadCard
          id="po-import-scan"
          title="Scan with AI"
          description="Photo of a printed PO or a PDF — AI vision extracts vendor, line items, qty, and totals. Confidence is shown per line; you review and approve."
        >
          <PoScanForm />
        </UploadCard>

        <UploadCard
          id="po-import-upload"
          title="Upload CSV / structured PDF"
          description="Faster and 100% accurate when your supplier exports a clean CSV or structured PDF (Amazon Business, QuickBooks, NetSuite, etc.)."
        >
          <PoUploadForm />
        </UploadCard>
      </div>
    </div>
  );
}

/** A form card: the 13.5 / 500 title and its quiet explanation in the header,
 *  the form in an 18 px body. */
function UploadCard({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="border-border bg-card text-card-foreground min-w-0 rounded-lg border"
    >
      <div className="border-border border-b px-[18px] py-3.5">
        <h2 id={id} className="text-foreground text-[13.5px] font-medium leading-5">
          {title}
        </h2>
        <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-[18.75px]">
          {description}
        </p>
      </div>
      <div className="p-[18px]">{children}</div>
    </section>
  );
}
