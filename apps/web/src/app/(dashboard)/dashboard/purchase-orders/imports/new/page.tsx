import Link from 'next/link';

import { PoUploadForm } from '@/components/po-imports/po-upload-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload</CardTitle>
        </CardHeader>
        <CardContent>
          <PoUploadForm />
        </CardContent>
      </Card>
    </div>
  );
}
