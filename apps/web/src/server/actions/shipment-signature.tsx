'use server';

import { Buffer } from 'node:buffer';

import { renderToStream } from '@react-pdf/renderer';

import { sendEmail } from '@/lib/email/resend';
import {
  shipmentSignedHtml,
  shipmentSignedSubject,
  shipmentSignedText,
} from '@/lib/email/templates';
import { reportError } from '@/lib/error-reporter';
import {
  ShipmentPdf,
  addressJsonToLines,
  type ShipmentPdfLine,
} from '@/lib/pdf/shipment';
import { createAdminClient } from '@/lib/supabase/admin';

import {
  err,
  ok,
  submitShipmentSignatureSchema,
  type ActionResult,
  type SubmitShipmentSignatureInput,
} from '@stockpilot/core';

/**
 * Public, unauthenticated server action invoked by the /s/[token] page.
 *
 * Uses the service-role admin client because the visitor has no Supabase
 * session — the token IS the auth. Token validation is enforced here, not
 * by RLS.
 *
 * Audit-log strategy: the regular `audit()` helper depends on
 * `withContext()`, which requires an authenticated session. For this
 * token-auth flow we write audit rows directly via the admin client with
 * `user_id = source warehouse manager` (when known) or `null` otherwise.
 * The state-machine columns (status='delivered', signed_at) capture the
 * "this happened" fact independently, so an audit-write failure can never
 * lose the user's signature.
 */
export async function submitShipmentSignatureAction(
  input: SubmitShipmentSignatureInput,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = submitShipmentSignatureSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      'validation_error',
      parsed.error.issues[0]?.message ?? 'Invalid signature submission',
    );
  }
  const { token, signatureDataUrl, signedByName, email, notes } = parsed.data;

  const admin = createAdminClient();

  // 1. Look up the shipment by token. Service-role bypasses RLS.
  const { data: shipmentRow, error: lookupErr } = await admin
    .from('shipments')
    .select(
      'id, organization_id, work_order_number, status, ship_date, ' +
        'attention_to_name, notes, source_warehouse_id, ' +
        'destination_charter_id, signature_token_expires_at, ' +
        'signature_email_cc, signature_token',
    )
    .eq('signature_token', token)
    .maybeSingle();
  if (lookupErr) {
    void reportError(lookupErr, { tag: 'shipment-signature.lookup' });
    return err('internal_error', 'Could not load shipment.');
  }
  if (!shipmentRow) {
    return err('not_found', 'This signature link is no longer active.');
  }
  const shipment = shipmentRow as unknown as {
    id: string;
    organization_id: string;
    work_order_number: string;
    status: 'draft' | 'shipped' | 'delivered' | 'cancelled';
    ship_date: string;
    attention_to_name: string | null;
    notes: string | null;
    source_warehouse_id: string;
    destination_charter_id: string;
    signature_token_expires_at: string | null;
    signature_email_cc: string[] | null;
    signature_token: string;
  };

  if (shipment.status === 'delivered' || shipment.status === 'cancelled') {
    return err(
      'not_found',
      'This shipment is no longer accepting signatures.',
    );
  }
  if (shipment.status === 'draft') {
    // Signing a draft slip would skip the `post_shipment_shipped` RPC —
    // the only path that decrements stock. Block here so a signed
    // draft can never silently lose inventory.
    return err(
      'validation_error',
      "This packing slip hasn't been shipped yet — ask a manager to mark it shipped before signing.",
    );
  }
  if (
    shipment.signature_token_expires_at &&
    new Date(shipment.signature_token_expires_at).getTime() < Date.now()
  ) {
    return err('not_found', 'This signature link has expired.');
  }

  const signedAt = new Date();
  const mergedNotes =
    notes && notes.length > 0
      ? shipment.notes && shipment.notes.length > 0
        ? `${shipment.notes}\n\n[Signed by ${signedByName}]: ${notes}`
        : `[Signed by ${signedByName}]: ${notes}`
      : shipment.notes;

  // 2. Persist the signature + flip the state machine. We store the PNG
  // data URL inline in `signature_image_url` — the column is `text` and
  // a ~10–50KB PNG fits fine. Keeps the path simple (no storage bucket,
  // no signed URLs, no second round-trip from the PDF renderer).
  const { error: updateErr } = await admin
    .from('shipments')
    .update({
      signature_image_url: signatureDataUrl,
      signed_by_name: signedByName,
      signed_at: signedAt.toISOString(),
      signature_email_to: email,
      notes: mergedNotes,
      status: 'delivered',
    })
    .eq('id', shipment.id)
    .in('status', ['shipped']);
  if (updateErr) {
    void reportError(updateErr, { tag: 'shipment-signature.update' });
    return err('internal_error', 'Could not record signature. Please retry.');
  }

  // 3. Load the bits we need to re-render the signed PDF + send the email.
  const [linesRes, sourceRes, destRes, orgRes] = await Promise.all([
    admin
      .from('shipment_lines')
      .select(
        'id, item_id, qty_shipped, qty_back_ordered, line_order, ' +
          'item:inventory_items!item_id (id, name, sku, barcode)',
      )
      .eq('shipment_id', shipment.id)
      .order('line_order', { ascending: true }),
    admin
      .from('warehouses')
      .select(
        'id, name, code, address, contact_name, contact_email, contact_phone, ' +
          'manager_user_id, manager:user_profiles!manager_user_id (id, full_name, email)',
      )
      .eq('id', shipment.source_warehouse_id)
      .maybeSingle(),
    admin
      .from('charters')
      .select('id, name, code')
      .eq('id', shipment.destination_charter_id)
      .maybeSingle(),
    admin
      .from('organizations')
      .select('name, logo_url')
      .eq('id', shipment.organization_id)
      .maybeSingle(),
  ]);

  const lineRows: ShipmentPdfLine[] = ((linesRes.data ?? []) as unknown as Array<{
    item_id: string;
    qty_shipped: number | string;
    qty_back_ordered: number | string;
    item:
      | { id: string; name: string; sku: string; barcode: string | null }
      | { id: string; name: string; sku: string; barcode: string | null }[]
      | null;
  }>).map((r) => {
    const itemField = Array.isArray(r.item) ? r.item[0] ?? null : r.item ?? null;
    return {
      isbn: itemField?.barcode ?? itemField?.sku ?? '',
      description: itemField?.name ?? 'Unknown item',
      qtyShipped: Number(r.qty_shipped) || 0,
      qtyBackOrdered: Number(r.qty_back_ordered) || 0,
    };
  });

  const src = sourceRes.data as
    | {
        id: string;
        name: string;
        address: Record<string, unknown> | null;
        contact_phone: string | null;
        contact_email: string | null;
        manager_user_id: string | null;
        manager:
          | { id: string; full_name: string | null; email: string | null }
          | { id: string; full_name: string | null; email: string | null }[]
          | null;
      }
    | null;
  const dst = destRes.data as
    | {
        id: string;
        name: string;
        code: string | null;
      }
    | null;
  const orgRow = orgRes.data as
    | { name?: string | null; logo_url?: string | null }
    | null;

  const sourceAddrLines = addressJsonToLines(src?.address ?? null);
  // Destination is a charter — no address field in the schema.
  const sourceManager = src
    ? Array.isArray(src.manager)
      ? src.manager[0] ?? null
      : src.manager ?? null
    : null;

  // 4. Render the signed PDF. The QR block is suppressed automatically
  // because we pass status='delivered'.
  let pdfBuffer: Buffer | null = null;
  try {
    const stream = await renderToStream(
      <ShipmentPdf
        org={{
          name: (orgRow?.name ?? 'StockPilot') || 'StockPilot',
          logoUrl: (orgRow?.logo_url ?? null) || null,
        }}
        shipment={{
          workOrderNumber: shipment.work_order_number,
          shipDate: shipment.ship_date,
          attentionToName: shipment.attention_to_name,
          notes: mergedNotes,
          status: 'delivered',
        }}
        source={{
          name: src?.name ?? '',
          addressLines: sourceAddrLines,
          contactPhone: src?.contact_phone ?? null,
          contactEmail: src?.contact_email ?? null,
        }}
        destination={{
          name: dst?.name ?? '',
          code: dst?.code ?? null,
        }}
        lines={lineRows}
        manager={
          sourceManager
            ? {
                fullName: sourceManager.full_name,
                role: null,
                warehouseAddressLines: sourceAddrLines,
                phone: src?.contact_phone ?? null,
                email: sourceManager.email ?? src?.contact_email ?? null,
              }
            : null
        }
        qrDataUrl={null}
        signature={{
          imageDataUrl: signatureDataUrl,
          signedByName,
          signedAt,
        }}
      />,
    );
    pdfBuffer = await streamToBuffer(stream as NodeJS.ReadableStream);
  } catch (e) {
    void reportError(e, { tag: 'shipment-signature.pdf-render' });
    // Don't fail the action — the signature is captured. Email step
    // below will skip when buffer is null.
  }

  // 5. Build the recipient list. Type narrows + dedupes.
  const recipients = new Set<string>();
  recipients.add(email);
  if (sourceManager?.email) recipients.add(sourceManager.email);
  if (shipment.signature_email_cc) {
    for (const cc of shipment.signature_email_cc) {
      if (cc && cc.trim().length > 0) recipients.add(cc.trim());
    }
  }
  const recipientList = [...recipients];

  if (pdfBuffer) {
    const orgName = (orgRow?.name ?? 'StockPilot') || 'StockPilot';
    const subject = shipmentSignedSubject({
      orgName,
      workOrderNumber: shipment.work_order_number,
    });
    const templateParams = {
      orgName,
      workOrderNumber: shipment.work_order_number,
      sourceWarehouseName: src?.name ?? '',
      destinationCharterName: dst?.name ?? '',
      signedByName,
      signedAt,
      itemCount: lineRows.length,
      managerName: sourceManager?.full_name ?? null,
      managerEmail: sourceManager?.email ?? null,
    };
    const html = shipmentSignedHtml(templateParams);
    const text = shipmentSignedText(templateParams);
    const filename = `packing-slip-${shipment.work_order_number}-signed.pdf`;
    const emailResult = await sendEmail({
      to: recipientList,
      subject,
      html,
      text,
      attachments: [{ filename, content: pdfBuffer.toString('base64') }],
    });
    if (!emailResult.ok) {
      // Don't fail the action — the signature is saved and the user can
      // request a resend later. Just log + move on.
      void reportError(new Error(emailResult.error ?? 'unknown'), {
        tag: 'shipment-signature.email',
        extra: { workOrderNumber: shipment.work_order_number },
      });
    }
  }

  // 6. Audit. We can't use `audit()` (it depends on withContext()), so we
  // write directly via the admin client. user_id falls back to the source
  // warehouse manager — they're effectively the org-side party of record
  // for this state change. We use Promise.allSettled so a logging hiccup
  // never fails the request after we already succeeded.
  const auditorUserId = src?.manager_user_id ?? null;
  const baseMeta = {
    entity_type: 'shipment',
    entity_id: shipment.id,
    warehouse_id: shipment.source_warehouse_id,
    signed_by_name: signedByName,
    work_order_number: shipment.work_order_number,
  };
  await Promise.allSettled([
    admin.from('audit_logs').insert({
      organization_id: shipment.organization_id,
      user_id: auditorUserId,
      event: 'shipment.signed',
      metadata: baseMeta,
    }),
    admin.from('audit_logs').insert({
      organization_id: shipment.organization_id,
      user_id: auditorUserId,
      event: 'shipment.delivered',
      metadata: baseMeta,
    }),
    admin.from('audit_logs').insert({
      organization_id: shipment.organization_id,
      user_id: auditorUserId,
      event: 'shipment.email_sent',
      metadata: { ...baseMeta, recipientCount: recipientList.length },
    }),
  ]);

  return ok({ ok: true });
}

/** Convert a @react-pdf renderToStream output to a Buffer for email attachment. */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

