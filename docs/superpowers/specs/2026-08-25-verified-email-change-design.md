# Verified self-service email change — design

Date: 2026-08-25. Branch: `feat/verified-email-change`.

## The problem

A StockPilot user's email is their **account identity**: Supabase Auth logs
them in with it, `user_profiles.email` displays it and is what every
account-directed email (weekly digest, schedule reminders, admin password
reset) is addressed to. Today it is read-only ("ask your admin"), and there is
no path that changes the auth identity and the application projection
together.

## What was measured before designing (never assumed)

Production auth config, read from the Management API:

| Setting | Value | Consequence |
|---|---|---|
| `mailer_secure_email_change_enabled` | **true** | GoTrue requires confirmation from **both** the current and the new address. |
| `smtp_host` | none | The built-in mailer is in use — capped at `rate_limit_email_sent = 2` per hour project-wide and known to fail silently (2026-07-02 incident). A naive `updateUser({ email })` would burn that on one change. |
| `mailer_notifications_email_changed_enabled` | false | GoTrue will **not** tell the old address. We must. |
| `mailer_otp_exp` | 3600 | Links live one hour. |
| `security_update_password_require_reauthentication` | false | GoTrue enforces no reauth; the app must. |

GoTrue behaviour, measured against production with throwaway users (deleted
afterwards; `generateLink` mints tokens without sending mail):

1. `generateLink({ type: 'email_change_current' })` returns the correct
   hashed token. `generateLink({ type: 'email_change_new' })` returns
   `sha224(CURRENT_email + otp)` but **stores** `sha224(NEW_email + otp)` —
   a GoTrue bug. The new-side link therefore carries a hash we compute
   ourselves from the returned `email_otp`.
2. Verifying either side first returns **no session** and changes nothing
   (`email_change_confirm_status` 0 → 1). Verifying the second side applies
   the change and returns a session for the account, now bearing the new
   email.
3. After completion: the new email signs in with the unchanged password and
   the same user id; the old email is refused; password recovery resolves
   the new address and no longer finds the old; a used token is rejected on
   replay.
4. `user_profiles.email` does **not** follow: migration 0177 pins the column
   for every role (including service role) and the only auth→profile sync
   trigger (0001) is INSERT-only.
5. The admin API cannot clear a pending change; re-requesting to a different
   address replaces the pending target.

Existing data: 16 auth users, all with `auth.users.email = user_profiles.email`
exactly, none pending. No repair needed.

## Source of truth

**Supabase Auth (`auth.users.email`) is the identity.** `user_profiles.email`
is a projection kept equal to it by the database itself:

- `tg_pin_user_profile_email` (0177, redefined in 0345) now allows a profile
  email write **only when it equals the verified auth email** for that row;
  anything else is reverted silently, as before. No caller — not even the
  service role — can put an arbitrary address into the projection.
- A new `AFTER UPDATE OF email ON auth.users` trigger writes the projection and
  an audit row (`user.email.changed`, before/after) in the same transaction
  as GoTrue's own update. This is the primary sync and it cannot be skipped
  by any client path.
- `reconcileProfileEmail(userId)` is the idempotent app-level repair, run on
  the profile page and the mobile status route. It compares and writes only
  on difference; running it five times produces one result and no duplicate
  audit rows.

Pending state lives in GoTrue (`user.new_email`, `email_change_sent_at`); no
duplicate columns are added.

## The flow

```
Settings → Profile → Change email
  new email + current password   (AAL2 step-up if a TOTP factor is enrolled)
  ↓ requestEmailChangeAction
  account-status guard → rate limit (user + target) → password side-channel
  → duplicate check (auth_user_exists_by_email) → mint both links → Resend
  ↓
  email to NEW address:     /auth/confirm?type=email_change&token_hash=sha224(new+otp)
  email to CURRENT address: /auth/confirm?type=email_change&token_hash=<returned>
  ↓ POST /auth/confirm (click-through page; GET never consumes)
  first click  → "one confirmation down" page, nothing changed
  second click → GoTrue applies change → DB trigger syncs profile + audits
               → route reconciles, emails the OLD address a security notice,
                 redirects to /dashboard/settings/profile?emailChanged=1
```

The old address stays canonical for every ordinary email until the second
confirmation. The unverified address receives only its own confirmation link.

## Cancel

`public.cancel_pending_email_change(uuid)` — a SECURITY DEFINER function,
executable by `service_role` only, that clears GoTrue's five pending columns
for one user. It can only reduce capability (a pending change disappears);
it never sets an email. This is the one place the app touches `auth.users`
outside GoTrue's API, because GoTrue exposes no cancel.

## Routing matrix

| Email | Recipient source | Follows the change? |
|---|---|---|
| Weekly digest, schedule reminders, digest preview | `user_profiles.email` by user id at send time | Yes, via the projection |
| Admin "send password reset" | `user_profiles.email` | Yes |
| Password reset, sign-in, recovery | `auth.users.email` | Yes |
| New-device alert | the address typed at sign-in (= auth email) | Yes |
| Team invite matching / dedupe | `user_profiles.email` | Yes (pending invites to the OLD address will no longer match — expected) |
| Order requester (internal) | `requester_user_id` → profile | Yes |
| Order requester (portal / public), returns, rentals, support tickets, maintenance snapshot | stored contact strings | **No — intentionally.** External or historical. |
| `organization_invites.email`, `platform_admin_audit.actor_email`, `order_email_log.recipient_email`, `signed_by_email` | snapshots | **Never rewritten.** |

## Security

- Reauthentication: current password always (side-channel client, never the
  SSR session); fresh AAL2 when a verified TOTP factor exists.
- Rate limits, closed mode: `emailchange:<user>` 3/15 min,
  `emailchange-target:<email>` 3/15 min, `emailchange-resend:<user>` 3/15 min.
- Disabled and tombstoned accounts are refused before any budget is spent.
- Duplicate targets are refused with a generic message.
- The confirmation route hard-codes its redirect; `next` is ignored for this
  type.
- Sessions are not revoked (identity and user id are unchanged); the
  completing click yields a fresh session in that browser as with any
  magic link.
- Audit events: `user.email.change_requested`, `user.email.change_resent`,
  `user.email.change_cancelled`, `user.email.changed`.
