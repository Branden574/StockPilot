import { NextResponse, type NextRequest } from 'next/server';
import { zipSync } from 'fflate';

import { can } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportError } from '@/lib/error-reporter';
import { PoAttachmentsService } from '@/server/services/po-attachments';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Filesystem-safe filename fragment. */
function safe(name: string): string {
  return (name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}

/** Ensure unique names within the zip (Slip.pdf, Slip (2).pdf, …). */
function dedupe(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  let candidate = `${base} (${i})${ext}`;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${base} (${i})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * "Download all" for a PO — a .zip of the PO PDF + every attached file. Gated on
 * purchase_orders:read (same as the PDF route). The PO PDF is fetched from the
 * existing /pdf route (auth forwarded) so its generation lives in one place;
 * attachment bytes come from the private bucket via the (RLS-scoped) service.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await withApiContext(req);
    const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
    if (limited) return limited;
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    if (!can(ctx, 'purchase_orders:read')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    // PO number (for the file names) — also validates the PO is in-org.
    const poSvc = new PurchaseOrdersService(ctx);
    let poNumber = id;
    try {
      const { po } = await poSvc.get(id);
      poNumber = ((po as { po_number?: string }).po_number ?? id) || id;
    } catch (e) {
      if (e instanceof ServiceError && e.code === 'not_found') {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      throw e;
    }

    const files: Record<string, Uint8Array> = {};

    // 1. PO PDF — reuse the existing route (forward this caller's auth).
    try {
      const pdfRes = await fetch(new URL(`/api/purchase-orders/${id}/pdf`, req.url), {
        headers: {
          cookie: req.headers.get('cookie') ?? '',
          authorization: req.headers.get('authorization') ?? '',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (pdfRes.ok) {
        files[`${safe(poNumber)}.pdf`] = new Uint8Array(await pdfRes.arrayBuffer());
      }
    } catch (e) {
      // Best-effort: still ship the attachments even if the PDF couldn't render.
      void reportError(e, { tag: 'po.attachments_zip.pdf' });
    }

    // 2. Attachments.
    const attachSvc = new PoAttachmentsService(ctx);
    const rows = await attachSvc.listRaw(id);
    const used = new Set<string>(Object.keys(files));
    for (const r of rows) {
      const bytes = await attachSvc.download(r.storage_path);
      if (!bytes) continue;
      const raw = r.file_name || r.storage_path.split('/').pop() || 'file';
      files[dedupe(safe(raw), used)] = bytes;
    }

    if (Object.keys(files).length === 0) {
      return NextResponse.json({ error: 'nothing_to_download' }, { status: 404 });
    }

    const zipped = zipSync(files, { level: 6 });
    return new NextResponse(new Uint8Array(zipped), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${safe(poNumber)}-files.zip"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      // Map the service code to the right HTTP status (403/404/…), like the
      // sibling /pdf route — don't flatten a forbidden/not_found into a 500.
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'po.attachments_zip' });
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
