import Link from 'next/link';

import { PoScanForm } from '@/components/po-imports/po-scan-form';
import { PoUploadForm } from '@/components/po-imports/po-upload-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function NewPoImportPage() {
  return (
    <div className="container mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/purchase-orders/imports"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to imports
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New PO import</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Two ways to bring a PO in: scan a photo or PDF for AI extraction,
          or upload a CSV / structured PDF for the deterministic parser.
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scan with AI</CardTitle>
            <CardDescription>
              Photo of a printed PO or a PDF — AI vision extracts vendor,
              line items, qty, and totals. Confidence is shown per line; you
              review and approve.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PoScanForm />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload CSV / structured PDF</CardTitle>
            <CardDescription>
              Faster and 100% accurate when your supplier exports a clean CSV
              or structured PDF (Amazon Business, QuickBooks, NetSuite, etc.).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PoUploadForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
