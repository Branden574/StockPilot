'use server';

import { Buffer } from 'node:buffer';

import { headers } from 'next/headers';
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
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';

import {
  err,
  ok,
  submitShipmentSignatureSchema,
  type ActionResult,
  type SubmitShipmentSignatureInput,
} from '@stockpilot/core';

// I2: cap the merged notes column so a long original notes value plus a
// long signer-supplied notes value can't blow past the column / index
// budgets. The original notes column is already validated to <= 2000 at
// create time, and signer notes are <= 2000 at the schema layer; the
// concatenation could otherwise reach ~4100 chars. 4000 is a safe ceiling
// that preserves both ends in the common case.
const MERGED_NOTES_MAX = 4000;

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

  // I11: rate-limit the public signature endpoint. The token is the auth
  // gate, but a leaked link + a runaway client could otherwise pound the
  // PDF render + email send paths. 10 attempts per 5 minutes per token is
  // generous for legitimate retries (slow connection, server hiccup) and
  // cheap enough that a flooder can't extract value. Closed-mode failure
  // so a DB blip can't accidentally unlock unlimited submissions.
  const rl = await checkRateLimit(
    `shipment-sign:${token}`,
    10,
    5 * 60 * 1000,
    'closed',
  );
  if (!rl.allowed) {
    return err(
      'validation_error',
      'Too many signature attempts. Wait a few minutes and try again.',
    );
  }

  // Capture the signer's IP for audit metadata (I10). Vercel sets
  // `x-forwarded-for` (comma-separated, leftmost is the originating
  // client); fall back to `x-real-ip` and finally to null. We do NOT
  // trust this for auth — it's an audit-trail breadcrumb only.
  let signerIp: string | null = null;
  try {
    const h = await headers();
    const fwd = h.get('x-forwarded-for');
    if (fwd) signerIp = fwd.split(',')[0]?.trim() || null;
    if (!signerIp) signerIp = h.get('x-real-ip');
  } catch {
    // headers() throws outside a request context; non-fatal for tests.
  }

  const admin = createAdminClient();

  // 1. Look up the shipment by token. Service-role bypasses RLS.
  const { data: shipmentRow, error: lookupErr } = await admin
    .from('shipments')
    .select(
      'id, organization_id, work_order_number, status, ship_date, ' +
        'attention_to_name, notes, source_warehouse_id, ' +
        'destination_charter_id, signature_token_expires_at, ' +
        'signature_email_to, signature_email_cc, signature_token',
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
    signature_email_to: string | null;
    signature_email_cc: string[] | null;
    signature_token: string;
  };

  // I11 + M1/M7: the packing slip's `signature_email_to` is the
  // manager-set recipient lock. The signer's email MUST match it.
  //
  // Pre-2C ("back-compat") slips were created without setting
  // `signature_email_to`; previously NULL was treated as "anyone with
  // the token may sign," and the column was then overwritten with
  // whatever email the submitter typed. That made the body-supplied
  // `email` a self-elected recipient lock — any holder of a leaked
  // link could hand-pick where the signed PDF + audit emails got
  // delivered. Refuse with a clear validation error so the manager
  // rotates the link with a proper `signature_email_to` set, rather
  // than silently letting the submitter elect themselves.
  if (!shipment.signature_email_to || !shipment.signature_email_to.trim()) {
    return err(
      'validation_error',
      'This slip requires a manager to set the recipient email first.',
    );
  }
  const lockedTo = shipment.signature_email_to.trim().toLowerCase();
  if (email.trim().toLowerCase() !== lockedTo) {
    return err(
      'forbidden',
      'This signature link was issued to a different email address. Ask the warehouse manager for a fresh link.',
    );
  }

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
  // I2: cap merged notes at MERGED_NOTES_MAX so the concatenation can't
  // grow unbounded across re-signatures (defensive — the schema caps
  // each side at 2000, but the column is `text` and we don't want to
  // store > 4KB for a single shipment's notes).
  const rawMerged =
    notes && notes.length > 0
      ? shipment.notes && shipment.notes.length > 0
        ? `${shipment.notes}\n\n[Signed by ${signedByName}]: ${notes}`
        : `[Signed by ${signedByName}]: ${notes}`
      : shipment.notes;
  const mergedNotes =
    rawMerged && rawMerged.length > MERGED_NOTES_MAX
      ? `${rawMerged.slice(0, MERGED_NOTES_MAX - 1)}…`
      : rawMerged;

  // 2. Persist the signature + flip the state machine. We store the PNG
  // data URL inline in `signature_image_url` — the column is `text` and
  // a ~10–50KB PNG fits fine. Keeps the path simple (no storage bucket,
  // no signed URLs, no second round-trip from the PDF renderer).
  //
  // C3: null signature_token on this write so the public /s/[token]
  // page stops serving the receipt forever once the slip is delivered.
  // The token is single-use (sign once → expire); future visits fall
  // back to the InactiveCard ("This link is no longer active").
  //
  // C6: chain .select('id') so we can detect zero-row updates (status
  // changed under us, e.g. a manager hit Mark Delivered via the
  // authenticated path between lookup and update). The `.in('status',
  // ['shipped'])` filter silently passes on zero rows; without the
  // select-and-check we'd think we succeeded when we actually didn't.
  // M7: do NOT overwrite `signature_email_to` here. It's the
  // manager-set recipient lock and was validated equal to the
  // submitter's email above. Writing the submitter-supplied `email`
  // back into the column would be a no-op today but would silently
  // re-introduce the body-controlled-recipient vector if the lock
  // check ever loosens.
  const { data: updatedRows, error: updateErr } = await admin
    .from('shipments')
    .update({
      signature_image_url: signatureDataUrl,
      signed_by_name: signedByName,
      signed_at: signedAt.toISOString(),
      notes: mergedNotes,
      status: 'delivered',
      signature_token: null,
    })
    .eq('id', shipment.id)
    .in('status', ['shipped'])
    .select('id');
  if (updateErr) {
    void reportError(updateErr, { tag: 'shipment-signature.update' });
    return err('internal_error', 'Could not record signature. Please retry.');
  }
  if (!updatedRows || updatedRows.length === 0) {
    // Lost the race — the shipment is no longer in 'shipped' status.
    // Could be: a manager marked it delivered through the authenticated
    // UI between our lookup and our update, or it was cancelled. Either
    // way, treat as not_found so the user-facing message matches the
    // /s/[token] page's InactiveCard.
    return err(
      'not_found',
      'This shipment is no longer accepting signatures.',
    );
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
  // M7: seed the recipient list from the manager-set
  // `signature_email_to` (already validated equal to `email` above),
  // NOT the submitter-supplied body field. Defense-in-depth against
  // any future loosening of the lock-equality check — the recipient
  // list should always be derived from manager-controlled state.
  const recipients = new Set<string>();
  recipients.add(shipment.signature_email_to.trim());
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

  // 6. Audit. We can't use `audit()` (it depends on withContext()), so
  // we write directly via the admin client.
  //
  // I10: user_id is NULL — the signer is unauthenticated, not the
  // warehouse manager. Attributing audit rows to the manager was wrong:
  // a future "who did this?" lookup would point at someone who never
  // touched the slip. The signer's identity goes in metadata (name +
  // email + ip), which is the right shape for an external-party audit.
  // Promise.allSettled so a logging hiccup never fails the request
  // after we already succeeded.
  const baseMeta = {
    entity_type: 'shipment',
    entity_id: shipment.id,
    warehouse_id: shipment.source_warehouse_id,
    signed_by_name: signedByName,
    signed_by_email: email,
    signer_ip: signerIp,
    work_order_number: shipment.work_order_number,
  };
  await Promise.allSettled([
    admin.from('audit_logs').insert({
      organization_id: shipment.organization_id,
      user_id: null,
      event: 'shipment.signed',
      metadata: baseMeta,
    }),
    admin.from('audit_logs').insert({
      organization_id: shipment.organization_id,
      user_id: null,
      event: 'shipment.delivered',
      metadata: baseMeta,
    }),
    admin.from('audit_logs').insert({
      organization_id: shipment.organization_id,
      user_id: null,
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

