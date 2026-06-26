/**
 * Client-side trigger for the unified inventory export
 * (`POST /api/inventory/export`). POSTs the request (so a large "export
 * selected" id list isn't capped by URL length), reads the returned file as a
 * blob, and saves it using the server's Content-Disposition filename. Throws
 * with a readable message on failure so callers can toast it.
 */
export interface InventoryExportRequest {
  format: 'csv' | 'xlsx' | 'pdf';
  scope: 'selected' | 'filtered' | 'all';
  itemType?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  ids?: string[];
  filters?: {
    q?: string;
    status?: 'active' | 'archived' | 'discontinued' | 'all';
    stock?: 'low' | 'out' | null;
    sort?: string;
    categoryIds?: string[];
    locationIds?: string[];
    charterIds?: string[];
  };
}

export async function downloadInventoryExport(req: InventoryExportRequest): Promise<void> {
  const res = await fetch('/api/inventory/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    let message = 'Export failed. Please try again.';
    try {
      const j = (await res.json()) as { message?: string; error?: string };
      message = j.message || j.error || message;
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="?([^"]+)"?/i);
  const filename = match?.[1] ?? `inventory-export.${req.format}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
