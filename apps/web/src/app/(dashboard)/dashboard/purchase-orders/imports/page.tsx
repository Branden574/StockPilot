import Link from 'next/link';

import { PoImportStatusBadge } from '@/components/po-imports/po-import-status-badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PoImportsService } from '@/server/services/po-imports';
import { formatRelative } from '@/lib/utils';

export default async function PoImportsPage() {
  const svc = await PoImportsService.forCurrentUser();
  const imports = await svc.list();

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">PO imports</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Upload a vendor PO PDF or CSV to stage expected inbound. Inventory
            is not changed until you receive the items.
          </p>
        </div>
        <Button asChild variant="gradient">
          <Link href="/dashboard/purchase-orders/imports/new">+ New import</Link>
        </Button>
      </div>

      {imports.length === 0 ? (
        <p className="text-muted-foreground text-sm">No imports yet.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Uploaded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {imports.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <Link
                      href={`/dashboard/purchase-orders/imports/${i.id}`}
                      className="font-medium hover:underline"
                    >
                      {i.file_name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {i.source_type}
                  </TableCell>
                  <TableCell>
                    <PoImportStatusBadge status={i.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-xs">
                    {formatRelative(i.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
