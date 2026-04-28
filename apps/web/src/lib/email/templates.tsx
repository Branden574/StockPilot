interface InviteEmailParams {
  organizationName: string;
  inviterName: string;
  acceptUrl: string;
}

export function inviteEmailHtml({ organizationName, inviterName, acceptUrl }: InviteEmailParams): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:white;border-radius:12px;padding:40px;">
    <div style="display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:18px;margin-bottom:24px;">
      <span style="display:inline-block;width:28px;height:28px;background:linear-gradient(135deg,#3b82f6,#6366f1);border-radius:6px;"></span>
      StockPilot
    </div>
    <h1 style="font-size:24px;margin:0 0 12px;">${escapeHtml(inviterName)} invited you to <strong>${escapeHtml(organizationName)}</strong></h1>
    <p style="color:#52525b;line-height:1.6;margin:0 0 24px;">
      Join the team to track inventory, scan barcodes, and reorder before you run out.
    </p>
    <a href="${acceptUrl}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#6366f1);color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">
      Accept invite
    </a>
    <p style="color:#71717a;font-size:13px;margin-top:32px;">
      Or paste this link in your browser:<br>
      <span style="color:#3f3f46;word-break:break-all;">${acceptUrl}</span>
    </p>
    <p style="color:#a1a1aa;font-size:12px;margin-top:32px;border-top:1px solid #e4e4e7;padding-top:16px;">
      This invite expires in 7 days. If you weren't expecting this, you can safely ignore it.
    </p>
  </div>
</body></html>`;
}

export function inviteEmailText({ organizationName, inviterName, acceptUrl }: InviteEmailParams): string {
  return `${inviterName} invited you to ${organizationName} on StockPilot.

Accept the invite: ${acceptUrl}

This link expires in 7 days. If you weren't expecting this, ignore it.`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
