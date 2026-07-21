/**
 * Public StockPilot logo for email headers. A hosted PNG on our own domain —
 * email clients (Gmail/Outlook) strip inline <svg>, so the brand mark in an
 * email MUST be a real raster image at an absolute URL. Served from
 * apps/web/public/email-logo.png.
 */
// ?v=2 cache-busts Google's image proxy: GoogleImageProxy cached a failure for
// the bare URL when the logo first shipped (2026-06-18) and kept serving the
// broken state long after the file itself served fine — the proxy caches
// per-URL, failures included. Bump the version if it ever breaks again.
export const EMAIL_LOGO_URL = 'https://stockpilotusa.com/email-logo.png?v=2';
export function emailLogoImg(size = 28): string {
  const r = Math.round(size * 0.22);
  return `<img src="${EMAIL_LOGO_URL}" width="${size}" height="${size}" alt="StockPilot" style="display:inline-block;vertical-align:middle;width:${size}px;height:${size}px;border-radius:${r}px;" />`;
}

// The invite + password-reset templates that used to live here moved to
// the es design system: `es/families/invites.ts` (team-invite,
// invite-reminder, ws-ready, portal-invite), `es/families/security.ts`
// (pw-reset, signin), and `es/families/digest.ts` (weekly digest + preview).
// Only `emailLogoImg` remains as a shared legacy export.

// ---------------------------------------------------------------------------
// The weekly digest moved to the redesigned email system:
// lib/email/es/families/digest.ts (renderWeeklyDigestHtml / weeklyDigestText /
// weeklyDigestSubject). This file keeps the remaining classic-layout emails
// (invites, password reset) until their families migrate.
// ---------------------------------------------------------------------------
